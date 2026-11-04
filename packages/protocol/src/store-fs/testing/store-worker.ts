// Child process for surface-store.test.ts, run through vite-node so it can
// load the TypeScript sources directly. Reports its result over IPC.
import { appendFileSync } from 'node:fs';
import type { A2uiServerMessage } from '../../store.js';
import { SurfaceStore, withConversationLock } from '../index.js';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntil(startAt: number): void {
  while (Date.now() < startAt) sleepSync(1);
}

/** Commits `count` single-message batches to surface `w-<name>` and reports their seqs. */
function runCommits(
  dataDir: string,
  conversationId: string,
  name: string,
  count: number,
  startAt: number,
): { seqs: number[] } {
  const store = new SurfaceStore(dataDir, { lockTimeoutMs: 20_000 });
  const surfaceId = `w-${name}`;
  waitUntil(startAt);
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const message: A2uiServerMessage =
      i === 0
        ? { version: '1.0', createSurface: { surfaceId, catalogId: 'c', dataModel: { n: 0 } } }
        : { version: '1.0', updateDataModel: { surfaceId, path: '/n', value: i } };
    const lines = store.commit(conversationId, `call_${name}_${i}`, [message]);
    seqs.push(...lines.map((l) => l.seq));
  }
  return { seqs };
}

/** Takes the lock once and records entry and exit in `logPath`. */
function runLock(dir: string, logPath: string, holdMs: number, startAt: number): { ok: true } {
  waitUntil(startAt);
  withConversationLock(
    dir,
    () => {
      appendFileSync(logPath, `enter ${process.pid}\n`);
      sleepSync(holdMs);
      appendFileSync(logPath, `exit ${process.pid}\n`);
    },
    { lockTimeoutMs: 20_000 },
  );
  return { ok: true };
}

const [mode, ...args] = process.argv.slice(2);
let result: unknown;
if (mode === 'commit') {
  const [dataDir, conversationId, name, count, startAt] = args;
  result = runCommits(dataDir, conversationId, name, Number(count), Number(startAt));
} else if (mode === 'lock') {
  const [dir, logPath, holdMs, startAt] = args;
  result = runLock(dir, logPath, Number(holdMs), Number(startAt));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
process.send!(result, undefined, undefined, () => process.exit(0));
