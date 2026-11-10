/**
 * The worker side of the small RPC the editor uses with the C++ and Rust
 * language workers. Requests of the same method supersede each other: if a
 * newer `complete` arrives while an older one is still queued, the older one
 * is answered with `null` without running (typing fast never builds a backlog).
 * Diagnostics run debounced on the newest document version only.
 */

import type { Diagnostic, ServiceStatus } from '../types';

export type Request = { id: number; method: string; params: unknown };
export type ToWorker = Request | { type: 'update'; text: string; version: number };
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
  /** Loads the toolchain; requests wait for it. */
  ready: Promise<void>;
  handlers: Handlers;
  diagnose: (text: string) => Promise<Diagnostic[]>;
  debounceMs?: number;
}) {
  const latest = new Map<string, number>();
  let chain: Promise<unknown> = options.ready;
  let pending: { text: string; version: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;

  const enqueue = <T>(job: () => Promise<T>) => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };

  const runDiagnostics = () => {
    timer = null;
    if (checking || !pending) return;
    const { text, version } = pending;
    pending = null;
    checking = true;
    void enqueue(() => options.diagnose(text))
      .then((diagnostics) => self.postMessage({ type: 'diagnostics', version, diagnostics }))
      .catch((error) => console.warn('[intellisense] diagnostics failed', error))
      .finally(() => {
        checking = false;
        if (pending) schedule();
      });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runDiagnostics, options.debounceMs ?? 300);
  };

  self.onmessage = (event) => {
    const msg = event.data;
    if ('type' in msg) {
      pending = { text: msg.text, version: msg.version };
      schedule();
      return;
    }
    latest.set(msg.method, msg.id);
    const handler = options.handlers[msg.method];
    void enqueue(async () => {
      if (latest.get(msg.method) !== msg.id) return null; // superseded
      if (!handler) throw new Error(`unknown method ${msg.method}`);
      return handler(msg.params as never);
    }).then(
      (result) => self.postMessage({ id: msg.id, result }),
      (error: unknown) => self.postMessage({ id: msg.id, error: String((error as Error)?.message ?? error) }),
    );
  };
}

export function postStatus(status: ServiceStatus) {
  self.postMessage({ type: 'status', status });
}
