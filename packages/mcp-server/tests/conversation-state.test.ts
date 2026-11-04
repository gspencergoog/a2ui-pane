import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { FoldError } from '@a2ui-pane/protocol';
import { SurfaceStore, StoreLockError } from '@a2ui-pane/protocol/store-fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CatalogRegistry } from '../src/catalog-registry.js';
import { StoreWriter } from '../src/store-writer.js';
import { ConversationState } from '../src/conversation-state.js';

describe('ConversationState', () => {
  let tempDir: string;
  let catalogs: CatalogRegistry;
  let store: StoreWriter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-state-test-'));
    catalogs = new CatalogRegistry();
    store = new StoreWriter(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles empty or non-array messages arguments gracefully', async () => {
    const state = new ConversationState('conv-empty', catalogs, store);
    const emptyResult = await state.apply([], 'call-empty');
    expect(emptyResult.ok).toBe(true);

    const nonArrayResult = await state.apply('not an array' as any, 'call-bad');
    expect(nonArrayResult.ok).toBe(false);
    if (!nonArrayResult.ok) {
      expect(nonArrayResult.issues[0].messageIndex).toBe(-1);
    }
  });

  it('successfully creates and updates a surface with valid components', async () => {
    const state = new ConversationState('conv-1', catalogs, store);

    const result = await state.apply(
      [
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: 'surf-1',
            catalogId: 'basic',
            sendDataModel: true,
          },
        },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'surf-1',
            components: [
              {
                id: 'root',
                component: 'Column',
                children: ['title'],
              },
              {
                id: 'title',
                component: 'Text',
                text: 'Hello A2UI',
              },
            ],
          },
        },
      ],
      'call-1',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.surfaceIds).toEqual(['surf-1']);
    }

    const storedLines = store.readAll('conv-1');
    expect(storedLines).toHaveLength(1);
    expect(storedLines[0].seq).toBe(1);
    expect(storedLines[0].message.createSurface?.components).toHaveLength(2);

    expect(state.getSurfaces().has('surf-1')).toBe(true);
  });

  it('pre-validates envelope structure and surfaceIds without mutating processor (H3, L1)', async () => {
    const state = new ConversationState('conv-preval', catalogs, store);

    // Initial valid surface
    await state.apply(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf-valid', catalogId: 'basic' },
        },
      ],
      'call-init',
    );

    // Batch: message 0 valid, message 1 has invalid surfaceId traversal
    const res1 = await state.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-valid', path: '/val', value: 1 },
        },
        {
          version: 'v0.9',
          createSurface: { surfaceId: '../bad-path', catalogId: 'basic' },
        },
      ],
      'call-bad-id',
    );

    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues[0].messageIndex).toBe(1);
      expect(res1.issues[0].message).toContain('Invalid surfaceId');
    }
    // Verify message 0 was not committed or applied
    expect(store.readAll('conv-preval')).toHaveLength(1);

    // Batch: message 0 valid, message 1 is not an object
    const res2 = await state.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-valid', path: '/val', value: 2 },
        },
        'string message' as any,
      ],
      'call-non-obj',
    );
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues[0].messageIndex).toBe(1);
      expect(res2.issues[0].message).toContain('must be an object');
    }
    expect(store.readAll('conv-preval')).toHaveLength(1);

    // Batch: message 0 valid, message 1 missing version
    const res3 = await state.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-valid', path: '/val', value: 3 },
        },
        { createSurface: { surfaceId: 'surf-no-ver', catalogId: 'basic' } },
      ],
      'call-no-ver',
    );
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues[0].messageIndex).toBe(1);
      expect(res3.issues[0].message).toContain('version');
    }
    expect(store.readAll('conv-preval')).toHaveLength(1);
  });

  it('rejects updates to nonexistent surfaces and rolls back atomically', async () => {
    const state = new ConversationState('conv-2', catalogs, store);

    // Initial valid surface
    await state.apply(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf-ok', catalogId: 'basic' },
        },
      ],
      'call-init',
    );
    expect(store.readAll('conv-2')).toHaveLength(1);

    // Attempt batch: first message valid on surf-ok, second message targets missing surf-bad
    const result = await state.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-ok', path: '/foo', value: 'bar' },
        },
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-bad', path: '/baz', value: 123 },
        },
      ],
      'call-bad',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].messageIndex).toBe(1);
      expect(result.issues[0].message).toMatch(/Surface not found/);
    }

    // Atomicity check: store still has ONLY the 1 initial line; first message was rolled back
    const storedLines = store.readAll('conv-2');
    expect(storedLines).toHaveLength(1);

    // Subsequent valid update still works
    const retryResult = await state.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf-ok', path: '/foo', value: 'valid' },
        },
      ],
      'call-retry',
    );
    expect(retryResult.ok).toBe(true);
    const afterRetry = store.readAll('conv-2');
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0].seq).toBe(2);
    expect(afterRetry[0].message.createSurface?.dataModel).toEqual({ foo: 'valid' });
  });

  it('rebuilds active surfaces correctly from store on restart', async () => {
    const state1 = new ConversationState('conv-restart', catalogs, store);
    await state1.apply(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'persisted-surf', catalogId: 'basic' },
        },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'persisted-surf',
            components: [{ id: 'root', component: 'Text', text: 'Persistent' }],
          },
        },
      ],
      'call-1',
    );

    expect(state1.getSurfaces().has('persisted-surf')).toBe(true);

    // Simulate server restart: new ConversationState instance reading from same store
    const state2 = new ConversationState('conv-restart', catalogs, store);
    expect(state2.getSurfaces().has('persisted-surf')).toBe(true);

    // Modifying the restored surface works seamlessly
    const result = await state2.apply(
      [
        {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'persisted-surf', path: '/status', value: 'restarted' },
        },
      ],
      'call-2',
    );
    expect(result.ok).toBe(true);
    const restartLines = store.readAll('conv-restart');
    expect(restartLines).toHaveLength(1);
    expect(restartLines[0].message.createSurface?.dataModel).toEqual({ status: 'restarted' });
  });

  it('automatically deletes stale pre-existing surfaces when a subsequent batch creates a new surface', async () => {
    const state = new ConversationState('conv-stale-cleanup', catalogs, store);

    await state.apply(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf-old', catalogId: 'basic' },
        },
      ],
      'call-1',
    );
    expect(state.getSurfaces().has('surf-old')).toBe(true);

    const res2 = await state.apply(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf-new', catalogId: 'basic' },
        },
      ],
      'call-2',
    );
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.surfaceIds).toEqual(['surf-new']);
    }
    expect(state.getSurfaces().has('surf-old')).toBe(false);
    expect(state.getSurfaces().has('surf-new')).toBe(true);

    const lines = store.readAll('conv-stale-cleanup');
    expect(lines).toHaveLength(1);
    expect(lines[0].message.createSurface?.surfaceId).toBe('surf-new');
    expect(existsSync(join(store.getConversationDir('conv-stale-cleanup'), 'surf-old.jsonl'))).toBe(
      false,
    );
  });

  const createV09 = (surfaceId: string) => ({
    version: 'v0.9',
    createSurface: { surfaceId, catalogId: 'basic' },
  });

  it('rejects a reserved surfaceId as an issue instead of throwing', async () => {
    const state = new ConversationState('conv-reserved', catalogs, store);
    const result = await state.apply([createV09('_seq')], 'call-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].messageIndex).toBe(0);
      expect(result.issues[0].message).toContain('Invalid surfaceId');
      expect(result.issues[0].message).toContain('reserved');
    }
    expect(store.generation('conv-reserved')).toBe(0);
  });

  it('sees a surface deleted by another writer as missing on the next apply', async () => {
    const state = new ConversationState('conv-ext-del', catalogs, store);
    expect((await state.apply([createV09('surf-a')], 'call-1')).ok).toBe(true);

    new SurfaceStore(tempDir).deleteSurface('conv-ext-del', 'surf-a', 'call_pane_dismissed_1');

    const result = await state.apply(
      [{ version: 'v0.9', updateDataModel: { surfaceId: 'surf-a', path: '/x', value: 1 } }],
      'call-2',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toMatch(/Surface not found/);
    }
    expect(state.hasSurface('surf-a')).toBe(false);
    expect(store.readAll('conv-ext-del')).toEqual([]);
  });

  it('reflects surfaces written by another process in hasSurface and getSurfaces', async () => {
    const state = new ConversationState('conv-foreign', catalogs, store);
    const other = new ConversationState('conv-foreign', catalogs, new StoreWriter(tempDir));
    expect((await other.apply([createV09('from-other')], 'call-1')).ok).toBe(true);

    expect(state.hasSurface('from-other')).toBe(true);
    expect([...state.getSurfaces().keys()]).toEqual(['from-other']);
  });

  it('unlinks the files of other surfaces when a non-stacked batch creates a surface', async () => {
    const state = new ConversationState('conv-stack', catalogs, store);
    await state.apply([createV09('one')], 'call-1');
    await state.apply([createV09('two')], 'call-2', { clearStaleSurfaces: false });
    expect(store.readAll('conv-stack')).toHaveLength(2);

    const result = await state.apply([createV09('three')], 'call-3');
    expect(result.ok).toBe(true);
    const dir = store.getConversationDir('conv-stack');
    expect(existsSync(join(dir, 'one.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'two.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'three.jsonl'))).toBe(true);
    expect([...state.getSurfaces().keys()]).toEqual(['three']);
  });

  it('turns a delete injected between validation and commit into an issue', async () => {
    const state = new ConversationState('conv-race', catalogs, store);
    await state.apply([createV09('surf-race')], 'call-1');

    const append = store.append.bind(store);
    const spy = vi.spyOn(store, 'append').mockImplementationOnce((convId, callId, msgs) => {
      new SurfaceStore(tempDir).deleteSurface(convId, 'surf-race', 'call_pane_dismissed_2');
      return append(convId, callId, msgs);
    });

    const result = await state.apply(
      [{ version: 'v0.9', updateDataModel: { surfaceId: 'surf-race', path: '/x', value: 1 } }],
      'call-2',
    );
    spy.mockRestore();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].messageIndex).toBe(0);
      expect(result.issues[0].message).toContain('surf-race was removed by the user');
      expect(result.issues[0].message).toContain('replace: true');
    }
    expect(state.hasSurface('surf-race')).toBe(false);
    expect(store.readAll('conv-race')).toEqual([]);
  });

  it('turns a FoldError or StoreLockError from the store into an issue', async () => {
    const state = new ConversationState('conv-errors', catalogs, store);
    await state.apply([createV09('surf-e')], 'call-1');
    const update = [
      { version: 'v0.9', updateDataModel: { surfaceId: 'surf-e', path: '/x', value: 1 } },
    ];

    const spy = vi.spyOn(store, 'append').mockImplementationOnce(() => {
      throw new FoldError('Surface not found for message: surf-e', 'surf-e');
    });
    const folded = await state.apply(update, 'call-2');
    expect(folded.ok).toBe(false);

    spy.mockImplementationOnce(() => {
      throw new StoreLockError('/tmp/x/.lock');
    });
    const locked = await state.apply(update, 'call-3');
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.issues[0].message).toContain('busy');
    }

    spy.mockImplementationOnce(() => {
      throw new Error('disk on fire');
    });
    await expect(state.apply(update, 'call-4')).rejects.toThrow('disk on fire');
    spy.mockRestore();

    // The processor still matches disk: the surface exists with no data written.
    expect(state.hasSurface('surf-e')).toBe(true);
    expect(store.readAll('conv-errors')[0].message.createSurface?.dataModel).toBeUndefined();
  });

  it('rebuilds after a foreign write lands between the generation check and commit', async () => {
    const state = new ConversationState('conv-interleave', catalogs, store);
    await state.apply([createV09('mine')], 'call-1', { clearStaleSurfaces: false });

    const append = store.append.bind(store);
    const spy = vi.spyOn(store, 'append').mockImplementationOnce((convId, callId, msgs) => {
      new StoreWriter(tempDir).append(convId, 'call-foreign', [createV09('foreign') as any]);
      return append(convId, callId, msgs);
    });
    const result = await state.apply(
      [{ version: 'v0.9', updateDataModel: { surfaceId: 'mine', path: '/x', value: 1 } }],
      'call-2',
    );
    spy.mockRestore();

    expect(result.ok).toBe(true);
    expect(state.hasSurface('foreign')).toBe(true);
    expect(state.hasSurface('mine')).toBe(true);
  });

  it('replays v1.0 snapshots that carry components and a data model', async () => {
    const state1 = new ConversationState('conv-v1', catalogs, store);
    const result = await state1.apply(
      [
        {
          version: 'v1.0',
          createSurface: {
            surfaceId: 'v1-surf',
            catalogId: 'v1_0/basic',
          },
        },
        {
          version: 'v1.0',
          updateComponents: {
            surfaceId: 'v1-surf',
            components: [{ id: 'root', component: 'Text', text: 'v1' }],
          },
        },
        { version: 'v1.0', updateDataModel: { surfaceId: 'v1-surf', path: '/a', value: 1 } },
      ],
      'call-1',
    );
    expect(result).toEqual({ ok: true, surfaceIds: ['v1-surf'] });

    const errSpy = vi.spyOn(console, 'error');
    const state2 = new ConversationState('conv-v1', catalogs, store);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    const surface = state2.getSurfaces().get('v1-surf');
    expect(surface).toBeDefined();
    expect(surface.componentsModel.get('root')).toBeDefined();
    expect(surface.dataModel.get('/a')).toBe(1);
  });
});
