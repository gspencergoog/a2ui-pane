import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { basicCatalog as v1BasicCatalog } from '@a2ui/web_core/v1_0';
import { chartsSchemaCatalog, statusSchemaCatalog } from '@a2ui-pane/renderer';
import { ExpressWorker } from '../src/express-worker.js';
import { TemplateRegistry } from '../src/template-registry.js';
import { mergeRootDataUpdates } from '../src/tools/render.js';
import { checkChoicePresets, formatPresetErrors } from '../src/choice-presets.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'plugin', 'skills', 'genui', 'templates');
const FIXTURES_DIR = resolve(__dirname, 'fixtures', 'templates');
const CATALOG = resolve(REPO_ROOT, 'catalogs', 'v1_0', 'basic', 'catalog.json');
const CHARTS_CATALOG = resolve(REPO_ROOT, 'catalogs', 'v1_0', 'charts', 'catalog.json');
const STATUS_CATALOG = resolve(REPO_ROOT, 'catalogs', 'v1_0', 'status', 'catalog.json');
const WORKER = resolve(__dirname, '..', 'python', 'express_worker.py');

const pythonBin = process.env.A2UI_PANE_PYTHON;
const agentSdkPath = process.env.A2UI_PANE_AGENT_SDK_PATH;
const UPDATE = process.env.UPDATE_GOLDENS === '1';

const EXPECTED_TEMPLATES = [
  'assumption_ledger',
  'comparison_matrix',
  'confirm_gate',
  'consequence_cards',
  'contract_workbench',
  'decision_batch',
  'metrics_dashboard',
  'plan_overview',
  'progress_board',
  'scorecard',
  'stack_board',
  'state_walkthrough',
  'status_matrix',
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
      catalogPaths: [CATALOG, CHARTS_CATALOG, STATUS_CATALOG],
      startupTimeoutMs: 60_000,
      log: () => {},
    });
  });

  afterAll(() => worker.dispose());

  function validate(messages: unknown[]): void {
    const processor = new MessageProcessor(
      [v1BasicCatalog as any, chartsSchemaCatalog as any, statusSchemaCatalog as any],
      () => {},
      {
        validationConfig: {
          allowUnknownElements: false,
          allowOrphanComponents: false,
          allowDanglingReferences: false,
          allowMissingRoot: false,
        },
      },
    );
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
    const dataModel =
      (messages[0] as any).createSurface?.dataModel ??
      (messages.find((m: any) => m.updateDataModel) as any)?.updateDataModel?.value;
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

  it('compiles progress_board cleanly when caller items omit optional tone', async () => {
    const legacyCallerDsl =
      '$/items = [{status: "⏳", label: "Step 1", detail: "Waiting for review"}]';
    const messages = await worker.compile(
      registry.inflate('progress_board', 'legacy_board', { callerDsl: legacyCallerDsl }),
      'legacy_board',
    );
    expect(() => validate(messages)).not.toThrow();
  });

  it('compiles consequence_cards cleanly when caller options omit optional badge, tone, and trace', async () => {
    const legacyCallerDsl =
      '$/options = [{title: "**Option A**", impact: "Impact: 1 file", tradeoff: "Tradeoff: none"}]';
    const messages = await worker.compile(
      registry.inflate('consequence_cards', 'legacy_fork', { callerDsl: legacyCallerDsl }),
      'legacy_fork',
    );
    expect(() => validate(messages)).not.toThrow();
  });

  it('compiles consequence_cards and comparison_matrix with combined multi-select choices', async () => {
    const forkCallerDsl = [
      '$/options = [{title: "**Option A**", impact: "Impact A", tradeoff: "Tradeoff A"}, {title: "**Option B**", impact: "Impact B", tradeoff: "Tradeoff B"}]',
      '$/choice = ["a", "b"]',
    ].join('\n');
    const forkMessages = await worker.compile(
      registry.inflate('consequence_cards', 'combined_fork', { callerDsl: forkCallerDsl }),
      'combined_fork',
    );
    expect(() => validate(forkMessages)).not.toThrow();

    const matrixCallerDsl = [
      '$/rows = [{criterion: "Latency", o1: {text: "Fast", tone: "success"}, o2: {text: "Medium", tone: "info"}, o3: {text: "Slow", tone: "warning"}}]',
      '$/choice = ["o1", "o2"]',
    ].join('\n');
    const matrixMessages = await worker.compile(
      registry.inflate('comparison_matrix', 'combined_matrix', { callerDsl: matrixCallerDsl }),
      'combined_matrix',
    );
    expect(() => validate(matrixMessages)).not.toThrow();
  });

  it('compiles and validates every standalone surface recipe in references/templates.md', async () => {
    const templatesDoc = readFileSync(
      resolve(REPO_ROOT, 'plugin', 'skills', 'genui', 'references', 'templates.md'),
      'utf8',
    );
    const blocks = Array.from(
      templatesDoc.matchAll(/```text\n(surface\([\s\S]*?)```/g),
      (m) => m[1],
    );
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < blocks.length; i++) {
      const idMatch = blocks[i].match(/^surface\("([^"]+)"/);
      const surfaceId = idMatch ? idMatch[1] : `recipe_${i}`;
      const messages = await worker.compile(blocks[i], surfaceId);
      expect(() => validate(messages), `recipe #${i + 1} (${surfaceId})`).not.toThrow();
    }
  });

  it('compiles a data-only block to leaf-path updates that mergeRootDataUpdates preserves', async () => {
    const messages = await worker.compile('$/title = "### New"\n$/note = "x"', 'live');
    expect(messages).toEqual([
      {
        version: '1.0',
        updateDataModel: { surfaceId: 'live', path: '/title', value: '### New' },
      },
      {
        version: '1.0',
        updateDataModel: { surfaceId: 'live', path: '/note', value: 'x' },
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

  it('passes the choice preset check for every template fixture', async () => {
    for (const id of EXPECTED_TEMPLATES) {
      const callerDsl = readFileSync(resolve(FIXTURES_DIR, `${id}.data.a2ui`), 'utf-8');
      const messages = await worker.compile(registry.inflate(id, id, { callerDsl }), id);
      const report = checkChoicePresets(messages);
      expect(formatPresetErrors(report), id).toBeUndefined();
      expect(report.wrapped, id).toEqual([]);
    }
  }, 60_000);

  it('catches scalar decision_batch choices and unknown triage_matrix buckets after compiling', async () => {
    const decision = await worker.compile(
      registry.inflate('decision_batch', 'd', {
        callerDsl:
          '$/items = [{prompt: "Budget", hint: "", options: [{value: "120", label: "120"}, {value: "80", label: "80"}], choice: "120"}]',
      }),
      'd',
    );
    const decisionReport = checkChoicePresets(decision);
    expect(decisionReport.wrapped).toMatchObject([{ path: '/items/0/choice', value: '120' }]);
    expect(formatPresetErrors(decisionReport)).toBeUndefined();

    const triage = await worker.compile(
      registry.inflate('triage_matrix', 't', {
        callerDsl:
          '$/items = [{icon: "error", title: "F1", summary: "s", trace: "", bucket: ["Apply"], note: ""}]',
      }),
      't',
    );
    expect(formatPresetErrors(checkChoicePresets(triage))).toContain(
      '"Apply" is not one of [p0, p1, out]',
    );

    const customized = await worker.compile(
      registry.inflate('triage_matrix', 't', {
        callerDsl:
          '$/items = [{icon: "error", title: "F1", summary: "s", trace: "", bucket: ["apply"], note: ""}]\n' +
          'bucket_picker = ChoicePicker(_, "mutuallyExclusive", [{label: "Apply", value: "apply"}, {label: "Reject", value: "reject"}], $bucket, "chips")',
      }),
      't',
    );
    expect(formatPresetErrors(checkChoicePresets(customized))).toBeUndefined();
  }, 60_000);

  it('has no stray fixture files', () => {
    const names = readdirSync(FIXTURES_DIR).filter((n) => !n.startsWith('.'));
    for (const name of names) {
      const id = name.replace(/\.(data\.a2ui|golden\.json)$/, '');
      expect(EXPECTED_TEMPLATES, name).toContain(id);
    }
  });
});
