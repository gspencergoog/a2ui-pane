#!/usr/bin/env node
// Fake Express worker used by express-worker.test.ts.
// Behavior is controlled by env vars:
//   FAKE_WORKER_MODE=normal      -> answers every request
//   FAKE_WORKER_MODE=crash-once  -> exits on the first compile request, normal afterwards (tracked via a file)
//   FAKE_WORKER_MODE=crash-always-> exits on every compile request
//   FAKE_WORKER_MODE=hang        -> never answers compile requests
//   FAKE_WORKER_MODE=init-fail   -> answers init with ok:false
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_WORKER_MODE || 'normal';
const crashMarker = process.env.FAKE_WORKER_CRASH_MARKER || '';
let workerVersion = 'v1.0';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({ id: null, ok: false, error: { kind: 'BadRequest', message: 'bad json' } }) +
        '\n',
    );
    return;
  }
  if (req.op === 'init') {
    workerVersion = req.version || 'v1.0';
    if (mode === 'init-exit') {
      process.exit(2);
    }
    if (mode === 'init-slow') {
      setTimeout(() => {
        process.stdout.write(
          JSON.stringify({
            id: req.id,
            ok: true,
            version: workerVersion,
            componentCount: 19,
            catalogId: 'basic',
            catalogIds: ['basic', 'charts'],
          }) + '\n',
        );
      }, 120);
      return;
    }
    if (mode === 'init-fail') {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: { kind: 'ImportError', message: 'No module named a2ui' },
        }) + '\n',
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({
        id: req.id,
        ok: true,
        version: workerVersion,
        componentCount: 19,
        catalogId: 'basic',
        catalogIds: ['basic', 'charts'],
      }) + '\n',
    );
    return;
  }
  if (req.op === 'ping') {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, initialized: true }) + '\n');
    return;
  }
  if (req.op === 'compile') {
    const msgVersion = req.version || workerVersion || 'v1.0';
    if (mode === 'crash-always') process.exit(3);
    if (mode === 'crash-once' && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, 'crashed');
      process.exit(3);
    }
    if (mode === 'hang') return;
    if (String(req.dsl).includes('BAD')) {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: {
            kind: 'ExpressParseError',
            message: 'Syntax error at line 2:5: oops',
            line: 2,
            column: 5,
          },
        }) + '\n',
      );
      return;
    }
    if (String(req.dsl).includes('HELPME')) {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: {
            kind: 'ExpressCompilerError',
            message: "Property 'foo' is not a valid property of component 'Text'.",
            help: "Component 'Text' accepts properties: text, variant",
          },
        }) + '\n',
      );
      return;
    }
    // A block of only `$/key = <json>` lines mimics the compiler's data-only output:
    // a single root-path updateDataModel carrying every assigned top-level key.
    const dataLines = String(req.dsl)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (dataLines.length > 0 && dataLines.every((l) => /^\$\/[A-Za-z0-9_]+\s*=/.test(l))) {
      const value = {};
      for (const l of dataLines) {
        const m = /^\$\/([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(l);
        value[m[1]] = JSON.parse(m[2]);
      }
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: true,
          messages: [
            {
              version: msgVersion,
              updateDataModel: { surfaceId: req.surfaceId || 'main', path: '/', value },
            },
          ],
        }) + '\n',
      );
      return;
    }
    if (msgVersion === 'v0.9') {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: true,
          messages: [
            {
              version: 'v0.9',
              createSurface: { surfaceId: req.surfaceId || 'main', catalogId: 'basic' },
            },
            {
              version: 'v0.9',
              updateComponents: {
                surfaceId: req.surfaceId || 'main',
                components: [{ id: 'root', component: 'Text', text: String(req.dsl).slice(0, 20) }],
              },
            },
            {
              version: 'v0.9',
              updateDataModel: {
                surfaceId: req.surfaceId || 'main',
                path: '/',
                value: { title: 'Default title', note: '' },
              },
            },
          ],
        }) + '\n',
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({
        id: req.id,
        ok: true,
        messages: [
          {
            version: 'v1.0',
            createSurface: {
              surfaceId: req.surfaceId || 'main',
              components: [
                {
                  id: 'root',
                  component: 'Text',
                  catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
                  text: String(req.dsl).slice(0, 20),
                },
              ],
              dataModel: { title: 'Default title', note: '' },
            },
          },
        ],
      }) + '\n',
    );
    return;
  }
  if (req.op === 'instructions') {
    process.stdout.write(
      JSON.stringify({ id: req.id, ok: true, text: '# Fake Express Contract' }) + '\n',
    );
    return;
  }
  if (req.op === 'decompile') {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, text: 'root = Text("x")' }) + '\n');
    return;
  }
  if (req.op === 'synthesize') {
    if (req.intent === 'ABSTAIN') {
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: true,
          messages: [],
          stage: 'abstain_fallback',
          confidence: 0.1,
          entropy: 0.9,
          dsl: '',
          fallbackSource: null,
          selectedTemplateId: null,
        }) + '\n',
      );
      return;
    }
    // Mirrors DecisionRenderTool: a JSON-string payload is decoded, and an
    // abstention with fallbackDsl (or the default card) still yields messages.
    const payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : req.payload || {};
    const fallbackSource =
      req.intent === 'ABSTAIN_WITH_FALLBACK' ? (req.fallbackDsl ? 'fallback_dsl' : 'fallback_card') : null;
    const stage = fallbackSource ? 'abstain_fallback' : 'fast_1pass_leaf';
    const confidence = fallbackSource ? 0.1 : 0.95;
    const msgVersion = req.version || workerVersion || 'v1.0';
    const surfaceId = req.surfaceId || 'main';
    const text = `Synthesized: ${req.intent}`;
    const messages =
      msgVersion === 'v0.9'
        ? [
            { version: 'v0.9', createSurface: { surfaceId, catalogId: 'basic' } },
            {
              version: 'v0.9',
              updateComponents: {
                surfaceId,
                components: [{ id: 'root', component: 'Text', text }],
              },
            },
          ]
        : [
            {
              version: 'v1.0',
              createSurface: {
                surfaceId,
                components: [
                  {
                    id: 'root',
                    component: 'Text',
                    catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
                    text,
                  },
                ],
                dataModel: payload,
              },
            },
          ];
    process.stdout.write(
      JSON.stringify({
        id: req.id,
        ok: true,
        messages,
        stage,
        confidence,
        entropy: fallbackSource ? 0.9 : 0.05,
        dsl: `surface("${surfaceId}")\nroot = Text("${text}")`,
        fallbackSource,
        selectedTemplateId: null,
      }) + '\n',
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      id: req.id,
      ok: false,
      error: { kind: 'UnknownOp', message: `Unknown op ${req.op}` },
    }) + '\n',
  );
});
