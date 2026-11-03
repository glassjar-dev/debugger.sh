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
