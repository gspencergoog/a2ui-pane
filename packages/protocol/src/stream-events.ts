import { StoreLine } from './store.js';

export const STREAM_EVENT_LINE = 'line';
export const STREAM_EVENT_RESET = 'reset';
export const KEEPALIVE_INTERVAL_MS = 15_000;

export type StreamEvent =
  { type: typeof STREAM_EVENT_LINE; line: StoreLine } | { type: typeof STREAM_EVENT_RESET };

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
