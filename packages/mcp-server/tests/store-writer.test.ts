import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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

  it('throws error when dataDir is empty', () => {
    expect(() => new StoreWriter('')).toThrow('StoreWriter requires a valid dataDir path');
  });

  it('throws error when conversationId is invalid in getConversationFilePath', () => {
    expect(() => writer.getConversationFilePath('../traversal')).toThrow('Invalid conversationId');
  });

  it('reads empty array when conversation file does not exist', () => {
    const lines = writer.readAll('nonexistent-conv');
    expect(lines).toEqual([]);
  });

  it('appends messages with incrementing sequence numbers and caches seq', () => {
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

    // Second append uses in-memory sequence cache
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

  it('throws on invalid conversation or call identifiers before checking messages', () => {
    expect(() => writer.append('../traversal', 'call-1', [])).toThrow(/conversationId/);
    expect(() =>
      writer.append('conv-1', '../call', [{ version: 'v0.9', deleteSurface: { surfaceId: 's' } }]),
    ).toThrow(/callId/);
    expect(writer.append('conv-1', 'call-valid', [])).toEqual([]);
  });

  it('tolerates and skips an unparseable trailing line from an interrupted write', () => {
    writer.append('conv-partial', 'call-1', [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
      { version: 'v0.9', createSurface: { surfaceId: 's2', catalogId: 'basic' } },
    ]);

    const filePath = writer.getConversationFilePath('conv-partial');
    // Append a truncated/incomplete line mimicking process crash
    writeFileSync(filePath, '{"seq": 3, "callId": "call-interrupted"\n', { flag: 'a' });

    // Should successfully read the 2 valid lines without throwing
    const lines = writer.readAll('conv-partial');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);

    // Next append should correctly continue from seq 2
    const nextLines = writer.append('conv-partial', 'call-2', [
      { version: 'v0.9', deleteSurface: { surfaceId: 's1' } },
    ]);
    expect(nextLines[0].seq).toBe(3);
  });

  it('throws an error if a line in the middle of the store is corrupted', () => {
    const filePath = writer.getConversationFilePath('conv-middle-corrupt');
    writeFileSync(
      filePath,
      '{"seq":1,"callId":"c1","ts":"2026-09-30T00:00:00Z","message":{"version":"v0.9"}}\n' +
        'INVALID_JSON_MIDDLE_LINE\n' +
        '{"seq":2,"callId":"c1","ts":"2026-09-30T00:00:00Z","message":{"version":"v0.9"}}\n',
    );

    expect(() => writer.readAll('conv-middle-corrupt')).toThrow(/Corrupt line at index 1/);
  });

  it('clears conversation files cleanly', () => {
    writer.append('conv-1', 'call-1', [
      { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'basic' } },
    ]);
    expect(writer.readAll('conv-1')).toHaveLength(1);

    writer.clear('conv-1');
    expect(writer.readAll('conv-1')).toHaveLength(0);
  });

  it('handles empty messages array and invalid callId in append', () => {
    expect(writer.append('conv-1', 'call-1', [])).toEqual([]);
    expect(() => writer.append('conv-1', '../bad-call-id', [])).toThrow('Invalid callId');
  });

  it('reads completely empty file and appends from fresh state without cached seq', () => {
    const filePath = writer.getConversationFilePath('conv-empty-file');
    writeFileSync(filePath, '   \n  \n');

    const lines = writer.readAll('conv-empty-file');
    expect(lines).toEqual([]);

    // Appending on a new conversation where lastSeqMap has not been initialized
    const newWriter = new StoreWriter(tempDir);
    const added = newWriter.append('conv-empty-file', 'call-init', [
      { version: 'v0.9', createSurface: { surfaceId: 'surf', catalogId: 'basic' } },
    ]);
    expect(added[0].seq).toBe(1);
  });
});
