import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MessageProcessor, basicCatalog } from '@a2ui/web_core/v0_9';
import { ExpressWorker } from '../src/express-worker.js';
import { TemplateRegistry } from '../src/template-registry.js';
import { mergeRootDataUpdates } from '../src/tools/render.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'plugin', 'skills', 'genui', 'templates');
const FIXTURES_DIR = resolve(__dirname, 'fixtures', 'templates');
const CATALOG = resolve(REPO_ROOT, 'catalogs', 'v0_9_1', 'basic', 'catalog.json');
const WORKER = resolve(__dirname, '..', 'python', 'express_worker.py');

const pythonBin = process.env.A2UI_PANE_PYTHON;
const agentSdkPath = process.env.A2UI_PANE_AGENT_SDK_PATH;
const UPDATE = process.env.UPDATE_GOLDENS === '1';

const EXPECTED_TEMPLATES = [
  'assumption_ledger',
  'confirm_gate',
  'consequence_cards',
  'contract_workbench',
  'progress_board',
  'state_walkthrough',
  'triage_matrix',
  'wave_sequencer',
];

describe('bundled genui templates (registry only)', () => {
  const registry = new TemplateRegistry([{ dir: TEMPLATES_DIR, source: 'plugin' }], () => {});

  it('registers every expected template with a header', () => {
    expect(registry.list().map((e) => e.id)).toEqual(EXPECTED_TEMPLATES);
    for (const entry of registry.list()) {
      expect(entry.summary, entry.id).not.toBe('');
      expect(entry.dataKeys.length, entry.id).toBeGreaterThan(0);
      expect(entry.action, entry.id).toMatch(/^[a-z_]+$/);
      expect(['inline', 'pane', 'either']).toContain(entry.surface);
    }
  });

  it('has a data fixture for every template', () => {
    for (const id of EXPECTED_TEMPLATES) {
      expect(existsSync(resolve(FIXTURES_DIR, `${id}.data.a2ui`)), id).toBe(true);
    }
  });
});

describe.skipIf(!pythonBin && !agentSdkPath)('bundled genui templates (compiled goldens)', () => {
  let worker: ExpressWorker;
  const registry = new TemplateRegistry([{ dir: TEMPLATES_DIR, source: 'plugin' }], () => {});

  beforeAll(() => {
    worker = new ExpressWorker({
      pythonBin,
      agentSdkPath,
      uvBin: process.env.A2UI_PANE_UV,
      workerScript: WORKER,
      catalogPath: CATALOG,
      startupTimeoutMs: 60_000,
      log: () => {},
    });
  });

  afterAll(() => worker.dispose());

  function validate(messages: unknown[]): void {
    const processor = new MessageProcessor([basicCatalog as any], () => {}, {
      validationConfig: {
        allowUnknownElements: false,
        allowOrphanComponents: false,
        allowDanglingReferences: false,
        allowMissingRoot: false,
      },
    });
    processor.processMessages(messages as any);
  }

  for (const id of EXPECTED_TEMPLATES) {
    it(`compiles ${id} with defaults and with fixture data`, async () => {
      const defaults = await worker.compile(registry.inflate(id, id), id);
      validate(defaults);

      const callerDsl = readFileSync(resolve(FIXTURES_DIR, `${id}.data.a2ui`), 'utf-8');
      const messages = await worker.compile(registry.inflate(id, id, { callerDsl }), id);
      validate(messages);

      const createSurface = (messages[0] as any).createSurface;
      expect(createSurface).toMatchObject({ surfaceId: id, sendDataModel: true });

      const goldenPath = resolve(FIXTURES_DIR, `${id}.golden.json`);
      const actual = JSON.stringify(messages, null, 2) + '\n';
      if (UPDATE || !existsSync(goldenPath)) {
        mkdirSync(FIXTURES_DIR, { recursive: true });
        writeFileSync(goldenPath, actual);
      }
      expect(actual).toBe(readFileSync(goldenPath, 'utf-8'));
    }, 60_000);
  }

  it('lets caller data override a template default', async () => {
    const messages = await worker.compile(
      registry.inflate('confirm_gate', 'g', { callerDsl: '$/title = "### Custom"' }),
      'g',
    );
    const dataModel = (messages.find((m: any) => m.updateDataModel) as any).updateDataModel.value;
    expect(dataModel.title).toBe('### Custom');
    expect(dataModel.confirmed).toBe(false);
  });

  it('lets a caller redefine a Customize button without orphaning a label', async () => {
    const buttons: Array<[string, string]> = [
      ['assumption_ledger', 'submit_btn = Button(Text("Ship it"), "primary", Event("ship"))'],
      ['confirm_gate', 'confirm_btn = Button(Text("Go"), "primary", Event("go"))'],
      ['confirm_gate', 'cancel_btn = Button(Text("Nope"), _, Event("nope"))'],
      ['progress_board', 'ack_btn = Button(Text("Seen"), _, Event("seen"))'],
    ];
    for (const [id, callerDsl] of buttons) {
      const messages = await worker.compile(registry.inflate(id, id, { callerDsl }), id);
      expect(() => validate(messages), `${id}: ${callerDsl}`).not.toThrow();
    }
  });

  it('compiles a data-only block to a root-path update that mergeRootDataUpdates splits', async () => {
    const messages = await worker.compile('$/title = "### New"\n$/note = "x"', 'live');
    expect(messages).toEqual([
      {
        version: 'v0.9',
        updateDataModel: { surfaceId: 'live', path: '/', value: { title: '### New', note: 'x' } },
      },
    ]);
    expect(mergeRootDataUpdates(messages, () => true).map((m: any) => m.updateDataModel)).toEqual([
      { surfaceId: 'live', path: '/title', value: '### New' },
      { surfaceId: 'live', path: '/note', value: 'x' },
    ]);
  });

  it("forwards the compiler's help hint on an invalid property", async () => {
    await expect(worker.compile('root = Text("x", nope="y")', 'h')).rejects.toMatchObject({
      detail: { kind: 'ExpressUnknownPropertyError', help: expect.stringContaining('Text') },
    });
  });

  it('has no stray fixture files', () => {
    const names = readdirSync(FIXTURES_DIR).filter((n) => !n.startsWith('.'));
    for (const name of names) {
      const id = name.replace(/\.(data\.a2ui|golden\.json)$/, '');
      expect(EXPECTED_TEMPLATES, name).toContain(id);
    }
  });
});
