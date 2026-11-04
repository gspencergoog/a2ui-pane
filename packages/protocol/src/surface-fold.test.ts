import { describe, expect, it } from 'vitest';
import { basicCatalog, MessageProcessor } from '@a2ui/web_core/v1_0';
import { basicCatalog as v09BasicCatalog } from '@a2ui/web_core/v0_9';
import type { A2uiServerMessage } from './store.js';
import {
  expandSurfaceSnapshot,
  FoldError,
  foldSurfaceMessage,
  messageSurfaceId,
  SurfaceSnapshot,
} from './surface-fold.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const V09_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

function create(extra: Record<string, unknown> = {}, version = '1.0'): A2uiServerMessage {
  return {
    version,
    createSurface: {
      surfaceId: 's1',
      catalogId: CATALOG,
      components: [{ id: 'root', component: 'Text', text: 'hello' }],
      ...extra,
    },
  };
}

function data(path: string | undefined, value?: unknown): A2uiServerMessage {
  const payload: Record<string, unknown> = { surfaceId: 's1' };
  if (path !== undefined) payload.path = path;
  if (arguments.length > 1) payload.value = value;
  return { version: '1.0', updateDataModel: payload as any };
}

function comps(components: unknown[], version = '1.0'): A2uiServerMessage {
  return { version, updateComponents: { surfaceId: 's1', components } };
}

function foldAll(messages: A2uiServerMessage[]): SurfaceSnapshot | null {
  return messages.reduce<SurfaceSnapshot | null>((s, m) => foldSurfaceMessage(s, m), null);
}

function dataOf(messages: A2uiServerMessage[]): unknown {
  return foldAll(messages)?.createSurface.dataModel;
}

describe('messageSurfaceId', () => {
  it('returns the target surface of each message kind', () => {
    expect(messageSurfaceId(create())).toBe('s1');
    expect(messageSurfaceId(comps([]))).toBe('s1');
    expect(messageSurfaceId(data('/a', 1))).toBe('s1');
    expect(messageSurfaceId({ version: '1.0', deleteSurface: { surfaceId: 'x' } })).toBe('x');
  });

  it('returns undefined for messages without a surface payload', () => {
    expect(messageSurfaceId({ version: '1.0' })).toBeUndefined();
    expect(messageSurfaceId({ version: '1.0', createSurface: 'nope' as any })).toBeUndefined();
    expect(
      messageSurfaceId({ version: '1.0', deleteSurface: { surfaceId: 3 as any } }),
    ).toBeUndefined();
  });
});

describe('foldSurfaceMessage', () => {
  it('createSurface replaces the snapshot with a deep clone', () => {
    const msg = create({ dataModel: { a: { b: 1 } } });
    const snap = foldSurfaceMessage(null, msg)!;
    expect(snap).toEqual(msg);
    (msg.createSurface as any).dataModel.a.b = 2;
    expect(snap.createSurface.dataModel).toEqual({ a: { b: 1 } });
    const replaced = foldSurfaceMessage(snap, create({ components: [] }));
    expect(replaced!.createSurface.components).toEqual([]);
    expect(replaced!.createSurface.dataModel).toBeUndefined();
  });

  it('createSurface without components defaults to []', () => {
    const snap = foldSurfaceMessage(null, {
      version: '1.0',
      createSurface: { surfaceId: 's1', catalogId: CATALOG },
    });
    expect(snap!.createSurface.components).toEqual([]);
  });

  it('createSurface drops a falsy dataModel', () => {
    const snap = foldSurfaceMessage(null, create({ dataModel: null }));
    expect('dataModel' in snap!.createSurface).toBe(false);
  });

  it('accepts both v1.0 and 1.0 versions and keeps the snapshot version', () => {
    const snap = foldAll([create({}, 'v1.0'), data('/a', 1)]);
    expect(snap!.version).toBe('v1.0');
    expect(snap!.createSurface.dataModel).toEqual({ a: 1 });
  });

  it('deleteSurface returns null', () => {
    const snap = foldSurfaceMessage(null, create());
    expect(foldSurfaceMessage(snap, { version: '1.0', deleteSurface: { surfaceId: 's1' } })).toBe(
      null,
    );
    expect(foldSurfaceMessage(null, { version: '1.0', deleteSurface: { surfaceId: 's1' } })).toBe(
      null,
    );
  });

  it('does not mutate the input snapshot', () => {
    const snap = foldSurfaceMessage(null, create({ dataModel: { a: [1] } }))!;
    const before = structuredClone(snap);
    foldSurfaceMessage(snap, data('/a/0', 2));
    foldSurfaceMessage(snap, comps([{ id: 'x', component: 'Text', text: 'x' }]));
    expect(snap).toEqual(before);
  });

  it('throws FoldError for unknown message kinds', () => {
    expect(() => foldSurfaceMessage(null, { version: '1.0' })).toThrow(FoldError);
  });

  describe('updateComponents', () => {
    it('replaces entries by id and appends new ids in order', () => {
      const snap = foldAll([
        create(),
        comps([
          { id: 'root', component: 'Column', children: ['a'] },
          { id: 'a', component: 'Text', text: 'A' },
        ]),
      ]);
      expect(snap!.createSurface.components).toEqual([
        { id: 'root', component: 'Column', children: ['a'] },
        { id: 'a', component: 'Text', text: 'A' },
      ]);
    });

    it('replaces properties instead of merging them, like ComponentModel.applyUpdate', () => {
      const snap = foldAll([
        create({ components: [{ id: 'root', component: 'Text', text: 'x', variant: 'h1' }] }),
        comps([{ id: 'root', component: 'Text', text: 'y' }]),
      ]);
      expect(snap!.createSurface.components).toEqual([
        { id: 'root', component: 'Text', text: 'y' },
      ]);
    });

    it('keeps the prior type when an update omits component', () => {
      const snap = foldAll([create(), comps([{ id: 'root', text: 'bye' }])]);
      expect(snap!.createSurface.components).toEqual([
        { id: 'root', component: 'Text', text: 'bye' },
      ]);
    });

    it('carries the prior catalogId on pre-1.0 surfaces only', () => {
      const v09 = foldAll([
        create({ components: [{ id: 'root', component: 'Text', catalogId: 'other' }] }, 'v0.9'),
        comps([{ id: 'root', text: 'x' }], 'v0.9'),
      ]);
      expect((v09!.createSurface.components as unknown[])[0]).toEqual({
        id: 'root',
        component: 'Text',
        catalogId: 'other',
        text: 'x',
      });
      const changedType = foldAll([
        create({ components: [{ id: 'root', component: 'Text', catalogId: 'other' }] }, 'v0.9'),
        comps([{ id: 'root', component: 'Row' }], 'v0.9'),
      ]);
      expect((changedType!.createSurface.components as unknown[])[0]).toEqual({
        id: 'root',
        component: 'Row',
      });
      const v1 = foldAll([
        create({ components: [{ id: 'root', component: 'Text', catalogId: 'other' }] }),
        comps([{ id: 'root', text: 'x' }]),
      ]);
      expect((v1!.createSurface.components as unknown[])[0]).toEqual({
        id: 'root',
        component: 'Text',
        text: 'x',
      });
    });

    it('rejects a new component without a type, a missing id, and duplicate ids', () => {
      const snap = foldSurfaceMessage(null, create());
      expect(() => foldSurfaceMessage(snap, comps([{ id: 'n', text: 'x' }]))).toThrow(
        /without a type/,
      );
      expect(() => foldSurfaceMessage(snap, comps([{ text: 'x' }]))).toThrow(/missing an 'id'/);
      expect(() =>
        foldSurfaceMessage(
          snap,
          comps([
            { id: 'a', component: 'Text' },
            { id: 'a', component: 'Text' },
          ]),
        ),
      ).toThrow(/Duplicate/);
    });
  });

  describe('updateDataModel', () => {
    it('sets the root through "", "/", and a missing path', () => {
      expect(dataOf([create(), data('', { a: 1 })])).toEqual({ a: 1 });
      expect(dataOf([create(), data('/', { b: 2 })])).toEqual({ b: 2 });
      expect(dataOf([create(), data(undefined, { c: 3 })])).toEqual({ c: 3 });
    });

    it('turns a null or missing root value into {}', () => {
      expect(dataOf([create({ dataModel: { a: 1 } }), data('/', null)])).toEqual({});
      expect(dataOf([create({ dataModel: { a: 1 } }), data('')])).toEqual({});
    });

    it('creates intermediate objects and arrays from the next segment', () => {
      expect(dataOf([create(), data('/a/b', 1)])).toEqual({ a: { b: 1 } });
      expect(dataOf([create(), data('/list/1/name', 'x')])).toEqual({
        list: [undefined, { name: 'x' }],
      });
    });

    it('writes numeric segments into arrays in place', () => {
      const snap = foldAll([
        create({
          dataModel: {
            items: [
              { id: 'a', n: 1 },
              { id: 'b', n: 2 },
            ],
          },
        }),
        data('/items/1/n', 5),
      ]);
      expect(snap!.createSurface.dataModel).toEqual({
        items: [
          { id: 'a', n: 1 },
          { id: 'b', n: 5 },
        ],
      });
      expect(Array.isArray((snap!.createSurface.dataModel as any).items)).toBe(true);
    });

    it('writes null at an array index on removal and ignores out-of-range removals', () => {
      expect(dataOf([create({ dataModel: { l: [1, 2, 3] } }), data('/l/1', null)])).toEqual({
        l: [1, null, 3],
      });
      expect(dataOf([create({ dataModel: { l: [1, 2, 3] } }), data('/l/1')])).toEqual({
        l: [1, null, 3],
      });
      expect(dataOf([create({ dataModel: { l: [1] } }), data('/l/5', null)])).toEqual({ l: [1] });
    });

    it('removes object keys on a null or missing value, and ignores absent paths', () => {
      expect(dataOf([create({ dataModel: { a: 1, b: 2 } }), data('/a', null)])).toEqual({ b: 2 });
      expect(dataOf([create({ dataModel: { a: 1, b: 2 } }), data('/b')])).toEqual({ a: 1 });
      expect(dataOf([create({ dataModel: { a: 1 } }), data('/x/y', null)])).toEqual({ a: 1 });
    });

    it('drops empty segments, so /a//b is /a/b', () => {
      expect(dataOf([create(), data('/a//b', 1)])).toEqual({ a: { b: 1 } });
    });

    it('decodes ~1 and ~0 in segments', () => {
      expect(dataOf([create(), data('/a~1b/c~0d', 1)])).toEqual({ 'a/b': { 'c~d': 1 } });
    });

    it('rejects forbidden segments', () => {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        expect(() => foldAll([create(), data(`/a/${key}/x`, 1)])).toThrow(FoldError);
      }
      expect(({} as any).x).toBeUndefined();
    });

    it('rejects invalid paths and writes through primitives', () => {
      expect(() => foldAll([create(), data('a/b', 1)])).toThrow(/Invalid path/);
      expect(() => foldAll([create(), data('/a~2', 1)])).toThrow(/Invalid path/);
      expect(() => foldAll([create({ dataModel: { a: 5 } }), data('/a/b', 1)])).toThrow(
        /primitive/,
      );
      expect(() => foldAll([create({ dataModel: { l: [] } }), data('/l/x', 1)])).toThrow(
        /non-numeric/,
      );
      expect(() => foldAll([create(), data('/l/10001', 1)])).toThrow(/maximum/);
    });
  });

  it('throws FoldError when an update targets a missing snapshot', () => {
    expect(() => foldSurfaceMessage(null, data('/a', 1))).toThrow(FoldError);
    expect(() => foldSurfaceMessage(null, comps([]))).toThrow(/Surface not found/);
    const other = foldSurfaceMessage(null, create())!;
    expect(() =>
      foldSurfaceMessage(other, {
        version: '1.0',
        updateDataModel: { surfaceId: 's2', path: '/a', value: 1 },
      }),
    ).toThrow(FoldError);
  });
});

describe('expandSurfaceSnapshot', () => {
  it('returns a v1.0 snapshot as its own single message', () => {
    const snap = foldSurfaceMessage(null, create({ dataModel: { a: 1 } }))!;
    expect(expandSurfaceSnapshot(snap)).toEqual([snap]);
    const tagged = foldSurfaceMessage(null, create({}, 'v1.0'))!;
    expect(expandSurfaceSnapshot(tagged)).toEqual([tagged]);
  });

  it('splits a v0.9 snapshot into createSurface, updateComponents, and updateDataModel', () => {
    const snap = foldSurfaceMessage(
      null,
      create({ catalogId: V09_CATALOG, dataModel: { a: 1 } }, 'v0.9'),
    )!;
    expect(expandSurfaceSnapshot(snap)).toEqual([
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: V09_CATALOG } },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 's1',
          components: [{ id: 'root', component: 'Text', text: 'hello' }],
        },
      },
      { version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/', value: { a: 1 } } },
    ]);
  });

  it('omits empty components and data for v0.9', () => {
    const snap = foldSurfaceMessage(
      null,
      create({ catalogId: V09_CATALOG, components: [] }, 'v0.9'),
    )!;
    expect(expandSurfaceSnapshot(snap)).toHaveLength(1);
  });
});

describe('parity with @a2ui/web_core MessageProcessor', () => {
  // The MCP server's config.
  const VALIDATED = {
    validationConfig: { allowUnknownElements: false, enforceIdentifiers: false },
  };
  const CATALOGS = [basicCatalog, v09BasicCatalog as any];

  function newProcessor(validated: boolean): MessageProcessor<any> {
    return new MessageProcessor(CATALOGS, () => {}, validated ? VALIDATED : {});
  }

  function normalize(msg: A2uiServerMessage): A2uiServerMessage {
    return msg.version === 'v1.0' ? { ...msg, version: '1.0' } : msg;
  }

  function surfaceState(processor: MessageProcessor<any>, surfaceId: string) {
    const surface = processor.getSurfaces().get(surfaceId) as any;
    if (!surface) return undefined;
    const components = [...surface.componentsModel.values].map((c: any) => ({
      ...c.componentTree,
      catalog: c.catalog.id,
    }));
    components.sort((a: any, b: any) => a.id.localeCompare(b.id));
    return { components, dataModel: JSON.parse(JSON.stringify(surface.dataModel.get('/') ?? {})) };
  }

  function expectParity(messages: A2uiServerMessage[], validated = true): void {
    const live = newProcessor(validated);
    for (const msg of messages) live.processMessages([normalize(msg) as any]);
    const snapshot = foldAll(messages);
    const replayed = newProcessor(validated);
    if (snapshot) replayed.processMessages(expandSurfaceSnapshot(snapshot).map(normalize) as any);
    expect(surfaceState(replayed, 's1')).toEqual(surfaceState(live, 's1'));
  }

  const column = (children: string[]) => ({ id: 'root', component: 'Column', children });

  it('matches for component replacement and appends', () => {
    expectParity([
      create({ components: [column(['a']), { id: 'a', component: 'Text', text: 'A' }] }),
      comps([column(['a', 'b']), { id: 'b', component: 'Text', text: 'B' }]),
      comps([{ id: 'a', component: 'Text', text: { path: '/label' } }]),
      comps([{ id: 'b', component: 'Text', text: 'B2', variant: 'caption' }]),
    ]);
  });

  it('matches for partial updates that omit component', () => {
    // The v1.0 envelope schema requires `component`, so partial updates only
    // occur on v0.9 surfaces. The v0.9 createSurface schema rejects
    // `components`, so the surface gets them from an updateComponents.
    expectParity(
      [
        {
          version: 'v0.9',
          createSurface: { surfaceId: 's1', catalogId: V09_CATALOG },
        },
        comps([column(['a']), { id: 'a', component: 'Text', text: 'A' }], 'v0.9'),
        { version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/label', value: 'L' } },
        comps([{ id: 'a', text: { path: '/label' }, variant: 'h2' }], 'v0.9'),
        comps([{ id: 'root', children: ['a'] }], 'v0.9'),
      ],
      false,
    );
  });

  it('matches for data model writes, array updates, and removals', () => {
    expectParity([
      create({
        components: [{ id: 'root', component: 'Text', text: { path: '/title' } }],
        dataModel: { title: 'T', items: [{ n: 1 }, { n: 2 }, { n: 3 }], drop: 1 },
      }),
      data('/items/1/n', 20),
      data('/items/2', null),
      data('/items/9'),
      data('/drop', null),
      data('/nested//deep/0/x', 'y'),
      data('/missing/key'),
      data('/a~1b', 1),
    ]);
  });

  it('matches for root replacement and null roots', () => {
    expectParity([
      create({ components: [{ id: 'root', component: 'Text', text: 'x' }], dataModel: { a: 1 } }),
      data('/', { b: [1, 2] }),
      data('/b/0', null),
      data('', null),
      data('/c', true),
    ]);
  });

  it('matches for v1.0-tagged messages and a re-created surface', () => {
    expectParity([
      create({ dataModel: { a: 1 } }, 'v1.0'),
      data('/a', 2),
      { version: 'v1.0', deleteSurface: { surfaceId: 's1' } },
      create({ dataModel: { fresh: true } }, 'v1.0'),
      data('/more', [1]),
    ]);
  });
});
