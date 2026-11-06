import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkChoicePresets,
  formatPresetErrors,
  formatWrappedNote,
} from '../src/choice-presets.js';
import { createServer } from '../src/server.js';
import { handleRenderA2ui } from '../src/tools/render.js';

const BASIC = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const STATUS = 'https://a2ui.org/specification/v1_0/catalogs/status/catalog.json';

const BUCKET_OPTIONS = [
  { label: 'Must-Have', value: 'p0' },
  { label: 'Fast-Follow', value: 'p1' },
  { label: 'Out of Scope', value: 'out' },
];

/** Compiled shape of `triage_matrix`: a List of cards, each with a static-option ChoicePicker. */
function triageBatch(buckets: unknown[], surfaceId = 'triage') {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId,
        sendDataModel: true,
        components: [
          { id: 'root', component: 'Card', catalogId: BASIC, child: 'col' },
          { id: 'col', component: 'Column', catalogId: BASIC, children: ['list'] },
          {
            id: 'list',
            component: 'List',
            catalogId: BASIC,
            children: { path: '/items', componentId: 'item' },
          },
          { id: 'item', component: 'Card', catalogId: BASIC, child: 'bucket_picker' },
          {
            id: 'bucket_picker',
            component: 'ChoicePicker',
            catalogId: BASIC,
            variant: 'mutuallyExclusive',
            options: BUCKET_OPTIONS,
            value: { '@path': 'bucket' },
          },
        ],
        dataModel: { items: buckets.map((bucket, i) => ({ title: `F${i + 1}`, bucket })) },
      },
    },
  ];
}

/** Compiled shape of `decision_batch`: a List of cards, each with ChoiceCards over per-item options. */
function decisionBatch(choices: unknown[]) {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'decisions',
        sendDataModel: true,
        components: [
          { id: 'root', component: 'Card', catalogId: BASIC, child: 'list' },
          {
            id: 'list',
            component: 'List',
            catalogId: BASIC,
            children: { path: '/items', componentId: 'item' },
          },
          { id: 'item', component: 'Card', catalogId: BASIC, child: 'choice_cards' },
          {
            id: 'choice_cards',
            component: 'ChoiceCards',
            catalogId: STATUS,
            options: { '@path': 'options' },
            value: { '@path': 'choice' },
          },
        ],
        dataModel: {
          items: choices.map((choice) => ({
            prompt: 'Budget?',
            options: [
              { value: '120', label: '120 words (Recommended)' },
              { value: '80', label: 'Keep 80' },
            ],
            choice,
          })),
        },
      },
    },
  ];
}

describe('checkChoicePresets', () => {
  it('accepts presets that are lists of option values', () => {
    const batch = triageBatch([['p0'], ['out']]);
    const report = checkChoicePresets(batch);
    expect(report.unknown).toEqual([]);
    expect(report.malformed).toEqual([]);
    expect(report.wrapped).toEqual([]);
    expect(report.messages).toBe(batch);
    expect(formatPresetErrors(report)).toBeUndefined();
    expect(formatWrappedNote(report)).toBeUndefined();
  });

  it('reports bucket values missing from static ChoicePicker options inside a List', () => {
    const report = checkChoicePresets(triageBatch([['Apply'], ['p1'], ['Apply']]));
    expect(report.unknown).toHaveLength(2);
    expect(report.unknown[0]).toMatchObject({
      surfaceId: 'triage',
      componentId: 'bucket_picker',
      componentType: 'ChoicePicker',
      path: '/items/0/bucket',
      unknown: ['Apply'],
      options: ['p0', 'p1', 'out'],
    });
    expect(report.unknown[1].path).toBe('/items/2/bucket');
    const text = formatPresetErrors(report)!;
    expect(text).toContain('"Apply" is not one of [p0, p1, out]');
    expect(text).toContain("redefine 'bucket_picker'");
    expect(text).toContain('Nothing was rendered');
  });

  it('wraps scalar ChoiceCards presets resolved against per-item bound options', () => {
    const report = checkChoicePresets(decisionBatch(['120', ['80']]));
    expect(report.unknown).toEqual([]);
    expect(report.wrapped).toEqual([
      {
        surfaceId: 'decisions',
        componentId: 'choice_cards',
        path: '/items/0/choice',
        value: '120',
      },
    ]);
    expect(report.messages.at(-1)).toEqual({
      version: '1.0',
      updateDataModel: { surfaceId: 'decisions', path: '/items/0/choice', value: ['120'] },
    });
    expect(formatWrappedNote(report)).toContain('/items/0/choice: "120" -> ["120"]');
  });

  it('wraps a scalar first, then still reports it if it matches no option', () => {
    const report = checkChoicePresets(decisionBatch(['200']));
    expect(report.wrapped).toHaveLength(1);
    expect(report.unknown).toMatchObject([{ path: '/items/0/choice', unknown: ['200'] }]);
  });

  it('reports non-list, non-scalar presets as malformed', () => {
    const report = checkChoicePresets(triageBatch([{ value: 'p0' }]));
    expect(report.malformed).toMatchObject([{ path: '/items/0/bucket', value: { value: 'p0' } }]);
    expect(formatPresetErrors(report)).toContain('are not string arrays');
  });

  it('ignores missing selections and choices not reachable from root', () => {
    const batch = triageBatch([undefined, null]);
    (batch[0].createSurface.components as any[]).push({
      id: 'orphan',
      component: 'ChoicePicker',
      options: BUCKET_OPTIONS,
      value: { '@path': '/nowhere' },
    });
    const report = checkChoicePresets(batch);
    expect(report.unknown).toEqual([]);
    expect(report.malformed).toEqual([]);
  });

  it('checks absolute paths and updateDataModel messages applied after creation', () => {
    const batch: unknown[] = [
      { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'basic' } },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 's',
          components: [
            {
              id: 'root',
              component: 'ChoicePicker',
              options: BUCKET_OPTIONS,
              value: { path: '/pick' },
            },
          ],
        },
      },
      { version: 'v0.9', updateDataModel: { surfaceId: 's', path: '/pick', value: 'p1' } },
    ];
    const report = checkChoicePresets(batch);
    expect(report.wrapped).toMatchObject([{ path: '/pick', value: 'p1' }]);
    expect(report.messages.at(-1)).toEqual({
      version: 'v0.9',
      updateDataModel: { surfaceId: 's', path: '/pick', value: ['p1'] },
    });
  });

  it('uses live surface components for data-only updates', () => {
    const live = {
      components: [
        {
          id: 'root',
          component: 'ChoicePicker',
          options: BUCKET_OPTIONS,
          value: { path: '/pick' },
        },
      ],
      data: { pick: ['p0'] },
    };
    const batch = [
      { version: '1.0', updateDataModel: { surfaceId: 'live', path: '/pick', value: ['nope'] } },
    ];
    const report = checkChoicePresets(batch, (sid) => (sid === 'live' ? live : undefined));
    expect(report.unknown).toMatchObject([{ surfaceId: 'live', unknown: ['nope'] }]);
    expect(live.data.pick).toEqual(['p0']);
  });

  it('truncates long problem lists', () => {
    const report = checkChoicePresets(triageBatch(Array.from({ length: 9 }, () => ['Apply'])));
    expect(formatPresetErrors(report)).toContain('...and 3 more');
  });
});

describe('handleRenderA2ui choice preset checks', () => {
  let tempDir: string;
  let server: ReturnType<typeof createServer>;

  beforeEach(() => {
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-presets-test-'));
    server = createServer(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a pane render whose bucket presets match no option and commits nothing', async () => {
    const result = await handleRenderA2ui(
      { conversationId: 'presets-1', messages: triageBatch([['Apply']]) },
      server.getState,
      server.catalogs,
      tempDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('A2UI Choice Preset Check Failed');
    expect(server.store.readAll('presets-1')).toHaveLength(0);
  });

  it('rejects an inline render with unknown presets', async () => {
    const result = await handleRenderA2ui(
      { conversationId: 'presets-2', mode: 'inline', messages: triageBatch([['Apply']]) },
      server.getState,
      server.catalogs,
      tempDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Apply" is not one of');
  });

  it('wraps scalar presets in a pane render and notes it in the result', async () => {
    const result = await handleRenderA2ui(
      { conversationId: 'presets-3', messages: triageBatch(['p0', ['p1']]) },
      server.getState,
      server.catalogs,
      tempDir,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('wrapped 1 single-value choice preset');
    const surface = server.getState('presets-3').getSurfaces().get('triage');
    expect(surface.dataModel.get('/items/0/bucket')).toEqual(['p0']);
    expect(surface.dataModel.get('/items/1/bucket')).toEqual(['p1']);
  });

  it('rejects a data-only update to a live surface that sets an unknown preset', async () => {
    const ok = await handleRenderA2ui(
      { conversationId: 'presets-4', messages: triageBatch([['p0']]) },
      server.getState,
      server.catalogs,
      tempDir,
    );
    expect(ok.isError).toBeUndefined();
    const result = await handleRenderA2ui(
      {
        conversationId: 'presets-4',
        messages: [
          {
            version: '1.0',
            updateDataModel: { surfaceId: 'triage', path: '/items/0/bucket', value: ['Apply'] },
          },
        ],
      },
      server.getState,
      server.catalogs,
      tempDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('/items/0/bucket');
  });
});
