// Copies the Python Express worker and the basic catalog JSON next to the bundled server
// so the installed plugin (plugin/mcp/dist) is self-contained.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const dist = resolve(pkgRoot, 'dist');

mkdirSync(dist, { recursive: true });
cpSync(resolve(pkgRoot, 'python', 'express_worker.py'), resolve(dist, 'express_worker.py'));
cpSync(resolve(repoRoot, 'catalogs'), resolve(dist, 'catalogs'), { recursive: true });
console.log('[mcp-server] staged express_worker.py and catalogs/ into dist/');
