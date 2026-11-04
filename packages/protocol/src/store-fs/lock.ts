import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, FILE_MODE, LOCK_FILE_NAME } from './layout.js';

/** Options for the conversation lock. */
export interface LockOptions {
  /** How long to keep retrying before throwing `StoreLockError`. Default 2000 ms. */
  lockTimeoutMs?: number;
  /** Age (by lock file mtime) after which a lock is considered abandoned. Default 10000 ms. */
  staleLockMs?: number;
}

/** Default time to wait for a lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 2000;

/** Default lock age after which a waiter may steal the lock. */
export const DEFAULT_STALE_LOCK_MS = 10_000;

const RETRY_INTERVAL_MS = 5;

/** Thrown when the conversation lock cannot be taken before the timeout. */
export class StoreLockError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for store lock ${lockPath}`);
    this.name = 'StoreLockError';
  }
}

/** Result of one attempt: the holder token, `retryNow` after a steal, or `wait`. */
type Attempt = { token: string } | 'retryNow' | 'wait';

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** Suffix of the guard file that serializes stale-lock removal. */
export const STEAL_GUARD_SUFFIX = '.steal';

/** Whether the file's mtime is older than `staleLockMs`; false when it is missing. */
function isStale(path: string, staleLockMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleLockMs;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
}

/** Creates `path` with O_EXCL. Returns false when it already exists. */
function createExclusive(path: string): boolean {
  try {
    closeSync(openSync(path, 'wx', FILE_MODE));
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Removes a stale lock. Only the holder of the `.lock.steal` guard (itself an
 * O_EXCL file) may unlink `.lock`, and it re-checks staleness while holding the
 * guard. Holders never refresh the lock's mtime, so a lock that is stale under
 * the guard cannot be a fresh one: no other process can replace `.lock` until
 * it is gone. A guard older than `staleLockMs` belongs to a waiter that died
 * mid-steal and is removed.
 *
 * @returns `retryNow` after removing the stale lock, `wait` otherwise.
 */
function stealIfStale(lockPath: string, staleLockMs: number): 'retryNow' | 'wait' {
  if (!isStale(lockPath, staleLockMs)) return 'wait';
  const guard = `${lockPath}${STEAL_GUARD_SUFFIX}`;
  if (!createExclusive(guard)) {
    if (isStale(guard, staleLockMs)) unlinkQuietly(guard);
    return 'wait';
  }
  try {
    if (!isStale(lockPath, staleLockMs)) return 'wait';
    unlinkQuietly(lockPath);
    return 'retryNow';
  } finally {
    unlinkQuietly(guard);
  }
}

function createLock(lockPath: string): string {
  const token = randomBytes(8).toString('hex');
  const fd = openSync(lockPath, 'wx', FILE_MODE);
  try {
    writeSync(fd, `${process.pid} ${new Date().toISOString()} ${token}\n`);
  } finally {
    closeSync(fd);
  }
  return token;
}

/** One attempt to take the lock at `lockPath`. Shared by the sync and async variants. */
function tryAcquire(lockPath: string, staleLockMs: number): Attempt {
  try {
    return { token: createLock(lockPath) };
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
  return stealIfStale(lockPath, staleLockMs);
}

/** Unlinks the lock only if it still holds `token`. */
function release(lockPath: string, token: string): void {
  let content: string;
  try {
    content = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  if (content.includes(token)) {
    unlinkQuietly(lockPath);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveOptions(opts?: LockOptions): Required<LockOptions> {
  return {
    lockTimeoutMs: opts?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs: opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
  };
}

/**
 * Runs `fn` while holding `<dir>/.lock`, creating `dir` if needed. Waits
 * synchronously between attempts, so use it only in short-lived writer
 * processes such as MCP tool calls.
 *
 * @throws {StoreLockError} If the lock is not taken within `lockTimeoutMs`.
 */
export function withConversationLock<T>(dir: string, fn: () => T, opts?: LockOptions): T {
  const { lockTimeoutMs, staleLockMs } = resolveOptions(opts);
  ensureDir(dir);
  const lockPath = join(dir, LOCK_FILE_NAME);
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    const attempt = tryAcquire(lockPath, staleLockMs);
    if (typeof attempt === 'object') {
      try {
        return fn();
      } finally {
        release(lockPath, attempt.token);
      }
    }
    if (Date.now() >= deadline) throw new StoreLockError(lockPath);
    if (attempt === 'wait') sleepSync(RETRY_INTERVAL_MS);
  }
}

/**
 * Runs `fn` while holding `<dir>/.lock`, creating `dir` if needed. Waits with
 * `setTimeout` between attempts, so a long-lived process (the sidecar) keeps
 * serving its event loop. `fn` itself runs synchronously under the lock.
 *
 * @throws {StoreLockError} If the lock is not taken within `lockTimeoutMs`.
 */
export async function withConversationLockAsync<T>(
  dir: string,
  fn: () => T,
  opts?: LockOptions,
): Promise<T> {
  const { lockTimeoutMs, staleLockMs } = resolveOptions(opts);
  ensureDir(dir);
  const lockPath = join(dir, LOCK_FILE_NAME);
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    const attempt = tryAcquire(lockPath, staleLockMs);
    if (typeof attempt === 'object') {
      try {
        return fn();
      } finally {
        release(lockPath, attempt.token);
      }
    }
    if (Date.now() >= deadline) throw new StoreLockError(lockPath);
    if (attempt === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
}
