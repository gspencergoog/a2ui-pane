import { StoreLine } from './store.js';

/** SSE event type emitted when a new JSONL store line arrives. */
export const STREAM_EVENT_LINE = 'line';

/**
 * SSE event type emitted when the store file is truncated or replaced.
 *
 * The sidecar no longer sends it. It is kept for one release so that a pane
 * built before the per-surface store layout still handles it by reconnecting.
 */
export const STREAM_EVENT_RESET = 'reset';

/**
 * SSE event type carrying the complete current set of live surfaces, one
 * `StoreLine` per surface, sorted by seq. Sent once when a stream connects.
 */
export const STREAM_EVENT_SNAPSHOT = 'snapshot';

/** Interval in milliseconds between SSE keepalive comment frames. */
export const KEEPALIVE_INTERVAL_MS = 15_000;

/** Discriminated union of Server-Sent Events emitted by `/api/stream`. */
export type StreamEvent =
  | { type: typeof STREAM_EVENT_LINE; line: StoreLine }
  | { type: typeof STREAM_EVENT_SNAPSHOT; lines: StoreLine[] }
  | { type: typeof STREAM_EVENT_RESET };

/**
 * Formats a single SSE frame according to the W3C EventSource standard.
 */
export function formatSseEvent(event: StreamEvent, id?: number | string): string {
  let output = `event: ${event.type}\n`;
  if (id !== undefined && id !== null) {
    output += `id: ${id}\n`;
  }
  if (event.type === STREAM_EVENT_LINE) {
    output += `data: ${JSON.stringify(event.line)}\n\n`;
  } else if (event.type === STREAM_EVENT_SNAPSHOT) {
    output += `data: ${JSON.stringify({ lines: event.lines })}\n\n`;
  } else {
    output += `data: {}\n\n`;
  }
  return output;
}

/**
 * Formats a keepalive SSE comment line.
 */
export function formatSseKeepalive(): string {
  return ': keepalive\n\n';
}
