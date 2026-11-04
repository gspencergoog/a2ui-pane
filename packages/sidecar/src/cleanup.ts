import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STALE_LOCK_MS, LOCK_FILE_NAME } from '@a2ui-pane/protocol/store-fs';

/** Summary counts returned after sweeping stale conversation and embed files. */
export interface CleanupResult {
  /** Files and conversation directories removed. */
  deleted: number;
  errors: number;
}

/**
 * Prefix of the name a conversation directory is renamed to before removal.
 * It starts with `.`, so `isValidId`, the store, and the change notifier all
 * ignore it.
 */
export const TRASH_PREFIX = '.trash-';

/** Lock files whose presence means a writer is active: the lock and its steal guard. */
const LOCK_NAMES = [LOCK_FILE_NAME, `${LOCK_FILE_NAME}.steal`];

/** Returns the file's mtime, or undefined when it does not exist. */
function mtimeOf(file: string): number | undefined {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Whether a writer holds the conversation lock. A lock (or steal guard)
 * older than `DEFAULT_STALE_LOCK_MS` was abandoned by a crashed writer, and
 * the store's own lock would steal it, so it does not count.
 */
function isLocked(dir: string): boolean {
  const freshAfter = Date.now() - DEFAULT_STALE_LOCK_MS;
  return LOCK_NAMES.some((name) => (mtimeOf(path.join(dir, name)) ?? -Infinity) > freshAfter);
}

/**
 * Returns the newest mtime among a directory's direct entries, and the
 * directory itself when `includeDir` is set. The store keeps every file
 * directly inside the conversation directory.
 */
function newestMtimeMs(dir: string, includeDir: boolean): number {
  let newest = includeDir ? fs.statSync(dir).mtimeMs : -Infinity;
  for (const name of fs.readdirSync(dir)) {
    newest = Math.max(newest, mtimeOf(path.join(dir, name)) ?? newest);
  }
  return newest;
}

/**
 * Whether a conversation directory may be removed: unlocked and idle since the
 * cutoff. The re-check after the trash rename passes `includeDir: false`,
 * because the rename itself may touch the directory's own mtime.
 */
function isRemovable(dir: string, cutoffTime: number, includeDir = true): boolean {
  return !isLocked(dir) && newestMtimeMs(dir, includeDir) < cutoffTime;
}

/**
 * Removes a stale conversation directory without racing a writer. The
 * directory is first renamed to a trash name, which writers never open, and
 * re-checked there: a writer that took the lock between the first check and
 * the rename makes the re-check fail, and the directory is renamed back.
 * Leftover trash directories from an interrupted sweep are removed directly.
 *
 * @returns Whether the directory was removed.
 */
function sweepConversationDir(dir: string, cutoffTime: number): boolean {
  if (!isRemovable(dir, cutoffTime)) return false;
  if (path.basename(dir).startsWith(TRASH_PREFIX)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  const trash = path.join(path.dirname(dir), `${TRASH_PREFIX}${randomBytes(6).toString('hex')}`);
  fs.renameSync(dir, trash);
  if (!isRemovable(trash, cutoffTime, false)) {
    fs.renameSync(trash, dir);
    return false;
  }
  fs.rmSync(trash, { recursive: true, force: true });
  return true;
}

/**
 * Removes one stale entry of a swept directory. When `sweepDirs` is set, a
 * conversation directory is removed through `sweepConversationDir`. A flat
 * file (legacy `*.jsonl`, `*.jsonl.migrated`, or an embed) is removed when it
 * is older than the cutoff.
 *
 * @returns Whether the entry was removed.
 */
function sweepEntry(entryPath: string, cutoffTime: number, sweepDirs: boolean): boolean {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory()) {
    return sweepDirs && sweepConversationDir(entryPath, cutoffTime);
  }
  if (stat.isFile() && stat.mtimeMs < cutoffTime) {
    fs.unlinkSync(entryPath);
    return true;
  }
  return false;
}

function sweepDir(
  dir: string,
  cutoffTime: number,
  sweepDirs: boolean,
  result: CleanupResult,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (dirErr) {
    console.error(`[cleanup] Failed reading directory ${dir}:`, dirErr);
    result.errors++;
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    try {
      if (sweepEntry(entryPath, cutoffTime, sweepDirs)) result.deleted++;
    } catch (entryErr) {
      console.error(`[cleanup] Failed to delete stale entry ${entryPath}:`, entryErr);
      result.errors++;
    }
  }
}

/**
 * Removes conversation store directories and flat files, and top-level embed
 * files, that have not been modified within the retention window (default 30
 * days). Conversation directories whose lock a writer currently holds are
 * skipped.
 */
export function cleanupOldFiles(dataDir: string, maxAgeDays = 30): CleanupResult {
  const result: CleanupResult = { deleted: 0, errors: 0 };
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  // Per-conversation embed directories are left alone, as before.
  const targets: Array<[string, boolean]> = [
    [path.join(dataDir, 'conversations'), true],
    [path.join(dataDir, 'embeds'), false],
  ];

  for (const [dir, sweepDirs] of targets) {
    if (fs.existsSync(dir)) sweepDir(dir, cutoffTime, sweepDirs, result);
  }
  return result;
}
