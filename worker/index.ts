/**
 * API for the static IDE. Workers Static Assets serves everything in `out/`; only
 * `/api/*` reaches this Worker (see `run_worker_first` in wrangler.jsonc).
 *
 *   POST /api/share       store an immutable workspace snapshot, returns { id }
 *   GET  /api/share/:id   read one back
 *   POST /api/events      append a batch of telemetry events
 *
 * Everything lands in one R2 bucket:
 *
 *   shares/<id>.json
 *   events/dt=YYYY-MM-DD/HH/<flushed_ms>-<uuid>.ndjson
 *
 * Every R2 write goes through `DataGate` (worker/gate.ts), which enforces a daily write
 * budget and batches telemetry into one object a minute.
 */

import { isShareId, shortId } from '@/lib/share/id';
import { MAX_SHARE_BYTES, parseWorkspaceState } from '@/lib/share/state';
import {
  MAX_EVENT_BYTES,
  TELEMETRY_EVENTS,
  droppedEvent,
  utf8Bytes,
  type TelemetryEnvelope,
} from '@/lib/telemetry/events';

import type { DataGate, GateEnv } from './gate';

export { DataGate } from './gate';

interface Env extends GateEnv {
  GATE: DurableObjectNamespace<DataGate>;
  SHARE_LIMITER: RateLimit;
  SHARE_READ_LIMITER: RateLimit;
  EVENTS_LIMITER: RateLimit;
}

const MAX_EVENTS_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_BATCH = 100;
const SESSION_ID = /^[0-9A-Za-z-]{1,64}$/;
// What the browser's stamp clock produces (microsecond precision, always UTC).
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
// Long enough to take down a share by deleting it, short enough to still save reads.
const SHARE_CACHE_SECONDS = 3600;
const EVENT_NAMES = new Set<string>(TELEMETRY_EVENTS);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fail(status: number, error: string): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  // 503 means a budget or buffer is full; give it a while before trying again.
  if (status === 503) headers['Retry-After'] = '600';
  return json({ error }, status, headers);
}

function gate(env: Env): DurableObjectStub<DataGate> {
  return env.GATE.get(env.GATE.idFromName('global'));
}

/**
 * Only the IDE's own pages may write. Requiring a JSON content type makes any cross-site
 * request need a CORS preflight, which fails because the API never sends CORS headers;
 * the Sec-Fetch-Site and Origin checks reject the rest.
 */
function requireSameOriginJson(request: Request): void {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Expected application/json');

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-site request');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'Cross-site request');
  }
}

async function rateLimit(limiter: RateLimit, request: Request): Promise<void> {
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'Too many requests');
}

/** Read a JSON body without ever buffering more than `maxBytes`. */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'Body too large');
  if (!request.body) throw new HttpError(400, 'Missing body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Body too large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function createShare(request: Request, env: Env): Promise<Response> {
  requireSameOriginJson(request);
  await rateLimit(env.SHARE_LIMITER, request);
  const state = parseWorkspaceState(await readJson(request, MAX_SHARE_BYTES));
  if (!state) throw new HttpError(400, 'Invalid workspace state');

  // ~59 bits per id makes a collision vanishingly rare, but checking is one cheap read.
  let id = shortId();
  while (await env.DATA.head(`shares/${id}.json`)) id = shortId();

  if (!(await gate(env).reserveWrite())) {
    throw new HttpError(503, 'Sharing is paused until tomorrow (UTC)');
  }
  await env.DATA.put(`shares/${id}.json`, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json({ id }, 201, { 'Cache-Control': 'no-store' });
}

async function getShare(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  if (!isShareId(id)) throw new HttpError(404, 'Not found');

  // Shares never change, so a cached copy is always correct until one is taken down.
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  await rateLimit(env.SHARE_READ_LIMITER, request);
  const object = await env.DATA.get(`shares/${id}.json`);
  if (!object) throw new HttpError(404, 'Not found');

  const response = new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${SHARE_CACHE_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function parseEnvelope(value: unknown): TelemetryEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.session_id !== 'string' || !SESSION_ID.test(row.session_id)) return null;
  if (typeof row.timestamp !== 'string' || !TIMESTAMP.test(row.timestamp)) return null;
  if (Number.isNaN(Date.parse(row.timestamp))) return null;
  if (typeof row.event !== 'string' || !EVENT_NAMES.has(row.event)) return null;
  const details = row.details;
  if (details !== null && (typeof details !== 'object' || Array.isArray(details))) return null;
  return {
    session_id: row.session_id,
    timestamp: row.timestamp,
    event: row.event as TelemetryEnvelope['event'],
    details,
  };
}

async function appendEvents(request: Request, env: Env): Promise<Response> {
  requireSameOriginJson(request);
  await rateLimit(env.EVENTS_LIMITER, request);
  const body = await readJson(request, MAX_EVENTS_BYTES);
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_EVENTS_PER_BATCH) {
    throw new HttpError(400, 'Expected 1 to 100 events');
  }

  const receivedAt = new Date().toISOString();
  let ndjson = '';
  let bytes = 0;
  for (const value of body) {
    const event = parseEnvelope(value);
    if (!event) throw new HttpError(400, 'Invalid event');
    let line = JSON.stringify({ ...event, received_at: receivedAt });
    let size = utf8Bytes(line);
    // Keep a record of anything too large to store, rather than rejecting the batch.
    if (size > MAX_EVENT_BYTES) {
      line = JSON.stringify({ ...droppedEvent(event, size), received_at: receivedAt });
      size = utf8Bytes(line);
    }
    ndjson += line + '\n';
    bytes += size + 1;
  }

  if ((await gate(env).bufferEvents(ndjson, bytes)) === 'full') {
    throw new HttpError(503, 'Telemetry is paused; retry later');
  }
  return new Response(null, { status: 204 });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (pathname === '/api/share') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    return createShare(request, env);
  }
  const shareMatch = /^\/api\/share\/([^/]+)$/.exec(pathname);
  if (shareMatch) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return getShare(request, env, ctx, shareMatch[1]!);
  }
  if (pathname === '/api/events') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    return appendEvents(request, env);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      console.error('api error', err);
      return fail(500, 'Internal error');
    }
  },
} satisfies ExportedHandler<Env>;
