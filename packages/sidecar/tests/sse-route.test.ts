import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleStream } from '../src/sse-route.js';
import { StoreReader } from '../src/store-reader.js';
import { ChangeNotifier } from '../src/change-notifier.js';
import type { A2uiServerMessage, StoreLine } from '@a2ui-pane/protocol';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createMockSseResponse() {
  const chunks: string[] = [];
  let statusCode = 200;
  const headers: Record<string, string> = {};

  const res: any = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    write(data: string) {
      chunks.push(data);
      return true;
    },
    end() {},
  };

  return {
    res,
    getOutput: () => ({
      statusCode,
      headers,
      chunks,
      body: chunks.join(''),
    }),
  };
}

interface ParsedEvent {
  event: string;
  id?: string;
  data: any;
}

function parseEvents(chunks: string[]): ParsedEvent[] {
  return chunks
    .filter((c) => c.startsWith('event:'))
    .map((chunk) => {
      const fields = Object.fromEntries(
        chunk
          .trim()
          .split('\n')
          .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
      );
      return { event: fields.event, id: fields.id, data: JSON.parse(fields.data) };
    });
}

const create = (surfaceId: string): A2uiServerMessage => ({
  version: '1.0',
  createSurface: { surfaceId, catalogId: 'basic' },
});

describe('handleStream', () => {
  let tmpDir: string;
  let store: SurfaceStore;
  let storeReader: StoreReader;
  let notifier: ChangeNotifier;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-route-test-'));
    store = new SurfaceStore(tmpDir);
    storeReader = new StoreReader(tmpDir);
    notifier = new ChangeNotifier(tmpDir, 50);
  });

  afterEach(() => {
    notifier.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const connect = (convId: string, headers: Record<string, string> = {}) => {
    const req: any = new EventEmitter();
    req.headers = headers;
    const mock = createMockSseResponse();
    handleStream(req, mock.res, convId, storeReader, notifier, { keepaliveIntervalMs: 1000 });
    return { req, ...mock };
  };

  it('sends one snapshot on connect, ignores Last-Event-ID, and emits keepalive', () => {
    vi.useFakeTimers();
    store.commit('conv_sse', 'c1', [create('s1'), create('s2')]);

    const { req, getOutput } = connect('conv_sse', { 'last-event-id': '99' });

    const out = getOutput();
    expect(out.statusCode).toBe(200);
    expect(out.headers['Content-Type']).toBe('text/event-stream');
    const events = parseEvents(out.chunks);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('snapshot');
    expect(events[0].data.lines.map((l: StoreLine) => l.seq)).toEqual([1, 2]);

    vi.advanceTimersByTime(1000);
    expect(getOutput().body).toContain(': keepalive');

    req.emit('close');
    vi.useRealTimers();
  });

  it('sends an empty snapshot for a conversation with no surfaces', () => {
    const { req, getOutput } = connect('conv_empty');
    expect(parseEvents(getOutput().chunks)).toEqual([
      { event: 'snapshot', id: undefined, data: { lines: [] } },
    ]);
    req.emit('close');
  });

  it('streams the live diff after a replace and a delete tombstone', () => {
    store.commit('conv_live', 'c1', [create('a'), create('b')]);
    const { req, getOutput } = connect('conv_live');

    store.commit('conv_live', 'c2', [
      { version: '1.0', updateDataModel: { surfaceId: 'a', path: '/x', value: 1 } },
    ]);
    (notifier as any).notify('conv_live');

    let events = parseEvents(getOutput().chunks);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ event: 'line', id: '3' });
    expect(events[1].data.message.createSurface.dataModel).toEqual({ x: 1 });

    // A tick with no change sends nothing.
    (notifier as any).notify('conv_live');
    expect(parseEvents(getOutput().chunks)).toHaveLength(2);

    store.deleteSurface('conv_live', 'b', 'call_pane_dismissed_1');
    (notifier as any).notify('conv_live');
    events = parseEvents(getOutput().chunks);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ event: 'line', id: '4' });
    expect(events[2].data.message).toEqual({ version: '1.0', deleteSurface: { surfaceId: 'b' } });

    req.emit('close');
  });

  it('subscribes before taking the snapshot', () => {
    const order: string[] = [];
    const subscribe = vi.spyOn(notifier, 'subscribe').mockImplementation(() => {
      order.push('subscribe');
      return () => {};
    });
    const snapshot = vi.spyOn(storeReader, 'snapshot').mockImplementation(() => {
      order.push('snapshot');
      return [];
    });

    const { req } = connect('conv_order');
    expect(order).toEqual(['subscribe', 'snapshot']);
    req.emit('close');
    subscribe.mockRestore();
    snapshot.mockRestore();
  });

  it('does not resend a write that landed between subscribe and snapshot', () => {
    const realSubscribe = notifier.subscribe.bind(notifier);
    vi.spyOn(notifier, 'subscribe').mockImplementation((convId, cb) => {
      const unsubscribe = realSubscribe(convId, cb);
      store.commit(convId, 'c-race', [create('raced')]);
      return unsubscribe;
    });

    const { req, getOutput } = connect('conv_race');
    (notifier as any).notify('conv_race');

    const events = parseEvents(getOutput().chunks);
    expect(events).toHaveLength(1);
    expect(events[0].data.lines[0].message.createSurface.surfaceId).toBe('raced');
    req.emit('close');
  });

  it('falls back to the first diff when the snapshot read fails', () => {
    store.commit('conv_fail', 'c1', [create('a')]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const snapshot = vi.spyOn(storeReader, 'snapshot').mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    const { req, getOutput } = connect('conv_fail');
    expect(parseEvents(getOutput().chunks)).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error reading snapshot'),
      expect.anything(),
    );

    (notifier as any).notify('conv_fail');
    const events = parseEvents(getOutput().chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'line', id: '1' });

    req.emit('close');
    snapshot.mockRestore();
    errSpy.mockRestore();
  });

  it('safely handles write errors in the keepalive timer and the notifier tick', () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req: any = new EventEmitter();
    req.headers = {};
    const { res } = createMockSseResponse();
    res.write = vi.fn().mockImplementation(() => {
      throw new Error('Socket write failure');
    });

    handleStream(req, res, 'conv_write_err', storeReader, notifier, { keepaliveIntervalMs: 50 });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();

    store.commit('conv_write_err', 'c1', [create('a')]);
    expect(() => (notifier as any).notify('conv_write_err')).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error processing update'),
      expect.anything(),
    );

    req.emit('close');
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('unsubscribes on close', () => {
    const { req } = connect('conv_close');
    expect((notifier as any).listeners.has('conv_close')).toBe(true);
    req.emit('close');
    expect((notifier as any).listeners.has('conv_close')).toBe(false);
  });
});
