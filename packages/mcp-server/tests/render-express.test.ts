import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createServer,
  createExpressWorkerFromEnv,
  createTemplateRegistryFromEnv,
} from '../src/server.js';
import { ExpressWorker } from '../src/express-worker.js';
import { TemplateRegistry } from '../src/template-registry.js';
import {
  handleRenderA2ui,
  resolveMessages,
  createdSurfaceIds,
  mergeRootDataUpdates,
  unpackUpdates,
  formatDataAsExpressDsl,
} from '../src/tools/render.js';
import { handleA2uiInstructions } from '../src/tools/instructions.js';

const FAKE = resolve(__dirname, 'fixtures', 'fake_worker.mjs');
const CATALOG = resolve(__dirname, '..', '..', '..', 'catalogs', 'v1_0', 'basic', 'catalog.json');
const CHARTS_CATALOG = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'catalogs',
  'v1_0',
  'charts',
  'catalog.json',
);

function fakeWorker(mode = 'normal') {
  return new ExpressWorker({
    pythonBin: process.execPath,
    workerScript: FAKE,
    catalogPaths: [CATALOG, CHARTS_CATALOG],
    requestTimeoutMs: 1000,
    log: () => {},
    spawnFn: ((cmd: string, args: string[], opts: any) =>
      spawn(cmd, args, { ...opts, env: { ...process.env, FAKE_WORKER_MODE: mode } })) as any,
  });
}

describe('render_a2ui Express paths', () => {
  let tempDir: string;
  let templatesDir: string;
  let worker: ExpressWorker;
  let templates: TemplateRegistry;
  let server: ReturnType<typeof createServer>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-express-test-'));
    templatesDir = join(tempDir, 'tpl');
    mkdirSync(templatesDir);
    writeFileSync(
      join(templatesDir, 'greeting.a2ui'),
      '// @genui id=greeting surface=inline\n// @summary Says hi.\n// @data /name\n$/name = "World"\nroot = Card(Text($/name))\n',
    );
    worker = fakeWorker('normal');
    templates = new TemplateRegistry([{ dir: templatesDir, source: 'plugin' }], () => {});
    server = createServer(tempDir, { worker, templates });
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
  });

  afterEach(() => {
    worker.dispose();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of [
      'A2UI_PANE_PYTHON',
      'A2UI_PANE_AGENT_SDK_PATH',
      'A2UI_PANE_EXPRESS',
      'A2UI_PANE_TEMPLATES_DIR',
    ]) {
      delete process.env[key];
    }
  });

  it('rejects missing or conflicting authoring inputs', async () => {
    const none = await resolveMessages({}, {});
    expect((none as any).isError).toBe(true);
    expect((none as any).content[0].text).toContain('Missing authoring input');

    const both = await resolveMessages({ messages: [], dsl: 'root = Text("x")' }, {});
    expect((both as any).content[0].text).toContain('not both');

    const empty = await resolveMessages({ messages: [] }, {});
    expect(empty).toEqual({ messages: [], authored: 'messages' });
  });

  it('explains when no worker or registry is configured', async () => {
    const noWorker = await resolveMessages({ dsl: 'root = Text("x")' }, {});
    expect((noWorker as any).content[0].text).toContain('no Python worker');
    const noTemplates = await resolveMessages({ template: 'greeting' }, { worker });
    expect((noTemplates as any).content[0].text).toContain('Template rendering is not configured');
  });

  it('compiles dsl and renders it to the pane with a compiled note', async () => {
    const result = await handleRenderA2ui(
      { conversationId: 'conv-dsl', dsl: 'root = Text("hello")', surfaceId: 'hello', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('surface(s) [hello]');
    expect(result.content[0].text).toContain('compiled from Express dsl');
    expect(server.getState('conv-dsl').hasSurface('hello')).toBe(true);
  });

  it('renders a template inline with caller data appended', async () => {
    const result = await handleRenderA2ui(
      { conversationId: 'conv-tpl', template: 'greeting', dsl: '$/name = "Greg"', mode: 'inline' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('<agent-embed');
    expect(result.content[0].text).toContain('surface(s) [main]');
  });

  it('reports unknown templates and invalid surface ids', async () => {
    const unknown = await resolveMessages({ template: 'nope' }, { worker, templates });
    expect((unknown as any).content[0].text).toContain("Unknown template 'nope'");
    const badId = await resolveMessages(
      { dsl: 'root = Text("x")', surfaceId: 'bad id!' },
      { worker, templates },
    );
    expect((badId as any).content[0].text).toContain('Invalid surfaceId');
  });

  it('formats compile errors with line, column, and the source line', async () => {
    const result = await resolveMessages(
      { dsl: '<a2ui>\nroot = Card(x)\nBAD line here\n</a2ui>' },
      { worker, templates },
    );
    const text = (result as any).content[0].text as string;
    expect(text).toContain('Express ExpressParseError at line 2, column 5');
    expect(text).toContain('> BAD line here');
    expect(text).toContain('pass raw `messages`');
  });

  it("includes the compiler's help hint when the worker provides one", async () => {
    const result = await resolveMessages({ dsl: 'root = Text(HELPME)' }, { worker, templates });
    const text = (result as any).content[0].text as string;
    expect(text).toContain("Express ExpressCompilerError: Property 'foo' is not a valid property");
    expect(text).toContain("Help: Component 'Text' accepts properties: text, variant");
  });

  it('reports an unavailable worker with repair guidance', async () => {
    const broken = fakeWorker('init-fail');
    const result = await resolveMessages({ dsl: 'root = Text("x")' }, { worker: broken });
    expect((result as any).content[0].text).toContain('Express compiler unavailable');
    broken.dispose();
  });

  it('replace deletes an existing surface before re-creating it', async () => {
    const first = await handleRenderA2ui(
      { conversationId: 'conv-rep', dsl: 'root = Text("v1")', surfaceId: 'dup', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(first.isError).toBeUndefined();

    const again = await handleRenderA2ui(
      { conversationId: 'conv-rep', dsl: 'root = Text("v2")', surfaceId: 'dup', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('already exists');

    const replaced = await handleRenderA2ui(
      {
        conversationId: 'conv-rep',
        dsl: 'root = Text("v2")',
        surfaceId: 'dup',
        mode: 'pane',
        replace: true,
      },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(replaced.isError).toBeUndefined();
    expect(server.getState('conv-rep').hasSurface('dup')).toBe(true);

    const stacked = await handleRenderA2ui(
      {
        conversationId: 'conv-rep',
        dsl: 'root = Text("stacked")',
        surfaceId: 'second',
        mode: 'pane',
        stack: true,
      },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(stacked.isError).toBeUndefined();
    expect(server.getState('conv-rep').hasSurface('dup')).toBe(true);
    expect(server.getState('conv-rep').hasSurface('second')).toBe(true);

    // replace + stack re-creates one surface and leaves the other alone.
    const recreated = await handleRenderA2ui(
      {
        conversationId: 'conv-rep',
        dsl: 'root = Text("v3")',
        surfaceId: 'dup',
        mode: 'pane',
        replace: true,
        stack: true,
      },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(recreated.isError).toBeUndefined();
    expect(server.getState('conv-rep').hasSurface('dup')).toBe(true);
    expect(server.getState('conv-rep').hasSurface('second')).toBe(true);

    // Without stack, creating a surface clears the others (the pre-existing default).
    const cleared = await handleRenderA2ui(
      { conversationId: 'conv-rep', dsl: 'root = Text("solo")', surfaceId: 'third', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(cleared.isError).toBeUndefined();
    expect(server.getState('conv-rep').hasSurface('third')).toBe(true);
    expect(server.getState('conv-rep').hasSurface('dup')).toBe(false);
    expect(server.getState('conv-rep').hasSurface('second')).toBe(false);

    expect(
      createdSurfaceIds([
        { createSurface: { surfaceId: 'a' } },
        { createSurface: { surfaceId: 'a' } },
        {},
      ]),
    ).toEqual(['a']);
  });

  it('merges a data-only Express update into a live surface by top-level key', async () => {
    const first = await handleRenderA2ui(
      { conversationId: 'conv-merge', dsl: 'root = Text("v1")', surfaceId: 'board', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(first.isError).toBeUndefined();
    const dataModel = () =>
      (server.getState('conv-merge').getSurfaces().get('board') as any).dataModel;
    expect(dataModel().get('/title')).toBe('Default title');

    const update = await handleRenderA2ui(
      { conversationId: 'conv-merge', dsl: '$/note = "edited"', surfaceId: 'board', mode: 'pane' },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(update.isError).toBeUndefined();
    expect(dataModel().get('/note')).toBe('edited');
    expect(dataModel().get('/title')).toBe('Default title');
  });

  it('mergeRootDataUpdates leaves non-root, non-live, and freshly created surfaces alone', () => {
    const live = new Set(['live']);
    const isLive = (sid: string) => live.has(sid);
    const root = (surfaceId: string, value: unknown, path = '/') => ({
      version: 'v0.9',
      updateDataModel: { surfaceId, path, value },
    });

    expect(mergeRootDataUpdates([root('live', { a: 1, 'b/c': 2 })], isLive)).toEqual([
      root('live', 1, '/a'),
      root('live', 2, '/b~1c'),
    ]);
    const untouched = [
      root('live', { a: 1 }, '/nested'),
      root('other', { a: 1 }),
      root('live', [1, 2]),
      { version: 'v0.9', createSurface: { surfaceId: 'fresh' } },
      root('fresh', { a: 1 }),
      { version: 'v0.9', deleteSurface: { surfaceId: 'live' } },
    ];
    expect(mergeRootDataUpdates(untouched, isLive)).toEqual(untouched);
  });

  it('unpackUpdates decomposes numeric array index mutations into leaf paths', () => {
    const input = {
      subtitle: 'Reviewing PR #3653',
      items: {
        '0': {
          state: 'Ready for review',
          tone: 'active',
          step: 2,
        },
      },
    };
    const unpacked = unpackUpdates('/', input);
    expect(unpacked).toEqual([
      { path: '/subtitle', value: 'Reviewing PR #3653' },
      { path: '/items/0/state', value: 'Ready for review' },
      { path: '/items/0/tone', value: 'active' },
      { path: '/items/0/step', value: 2 },
    ]);

    // Preserves full array replacement
    const fullArray = [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ];
    expect(unpackUpdates('/items', fullArray)).toEqual([{ path: '/items', value: fullArray }]);

    // Decomposes non-root path targeting an array element
    const itemProps = { state: 'Ready for review', tone: 'active' };
    expect(unpackUpdates('/items/0', itemProps)).toEqual([
      { path: '/items/0/state', value: 'Ready for review' },
      { path: '/items/0/tone', value: 'active' },
    ]);
  });

  it('mergeRootDataUpdates unpacks array index dictionaries and preserves live array identity', async () => {
    const live = new Set(['stack']);
    const isLive = (sid: string) => live.has(sid);

    // Root update with collapsed array dictionary
    const rootMsg = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'stack',
        path: '/',
        value: {
          subtitle: 'Active wave',
          items: {
            '0': { state: 'Merged', tone: 'success' },
          },
        },
      },
    };
    expect(mergeRootDataUpdates([rootMsg], isLive)).toEqual([
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'stack', path: '/subtitle', value: 'Active wave' },
      },
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'stack', path: '/items/0/state', value: 'Merged' },
      },
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'stack', path: '/items/0/tone', value: 'success' },
      },
    ]);

    // Non-root update with path: "/items" but numeric keys
    const itemsMsg = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'stack',
        path: '/items',
        value: {
          '1': { state: 'In progress', tone: 'active' },
        },
      },
    };
    expect(mergeRootDataUpdates([itemsMsg], isLive)).toEqual([
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'stack', path: '/items/1/state', value: 'In progress' },
      },
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'stack', path: '/items/1/tone', value: 'active' },
      },
    ]);
  });

  it('preserves array data model and sibling item fields across live surface updates', async () => {
    const initialMessages = [
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'board',
          components: [
            {
              id: 'root',
              component: 'Text',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              text: 'live',
            },
          ],
          dataModel: {
            subtitle: 'Initial',
            items: [
              { id: '1', title: 'PR #3653', state: 'Draft', tone: 'neutral', step: 1 },
              { id: '2', title: 'PR #3655', state: 'Draft', tone: 'neutral', step: 0 },
            ],
          },
        },
      },
    ];

    const first = await handleRenderA2ui(
      {
        conversationId: 'conv-array-merge',
        messages: initialMessages,
        surfaceId: 'board',
        mode: 'pane',
      },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(first.isError).toBeUndefined();

    const dataModel = () =>
      (server.getState('conv-array-merge').getSurfaces().get('board') as any).dataModel;
    expect(Array.isArray(dataModel().get('/items'))).toBe(true);
    expect(dataModel().get('/items').length).toBe(2);

    // Now execute a data-only update that the worker collapses into path: "/" with { subtitle, items: { "0": ... } }
    const updateDsl = [
      '$/subtitle = "Wave 2 updated"',
      '$/items = {"0": {"state": "Ready for review", "tone": "active", "step": 2}}',
    ].join('\n');

    const updated = await handleRenderA2ui(
      {
        conversationId: 'conv-array-merge',
        dsl: updateDsl,
        surfaceId: 'board',
        mode: 'pane',
      },
      server.getState,
      server.catalogs,
      tempDir,
      undefined,
      { worker, templates },
    );
    expect(updated.isError).toBeUndefined();

    // The items dataModel MUST remain an Array, have length 2, and preserve item 0's id and title!
    const items = dataModel().get('/items');
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      id: '1',
      title: 'PR #3653',
      state: 'Ready for review',
      tone: 'active',
      step: 2,
    });
    expect(items[1]).toEqual({
      id: '2',
      title: 'PR #3655',
      state: 'Draft',
      tone: 'neutral',
      step: 0,
    });
    expect(dataModel().get('/subtitle')).toBe('Wave 2 updated');
  });

  it('formatDataAsExpressDsl converts dictionary and JSON data to Express statements', () => {
    const fromObj = formatDataAsExpressDsl({
      subtitle: 'PR Tracker',
      '/note': 'Check CI',
      '$/items': [{ id: '1' }],
      count: 42,
    });
    expect(fromObj).toContain('$/subtitle = "PR Tracker"');
    expect(fromObj).toContain('$/note = "Check CI"');
    expect(fromObj).toContain('$/items = [{"id":"1"}]');
    expect(fromObj).toContain('$/count = 42');

    const fromJson = formatDataAsExpressDsl('{"title": "From JSON"}');
    expect(fromJson).toBe('$/title = "From JSON"');

    const malformed = formatDataAsExpressDsl('{ bad json');
    expect((malformed as any).isError).toBe(true);
    expect((malformed as any).content[0].text).toContain('Malformed data JSON string');

    const invalid = formatDataAsExpressDsl([1, 2, 3]);
    expect((invalid as any).isError).toBe(true);
    expect((invalid as any).content[0].text).toContain('must be an object');
  });

  it('adapts data and dataModel parameters when authoring with templates or dsl', async () => {
    // 1. Adapts data into template inflation
    const result = await resolveMessages(
      {
        template: 'greeting',
        data: { name: 'Antigravity' },
      },
      { worker, templates },
    );
    expect((result as any).isError).toBeUndefined();
    expect((result as any).authored).toBe('template');

    // 2. Adapts dataModel alias with JSON string
    const aliasResult = await resolveMessages(
      {
        template: 'greeting',
        dataModelJSON: JSON.stringify({ name: 'Jetski' }),
      },
      { worker, templates },
    );
    expect((aliasResult as any).isError).toBeUndefined();
    expect((aliasResult as any).authored).toBe('template');

    // 3. Rejects messages passed with data
    const conflict = await resolveMessages(
      {
        messages: [],
        data: { name: 'Conflict' },
      },
      { worker, templates },
    );
    expect((conflict as any).isError).toBe(true);
    expect((conflict as any).content[0].text).toContain('not both');
  });

  it('a2ui_instructions returns the Express contract, host rules, and template index', async () => {
    const result = await handleA2uiInstructions({}, server.catalogs, { worker, templates });
    const text = result.content[0].text;
    expect(text).toContain('# Fake Express Contract');
    expect(text).toContain('Host Rules for `render_a2ui`');
    expect(text).toContain('`conversationId`: your current conversation ID. Always pass it');
    expect(text).toContain('render_a2ui({ conversationId, template: "<id>", surfaceId, mode, dsl');
    expect(text).toContain('| `greeting` | inline | Says hi. |');
  });

  it('a2ui_instructions falls back to JSON rules with the worker failure reason', async () => {
    const broken = fakeWorker('init-fail');
    const result = await handleA2uiInstructions({}, server.catalogs, { worker: broken, templates });
    expect(result.content[0].text).toContain('A2UI Express authoring is unavailable');
    expect(result.content[0].text).toContain('No module named a2ui');
    expect(result.content[0].text).toContain('A2UI Protocol Rules (v0.9)');
    broken.dispose();

    const explicitJson = await handleA2uiInstructions({ format: 'json' }, server.catalogs, {
      worker,
      templates,
    });
    expect(explicitJson.content[0].text).toContain('A2UI Protocol Rules (v0.9)');
    expect(explicitJson.content[0].text).not.toContain('unavailable');
  });

  it('builds the worker and registry from environment variables', () => {
    expect(createExpressWorkerFromEnv()).toBeUndefined();
    process.env.A2UI_PANE_PYTHON = '';
    expect(createExpressWorkerFromEnv()).toBeUndefined();
    process.env.A2UI_PANE_PYTHON = '/some/python';
    const w = createExpressWorkerFromEnv();
    expect(w).toBeInstanceOf(ExpressWorker);
    w?.dispose();

    process.env.A2UI_PANE_TEMPLATES_DIR = templatesDir;
    const reg = createTemplateRegistryFromEnv(tempDir);
    expect(reg.resolve('greeting')?.source).toBe('plugin');
    mkdirSync(join(tempDir, 'templates'));
    writeFileSync(join(tempDir, 'templates', 'greeting.a2ui'), 'root = Text("user")\n');
    const reg2 = createTemplateRegistryFromEnv(tempDir);
    expect(reg2.resolve('greeting')?.source).toBe('user');
  });
});

const REAL_WORKER = resolve(__dirname, '..', 'python', 'express_worker.py');
const STATUS_CATALOG = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'catalogs',
  'v1_0',
  'status',
  'catalog.json',
);
const realPython = process.env.A2UI_PANE_PYTHON;
const agentSdkPath = process.env.A2UI_PANE_AGENT_SDK_PATH;

describe.skipIf(!realPython && !agentSdkPath)(
  'render_a2ui Express status catalog (real worker)',
  () => {
    it('compiles a Table with static columns and a $/rows binding', async () => {
      const worker = new ExpressWorker({
        pythonBin: realPython,
        agentSdkPath,
        uvBin: process.env.A2UI_PANE_UV,
        workerScript: REAL_WORKER,
        catalogPaths: [CATALOG, CHARTS_CATALOG, STATUS_CATALOG],
        startupTimeoutMs: 60_000,
        log: () => {},
      });
      try {
        const dsl = [
          'surface("grid", sendDataModel=true)',
          '$/rows = [{name: "CL 1", state: {text: "Merged", tone: "success"}}]',
          't = Table([{key:"name",label:"Name"}], $/rows)',
          'root = Card(t)',
        ].join('\n');
        const messages = await worker.compile(dsl, 'grid');
        const components = (messages[0] as any).createSurface.components as Array<
          Record<string, unknown>
        >;
        const table = components.find((c) => c.component === 'Table');
        expect(table).toMatchObject({
          id: 't',
          catalogId: 'https://a2ui.org/specification/v1_0/catalogs/status/catalog.json',
          columns: [{ key: 'name', label: 'Name' }],
          rows: { '@path': '/rows' },
        });

        // The server-side zod mirror in catalog-registry.ts must accept the compiled JSON.
        const tempDir = mkdtempSync(join(tmpdir(), 'a2ui-table-test-'));
        try {
          const server = createServer(tempDir, {});
          const result = await handleRenderA2ui(
            { conversationId: 'conv-table', messages, mode: 'pane' },
            server.getState,
            server.catalogs,
            tempDir,
          );
          expect(result.isError).toBeUndefined();
          expect(server.getState('conv-table').hasSurface('grid')).toBe(true);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } finally {
        worker.dispose();
      }
    }, 90_000);

    it('compiles a Stepper with a $/steps binding and a $/cur binding', async () => {
      const worker = new ExpressWorker({
        pythonBin: realPython,
        agentSdkPath,
        uvBin: process.env.A2UI_PANE_UV,
        workerScript: REAL_WORKER,
        catalogPaths: [CATALOG, CHARTS_CATALOG, STATUS_CATALOG],
        startupTimeoutMs: 60_000,
        log: () => {},
      });
      try {
        const dsl = [
          'surface("life", sendDataModel=true)',
          '$/steps = [{label: "Draft"}, {label: "Review", detail: "Two reviewers"}, {label: "Merged"}]',
          '$/cur = 1',
          's = Stepper($/steps, $/cur)',
          'v = Stepper([{label: "Plan"}, {label: "Build"}], 1, "danger", "vertical")',
          'root = Column([s, v])',
        ].join('\n');
        const messages = await worker.compile(dsl, 'life');
        const components = (messages[0] as any).createSurface.components as Array<
          Record<string, unknown>
        >;
        const stepper = components.find((c) => c.id === 's');
        expect(stepper).toMatchObject({
          id: 's',
          component: 'Stepper',
          catalogId: 'https://a2ui.org/specification/v1_0/catalogs/status/catalog.json',
          steps: { '@path': '/steps' },
          current: { '@path': '/cur' },
        });
        expect(components.find((c) => c.id === 'v')).toMatchObject({
          component: 'Stepper',
          steps: [{ label: 'Plan' }, { label: 'Build' }],
          current: 1,
          tone: 'danger',
          orientation: 'vertical',
        });
        // Surfaced in the board report so the verifier can compare it with the golden.
        console.log('[stepper-express] ' + JSON.stringify(stepper));

        const tempDir = mkdtempSync(join(tmpdir(), 'a2ui-stepper-test-'));
        try {
          const server = createServer(tempDir, {});
          const result = await handleRenderA2ui(
            { conversationId: 'conv-stepper', messages, mode: 'pane' },
            server.getState,
            server.catalogs,
            tempDir,
          );
          expect(result.isError).toBeUndefined();
          expect(server.getState('conv-stepper').hasSurface('life')).toBe(true);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } finally {
        worker.dispose();
      }
    }, 90_000);
  },
);
