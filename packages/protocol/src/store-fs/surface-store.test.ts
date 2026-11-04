import { fork } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2uiServerMessage, StoreLine } from '../store.js';
import { FoldError } from '../surface-fold.js';
import {
  conversationDir,
  isStorableSurfaceId,
  legacyFile,
  migratedFile,
  migrateLegacyStore,
  seqFile,
  StoreLockError,
  surfaceFile,
  SurfaceStore,
  withConversationLock,
  withConversationLockAsync,
} from './index.js';

const CONV = 'conv-1';
const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'testing', 'store-worker.ts');
const VITE_NODE = join(
  dirname(createRequire(import.meta.url).resolve('vite-node/package.json')),
  'vite-node.mjs',
);

function create(surfaceId: string, dataModel?: unknown, version = '1.0'): A2uiServerMessage {
  return {
    version,
    createSurface: {
      surfaceId,
      catalogId: CATALOG,
      components: [{ id: 'root', component: 'Text', text: { path: '/n' } }],
      ...(dataModel === undefined ? {} : { dataModel }),
    },
  };
}

function update(surfaceId: string, path: string, value: unknown): A2uiServerMessage {
  return { version: '1.0', updateDataModel: { surfaceId, path, value } };
}

function del(surfaceId: string): A2uiServerMessage {
  return { version: '1.0', deleteSurface: { surfaceId } };
}

function fileLines(path: string): string[] {
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

function makeStale(path: string): void {
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
}

function runWorker(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = fork(VITE_NODE, [WORKER, ...args], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let result: unknown;
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('message', (m) => (result = m));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 && result ? resolve(result) : reject(new Error(`worker exit ${code}: ${stderr}`)),
    );
  });
}

describe('SurfaceStore', () => {
  let dataDir: string;
  let store: SurfaceStore;
  let dir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'surface-store-'));
    store = new SurfaceStore(dataDir);
    dir = conversationDir(dataDir, CONV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('commit', () => {
    it('compacts 20 updates into one line', () => {
      store.commit(CONV, 'call_0', [create('s1', { n: 0 })]);
      for (let i = 1; i <= 20; i++) {
        store.commit(CONV, `call_${i}`, [update('s1', '/n', i)]);
      }
      const lines = fileLines(surfaceFile(dataDir, CONV, 's1'));
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]) as StoreLine;
      expect(line.seq).toBe(21);
      expect(line.callId).toBe('call_20');
      expect(line.message.createSurface!.dataModel).toEqual({ n: 20 });
      expect(store.generation(CONV)).toBe(21);
      expect(readFileSync(seqFile(dataDir, CONV), 'utf-8')).toBe('21\n');
    });

    it('creates the directory and files with private modes', () => {
      store.commit(CONV, 'call_0', [create('s1')]);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(surfaceFile(dataDir, CONV, 's1')).mode & 0o777).toBe(0o600);
      expect(statSync(seqFile(dataDir, CONV)).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).sort()).toEqual(['_seq', 's1.jsonl']);
    });

    it('folds a batch in order and assigns one seq per touched surface', () => {
      const lines = store.commit(CONV, 'call_a', [
        create('a', { n: 1 }),
        create('b', { n: 1 }),
        update('a', '/n', 2),
      ]);
      expect(lines.map((l) => [l.message.createSurface!.surfaceId, l.seq])).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      expect(lines[0].message.createSurface!.dataModel).toEqual({ n: 2 });
      expect(store.generation(CONV)).toBe(2);
    });

    it('orders readSnapshot by seq across surfaces', () => {
      store.commit(CONV, 'call_1', [create('b')]);
      store.commit(CONV, 'call_2', [create('a')]);
      store.commit(CONV, 'call_3', [update('b', '/n', 1)]);
      const snap = store.readSnapshot(CONV);
      expect(snap.map((l) => [l.message.createSurface!.surfaceId, l.seq])).toEqual([
        ['a', 2],
        ['b', 3],
      ]);
    });

    it('unlinks deleted surfaces and returns a tombstone that consumes a seq', () => {
      store.commit(CONV, 'call_1', [create('a'), create('b')]);
      const lines = store.commit(CONV, 'call_2', [del('a')]);
      expect(lines).toEqual([
        {
          seq: 3,
          callId: 'call_2',
          ts: expect.any(String),
          message: { version: '1.0', deleteSurface: { surfaceId: 'a' } },
        },
      ]);
      expect(existsSync(surfaceFile(dataDir, CONV, 'a'))).toBe(false);
      expect(store.generation(CONV)).toBe(3);
      expect(store.readSnapshot(CONV).map((l) => l.message.createSurface!.surfaceId)).toEqual([
        'b',
      ]);
    });

    it('bumps _seq for a deleteSurface even when it is the only change', () => {
      store.commit(CONV, 'call_1', [create('a')]);
      const lines = store.commit(CONV, 'call_2', [del('ghost')]);
      expect(lines.map((l) => l.seq)).toEqual([2]);
      expect(store.generation(CONV)).toBe(2);
    });

    it('re-creates a surface deleted earlier in the same batch', () => {
      store.commit(CONV, 'call_1', [create('a', { n: 1 })]);
      const lines = store.commit(CONV, 'call_2', [del('a'), create('a', { n: 9 })]);
      expect(lines).toHaveLength(1);
      expect(lines[0].message.createSurface!.dataModel).toEqual({ n: 9 });
    });

    it('writes nothing when a message fails to fold', () => {
      store.commit(CONV, 'call_1', [create('a', { n: 1 })]);
      expect(() =>
        store.commit(CONV, 'call_2', [update('a', '/n', 2), update('missing', '/n', 1)]),
      ).toThrow(FoldError);
      expect(store.generation(CONV)).toBe(1);
      expect(store.readSnapshot(CONV)[0].message.createSurface!.dataModel).toEqual({ n: 1 });
      expect(existsSync(join(dir, '.lock'))).toBe(false);
    });

    it('rejects reserved and invalid surface ids before touching disk', () => {
      expect(isStorableSurfaceId('_seq')).toBe(false);
      expect(isStorableSurfaceId('.lock')).toBe(false);
      expect(isStorableSurfaceId('ok-id_1')).toBe(true);
      expect(() => store.commit(CONV, 'call_1', [create('_seq')])).toThrow(/reserved/);
      expect(() => store.commit(CONV, 'call_1', [create('a/b')])).toThrow(/reserved/);
      expect(() => store.commit(CONV, 'call_1', [{ version: '1.0' }])).toThrow(/surfaceId/);
      expect(() => store.commit(CONV, 'bad call', [create('a')])).toThrow(/callId/);
      expect(() => store.commit('../x', 'call_1', [create('a')])).toThrow(/conversationId/);
      expect(existsSync(dir)).toBe(false);
    });

    it('returns [] for an empty batch without writing', () => {
      expect(store.commit(CONV, 'call_1', [])).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    });

    it('never lets seq go backward when _seq is behind a surface file', () => {
      store.commit(CONV, 'call_1', [create('a'), create('b')]);
      writeFileSync(seqFile(dataDir, CONV), '0\n');
      const [line] = store.commit(CONV, 'call_2', [update('b', '/n', 1)]);
      expect(line.seq).toBe(3);
    });
  });

  describe('readSnapshot and generation', () => {
    it('returns [] and 0 for an unknown conversation', () => {
      expect(store.readSnapshot(CONV)).toEqual([]);
      expect(store.generation(CONV)).toBe(0);
    });

    it('ignores tmp, lock, and _seq files and skips corrupt surface files', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.commit(CONV, 'call_1', [create('good')]);
      writeFileSync(join(dir, '.good.tmp-123'), 'partial');
      writeFileSync(join(dir, '.lock.stale.1.ab'), '1');
      writeFileSync(join(dir, 'bad.jsonl'), '{not json');
      writeFileSync(join(dir, 'empty.jsonl'), '');
      writeFileSync(
        join(dir, 'wrong.jsonl'),
        JSON.stringify({ seq: 9, callId: 'c', ts: 't', message: create('other') }),
      );
      writeFileSync(join(dir, 'notes.txt'), 'x');
      const snap = store.readSnapshot(CONV);
      expect(snap.map((l) => l.message.createSurface!.surfaceId)).toEqual(['good']);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it('treats an unreadable _seq as 0', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(seqFile(dataDir, CONV), 'garbage');
      expect(store.generation(CONV)).toBe(0);
    });

    it('accepts both v1.0 and 1.0 versions in stored lines', () => {
      store.commit(CONV, 'call_1', [create('a', { n: 0 }, 'v1.0'), create('b', { n: 0 }, '1.0')]);
      store.commit(CONV, 'call_2', [update('a', '/n', 1), update('b', '/n', 1)]);
      const snap = store.readSnapshot(CONV);
      expect(snap.map((l) => l.message.version)).toEqual(['v1.0', '1.0']);
      expect(snap.map((l) => l.message.createSurface!.dataModel)).toEqual([{ n: 1 }, { n: 1 }]);
    });
  });

  describe('deleteSurface', () => {
    it('unlinks the file, bumps _seq, and returns a tombstone', () => {
      store.commit(CONV, 'call_1', [create('a', undefined, 'v1.0'), create('b')]);
      const line = store.deleteSurface(CONV, 'a', 'call_pane_dismissed_1');
      expect(line).toMatchObject({
        seq: 3,
        callId: 'call_pane_dismissed_1',
        message: { version: 'v1.0', deleteSurface: { surfaceId: 'a' } },
      });
      expect(existsSync(surfaceFile(dataDir, CONV, 'a'))).toBe(false);
      expect(store.generation(CONV)).toBe(3);
    });

    it('returns null without bumping _seq when the surface is absent or reserved', () => {
      store.commit(CONV, 'call_1', [create('a')]);
      expect(store.deleteSurface(CONV, 'nope', 'call_x')).toBeNull();
      expect(store.deleteSurface(CONV, '_seq', 'call_x')).toBeNull();
      expect(store.generation(CONV)).toBe(1);
      expect(() => store.deleteSurface(CONV, 'a b', 'call_x')).toThrow(/surfaceId/);
    });

    it('has an async variant', async () => {
      store.commit(CONV, 'call_1', [create('a')]);
      const line = await store.deleteSurfaceAsync(CONV, 'a', 'call_pane_submitted_1');
      expect(line?.seq).toBe(2);
      expect(await store.deleteSurfaceAsync(CONV, 'a', 'call_pane_submitted_2')).toBeNull();
    });
  });

  describe('legacy migration', () => {
    function writeLegacy(lines: Array<StoreLine | string>): void {
      mkdirSync(join(dataDir, 'conversations'), { recursive: true });
      const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
      writeFileSync(legacyFile(dataDir, CONV), `${text}\n`);
    }

    const at = (seq: number, message: A2uiServerMessage): StoreLine => ({
      seq,
      callId: `call_${seq}`,
      ts: `2026-10-01T00:00:0${seq % 10}.000Z`,
      message,
    });

    beforeEach(() => {
      writeLegacy([
        at(1, create('keep', { n: 0 })),
        at(2, create('gone', { n: 0 })),
        at(3, update('keep', '/n', 1)),
        at(4, del('gone')),
        at(5, update('never', '/n', 1)),
        '{"truncated":',
        at(6, update('keep', '/list/0', 'x')),
      ]);
    });

    it('folds the flat log into per-surface files on first read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const snap = store.readSnapshot(CONV);
      expect(snap).toEqual([
        {
          seq: 6,
          callId: 'call_6',
          ts: '2026-10-01T00:00:06.000Z',
          message: {
            ...create('keep'),
            createSurface: { ...create('keep').createSurface, dataModel: { n: 1, list: ['x'] } },
          },
        },
      ]);
      expect(store.generation(CONV)).toBe(6);
      expect(existsSync(legacyFile(dataDir, CONV))).toBe(false);
      expect(existsSync(migratedFile(dataDir, CONV))).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(['_seq', 'keep.jsonl']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 2 legacy line(s)'));
    });

    it('runs once and is a no-op when _seq exists', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(migrateLegacyStore(dataDir, CONV)).toBe(true);
      expect(migrateLegacyStore(dataDir, CONV)).toBe(false);
      writeLegacy([at(1, create('late'))]);
      expect(migrateLegacyStore(dataDir, CONV)).toBe(false);
      expect(store.readSnapshot(CONV).map((l) => l.message.createSurface!.surfaceId)).toEqual([
        'keep',
      ]);
    });

    it('continues seqs after the legacy log when commit triggers migration', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const [line] = store.commit(CONV, 'call_new', [create('fresh')]);
      expect(line.seq).toBe(7);
      expect(store.readSnapshot(CONV).map((l) => l.seq)).toEqual([6, 7]);
    });

    it('defers migration on read while another writer holds the lock', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const busy = new SurfaceStore(dataDir, { lockTimeoutMs: 20 });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.lock'), 'other');
      expect(busy.readSnapshot(CONV)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deferred migration'));
      expect(() => busy.commit(CONV, 'call_x', [create('x')])).toThrow(StoreLockError);
    });
  });
});

describe('conversation lock', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'store-lock-')), 'conv');
  });

  afterEach(() => {
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  it('creates the directory, holds the lock during fn, and releases it', () => {
    const result = withConversationLock(dir, () => {
      const content = readFileSync(join(dir, '.lock'), 'utf-8');
      expect(content).toMatch(new RegExp(`^${process.pid} \\S+ [0-9a-f]{16}\\n$`));
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(join(dir, '.lock'))).toBe(false);
  });

  it('releases the lock when fn throws', () => {
    expect(() =>
      withConversationLock(dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(dir, '.lock'))).toBe(false);
  });

  it('times out on a fresh lock held by someone else', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'other');
    expect(() => withConversationLock(dir, () => 1, { lockTimeoutMs: 30 })).toThrow(StoreLockError);
    expect(readFileSync(join(dir, '.lock'), 'utf-8')).toBe('other');
  });

  it('steals a lock whose mtime is older than staleLockMs', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'abandoned');
    makeStale(join(dir, '.lock'));
    expect(withConversationLock(dir, () => 'ok', { lockTimeoutMs: 100 })).toBe('ok');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves a stale lock alone while another waiter holds the steal guard', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'abandoned');
    makeStale(join(dir, '.lock'));
    writeFileSync(join(dir, '.lock.steal'), '');
    expect(() => withConversationLock(dir, () => 1, { lockTimeoutMs: 30 })).toThrow(StoreLockError);
    expect(readFileSync(join(dir, '.lock'), 'utf-8')).toBe('abandoned');
  });

  it('clears a steal guard left behind by a dead waiter', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'abandoned');
    makeStale(join(dir, '.lock'));
    writeFileSync(join(dir, '.lock.steal'), '');
    makeStale(join(dir, '.lock.steal'));
    expect(withConversationLock(dir, () => 'ok', { lockTimeoutMs: 200 })).toBe('ok');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not unlink a lock that is no longer its own', () => {
    withConversationLock(dir, () => writeFileSync(join(dir, '.lock'), 'someone else'));
    expect(readFileSync(join(dir, '.lock'), 'utf-8')).toBe('someone else');
  });

  it('async variant waits without blocking the event loop', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'other');
    const events: string[] = [];
    setTimeout(() => events.push('timer'), 10);
    setTimeout(() => rmSync(join(dir, '.lock')), 60);
    const value = await withConversationLockAsync(dir, () => {
      events.push('locked');
      return 7;
    });
    expect(value).toBe(7);
    expect(events).toEqual(['timer', 'locked']);
    expect(existsSync(join(dir, '.lock'))).toBe(false);
  });

  it('async variant times out with StoreLockError', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'other');
    await expect(withConversationLockAsync(dir, () => 1, { lockTimeoutMs: 30 })).rejects.toThrow(
      StoreLockError,
    );
  });

  it('lets only one of several simultaneous stealers in at a time', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.lock'), 'abandoned');
    makeStale(join(dir, '.lock'));
    const log = join(dirname(dir), 'log.txt');
    const startAt = String(Date.now() + 1500);
    await Promise.all([1, 2, 3, 4].map(() => runWorker(['lock', dir, log, '40', startAt])));
    const entries = fileLines(log);
    expect(entries).toHaveLength(8);
    for (let i = 0; i < entries.length; i += 2) {
      const [enter, pid] = entries[i].split(' ');
      expect(enter).toBe('enter');
      expect(entries[i + 1]).toBe(`exit ${pid}`);
    }
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);
});

describe('multi-process contention', () => {
  it('gives two forked writers with 50 commits each unique, increasing seqs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'surface-store-fork-'));
    try {
      const startAt = String(Date.now() + 1500);
      const [a, b] = await Promise.all([
        runWorker(['commit', dataDir, CONV, 'a', '50', startAt]),
        runWorker(['commit', dataDir, CONV, 'b', '50', startAt]),
      ]);
      for (const { seqs } of [a, b]) {
        expect(seqs).toHaveLength(50);
        expect([...seqs].sort((x: number, y: number) => x - y)).toEqual(seqs);
      }
      const all = new Set([...a.seqs, ...b.seqs]);
      expect(all.size).toBe(100);
      expect(Math.max(...all)).toBe(100);
      const store = new SurfaceStore(dataDir);
      expect(store.generation(CONV)).toBe(100);
      const snap = store.readSnapshot(CONV);
      expect(snap.map((l) => l.message.createSurface!.dataModel)).toEqual([{ n: 49 }, { n: 49 }]);
      expect(snap.map((l) => l.seq)).toContain(100);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
