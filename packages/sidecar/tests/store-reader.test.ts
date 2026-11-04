import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serializeStoreLine, type A2uiServerMessage } from '@a2ui-pane/protocol';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';
import { knownFromLines, STORE_TOMBSTONE_CALL_ID, StoreReader } from '../src/store-reader.js';

const create = (surfaceId: string, version = '1.0'): A2uiServerMessage => ({
  version,
  createSurface: { surfaceId, catalogId: 'basic' },
});

const update = (surfaceId: string, value: unknown): A2uiServerMessage => ({
  version: '1.0',
  updateDataModel: { surfaceId, path: '/v', value },
});

describe('StoreReader', () => {
  let tmpDir: string;
  let store: SurfaceStore;
  let reader: StoreReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-reader-test-'));
    store = new SurfaceStore(tmpDir);
    reader = new StoreReader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an invalid conversationId', () => {
    expect(() => reader.snapshot('../bad')).toThrow('Invalid conversationId');
    expect(() => reader.diff('../bad', new Map())).toThrow('Invalid conversationId');
  });

  it('returns an empty snapshot and generation 0 for a missing conversation', () => {
    expect(reader.snapshot('conv-none')).toEqual([]);
    expect(reader.generation('conv-none')).toBe(0);
    expect(reader.diff('conv-none', new Map())).toEqual({ lines: [], known: new Map() });
  });

  it('returns one snapshot line per surface sorted by seq', () => {
    store.commit('conv', 'c1', [create('a'), create('b')]);
    store.commit('conv', 'c2', [update('a', 1)]);

    const lines = reader.snapshot('conv');
    expect(lines.map((l) => [l.message.createSurface?.surfaceId, l.seq])).toEqual([
      ['b', 2],
      ['a', 3],
    ]);
    expect(reader.generation('conv')).toBe(3);
    expect(knownFromLines(lines)).toEqual(
      new Map([
        ['b', { seq: 2, version: '1.0' }],
        ['a', { seq: 3, version: '1.0' }],
      ]),
    );
  });

  it('diff emits new surfaces and surfaces with a higher seq only', () => {
    store.commit('conv', 'c1', [create('a'), create('b')]);
    const known = knownFromLines(reader.snapshot('conv'));

    expect(reader.diff('conv', known).lines).toEqual([]);

    store.commit('conv', 'c2', [update('a', 1)]);
    store.commit('conv', 'c3', [create('c')]);
    const result = reader.diff('conv', known);
    expect(result.lines.map((l) => [l.message.createSurface?.surfaceId, l.seq])).toEqual([
      ['a', 3],
      ['c', 4],
    ]);
    expect(result.known.get('a')).toEqual({ seq: 3, version: '1.0' });
    expect(result.known.get('c')).toEqual({ seq: 4, version: '1.0' });
  });

  it('diff emits a tombstone for a surface whose file is gone', () => {
    store.commit('conv', 'c1', [create('a', 'v0.9'), create('b')]);
    const known = knownFromLines(reader.snapshot('conv'));

    store.deleteSurface('conv', 'a', 'call_pane_dismissed_1');
    const result = reader.diff('conv', known);
    expect(result.lines).toEqual([
      {
        seq: 3,
        callId: STORE_TOMBSTONE_CALL_ID,
        ts: expect.any(String),
        message: { version: 'v0.9', deleteSurface: { surfaceId: 'a' } },
      },
    ]);
    expect(result.known.has('a')).toBe(false);
    expect(reader.diff('conv', result.known).lines).toEqual([]);
  });

  it('diff sends a re-created surface with a seq above the tombstone it replaces', () => {
    store.commit('conv', 'c1', [create('a')]);
    const known = knownFromLines(reader.snapshot('conv'));

    store.deleteSurface('conv', 'a', 'call_pane_dismissed_1');
    store.commit('conv', 'c2', [create('a')]);
    const result = reader.diff('conv', known);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].message.createSurface?.surfaceId).toBe('a');
    expect(result.lines[0].seq).toBe(3);
  });

  it('reads _seq before listing the directory', () => {
    store.commit('conv', 'c1', [create('a')]);
    const known = knownFromLines(reader.snapshot('conv'));
    const order: string[] = [];
    const generation = vi.spyOn(reader, 'generation').mockImplementation(() => {
      order.push('generation');
      return 1;
    });
    const snapshot = vi.spyOn(reader, 'snapshot').mockImplementation(() => {
      order.push('snapshot');
      return [];
    });

    const result = reader.diff('conv', known);
    expect(order).toEqual(['generation', 'snapshot']);
    expect(result.lines[0].message.deleteSurface).toEqual({ surfaceId: 'a' });
    generation.mockRestore();
    snapshot.mockRestore();
  });

  it('migrates a legacy flat file on first read', () => {
    const convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const legacy = path.join(convDir, 'conv-legacy.jsonl');
    const lines = [
      { seq: 1, callId: 'c1', ts: 't', message: create('a') },
      { seq: 2, callId: 'c1', ts: 't', message: create('gone') },
      { seq: 3, callId: 'c2', ts: 't', message: update('a', 5) },
      {
        seq: 4,
        callId: 'c3',
        ts: 't',
        message: { version: '1.0', deleteSurface: { surfaceId: 'gone' } },
      },
    ];
    fs.writeFileSync(legacy, lines.map((l) => serializeStoreLine(l)).join('\n') + '\n');

    const snapshot = reader.snapshot('conv-legacy');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].message.createSurface?.surfaceId).toBe('a');
    expect(snapshot[0].message.createSurface?.dataModel).toEqual({ v: 5 });
    expect(reader.generation('conv-legacy')).toBe(4);
    expect(fs.existsSync(`${legacy}.migrated`)).toBe(true);
  });

  it('skips an unparseable surface file', () => {
    store.commit('conv', 'c1', [create('a')]);
    fs.writeFileSync(path.join(tmpDir, 'conversations', 'conv', 'broken.jsonl'), '{nope\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(reader.snapshot('conv').map((l) => l.message.createSurface?.surfaceId)).toEqual(['a']);
    warn.mockRestore();
  });
});
