import type { TelemetryEvent } from './types';

/**
 * Every event name the Worker accepts. Shared by the browser and the Worker, so it must
 * stay free of DOM and React imports.
 */
export const TELEMETRY_EVENTS = [
  'session',
  'edit',
  'run_start',
  'run_io',
  'run_stop',
  'debug_breakpoint',
  'debug_stop',
  'debug_step',
  'debug_frame',
  'debug_variable',
  'share',
  'layout_changed',
  'error',
  'telemetry_dropped',
] as const satisfies readonly TelemetryEvent[];

// Fails to compile when an event is added to `TelemetryDetails` but not listed above.
type Missing = Exclude<TelemetryEvent, (typeof TELEMETRY_EVENTS)[number]>;
const _exhaustive: [Missing] extends [never] ? true : Missing = true;
void _exhaustive;

/** Envelope the browser queues and the Worker stores, one per event. */
export type TelemetryEnvelope = {
  session_id: string;
  timestamp: string;
  event: TelemetryEvent;
  details: unknown;
};

/** Largest event the Worker stores, as one JSON line in UTF-8 bytes. */
export const MAX_EVENT_BYTES = 256 * 1024;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The marker stored in place of an event that is too large to keep. */
export function droppedEvent(event: TelemetryEnvelope, bytes: number): TelemetryEnvelope {
  return {
    session_id: event.session_id,
    timestamp: event.timestamp,
    event: 'telemetry_dropped',
    details: { reason: 'too_large', event: event.event, bytes },
  };
}
