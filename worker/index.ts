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
 *   events/dt=YYYY-MM-DD/HH/<received_ms>-<uuid>.ndjson
 */

import { isShareId, shortId } from '@/lib/share/id';
import { parseWorkspaceState } from '@/lib/share/state';
import { TELEMETRY_EVENTS, type TelemetryEnvelope } from '@/lib/telemetry/events';

interface Env {
  DATA: R2Bucket;
  SHARE_LIMITER: RateLimit;
  EVENTS_LIMITER: RateLimit;
}

const MAX_SHARE_BYTES = 128 * 1024;
const MAX_EVENTS_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_EVENT_BYTES = 256 * 1024;
const SESSION_ID = /^[0-9A-Za-z-]{1,64}$/;
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
  return json({ error }, status, { 'Cache-Control': 'no-store' });
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
  await rateLimit(env.SHARE_LIMITER, request);
  const state = parseWorkspaceState(await readJson(request, MAX_SHARE_BYTES));
  if (!state) throw new HttpError(400, 'Invalid workspace state');

  // ~59 bits per id makes a collision vanishingly rare, but checking is one cheap read.
  let id = shortId();
  while (await env.DATA.head(`shares/${id}.json`)) id = shortId();

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

  // Shares never change, so a cached copy is always correct.
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const object = await env.DATA.get(`shares/${id}.json`);
  if (!object) throw new HttpError(404, 'Not found');

  const response = new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function parseEnvelope(value: unknown): TelemetryEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.session_id !== 'string' || !SESSION_ID.test(row.session_id)) return null;
  if (typeof row.timestamp !== 'string' || Number.isNaN(Date.parse(row.timestamp))) return null;
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
  await rateLimit(env.EVENTS_LIMITER, request);
  const body = await readJson(request, MAX_EVENTS_BYTES);
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_EVENTS_PER_BATCH) {
    throw new HttpError(400, 'Expected 1 to 100 events');
  }

  const received = new Date();
  const receivedAt = received.toISOString();
  const lines: string[] = [];
  for (const value of body) {
    const event = parseEnvelope(value);
    if (!event) throw new HttpError(400, 'Invalid event');
    const line = JSON.stringify({ ...event, received_at: receivedAt });
    if (line.length > MAX_EVENT_BYTES) throw new HttpError(413, 'Event too large');
    lines.push(line);
  }

  const day = receivedAt.slice(0, 10);
  const hour = receivedAt.slice(11, 13);
  const key = `events/dt=${day}/${hour}/${received.getTime()}-${crypto.randomUUID()}.ndjson`;
  await env.DATA.put(key, lines.join('\n') + '\n', {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });
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
