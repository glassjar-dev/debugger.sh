/**
 * The only writer to R2 besides wrangler. One instance (`idFromName('global')`) keeps a
 * per-UTC-day write budget, so R2 Class A operations have a hard ceiling no matter how
 * much traffic the API gets, and buffers telemetry so it lands as one object per minute
 * instead of one per client request.
 *
 * Runs on the Workers Free plan: SQLite-backed Durable Objects are included there.
 */

import { DurableObject } from 'cloudflare:workers';

export interface GateEnv {
  DATA: R2Bucket;
  /** Max R2 writes per UTC day, shares and telemetry flushes together. */
  R2_DAILY_WRITE_LIMIT?: string;
}

const DEFAULT_DAILY_WRITES = 30_000;
const FLUSH_DELAY_MS = 60_000;
/** Flush early once this much telemetry is waiting. */
const FLUSH_AT_BYTES = 8 * 1024 * 1024;
/** Most telemetry written to a single R2 object. */
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
/** Refuse new telemetry past this; clients keep it and retry. */
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const RETRY_DELAY_MS = 30_000;

export type BufferResult = 'buffered' | 'full';

function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function nextUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
}

export class DataGate extends DurableObject<GateEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: GateEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, writes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bytes INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  private dailyLimit(): number {
    const parsed = Number(this.env.R2_DAILY_WRITE_LIMIT);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_WRITES;
  }

  /** Take one write from today's budget. False means R2 is closed until midnight UTC. */
  reserveWrite(): boolean {
    const day = utcDay();
    const row = this.sql
      .exec<{ writes: number }>('SELECT writes FROM budget WHERE day = ?', day)
      .toArray()[0];
    const used = row?.writes ?? 0;
    if (used >= this.dailyLimit()) return false;
    this.sql.exec(
      'INSERT INTO budget (day, writes) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET writes = writes + 1',
      day,
    );
    // Yesterday's count is never read again.
    this.sql.exec('DELETE FROM budget WHERE day < ?', day);
    return true;
  }

  private pendingBytes(): number {
    return this.sql.exec<{ total: number | null }>('SELECT SUM(bytes) AS total FROM pending').one()
      .total ?? 0;
  }

  /** Queue newline-terminated NDJSON for the next flush. */
  async bufferEvents(ndjson: string, bytes: number): Promise<BufferResult> {
    const waiting = this.pendingBytes();
    if (waiting + bytes > MAX_PENDING_BYTES) return 'full';
    this.sql.exec('INSERT INTO pending (bytes, body) VALUES (?, ?)', bytes, ndjson);

    const due = waiting + bytes >= FLUSH_AT_BYTES ? Date.now() : Date.now() + FLUSH_DELAY_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > due) await this.ctx.storage.setAlarm(due);
    return 'buffered';
  }

  async alarm(): Promise<void> {
    const rows = this.sql
      .exec<{ id: number; bytes: number; body: string }>(
        'SELECT id, bytes, body FROM pending ORDER BY id',
      )
      .toArray();
    if (rows.length === 0) return;

    if (!this.reserveWrite()) {
      await this.ctx.storage.setAlarm(nextUtcMidnight());
      return;
    }

    // Oldest rows first, up to one object's worth. A single row is never split.
    let size = 0;
    let lastId = rows[0]!.id;
    const parts: string[] = [];
    for (const row of rows) {
      if (parts.length > 0 && size + row.bytes > MAX_OBJECT_BYTES) break;
      parts.push(row.body);
      size += row.bytes;
      lastId = row.id;
    }

    const now = new Date();
    const stamp = now.toISOString();
    const key = `events/dt=${stamp.slice(0, 10)}/${stamp.slice(11, 13)}/${now.getTime()}-${crypto.randomUUID()}.ndjson`;
    try {
      await this.env.DATA.put(key, parts.join(''), {
        httpMetadata: { contentType: 'application/x-ndjson' },
      });
    } catch (err) {
      console.error('telemetry flush failed', err);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      return;
    }

    this.sql.exec('DELETE FROM pending WHERE id <= ?', lastId);
    if (rows.length > parts.length) await this.ctx.storage.setAlarm(Date.now());
  }
}
