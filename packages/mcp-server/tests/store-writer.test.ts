import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StoreWriter } from '../src/store-writer.js';

describe('StoreWriter', () => {
  let tempDir: string;
  let writer: StoreWriter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-store-test-'));
    writer = new StoreWriter(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reads empty array when conversation file does not exist', () => {
    const lines = writer.readAll('nonexistent-conv');
    expect(lines).toEqual([]);
  });

  it('appends messages with incrementing sequence numbers', () => {
    const lines1 = writer.append('conv-1', 'call-1', [
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surf-1', catalogId: 'basic' },
      },
    ]);

    expect(lines1).toHaveLength(1);
    expect(lines1[0].seq).toBe(1);
    expect(lines1[0].callId).toBe('call-1');
    expect(lines1[0].message.createSurface?.surfaceId).toBe('surf-1');

    const lines2 = writer.append('conv-1', 'call-2', [
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'surf-1', path: '/val', value: 42 },
      },
      {
        version: 'v0.9',
        deleteSurface: { surfaceId: 'surf-1' },
      },
    ]);

    expect(lines2).toHaveLength(2);
    expect(lines2[0].seq).toBe(2);
    expect(lines2[1].seq).toBe(3);

    const all = writer.readAll('conv-1');
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('throws on invalid conversation or call identifiers', () => {
    expect(() => writer.append('../traversal', 'call-1', [])).toThrow(/conversationId/);
    expect(() =>
      writer.append('conv-1', '../call', [{ version: 'v0.9', deleteSurface: { surfaceId: 's' } }]),
    ).toThrow(/callId/);
  });

  it('clears conversation files cleanly', () => {
    writer.append('conv-1', 'call-1', [
      { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'basic' } },
    ]);
    expect(writer.readAll('conv-1')).toHaveLength(1);

    writer.clear('conv-1');
    expect(writer.readAll('conv-1')).toHaveLength(0);
  });
});
