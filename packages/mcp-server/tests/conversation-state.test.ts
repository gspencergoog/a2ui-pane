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
