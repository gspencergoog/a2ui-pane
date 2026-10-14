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
} from '../src/tools/render.js';
import { handleA2uiInstructions } from '../src/tools/instructions.js';

const FAKE = resolve(__dirname, 'fixtures', 'fake_worker.mjs');
const CATALOG = resolve(__dirname, '..', '..', '..', 'catalogs', 'v0_9_1', 'basic', 'catalog.json');

function fakeWorker(mode = 'normal') {
  return new ExpressWorker({
    pythonBin: process.execPath,
    workerScript: FAKE,
    catalogPath: CATALOG,
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
    expect(text).toContain("Help: Component 'Text' accepts properties: text, usageHint");
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
