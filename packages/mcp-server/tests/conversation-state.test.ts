import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
    expect(storedLines).toHaveLength(2);
    expect(storedLines[0].seq).toBe(1);
    expect(storedLines[1].seq).toBe(2);

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
    expect(store.readAll('conv-2')).toHaveLength(2);
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
    expect(store.readAll('conv-restart')).toHaveLength(3);
  });
});
