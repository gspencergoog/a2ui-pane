import { describe, it, expect } from 'vitest';
import {
  formatSseEvent,
  formatSseKeepalive,
  STREAM_EVENT_LINE,
  STREAM_EVENT_RESET,
  StreamEvent,
} from './stream-events.js';
import { StoreLine } from './store.js';

describe('SSE framing and events', () => {
  const sampleLine: StoreLine = {
    seq: 42,
    callId: 'call_1',
    ts: '2026-09-30T20:00:00.000Z',
    message: {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'surf',
        path: '/count',
        value: 5,
      },
    },
  };

  it('formats line event with id', () => {
    const event: StreamEvent = { type: STREAM_EVENT_LINE, line: sampleLine };
    const frame = formatSseEvent(event, 42);
    expect(frame).toBe(`event: line\nid: 42\ndata: ${JSON.stringify(sampleLine)}\n\n`);
  });

  it('formats reset event without id', () => {
    const event: StreamEvent = { type: STREAM_EVENT_RESET };
    const frame = formatSseEvent(event);
    expect(frame).toBe('event: reset\ndata: {}\n\n');
  });

  it('formats keepalive comment', () => {
    expect(formatSseKeepalive()).toBe(': keepalive\n\n');
  });
});
