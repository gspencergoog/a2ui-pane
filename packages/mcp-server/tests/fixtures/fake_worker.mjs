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
        version: req.version || 'v0.9',
        componentCount: 18,
        catalogId: 'basic',
      }) + '\n',
    );
    return;
  }
  if (req.op === 'ping') {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, initialized: true }) + '\n');
    return;
  }
  if (req.op === 'compile') {
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
  process.stdout.write(
    JSON.stringify({
      id: req.id,
      ok: false,
      error: { kind: 'UnknownOp', message: `Unknown op ${req.op}` },
    }) + '\n',
  );
});
