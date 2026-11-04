import { describe, it, expect } from 'vitest';
import {
  formatSseEvent,
  formatSseKeepalive,
  STREAM_EVENT_LINE,
  STREAM_EVENT_RESET,
  STREAM_EVENT_SNAPSHOT,
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

  it('formats snapshot event with all lines in one data frame', () => {
    const second: StoreLine = { ...sampleLine, seq: 43 };
    const event: StreamEvent = { type: STREAM_EVENT_SNAPSHOT, lines: [sampleLine, second] };
    const frame = formatSseEvent(event, 43);
    expect(frame).toBe(
      `event: snapshot\nid: 43\ndata: ${JSON.stringify({ lines: [sampleLine, second] })}\n\n`,
    );
    const data = JSON.parse(frame.split('\n')[2].slice('data: '.length));
    expect(data.lines.map((l: StoreLine) => l.seq)).toEqual([42, 43]);
  });

  it('formats an empty snapshot event', () => {
    const frame = formatSseEvent({ type: STREAM_EVENT_SNAPSHOT, lines: [] });
    expect(frame).toBe('event: snapshot\ndata: {"lines":[]}\n\n');
  });

  it('formats keepalive comment', () => {
    expect(formatSseKeepalive()).toBe(': keepalive\n\n');
  });
});
