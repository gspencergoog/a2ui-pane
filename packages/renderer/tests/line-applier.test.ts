import { describe, it, expect, vi } from 'vitest';
import { LineApplier } from '../src/line-applier.js';
import { StoreLine } from '@a2ui-pane/protocol';
import { createProcessor } from '../src/processor.js';
import '../src/a2ui-pane-view.js';
import type { A2uiPaneView } from '../src/a2ui-pane-view.js';

describe('LineApplier', () => {
  it('sequentially applies valid StoreLines and updates lastAppliedSeq', () => {
    const applier = new LineApplier();

    const lines: StoreLine[] = [
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'call_1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf1', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        timestamp: new Date().toISOString(),
        callId: 'call_1',
        message: {
          version: 'v0.9',
          updateDataModel: {
            surfaceId: 'surf1',
            path: '/greeting',
            value: 'hello',
          },
        },
      },
    ];

    applier.apply(lines);

    expect(applier.getLastAppliedSeq()).toBe(2);
    expect(applier.getErrors()).toHaveLength(0);
    expect(applier.getProcessor().getSurface('surf1')).toBeDefined();
    expect(applier.getProcessor().getSurface('surf1')?.dataModel.get('/greeting')).toBe('hello');
  });

  it('skips lines at or below the seq recorded for their own surface', () => {
    const applier = new LineApplier();

    applier.apply([
      {
        seq: 5,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf5', catalogId: 'basic' },
        },
      },
    ]);
    expect(applier.getLastAppliedSeq()).toBe(5);

    applier.apply([
      {
        seq: 4,
        ts: new Date().toISOString(),
        callId: 'c2',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf4', catalogId: 'basic' },
        },
      },
      {
        seq: 5,
        ts: new Date().toISOString(),
        callId: 'c3',
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf5', path: '/val', value: 123 },
        },
      },
    ]);

    // surf4 has its own counter, so seq 4 applies; seq 5 on surf5 is a duplicate.
    expect(applier.getProcessor().getSurface('surf4')).toBeDefined();
    expect(applier.getSurfaceSeq('surf4')).toBe(4);
    expect(applier.getSurfaceSeq('surf5')).toBe(5);
    expect(applier.getProcessor().getSurface('surf5')?.dataModel.get('/val')).toBeUndefined();
    expect(applier.getLastAppliedSeq()).toBe(5);
  });

  it('auto-adds version to message if omitted', () => {
    const applier = new LineApplier();

    const line: StoreLine = {
      seq: 1,
      timestamp: new Date().toISOString(),
      callId: 'c1',
      message: {
        createSurface: { surfaceId: 'surfNoVer', catalogId: 'basic' },
      } as any,
    };

    applier.apply([line]);
    expect(applier.getLastAppliedSeq()).toBe(1);
    expect(applier.getProcessor().getSurface('surfNoVer')).toBeDefined();
  });

  it('records errors for failing lines and continues applying subsequent lines', () => {
    const applier = new LineApplier();

    const lines: StoreLine[] = [
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'valid1', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          // Updating non-existent surface causes A2uiStateError
          updateDataModel: {
            surfaceId: 'nonexistent',
            path: '/foo',
            value: 'bar',
          },
        },
      },
      {
        seq: 3,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'valid2', catalogId: 'basic' },
        },
      },
    ];

    applier.apply(lines);

    // seq 1 and 3 should apply, seq 2 failed
    expect(applier.getLastAppliedSeq()).toBe(3);
    const errors = applier.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].seq).toBe(2);
    expect(errors[0].error).toContain('nonexistent');

    expect(applier.getProcessor().getSurface('valid1')).toBeDefined();
    expect(applier.getProcessor().getSurface('valid2')).toBeDefined();

    applier.clearErrors();
    expect(applier.getErrors()).toHaveLength(0);
  });

  describe('failed surfaces', () => {
    const line = (seq: number, message: Record<string, unknown>): StoreLine =>
      ({ seq, timestamp: new Date().toISOString(), callId: `c${seq}`, message }) as StoreLine;
    // A v1.0 createSurface whose root names no catalog: the processor rejects it.
    const brokenCreate = (seq: number, surfaceId: string): StoreLine =>
      line(seq, {
        version: '1.0',
        createSurface: {
          surfaceId,
          components: [{ id: 'root', component: 'Text', '@catalogId': 'nope', text: 'x' }],
        },
      });
    const goodCreate = (seq: number, surfaceId: string): StoreLine =>
      line(seq, { version: 'v0.9', createSurface: { surfaceId, catalogId: 'basic' } });

    it('records a failed createSurface per surface, leaves no partial surface, and notifies', () => {
      const applier = new LineApplier();
      const applied = vi.fn();
      applier.onApplied(applied);

      applier.apply([goodCreate(1, 'ok'), brokenCreate(2, 'broken')]);

      expect(applier.getProcessor().getSurface('ok')).toBeDefined();
      expect(applier.getProcessor().getSurface('broken')).toBeUndefined();
      const failed = applier.getFailedSurfaces();
      expect(Array.from(failed.keys())).toEqual(['broken']);
      expect(failed.get('broken')?.seq).toBe(2);
      expect(failed.get('broken')?.error).toMatch(/catalog/i);
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it('forgets the failure when a later line for the surface applies', () => {
      const applier = new LineApplier();
      applier.apply([brokenCreate(1, 's')]);
      expect(applier.getFailedSurfaces().has('s')).toBe(true);

      applier.apply([goodCreate(2, 's')]);
      expect(applier.getFailedSurfaces().size).toBe(0);
      expect(applier.getProcessor().getSurface('s')).toBeDefined();
    });

    it('drops the failure on a tombstone without touching the processor', () => {
      const applier = new LineApplier();
      applier.apply([brokenCreate(1, 's')]);
      const before = applier.getErrors().length;

      applier.apply([line(2, { version: '1.0', deleteSurface: { surfaceId: 's' } })]);

      expect(applier.getFailedSurfaces().size).toBe(0);
      expect(applier.getErrors()).toHaveLength(before);
    });

    it('drops failures for surfaces a snapshot no longer lists and clears them on reset', () => {
      const applier = new LineApplier();
      applier.apply([brokenCreate(1, 'gone'), brokenCreate(2, 'kept')]);
      expect(applier.getFailedSurfaces().size).toBe(2);

      applier.reconcile([brokenCreate(2, 'kept')]);
      expect(Array.from(applier.getFailedSurfaces().keys())).toEqual(['kept']);

      const applied = vi.fn();
      applier.onApplied(applied);
      applier.reset();
      expect(applier.getFailedSurfaces().size).toBe(0);
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it('does not report a surface that is still mounted after a failed update', () => {
      const applier = new LineApplier();
      applier.apply([goodCreate(1, 's')]);
      applier.apply([
        line(2, {
          version: 'v0.9',
          updateComponents: { surfaceId: 's', components: 'not-an-array' },
        }),
      ]);
      expect(applier.getErrors().length).toBeGreaterThan(0);
      expect(applier.getProcessor().getSurface('s')).toBeDefined();
      expect(applier.getFailedSurfaces().size).toBe(0);
    });
  });

  it('safely handles empty or non-array inputs', () => {
    const applier = new LineApplier();
    applier.apply([] as any);
    applier.apply(null as any);
    applier.apply([null as any, undefined as any]);
    expect(applier.getLastAppliedSeq()).toBe(0);
  });

  it('resets processor, clears seq and errors, and notifies onReset listeners', () => {
    const applier = new LineApplier();
    const onResetSpy = vi.fn();
    const unsubscribe = applier.onReset(onResetSpy);

    applier.apply([
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfReset', catalogId: 'basic' },
        },
      },
    ]);

    expect(applier.getLastAppliedSeq()).toBe(1);
    expect(applier.getProcessor().getSurface('surfReset')).toBeDefined();

    applier.reset();

    expect(applier.getLastAppliedSeq()).toBe(0);
    expect(applier.getErrors()).toHaveLength(0);
    // After reset, previous surface should no longer exist on the new processor
    expect(applier.getProcessor().getSurface('surfReset')).toBeUndefined();
    expect(onResetSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    applier.reset();
    expect(onResetSpy).toHaveBeenCalledTimes(1);

    // Test error in listener does not break reset()
    const throwingListener = vi.fn(() => {
      throw new Error('Listener failed');
    });
    applier.onReset(throwingListener);
    expect(() => applier.reset()).not.toThrow();

    // Test processor dispose is called if it exists
    const mockDispose = vi.fn();
    const mockProcessor = {
      dispose: mockDispose,
      processMessages: vi.fn(),
    } as any;
    const disposableApplier = new LineApplier(() => mockProcessor);
    disposableApplier.reset();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('supports custom processor factory and direct processor instance', () => {
    const customFactory = vi.fn(() => createProcessor());
    const applierWithFactory = new LineApplier(customFactory);
    expect(customFactory).toHaveBeenCalledTimes(1);
    applierWithFactory.reset();
    expect(customFactory).toHaveBeenCalledTimes(2);

    const directProcessor = createProcessor();
    const applierWithDirect = new LineApplier(directProcessor);
    expect(applierWithDirect.getProcessor()).toBe(directProcessor);
  });

  it('sorts out-of-order batch lines by seq before applying (M8)', () => {
    const applier = new LineApplier();

    const outOfOrder: StoreLine[] = [
      {
        seq: 2,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 's_sorted', path: '/val', value: 99 },
        },
      },
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 's_sorted', catalogId: 'basic' },
        },
      },
    ];

    applier.apply(outOfOrder);

    expect(applier.getLastAppliedSeq()).toBe(2);
    expect(applier.getErrors()).toHaveLength(0);
    expect(applier.getProcessor().getSurface('s_sorted')?.dataModel.get('/val')).toBe(99);
  });

  it('caps errors array at 50 entries (L4)', () => {
    const applier = new LineApplier();
    const failingLines: StoreLine[] = [];
    for (let i = 1; i <= 60; i++) {
      failingLines.push({
        seq: i,
        ts: new Date().toISOString(),
        callId: `c_${i}`,
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'missing_surf', path: '/x', value: i },
        },
      });
    }

    applier.apply(failingLines);

    const errors = applier.getErrors();
    expect(errors).toHaveLength(50);
    expect(errors[0].seq).toBe(11);
    expect(errors[49].seq).toBe(60);
  });
});

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

function storeLine(seq: number, message: Record<string, unknown>): StoreLine {
  return { seq, ts: new Date().toISOString(), callId: `c_${seq}`, message } as StoreLine;
}

function textComponent(id: string, text: string) {
  return { id, component: 'Text', catalogId: BASIC_CATALOG_ID, text };
}

interface SnapshotOptions {
  childIds?: string[];
  dataModel?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  sendDataModel?: boolean;
  rootId?: string;
}

/** A v1.0 surface snapshot: one `createSurface` that carries components and data. */
function snapshotLine(seq: number, surfaceId: string, opts: SnapshotOptions = {}): StoreLine {
  const childIds = opts.childIds ?? ['title'];
  const rootId = opts.rootId ?? 'root';
  const createSurface: Record<string, unknown> = {
    surfaceId,
    catalogId: BASIC_CATALOG_ID,
    components: [
      { id: rootId, component: 'Column', catalogId: BASIC_CATALOG_ID, children: childIds },
      ...childIds.map((id) => textComponent(id, `${id} text`)),
    ],
    dataModel: opts.dataModel ?? { n: seq },
  };
  if (opts.theme) createSurface.theme = opts.theme;
  if (opts.sendDataModel !== undefined) createSurface.sendDataModel = opts.sendDataModel;
  if (opts.rootId) createSurface.rootId = opts.rootId;
  return storeLine(seq, { version: '1.0', createSurface });
}

function deleteLine(seq: number, surfaceId: string): StoreLine {
  return storeLine(seq, { version: '1.0', deleteSurface: { surfaceId } });
}

describe('LineApplier per-surface seqs', () => {
  it('removes the seq entry on deleteSurface so a re-create is never skipped', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(5, 's1')]);
    applier.apply([deleteLine(9, 's1')]);

    expect(applier.getSurfaceSeq('s1')).toBeUndefined();
    expect(applier.getProcessor().getSurface('s1')).toBeUndefined();

    // A re-create numbered below the tombstone still applies.
    applier.apply([snapshotLine(7, 's1')]);
    expect(applier.getProcessor().getSurface('s1')).toBeDefined();
    expect(applier.getSurfaceSeq('s1')).toBe(7);
    expect(applier.getErrors()).toHaveLength(0);
  });

  it('applies a tombstone whose seq equals the surface seq', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(4, 's1')]);
    applier.apply([deleteLine(4, 's1')]);
    expect(applier.getProcessor().getSurface('s1')).toBeUndefined();
  });

  it('skips a tombstone older than a re-create', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(8, 's1')]);
    applier.apply([deleteLine(6, 's1')]);
    expect(applier.getProcessor().getSurface('s1')).toBeDefined();
    expect(applier.getSurfaceSeq('s1')).toBe(8);
  });

  it('keeps getLastAppliedSeq working for a global counter on one surface', () => {
    // The cheats inflight plugin numbers every line with one `++seq`.
    const applier = new LineApplier();
    let seq = 0;
    applier.apply([
      storeLine(++seq, {
        version: 'v0.9',
        createSurface: { surfaceId: 'board', catalogId: 'basic' },
      }),
      storeLine(++seq, {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'board', path: '/', value: { a: 1 } },
      }),
    ]);
    applier.apply([
      storeLine(++seq, {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'board', path: '/a', value: 2 },
      }),
    ]);
    expect(applier.getLastAppliedSeq()).toBe(3);
    expect(applier.getProcessor().getSurface('board')?.dataModel.get('/a')).toBe(2);
    expect(applier.getErrors()).toHaveLength(0);
  });

  it('reports the maximum seq over live surfaces', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(3, 'a'), snapshotLine(6, 'b')]);
    expect(applier.getLastAppliedSeq()).toBe(6);
    applier.apply([deleteLine(7, 'b')]);
    expect(applier.getLastAppliedSeq()).toBe(3);
  });
});

describe('LineApplier.reconcile', () => {
  it('deletes surfaces missing from the snapshot and applies the rest', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(1, 'keep'), snapshotLine(2, 'gone')]);

    applier.reconcile([snapshotLine(3, 'keep'), snapshotLine(4, 'fresh')]);

    const processor = applier.getProcessor();
    expect(processor.getSurface('gone')).toBeUndefined();
    expect(applier.getSurfaceSeq('gone')).toBeUndefined();
    expect(processor.getSurface('keep')?.dataModel.get('/n')).toBe(3);
    expect(processor.getSurface('fresh')).toBeDefined();
    expect(applier.getErrors()).toHaveLength(0);
  });

  it('clears every surface for an empty snapshot', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(1, 'a'), snapshotLine(2, 'b')]);
    applier.reconcile([]);
    expect(applier.getProcessor().getSurfaces().size).toBe(0);
    expect(applier.getLastAppliedSeq()).toBe(0);
  });

  it('leaves an unchanged surface alone', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(1, 'a')]);
    const before = applier.getProcessor().getSurface('a');
    const created = vi.fn();
    applier.getProcessor().onSurfaceCreated(created);

    applier.reconcile([snapshotLine(1, 'a')]);

    expect(applier.getProcessor().getSurface('a')).toBe(before);
    expect(created).not.toHaveBeenCalled();
  });

  it('applies a snapshot numbered below the recorded seq after a store reset', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(40, 'a')]);
    applier.reconcile([snapshotLine(2, 'a', { dataModel: { n: 'fresh' } })]);
    expect(applier.getSurfaceSeq('a')).toBe(2);
    expect(applier.getProcessor().getSurface('a')?.dataModel.get('/n')).toBe('fresh');
  });

  it('replays a v0.9 snapshot through expandSurfaceSnapshot', () => {
    const applier = new LineApplier();
    applier.reconcile([
      storeLine(2, {
        version: 'v0.9',
        createSurface: {
          surfaceId: 'legacy',
          catalogId: 'basic',
          components: [{ id: 'root', component: 'Text', text: 'hi' }],
          dataModel: { greeting: 'hello' },
        },
      }),
    ]);
    expect(applier.getErrors()).toHaveLength(0);
    const surface = applier.getProcessor().getSurface('legacy');
    expect(surface?.dataModel.get('/greeting')).toBe('hello');
    expect(surface?.componentsModel.get('root')?.type).toBe('Text');
  });
});

describe('LineApplier createSurface on a mounted surface', () => {
  it('updates in place when settings match and no component is removed', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(1, 's', { childIds: ['title'] })]);
    const processor = applier.getProcessor();
    const surface = processor.getSurface('s');
    const title = surface?.componentsModel.get('title');
    const created = vi.fn();
    const deleted = vi.fn();
    processor.onSurfaceCreated(created);
    processor.onSurfaceDeleted(deleted);

    applier.apply([snapshotLine(2, 's', { childIds: ['title', 'extra'], dataModel: { n: 42 } })]);

    expect(applier.getErrors()).toHaveLength(0);
    expect(processor.getSurface('s')).toBe(surface);
    expect(surface?.componentsModel.get('title')).toBe(title);
    expect(surface?.componentsModel.get('extra')?.type).toBe('Text');
    expect(surface?.dataModel.get('/n')).toBe(42);
    expect(created).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('replaces the whole data model in place', () => {
    const applier = new LineApplier();
    applier.apply([snapshotLine(1, 's', { dataModel: { a: 1, b: 2 } })]);
    applier.apply([snapshotLine(2, 's', { dataModel: { a: 3 } })]);
    const surface = applier.getProcessor().getSurface('s');
    expect(surface?.dataModel.get('/a')).toBe(3);
    expect(surface?.dataModel.get('/b')).toBeUndefined();
  });

  const recreateCases: Array<[string, SnapshotOptions]> = [
    ['a component is removed', { childIds: [] }],
    ['sendDataModel changes', { sendDataModel: true }],
  ];

  for (const [label, opts] of recreateCases) {
    it(`re-creates the surface when ${label}`, () => {
      const applier = new LineApplier();
      applier.apply([snapshotLine(1, 's')]);
      const processor = applier.getProcessor();
      const surface = processor.getSurface('s');
      const created = vi.fn();
      processor.onSurfaceCreated(created);

      applier.apply([snapshotLine(2, 's', opts)]);

      expect(applier.getErrors()).toEqual([]);
      expect(processor.getSurface('s')).toBeDefined();
      expect(processor.getSurface('s')).not.toBe(surface);
      expect(created).toHaveBeenCalledTimes(1);
      expect(applier.getSurfaceSeq('s')).toBe(2);
    });
  }

  function legacySnapshot(seq: number, theme?: Record<string, unknown>): StoreLine {
    return storeLine(seq, {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'legacy',
        catalogId: 'basic',
        ...(theme ? { theme } : {}),
        components: [{ id: 'root', component: 'Text', text: `t${seq}` }],
        dataModel: { n: seq },
      },
    });
  }

  it('updates a v0.9 surface in place when its settings match', () => {
    const applier = new LineApplier();
    applier.apply([legacySnapshot(1, { primaryColor: '#00ff00' })]);
    const surface = applier.getProcessor().getSurface('legacy');
    applier.apply([legacySnapshot(2, { primaryColor: '#00ff00' })]);
    expect(applier.getErrors()).toEqual([]);
    expect(applier.getProcessor().getSurface('legacy')).toBe(surface);
    expect(surface?.dataModel.get('/n')).toBe(2);
  });

  it('re-creates the surface when the theme changes', () => {
    const applier = new LineApplier();
    applier.apply([legacySnapshot(1)]);
    const surface = applier.getProcessor().getSurface('legacy');
    applier.apply([legacySnapshot(2, { primaryColor: '#ff0000' })]);
    expect(applier.getErrors()).toEqual([]);
    const next = applier.getProcessor().getSurface('legacy');
    expect(next).not.toBe(surface);
    expect(next?.dataModel.get('/n')).toBe(2);
  });

  it('re-creates the surface when the catalog changes', () => {
    const applier = new LineApplier();
    applier.apply([
      storeLine(1, { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'basic' } }),
    ]);
    const surface = applier.getProcessor().getSurface('s');
    applier.apply([snapshotLine(2, 's')]);
    expect(applier.getErrors()).toEqual([]);
    expect(applier.getProcessor().getSurface('s')).not.toBe(surface);
  });

  it('keeps the rendered <a2ui-surface> element across an in-place update', async () => {
    const applier = new LineApplier();
    const pane = document.createElement('a2ui-pane-view') as A2uiPaneView;
    document.body.appendChild(pane);
    try {
      applier.apply([snapshotLine(1, 's')]);
      pane.processor = applier.getProcessor();
      await pane.updateComplete;
      const before = pane.shadowRoot!.querySelector('a2ui-surface') as any;
      expect(before).not.toBeNull();
      const model = before.surface;

      applier.apply([snapshotLine(2, 's', { childIds: ['title', 'extra'] })]);
      await pane.updateComplete;
      const afterInPlace = pane.shadowRoot!.querySelector('a2ui-surface') as any;
      expect(afterInPlace).toBe(before);
      expect(afterInPlace.surface).toBe(model);

      applier.apply([snapshotLine(3, 's', { childIds: [] })]);
      await pane.updateComplete;
      const afterRecreate = pane.shadowRoot!.querySelector('a2ui-surface') as any;
      expect(afterRecreate.surface).not.toBe(model);
      expect(afterRecreate.surface).toBe(applier.getProcessor().getSurface('s'));
    } finally {
      pane.remove();
    }
  });
});
