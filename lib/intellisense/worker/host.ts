/**
 * The worker side of the small RPC the editor uses with the C++ and Rust
 * language workers. The toolchain runs one job at a time, so:
 *  - interactive requests (completion, hover, signature help, definition) go
 *    before background diagnostics, so typing never waits on a full check;
 *  - a request superseded by a newer one of the same method is answered with
 *    `null` without running (typing fast never builds a backlog);
 *  - diagnostics run debounced, on the newest document version only.
 */

import type { Diagnostic, ServiceStatus } from '../types';

export type Request = { id: number; method: string; params: unknown };
export type ToWorker =
  | Request
  | { type: 'update'; text: string; version: number }
  /** The workspace's files, so includes and modules resolve. */
  | { type: 'files'; files: Readonly<Record<string, string>> }
  /** Which workspace file `update` and requests refer to. */
  | { type: 'active'; path: string };
export type FromWorker =
  | { id: number; result?: unknown; error?: string }
  | { type: 'diagnostics'; version: number; diagnostics: Diagnostic[] }
  | { type: 'status'; status: ServiceStatus };

type Handlers = Record<string, (params: never) => Promise<unknown>>;

declare const self: {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

export function serve(options: {
  /** Loads the toolchain; nothing runs before it settles. */
  ready: Promise<void>;
  handlers: Handlers;
  diagnose: (text: string) => Promise<Diagnostic[]>;
  setFiles?: (files: Readonly<Record<string, string>>) => void;
  setActive?: (path: string) => void;
  debounceMs?: number;
}) {
  const latest = new Map<string, number>();
  const requests: Request[] = [];
  let doc: { text: string; version: number } | null = null;
  let diagnoseDue = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let started = false;

  const pump = async () => {
    if (busy || !started) return;
    busy = true;
    try {
      for (;;) {
        const msg = requests.shift();
        if (msg) {
          if (latest.get(msg.method) !== msg.id) {
            self.postMessage({ id: msg.id, result: null }); // superseded
            continue;
          }
          const handler = options.handlers[msg.method];
          try {
            if (!handler) throw new Error(`unknown method ${msg.method}`);
            self.postMessage({ id: msg.id, result: await handler(msg.params as never) });
          } catch (error) {
            self.postMessage({ id: msg.id, error: String((error as Error)?.message ?? error) });
          }
          continue;
        }
        if (diagnoseDue && doc) {
          diagnoseDue = false;
          const { text, version } = doc;
          try {
            self.postMessage({ type: 'diagnostics', version, diagnostics: await options.diagnose(text) });
          } catch (error) {
            console.warn('[intellisense] diagnostics failed', error);
          }
          continue;
        }
        break;
      }
    } finally {
      busy = false;
    }
  };

  // Workspace changes that arrived while the toolchain loaded; they apply before any request.
  const waiting: Array<() => void> = [];

  options.ready.then(
    () => {
      started = true;
      for (const apply of waiting.splice(0)) apply();
      void pump();
    },
    (error: unknown) => {
      // Answer everything with an error rather than leaving callers hanging.
      started = true;
      options.handlers = {};
      options.diagnose = () => Promise.reject(error);
      void pump();
    },
  );

  // Workspace changes apply in arrival order, and always before the requests behind them.
  const whenReady = (apply: () => void) => (started ? apply() : void waiting.push(apply));

  self.onmessage = (event) => {
    const msg = event.data;
    if ('type' in msg && msg.type === 'active') {
      // Arrives just before the new file's `update`, which schedules its check.
      whenReady(() => options.setActive?.(msg.path));
      return;
    }
    if ('type' in msg && msg.type === 'files') {
      // Another file changed: the open one may now check differently.
      whenReady(() => options.setFiles?.(msg.files));
      if (!doc) return;
    } else if ('type' in msg) {
      doc = { text: msg.text, version: msg.version };
    }
    if ('type' in msg) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        diagnoseDue = true;
        void pump();
      }, options.debounceMs ?? 300);
      return;
    }
    latest.set(msg.method, msg.id);
    requests.push(msg);
    void pump();
  };
}

export function postStatus(status: ServiceStatus) {
  self.postMessage({ type: 'status', status });
}
