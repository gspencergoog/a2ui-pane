#!/usr/bin/env node
// Manual check (not used by the test suite): compiles every template under
// plugin/skills/genui/templates with its fixture data through the real worker.
// Requires a built dist/ and a Python interpreter with the a2ui agent SDK:
//   A2UI_PANE_PYTHON=/path/to/python node packages/mcp-server/scripts/check-templates.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

const { ExpressWorker } = await import(resolve(pkgRoot, 'dist', 'server.mjs'));

const templatesDir = resolve(repoRoot, 'plugin', 'skills', 'genui', 'templates');
const fixturesDir = resolve(pkgRoot, 'tests', 'fixtures', 'templates');
const worker = new ExpressWorker({
  pythonBin: process.env.A2UI_PANE_PYTHON,
  agentSdkPath: process.env.A2UI_PANE_AGENT_SDK_PATH,
  workerScript: resolve(pkgRoot, 'python', 'express_worker.py'),
  catalogPaths: [
    resolve(repoRoot, 'catalogs', 'v1_0', 'basic', 'catalog.json'),
    resolve(repoRoot, 'catalogs', 'v1_0', 'charts', 'catalog.json'),
  ],
  log: () => {},
});

let failures = 0;
for (const name of readdirSync(templatesDir)
  .filter((n) => n.endsWith('.a2ui'))
  .sort()) {
  const id = name.replace(/\.a2ui$/, '');
  const body = readFileSync(resolve(templatesDir, name), 'utf-8');
  const fixture = resolve(fixturesDir, `${id}.data.a2ui`);
  const data = existsSync(fixture) ? readFileSync(fixture, 'utf-8') : '';
  const source = `surface("${id}", sendDataModel=true)\n${body}\n${data}`;
  try {
    const messages = await worker.compile(source, id);
    console.log(`ok   ${id} (${messages.length} messages)`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${id}: ${err.detail ? JSON.stringify(err.detail) : err.message}`);
  }
}
worker.dispose();
process.exit(failures ? 1 : 0);
