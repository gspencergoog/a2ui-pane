import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StoreReader } from '../src/store-reader.js';
import { serializeStoreLine, StoreLine } from '@a2ui-pane/protocol';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StoreReader', () => {
  let tmpDir: string;
  let convDir: string;
  let reader: StoreReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-reader-test-'));
    convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    reader = new StoreReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty lines when conversation file does not exist', () => {
    const result = reader.read('missing_conv', 0);
    expect(result).toEqual({ lines: [], reset: false });
  });

  it('rejects invalid conversationId with directory traversal', () => {
    expect(() => reader.read('../bad_id')).toThrow('Invalid conversationId');
    expect(() => reader.read('bad/slash')).toThrow('Invalid conversationId');
  });

  it('reads lines incrementally and filters by afterSeq', () => {
    const convId = 'conv_incremental';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: {
        version: 'v0.9',
        createSurface: { surfaceId: 's1', catalogId: 'basic' },
      },
    };
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: {
        version: 'v0.9',
        updateDataModel: { surfaceId: 's1', path: '/x', value: 10 },
      },
    };

    fs.writeFileSync(filePath, serializeStoreLine(line1) + '\n' + serializeStoreLine(line2) + '\n');

    // Initial read
    const res1 = reader.read(convId, 0);
    expect(res1.reset).toBe(false);
    expect(res1.lines).toHaveLength(2);
    expect(res1.lines[0].seq).toBe(1);
    expect(res1.lines[1].seq).toBe(2);

    // Read with afterSeq = 1
    const res2 = reader.read(convId, 1);
    expect(res2.lines).toHaveLength(1);
    expect(res2.lines[0].seq).toBe(2);

    // Append line 3
    const line3: StoreLine = {
      seq: 3,
      ts: new Date().toISOString(),
      callId: 'c2',
      message: {
        version: 'v0.9',
        updateDataModel: { surfaceId: 's1', path: '/x', value: 20 },
      },
    };
    fs.appendFileSync(filePath, serializeStoreLine(line3) + '\n');

    // Read again with afterSeq = 2
    const res3 = reader.read(convId, 2);
    expect(res3.lines).toHaveLength(1);
    expect(res3.lines[0].seq).toBe(3);
  });

  it('holds back partial trailing line until subsequent read with newline', () => {
    const convId = 'conv_partial';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9' },
    };
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c2',
      message: { version: 'v0.9' },
    };

    const line1Json = serializeStoreLine(line1);
    const line2Json = serializeStoreLine(line2);

    // Write line 1 in full, but only half of line 2 without trailing newline
    const halfLine2 = line2Json.slice(0, 25);
    fs.writeFileSync(filePath, `${line1Json}\n${halfLine2}`);

    const res1 = reader.read(convId, 0);
    // Line 1 should be parsed, partial line 2 is buffered
    expect(res1.lines).toHaveLength(1);
    expect(res1.lines[0].seq).toBe(1);

    // Now append the rest of line 2 with newline
    const restLine2 = line2Json.slice(25);
    fs.appendFileSync(filePath, `${restLine2}\n`);

    const res2 = reader.read(convId, 1);
    expect(res2.lines).toHaveLength(1);
    expect(res2.lines[0].seq).toBe(2);
  });

  it('detects file truncation and triggers reset: true', () => {
    const convId = 'conv_truncate';
    const filePath = path.join(convDir, `${convId}.jsonl`);

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9' },
    };
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c2',
      message: { version: 'v0.9' },
    };

    fs.writeFileSync(filePath, serializeStoreLine(line1) + '\n' + serializeStoreLine(line2) + '\n');

    const res1 = reader.read(convId, 0);
    expect(res1.lines).toHaveLength(2);
    expect(res1.reset).toBe(false);

    // Truncate file and write a brand new line 1
    const newLine1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c_reset',
      message: { version: 'v0.9', createSurface: { surfaceId: 'fresh', catalogId: 'basic' } },
    };
    fs.writeFileSync(filePath, serializeStoreLine(newLine1) + '\n');

    const res2 = reader.read(convId, 0);
    expect(res2.reset).toBe(true);
    expect(res2.lines).toHaveLength(1);
    expect((res2.lines[0].message as any).createSurface?.surfaceId).toBe('fresh');
  });

  it('skips corrupt lines with warning and parses subsequent valid lines', () => {
    const convId = 'conv_corrupt';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const line1: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'c1',
      message: { version: 'v0.9' },
    };
    const line2: StoreLine = {
      seq: 2,
      ts: new Date().toISOString(),
      callId: 'c2',
      message: { version: 'v0.9' },
    };

    fs.writeFileSync(
      filePath,
      serializeStoreLine(line1) + '\n{bad json}\n' + serializeStoreLine(line2) + '\n',
    );

    const res = reader.read(convId, 0);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0].seq).toBe(1);
    expect(res.lines[1].seq).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clears conversation state', () => {
    const convId = 'conv_clear';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, '');
    reader.read(convId);
    expect(() => reader.clear(convId)).not.toThrow();
  });

  it('handles chunk with no newline at all by buffering into partialBuffer', () => {
    const convId = 'conv_no_newline';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, 'partial-without-newline');
    const res = reader.read(convId, 0);
    expect(res.lines).toHaveLength(0);
  });

  it('handles statSync or openSync error safely', () => {
    const convId = 'conv_stat_err';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, 'data\n');

    const originalStat = fs.statSync;
    (fs as any).statSync = (p: string) => {
      if (p === filePath) throw new Error('EACCES');
      return originalStat(p);
    };
    expect(reader.read(convId, 0)).toEqual({ lines: [], reset: false });
    fs.statSync = originalStat;

    const originalOpen = fs.openSync;
    (fs as any).openSync = (p: string) => {
      if (p === filePath) throw new Error('EBADF');
      return originalOpen(p);
    };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(reader.read(convId, 0)).toEqual({ lines: [], reset: false });
    fs.openSync = originalOpen;
    consoleSpy.mockRestore();
  });
});
