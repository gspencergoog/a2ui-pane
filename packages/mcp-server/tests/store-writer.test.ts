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

  it('keeps seq monotonic when two writers append to the same conversation file', () => {
    const msg = (id: string) => ({
      version: 'v0.9' as const,
      createSurface: { surfaceId: id, catalogId: 'basic' },
    });
    const writerA = new StoreWriter(tempDir);
    const writerB = new StoreWriter(tempDir);

    writerA.append('conv-shared', 'call-a1', [msg('a1'), msg('a2'), msg('a3')]);
    writerB.append('conv-shared', 'call-b1', [msg('b1'), msg('b2')]);
    const last = writerA.append('conv-shared', 'call-a2', [msg('a4')]);

    expect(last[0].seq).toBe(6);
    const all = writer.readAll('conv-shared');
    expect(all.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(all.map((l) => l.seq)).size).toBe(6);
  });

  it('resumes from the last complete record when the tail ends in a truncated line', () => {
    writer.append('conv-tail', 'call-1', [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
      { version: 'v0.9', createSurface: { surfaceId: 's2', catalogId: 'basic' } },
    ]);
    const filePath = writer.getConversationFilePath('conv-tail');
    writeFileSync(filePath, '{"seq":3,"callId":"call-interrupted","ts":"2026', { flag: 'a' });

    const fresh = new StoreWriter(tempDir);
    const next = fresh.append('conv-tail', 'call-2', [
      { version: 'v0.9', deleteSurface: { surfaceId: 's1' } },
    ]);
    expect(next[0].seq).toBe(3);
  });

  it('never goes backwards when the file is replaced by a shorter one', () => {
    writer.append('conv-floor', 'call-1', [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
      { version: 'v0.9', createSurface: { surfaceId: 's2', catalogId: 'basic' } },
    ]);
    const filePath = writer.getConversationFilePath('conv-floor');
    writeFileSync(
      filePath,
      '{"seq":1,"callId":"c1","ts":"2026-09-30T00:00:00Z","message":{"version":"v0.9"}}\n',
    );

    const next = writer.append('conv-floor', 'call-2', [
      { version: 'v0.9', deleteSurface: { surfaceId: 's1' } },
    ]);
    expect(next[0].seq).toBe(3);
  });

  it('reads the last seq from the tail of a file larger than the tail window', () => {
    const filePath = writer.getConversationFilePath('conv-large');
    const padding = 'x'.repeat(2048);
    let content = '';
    for (let seq = 1; seq <= 200; seq++) {
      content += `{"seq":${seq},"callId":"c1","ts":"2026-09-30T00:00:00Z","message":{"version":"v0.9","updateDataModel":{"surfaceId":"s","path":"/p","value":"${padding}"}}}\n`;
    }
    writeFileSync(filePath, content);
    expect(content.length).toBeGreaterThan(64 * 1024);

    const next = writer.append('conv-large', 'call-2', [
      { version: 'v0.9', deleteSurface: { surfaceId: 's' } },
    ]);
    expect(next[0].seq).toBe(201);
  });
});
