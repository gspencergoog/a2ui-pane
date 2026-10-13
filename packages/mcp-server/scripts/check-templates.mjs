#!/usr/bin/env node
// Compiles every template under plugin/skills/genui/templates with its fixture data and
// validates the result against the basic catalog. Used by templates.test.ts and handy
// for a quick manual check:
//   A2UI_PANE_PYTHON=/path/to/python node packages/mcp-server/scripts/check-templates.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const require = createRequire(import.meta.url);

const { ExpressWorker } = await import(resolve(pkgRoot, 'dist', 'check-templates-lib.mjs')).catch(
  () => import('../src/express-worker.ts'),
);
void require;

const templatesDir = resolve(repoRoot, 'plugin', 'skills', 'genui', 'templates');
const fixturesDir = resolve(pkgRoot, 'tests', 'fixtures', 'templates');
const worker = new ExpressWorker({
  pythonBin: process.env.A2UI_PANE_PYTHON,
  agentSdkPath: process.env.A2UI_PANE_AGENT_SDK_PATH,
  workerScript: resolve(pkgRoot, 'python', 'express_worker.py'),
  catalogPath: resolve(repoRoot, 'catalogs', 'v0_9_1', 'basic', 'catalog.json'),
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
