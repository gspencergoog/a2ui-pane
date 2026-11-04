import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FoldError, serializeStoreLine, type A2uiServerMessage } from '@a2ui-pane/protocol';
import { StoreWriter } from '../src/store-writer.js';

const create = (surfaceId: string): A2uiServerMessage => ({
  version: '1.0',
  createSurface: {
    surfaceId,
    catalogId: 'basic',
    components: [{ id: 'root', component: 'Text', text: 'hi' }],
  },
});

const update = (surfaceId: string, value: unknown): A2uiServerMessage => ({
  version: '1.0',
  updateDataModel: { surfaceId, path: '/count', value },
});

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

  it('creates the conversations directory', () => {
    expect(existsSync(join(tempDir, 'conversations'))).toBe(true);
  });

  it('rejects an invalid conversationId', () => {
    expect(() => writer.getConversationDir('../traversal')).toThrow('Invalid conversationId');
    expect(() => writer.append('../traversal', 'call-1', [])).toThrow(/conversationId/);
    expect(() => writer.readAll('../traversal')).toThrow(/conversationId/);
  });

  it('rejects an invalid callId and returns [] for an empty batch', () => {
    expect(writer.append('conv-1', 'call-valid', [])).toEqual([]);
    expect(() => writer.append('conv-1', '../call', [create('s')])).toThrow('Invalid callId');
  });

  it('rejects a reserved surface id', () => {
    expect(() => writer.append('conv-1', 'call-1', [create('_seq')])).toThrow(/reserved/);
  });

  it('reads an empty array and generation 0 when the conversation does not exist', () => {
    expect(writer.readAll('nonexistent-conv')).toEqual([]);
    expect(writer.generation('nonexistent-conv')).toBe(0);
  });

  it('compacts every update of a surface into one snapshot line', () => {
    writer.append('conv-1', 'call-0', [create('s1')]);
    for (let i = 1; i <= 20; i++) {
      writer.append('conv-1', `call-${i}`, [update('s1', i)]);
    }

    const all = writer.readAll('conv-1');
    expect(all).toHaveLength(1);
    expect(all[0].seq).toBe(21);
    expect(all[0].callId).toBe('call-20');
    expect(all[0].message.createSurface?.dataModel).toEqual({ count: 20 });

    const file = join(writer.getConversationDir('conv-1'), 's1.jsonl');
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('returns one line per surface sorted by seq and advances the generation', () => {
    const first = writer.append('conv-1', 'call-1', [create('a'), create('b')]);
    expect(first.map((l) => l.seq)).toEqual([1, 2]);
    expect(writer.generation('conv-1')).toBe(2);

    writer.append('conv-1', 'call-2', [update('a', 1)]);
    expect(writer.generation('conv-1')).toBe(3);
    expect(writer.readAll('conv-1').map((l) => l.message.createSurface?.surfaceId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('keeps seqs unique across writer instances sharing one store', () => {
    const writerA = new StoreWriter(tempDir);
    const writerB = new StoreWriter(tempDir);
    writerA.append('conv-shared', 'call-a1', [create('a')]);
    writerB.append('conv-shared', 'call-b1', [create('b')]);
    const last = writerA.append('conv-shared', 'call-a2', [update('a', 1)]);
    expect(last[0].seq).toBe(3);
    expect(writer.generation('conv-shared')).toBe(3);
  });

  it('unlinks a deleted surface and returns a tombstone line', () => {
    writer.append('conv-1', 'call-1', [create('a'), create('b')]);
    const lines = writer.append('conv-1', 'call-2', [
      { version: '1.0', deleteSurface: { surfaceId: 'a' } },
    ]);
    expect(lines).toEqual([
      expect.objectContaining({
        seq: 3,
        message: { version: '1.0', deleteSurface: { surfaceId: 'a' } },
      }),
    ]);
    expect(existsSync(join(writer.getConversationDir('conv-1'), 'a.jsonl'))).toBe(false);
    expect(writer.readAll('conv-1')).toHaveLength(1);
    expect(writer.generation('conv-1')).toBe(3);
  });

  it('throws FoldError for an update to a missing surface and writes nothing', () => {
    expect(() => writer.append('conv-1', 'call-1', [update('missing', 1)])).toThrow(FoldError);
    expect(writer.generation('conv-1')).toBe(0);
  });

  it('skips an unparseable surface file when reading', () => {
    writer.append('conv-1', 'call-1', [create('good')]);
    writeFileSync(join(writer.getConversationDir('conv-1'), 'bad.jsonl'), '{not json\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(writer.readAll('conv-1').map((l) => l.message.createSurface?.surfaceId)).toEqual([
      'good',
    ]);
    warn.mockRestore();
  });

  it('migrates a legacy flat file on first read', () => {
    const legacy = join(tempDir, 'conversations', 'conv-legacy.jsonl');
    const lines = [
      { seq: 1, callId: 'c1', ts: 't', message: create('a') },
      { seq: 2, callId: 'c1', ts: 't', message: create('b') },
      { seq: 3, callId: 'c2', ts: 't', message: update('a', 7) },
      {
        seq: 4,
        callId: 'c3',
        ts: 't',
        message: { version: '1.0', deleteSurface: { surfaceId: 'b' } },
      },
    ];
    writeFileSync(legacy, lines.map((l) => serializeStoreLine(l)).join('\n') + '\n');

    const all = writer.readAll('conv-legacy');
    expect(all).toHaveLength(1);
    expect(all[0].message.createSurface?.surfaceId).toBe('a');
    expect(all[0].message.createSurface?.dataModel).toEqual({ count: 7 });
    expect(writer.generation('conv-legacy')).toBe(4);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
  });

  it('clear removes the directory and the legacy and migrated files', () => {
    writer.append('conv-1', 'call-1', [create('a')]);
    const legacy = join(tempDir, 'conversations', 'conv-1.jsonl');
    writeFileSync(legacy, '');
    writeFileSync(`${legacy}.migrated`, '');
    mkdirSync(join(writer.getConversationDir('conv-1'), 'nested'), { recursive: true });

    writer.clear('conv-1');
    expect(existsSync(writer.getConversationDir('conv-1'))).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(false);
    expect(writer.readAll('conv-1')).toEqual([]);
    expect(() => writer.clear('conv-never')).not.toThrow();
  });
});
