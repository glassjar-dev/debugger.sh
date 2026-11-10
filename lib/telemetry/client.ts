'use client';

import type { DockState } from '@/components/dock/types';

import {
  EDIT_MERGE_MS,
  createStampClock,
  tryMerge,
  type EditAtom,
  type OpenEdit,
} from './coalesce';
import { MAX_EVENT_BYTES, droppedEvent, utf8Bytes, type TelemetryEnvelope } from './events';
import type { Language, TelemetryDetails, TelemetryEvent } from './types';

const QUEUE_KEY = 'dbg.telemetry.queue';
const STABLE_KEY = 'dbg.telemetry.stable_id';
// Each send is a Worker request, and the Workers Free plan allows 100k a day per account.
const FLUSH_MS = 10_000;
// Leaves room for the `received_at` the Worker adds before checking MAX_EVENT_BYTES.
const MAX_QUEUED_EVENT_BYTES = MAX_EVENT_BYTES - 1024;
const LAYOUT_SETTLE_MS = 200;
const IO_WINDOW_MS = 500;
const MAX_QUEUE = 1000;
const BATCH = 100;
const ENDPOINT = '/api/events';
// The Worker rejects bodies over 1 MiB. Keepalive requests, used while the page is
// hiding, are limited by the browser to 64 KiB in flight.
const MAX_BODY_BYTES = 768 * 1024;
const MAX_KEEPALIVE_BYTES = 60 * 1024;

type QueuedEvent = TelemetryEnvelope;

type IoKind = 'stdout' | 'stderr';

type IoWindow = {
  data: string;
  startedAt: number;
  timer: number;
};

const stamp = createStampClock();

let sessionId: string | null = null;
let sessionStarted = false;
let queue: QueuedEvent[] = [];
let loaded = false;
let pendingEdit: OpenEdit | null = null;
let editTimer: number | null = null;
let layoutTimer: number | null = null;
let pendingLayout: DockState | null = null;
let layoutKey = '';
let stdinBuf = '';
const ioWindows: Partial<Record<IoKind, IoWindow>> = {};
let flushTimer: number | null = null;
let flushing = false;
let flushAgain = false;
let retryMs = 1000;
let installed = false;

function guard(fn: () => void) {
  try {
    fn();
  } catch {
    // Telemetry must never surface a failure to the page.
  }
}

function getSessionId(): string {
  if (!sessionId) sessionId = crypto.randomUUID();
  return sessionId;
}

function stableId(): string {
  try {
    const existing = localStorage.getItem(STABLE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(STABLE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function pointerKind(): 'coarse' | 'fine' | 'none' {
  if (window.matchMedia('(pointer: coarse)').matches) return 'coarse';
  if (window.matchMedia('(pointer: fine)').matches) return 'fine';
  return 'none';
}

function isQueued(value: unknown): value is QueuedEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as QueuedEvent;
  return (
    typeof row.session_id === 'string' &&
    typeof row.timestamp === 'string' &&
    typeof row.event === 'string' &&
    'details' in row
  );
}

function ensureLoaded() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { events?: unknown };
    if (!Array.isArray(parsed.events)) return;
    queue = parsed.events.filter(isQueued);
  } catch {
    queue = [];
  }
}

function persist() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ events: queue }));
  } catch {
    // Quota or private mode: keep the in-memory queue and retry the send.
  }
}

function scheduleFlush(delay: number) {
  if (typeof window === 'undefined' || flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

/** Too large for the Worker to store: keep a record that it happened instead. */
function fitEvent(envelope: QueuedEvent): QueuedEvent {
  const line = JSON.stringify(envelope);
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so short lines skip the encode.
  if (line.length * 3 <= MAX_QUEUED_EVENT_BYTES) return envelope;
  const bytes = utf8Bytes(line);
  return bytes > MAX_QUEUED_EVENT_BYTES ? droppedEvent(envelope, bytes) : envelope;
}

function enqueue(
  event: TelemetryEvent,
  details: unknown,
  at = Date.now(),
  skipFlush = false,
) {
  ensureLoaded();
  // Stamp older buffered edits/output first so client timestamps stay ordered.
  if (!skipFlush) flushPendingBefore(at);
  if (queue.length >= MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE + 1);
  const envelope: QueuedEvent = {
    session_id: getSessionId(),
    timestamp: stamp(at),
    event,
    details: details ?? null,
  };
  queue.push(fitEvent(envelope));
  persist();
  scheduleFlush(FLUSH_MS);
}

let flushingPending = false;

/** Commit coalesced events that started at or before `at`, oldest first. */
function flushPendingBefore(at: number) {
  if (flushingPending) return;
  flushingPending = true;
  try {
    for (;;) {
      const editAt =
        pendingEdit && pendingEdit.startedAt <= at ? pendingEdit.startedAt : Infinity;
      let ioKind: IoKind | null = null;
      let ioAt = Infinity;
      for (const kind of ['stdout', 'stderr'] as const) {
        const buf = ioWindows[kind];
        if (buf && buf.data && buf.startedAt <= at && buf.startedAt < ioAt) {
          ioAt = buf.startedAt;
          ioKind = kind;
        }
      }
      if (editAt === Infinity && !ioKind) break;
      if (editAt <= ioAt) commitPendingEdit();
      else if (ioKind) commitIo(ioKind);
    }
  } finally {
    flushingPending = false;
  }
}

function editDetails(edit: OpenEdit): TelemetryDetails['edit'] {
  return {
    ...(edit.file ? { file: edit.file } : {}),
    offset: edit.offset,
    ...(edit.deleted > 0 ? { deleted: edit.deleted } : {}),
    ...(edit.inserted.length > 0 ? { inserted: edit.inserted } : {}),
    ...(edit.reason ? { reason: edit.reason } : {}),
    ...(edit.language ? { language: edit.language as Language } : {}),
  };
}

function commitPendingEdit() {
  const open = pendingEdit;
  if (!open) return;
  pendingEdit = null;
  if (editTimer != null) {
    window.clearTimeout(editTimer);
    editTimer = null;
  }
  if (!flushingPending) flushPendingBefore(open.startedAt);
  enqueue('edit', editDetails(open), open.startedAt, true);
}

function armEditTimer() {
  if (typeof window === 'undefined') return;
  if (editTimer != null) window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    editTimer = null;
    guard(commitPendingEdit);
  }, EDIT_MERGE_MS);
}

function noteEdit(atom: EditAtom) {
  if (!sessionStarted) return;
  if (atom.deleted === 0 && atom.inserted === '' && atom.reason !== 'language') return;
  const open: OpenEdit = { ...atom, startedAt: atom.at };
  if (pendingEdit) {
    const merged = tryMerge(pendingEdit, atom);
    if (merged) {
      pendingEdit = merged;
      armEditTimer();
      return;
    }
    commitPendingEdit();
  }
  pendingEdit = open;
  armEditTimer();
}

function commitIo(kind: IoKind) {
  const windowBuf = ioWindows[kind];
  if (!windowBuf) return;
  window.clearTimeout(windowBuf.timer);
  delete ioWindows[kind];
  if (!windowBuf.data) return;
  if (!flushingPending) flushPendingBefore(windowBuf.startedAt);
  enqueue('run_io', { kind, data: windowBuf.data }, windowBuf.startedAt, true);
}

function pushStream(kind: IoKind, data: string) {
  if (!data || !sessionStarted) return;
  const existing = ioWindows[kind];
  if (existing) {
    existing.data += data;
    return;
  }
  const startedAt = Date.now();
  const timer = window.setTimeout(() => {
    guard(() => commitIo(kind));
  }, IO_WINDOW_MS);
  ioWindows[kind] = { data, startedAt, timer };
}

/** Line-buffer stdin the same way the terminal submits it to the process. */
function pushStdin(data: string) {
  if (!sessionStarted) return;
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && data[i + 1] === '\n') i += 1;
      const line = `${stdinBuf}\n`;
      stdinBuf = '';
      enqueue('run_io', { kind: 'stdin', data: line });
    } else if (ch === '\u007f' || ch === '\b') {
      stdinBuf = stdinBuf.slice(0, -1);
    } else if (ch === '\x04') {
      stdinBuf = '';
      enqueue('run_io', { kind: 'stdin', data: '\x04' });
    } else if (ch >= ' ' || ch === '\t') {
      stdinBuf += ch;
    }
    i += 1;
  }
}

function commitLayout() {
  layoutTimer = null;
  const layout = pendingLayout;
  if (!layout) return;
  if (!sessionStarted) {
    layoutTimer = window.setTimeout(() => guard(commitLayout), LAYOUT_SETTLE_MS);
    return;
  }
  pendingLayout = null;
  const key = JSON.stringify(layout);
  if (key === layoutKey) return;
  layoutKey = key;
  enqueue('layout_changed', { layout: JSON.parse(key) as DockState });
}

/** Take events from the front of the queue until the batch would exceed `maxBytes`. */
function takeBatch(maxBytes: number): QueuedEvent[] {
  const batch: QueuedEvent[] = [];
  let bytes = 2;
  for (const event of queue) {
    if (batch.length >= BATCH) break;
    const size = new Blob([JSON.stringify(event)]).size + 1;
    if (batch.length > 0 && bytes + size > maxBytes) break;
    batch.push(event);
    bytes += size;
  }
  return batch;
}

async function send(batch: QueuedEvent[]): Promise<'ok' | 'retry' | 'poison'> {
  try {
    const body = JSON.stringify(batch);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Lets the request outlive the page when sent from `pagehide`.
      keepalive: new Blob([body]).size <= MAX_KEEPALIVE_BYTES,
    });
    if (res.ok) return 'ok';
    // 429 is the per-IP rate limit; the batch itself is fine.
    if (res.status === 429) return 'retry';
    if (res.status >= 400 && res.status < 500) return 'poison';
    return 'retry';
  } catch {
    return 'retry';
  }
}

function takeRetry(): number {
  const wait = retryMs;
  retryMs = Math.min(30_000, retryMs * 2);
  return wait;
}

async function flush(maxBytes = MAX_BODY_BYTES): Promise<void> {
  if (typeof window === 'undefined') return;
  if (flushing) {
    flushAgain = true;
    return;
  }
  ensureLoaded();
  if (queue.length === 0) return;
  flushing = true;
  const batch = takeBatch(maxBytes);
  let retryDelay: number | null = null;
  try {
    const result = await send(batch);
    if (result === 'ok') {
      queue.splice(0, batch.length);
      persist();
      retryMs = 1000;
      if (queue.length) flushAgain = true;
    } else if (result === 'poison') {
      const head = await send(queue.slice(0, 1));
      if (head === 'ok' || head === 'poison') {
        queue.shift();
        persist();
        if (head === 'ok') retryMs = 1000;
        if (queue.length) flushAgain = true;
      } else {
        retryDelay = takeRetry();
      }
    } else {
      retryDelay = takeRetry();
    }
  } catch {
    retryDelay = takeRetry();
  } finally {
    flushing = false;
  }
  if (retryDelay != null) {
    flushAgain = false;
    if (flushTimer != null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    scheduleFlush(retryDelay);
    return;
  }
  if (flushAgain) {
    flushAgain = false;
    scheduleFlush(0);
  }
}

function onPageHide() {
  guard(() => {
    flushPendingBefore(Date.now());
    // Small enough for a keepalive request, so it survives the page closing. Anything
    // left stays in localStorage and goes out on the next visit.
    void flush(MAX_KEEPALIVE_BYTES);
  });
}

function onOnline() {
  retryMs = 1000;
  void flush();
}

let reporting = false;
function reportError(type: string, reason: string) {
  if (reporting) return;
  reporting = true;
  try {
    enqueue('error', { type, reason: reason.slice(0, 4000) });
  } catch {
    // Ignore.
  } finally {
    reporting = false;
  }
}

function onWindowError(ev: ErrorEvent) {
  const err = ev.error;
  const type = err instanceof Error ? err.name : 'Error';
  const reason = err instanceof Error ? String(err) : ev.message || 'Unknown error';
  reportError(type, reason);
}

function onRejection(ev: PromiseRejectionEvent) {
  const reason = ev.reason;
  const type = reason instanceof Error ? reason.name : typeof reason;
  const text = reason instanceof Error ? String(reason) : String(reason);
  reportError(type, text);
}

export type SessionStartInput = {
  language: Language;
  code: string;
  files?: Record<string, string>;
  layout: DockState;
  shareId?: string;
};

type NullTelemetryEvent = {
  [E in TelemetryEvent]: TelemetryDetails[E] extends null ? E : never;
}[TelemetryEvent];

function recordLayout(layout: DockState) {
  if (typeof window === 'undefined') return;
  pendingLayout = layout;
  if (layoutTimer != null) window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => guard(commitLayout), LAYOUT_SETTLE_MS);
}

/** Publish client telemetry. Event payloads are documented on `TelemetryDetails`. */
export class Telemetry {
  static log<E extends NullTelemetryEvent>(event: E, details?: null): void;
  static log<E extends Exclude<TelemetryEvent, NullTelemetryEvent>>(
    event: E,
    details: TelemetryDetails[E],
  ): void;
  static log(event: TelemetryEvent, details?: TelemetryDetails[TelemetryEvent] | null): void {
    guard(() => {
      switch (event) {
        case 'session': {
          const payload = details as TelemetryDetails['session'];
          if (sessionStarted || typeof window === 'undefined') return;
          sessionStarted = true;
          layoutKey = JSON.stringify(payload.layout);
          enqueue('session', payload, Date.now(), true);
          return;
        }
        case 'edit': {
          const payload = details as TelemetryDetails['edit'];
          noteEdit({
            file: payload.file,
            offset: payload.offset,
            deleted: payload.deleted ?? 0,
            inserted: payload.inserted ?? '',
            reason: payload.reason,
            language: payload.language,
            at: Date.now(),
          });
          return;
        }
        case 'layout_changed':
          recordLayout((details as TelemetryDetails['layout_changed']).layout);
          return;
        case 'run_io': {
          const payload = details as TelemetryDetails['run_io'];
          if (payload.kind === 'stdin') pushStdin(payload.data);
          else pushStream(payload.kind, payload.data);
          return;
        }
        case 'run_start':
          stdinBuf = '';
          enqueue('run_start', null);
          return;
        case 'run_stop':
          stdinBuf = '';
          enqueue('run_stop', details);
          return;
        default:
          enqueue(event, details ?? null);
      }
    });
  }

  /** Gather the browser environment, then publish `session`. */
  static startSession(input: SessionStartInput) {
    guard(() => {
      if (sessionStarted || typeof window === 'undefined') return;
      const details: TelemetryDetails['session'] = {
        stable_id: stableId(),
        language: input.language,
        code: input.code,
        ...(input.files ? { files: input.files } : {}),
        layout: input.layout,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          pointer: pointerKind(),
        },
        user_agent: navigator.userAgent,
        timezone_offset_min: -new Date().getTimezoneOffset(),
      };
      if (input.shareId) details.share_id = input.shareId;
      Telemetry.log('session', details);
    });
  }
}

/** Uncaught errors, and retry of anything still buffered. */
export function installTelemetry(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  ensureLoaded();
  if (queue.length) scheduleFlush(FLUSH_MS);
  if (installed) return () => undefined;
  installed = true;
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
