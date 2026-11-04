import fs from 'node:fs';
import path from 'node:path';
import { LOCK_FILE_NAME } from '@a2ui-pane/protocol/store-fs';

/** Summary counts returned after sweeping stale conversation and embed files. */
export interface CleanupResult {
  /** Files and conversation directories removed. */
  deleted: number;
  errors: number;
}

/**
 * Returns the newest mtime among a directory and its direct entries. The
 * store keeps every file directly inside the conversation directory.
 */
function newestMtimeMs(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    } catch {
      // The entry vanished between readdir and lstat; the directory mtime covers it.
    }
  }
  return newest;
}

/**
 * Removes one stale entry of a swept directory. When `sweepDirs` is set, a
 * conversation directory is removed when its newest file is older than the
 * cutoff and no writer holds its lock. A flat file (legacy `*.jsonl`, `*.jsonl.migrated`, or an embed)
 * is removed when it is older than the cutoff.
 *
 * @returns Whether the entry was removed.
 */
function sweepEntry(entryPath: string, cutoffTime: number, sweepDirs: boolean): boolean {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory()) {
    if (!sweepDirs) return false;
    if (fs.existsSync(path.join(entryPath, LOCK_FILE_NAME))) return false;
    if (newestMtimeMs(entryPath) >= cutoffTime) return false;
    fs.rmSync(entryPath, { recursive: true, force: true });
    return true;
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
 * days). Conversation directories that currently hold a lock are skipped.
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
