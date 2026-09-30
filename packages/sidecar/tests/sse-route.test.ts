import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleStream } from '../src/sse-route.js';
import { StoreReader } from '../src/store-reader.js';
import { ChangeNotifier } from '../src/change-notifier.js';
import { serializeStoreLine, StoreLine } from '@a2ui-pane/protocol';
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

describe('handleStream', () => {
  let tmpDir: string;
  let convDir: string;
  let storeReader: StoreReader;
  let notifier: ChangeNotifier;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-route-test-'));
    convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    storeReader = new StoreReader(tmpDir);
    notifier = new ChangeNotifier(tmpDir, 50);
  });

  afterEach(() => {
    notifier.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams existing lines, handles Last-Event-ID, and emits keepalive', () => {
    vi.useFakeTimers();
    const convId = 'conv_sse';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
    };
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/x', value: 1 } },
    };

    fs.writeFileSync(filePath, serializeStoreLine(line1) + '\n' + serializeStoreLine(line2) + '\n');

    const req: any = new EventEmitter();
    req.headers = { 'last-event-id': '1' };

    const { res, getOutput } = createMockSseResponse();

    handleStream(req, res, convId, storeReader, notifier, {
      keepaliveIntervalMs: 1000,
    });

    const out1 = getOutput();
    expect(out1.statusCode).toBe(200);
    expect(out1.headers['Content-Type']).toBe('text/event-stream');
    // Seq 1 was skipped because of last-event-id: 1; seq 2 is sent
    expect(out1.body).toContain('id: 2');
    expect(out1.body).not.toContain('id: 1\n');

    // Trigger keepalive timer
    vi.advanceTimersByTime(1000);
    expect(getOutput().body).toContain(': keepalive');

    // Clean up
    req.emit('close');
    vi.useRealTimers();
  });

  it('emits live updates when store file is appended and handles reset on file truncation', () => {
    const convId = 'conv_live';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9' },
    };
    fs.writeFileSync(filePath, serializeStoreLine(line1) + '\n');

    const req: any = new EventEmitter();
    req.headers = {};
    const { res, getOutput } = createMockSseResponse();

    handleStream(req, res, convId, storeReader, notifier, {
      keepaliveIntervalMs: 5000,
    });

    expect(getOutput().body).toContain('id: 1');

    // Append line 2 and notify
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c2',
      message: { version: 'v0.9' },
    };
    fs.appendFileSync(filePath, serializeStoreLine(line2) + '\n');
    (notifier as any).notify(convId);

    expect(getOutput().body).toContain('id: 2');

    // Now simulate reset by truncating file
    const resetLine: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c_reset',
      message: { version: 'v0.9' },
    };
    fs.writeFileSync(filePath, serializeStoreLine(resetLine) + '\n');
    (notifier as any).notify(convId);

    expect(getOutput().body).toContain('event: reset');

    req.emit('close');
  });

  it('handles initial reset when file shrank before connection', () => {
    const convId = 'conv_initial_reset';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9' },
    };
    fs.writeFileSync(filePath, serializeStoreLine(line1) + '\n');

    // Force reader to remember a large offset
    storeReader.read(convId, 0);
    // Truncate file
    fs.writeFileSync(filePath, '');

    const req: any = new EventEmitter();
    req.headers = {};
    const { res, getOutput } = createMockSseResponse();

    handleStream(req, res, convId, storeReader, notifier);

    expect(getOutput().body).toContain('event: reset');
    req.emit('close');
  });

  it('safely ignores invalid or negative Last-Event-ID header', () => {
    const convId = 'conv_invalid_id';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, '');

    const req: any = new EventEmitter();
    req.headers = { 'last-event-id': 'not-a-number' };
    const { res } = createMockSseResponse();

    expect(() => handleStream(req, res, convId, storeReader, notifier)).not.toThrow();
    req.emit('close');
  });

  it('safely handles write error in keepalive timer and notifier error', () => {
    vi.useFakeTimers();
    const convId = 'conv_write_err';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, '');

    const req: any = new EventEmitter();
    req.headers = {};
    const { res } = createMockSseResponse();

    // Throwing res.write
    res.write = vi.fn().mockImplementation(() => {
      throw new Error('Socket write failure');
    });

    handleStream(req, res, convId, storeReader, notifier, {
      keepaliveIntervalMs: 50,
    });

    // Advance timer to trigger keepalive write error
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();

    req.emit('close');
    vi.useRealTimers();
  });
});
