import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { basicCatalog as v1BasicCatalog } from '@a2ui/web_core/v1_0';
import { chartsSchemaCatalog, statusSchemaCatalog } from '@a2ui-pane/renderer';
import {
  ExpressWorker,
  ExpressWorkerError,
  ExpressWorkerUnavailableError,
  buildSpawnArgs,
  DEFAULT_AGENT_SDK_SPEC,
} from '../src/express-worker.js';

const FAKE = resolve(__dirname, 'fixtures', 'fake_worker.mjs');
const REAL_WORKER = resolve(__dirname, '..', 'python', 'express_worker.py');
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

function fakeWorker(
  mode: string,
  extra: Partial<ConstructorParameters<typeof ExpressWorker>[0]> = {},
) {
  const logs: string[] = [];
  const worker = new ExpressWorker({
    pythonBin: process.execPath,
    workerScript: FAKE,
    catalogPath: CATALOG,
    requestTimeoutMs: 400,
    startupTimeoutMs: 5000,
    log: (l) => logs.push(l),
    spawnFn: ((cmd: string, args: string[], opts: any) =>
      spawn(cmd, args, {
        ...opts,
        env: { ...process.env, FAKE_WORKER_MODE: mode, ...(extra as any).env },
      })) as any,
    ...extra,
  });
  return { worker, logs };
}

describe('buildSpawnArgs', () => {
  it('prefers a resolved interpreter', () => {
    expect(
      buildSpawnArgs({ pythonBin: '/venv/bin/python', workerScript: '/w.py', catalogPath: '/c' }),
    ).toEqual({
      command: '/venv/bin/python',
      args: ['/w.py'],
    });
  });

  it('uses uv --project for a local checkout and treats empty strings as unset', () => {
    expect(
      buildSpawnArgs({
        pythonBin: '',
        uvBin: '/bin/uv',
        agentSdkPath: '/a2ui',
        workerScript: '/w.py',
        catalogPath: '/c',
      }),
    ).toEqual({
      command: '/bin/uv',
      args: [
        'run',
        '--project',
        '/a2ui',
        '--package',
        'a2ui-agent-sdk',
        '--no-sync',
        'python',
        '/w.py',
      ],
    });
  });

  it('falls back to uv --with the published SDK', () => {
    expect(buildSpawnArgs({ workerScript: '/w.py', catalogPath: '/c' })).toEqual({
      command: 'uv',
      args: ['run', '--with', DEFAULT_AGENT_SDK_SPEC, 'python', '/w.py'],
    });
  });
});

describe('ExpressWorker (fake child)', () => {
  const workers: ExpressWorker[] = [];
  afterEach(() => {
    for (const w of workers.splice(0)) w.dispose();
  });

  it('initializes lazily, compiles, serves instructions, and keeps request order', async () => {
    const { worker, logs } = fakeWorker('normal');
    workers.push(worker);
    expect(await worker.isAvailable()).toBe(true);
    const [a, b, text] = await Promise.all([
      worker.compile('root = Text("a")', 'one'),
      worker.compile('root = Text("b")', 'two'),
      worker.instructions(),
    ]);
    expect((a[0] as any).createSurface.surfaceId).toBe('one');
    expect((b[0] as any).createSurface.surfaceId).toBe('two');
    expect(text).toBe('# Fake Express Contract');
    expect(logs.some((l) => l.startsWith('ready'))).toBe(true);
  });

  it('surfaces compile errors with line and column', async () => {
    const { worker } = fakeWorker('normal');
    workers.push(worker);
    await expect(worker.compile('BAD', 'main')).rejects.toMatchObject({
      name: 'ExpressWorkerError',
      detail: { kind: 'ExpressParseError', line: 2, column: 5 },
    });
  });

  it('restarts once after a crash and retries the in-flight request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-worker-'));
    const marker = join(dir, 'crashed');
    const { worker, logs } = fakeWorker('crash-once', {
      env: { FAKE_WORKER_CRASH_MARKER: marker },
    } as any);
    workers.push(worker);
    const msgs = await worker.compile('root = Text("after crash")', 'main');
    expect((msgs[0] as any).createSurface.surfaceId).toBe('main');
    expect(existsSync(marker)).toBe(true);
    expect(logs.some((l) => l.includes('restarting and retrying'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives up after the second crash with an unavailable error', async () => {
    const { worker } = fakeWorker('crash-always');
    workers.push(worker);
    await expect(worker.compile('root = Text("x")', 'main')).rejects.toBeInstanceOf(
      ExpressWorkerUnavailableError,
    );
  });

  it('times out a hung request and recovers', async () => {
    const { worker } = fakeWorker('hang');
    workers.push(worker);
    await expect(worker.compile('root = Text("x")', 'main')).rejects.toBeInstanceOf(
      ExpressWorkerUnavailableError,
    );
  });

  it('reports init failures as unavailable and memoizes the reason', async () => {
    const { worker } = fakeWorker('init-fail');
    workers.push(worker);
    expect(await worker.isAvailable()).toBe(false);
    expect(worker.unavailableMessage).toContain('No module named a2ui');
    await expect(worker.compile('root = Text("x")', 'main')).rejects.toBeInstanceOf(
      ExpressWorkerUnavailableError,
    );
  });

  it('fails fast without respawn-looping if the child exits during init', async () => {
    const { worker, logs } = fakeWorker('init-exit', { startupTimeoutMs: 2000 });
    workers.push(worker);
    expect(await worker.isAvailable()).toBe(false);
    expect(worker.unavailableMessage).toContain('Express worker exited');
    expect(logs.filter((l) => l.startsWith('starting:')).length).toBe(1);
  });

  it('uses startupTimeoutMs rather than requestTimeoutMs for init', async () => {
    const { worker } = fakeWorker('init-slow', {
      requestTimeoutMs: 50,
      startupTimeoutMs: 1000,
    });
    workers.push(worker);
    expect(await worker.isAvailable()).toBe(true);
  });

  it('reports a missing executable as unavailable', async () => {
    const worker = new ExpressWorker({
      pythonBin: '/nonexistent/python',
      workerScript: FAKE,
      catalogPath: CATALOG,
      log: () => {},
    });
    workers.push(worker);
    expect(await worker.isAvailable()).toBe(false);
    expect(worker.unavailableMessage).toContain('failed to spawn');
  });

  it('rejects queued requests on dispose', async () => {
    const { worker } = fakeWorker('hang', { requestTimeoutMs: 60_000 });
    const pending = worker.compile('root = Text("x")', 'main');
    await worker.isAvailable();
    worker.dispose();
    await expect(pending).rejects.toBeInstanceOf(ExpressWorkerUnavailableError);
    expect(await worker.isAvailable()).toBe(false);
  });

  it('synthesizes UI using the fake worker', async () => {
    const { worker } = fakeWorker('normal');
    const res = await worker.synthesize('Show invoice status', { amount: 100 });
    expect(res.stage).toBe('fast_1pass_leaf');
    expect(res.confidence).toBe(0.95);
    expect(res.messages).toHaveLength(1);
    expect(res.dsl).toContain('Show invoice status');
    expect(res.fallbackSource).toBeNull();
    expect(res.selectedTemplateId).toBeNull();
    worker.dispose();
  });

  it('passes a JSON-string payload and fallbackDsl through to the worker', async () => {
    const { worker } = fakeWorker('normal');
    const res = await worker.synthesize(
      'ABSTAIN_WITH_FALLBACK',
      '{"amount": 100}',
      'inv',
      'root = Text("fallback")',
    );
    expect(res.stage).toBe('abstain_fallback');
    expect(res.fallbackSource).toBe('fallback_dsl');
    expect(res.messages).toHaveLength(1);
    worker.dispose();
  });
});

const realPython = process.env.A2UI_PANE_PYTHON;
const agentSdkPath = process.env.A2UI_PANE_AGENT_SDK_PATH;

describe.skipIf(!realPython && !agentSdkPath)('ExpressWorker (real Python SDK)', () => {
  it('compiles Express to valid v1.0 messages across basic + charts + status catalogs', async () => {
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
        'surface("real", sendDataModel=true)',
        '$/items = [{title: "A", done: true, tone: "success"}]',
        '$/series = [{name: "P95", values: [12, 18, 15]}]',
        'root = Card(Column([Text("## Hi"), ProgressBar(items=$/items), Collapsible("Details", Badge("OK", "success")), Chart("bar", $/series, labels=["Q1", "Q2", "Q3"]), Column(_template($/items, CheckBox($title, $done)))]))',
      ].join('\n');
      const messages = await worker.compile(dsl, 'real');
      const processor = new MessageProcessor(
        [v1BasicCatalog as any, chartsSchemaCatalog as any, statusSchemaCatalog as any],
        () => {},
        {
          validationConfig: { allowUnknownElements: false },
        },
      );
      processor.processMessages(messages as any);
      expect(processor.getSurfaces().has('real')).toBe(true);
      await expect(worker.compile('root = Card(', 'x')).rejects.toBeInstanceOf(ExpressWorkerError);
      const prompt = await worker.instructions();
      expect(prompt).toContain('A2UI Express');
      expect(prompt).toContain('Chart');
      expect(prompt).toContain('Badge');
    } finally {
      worker.dispose();
    }
  }, 90_000);
});
