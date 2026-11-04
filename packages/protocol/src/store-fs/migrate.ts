import { existsSync, readFileSync, renameSync } from 'node:fs';
import { parseStoreLine, type StoreLine } from '../store.js';
import { FoldError, foldSurfaceMessage, messageSurfaceId } from '../surface-fold.js';
import {
  conversationDir,
  isStorableSurfaceId,
  legacyFile,
  migratedFile,
  seqFile,
} from './layout.js';
import { type LockOptions, withConversationLock } from './lock.js';
import { type SnapshotLine, writeSeq, writeSurfaceLine } from './store-io.js';

interface LegacyFoldResult {
  surfaces: SnapshotLine[];
  lastSeq: number;
  skipped: number;
}

function needsMigration(dataDir: string, conversationId: string): boolean {
  return (
    existsSync(legacyFile(dataDir, conversationId)) && !existsSync(seqFile(dataDir, conversationId))
  );
}

/**
 * Folds one legacy line into `snapshots`.
 *
 * @returns false when the line was skipped (no storable surface or a fold error).
 */
function foldLegacyLine(snapshots: Map<string, SnapshotLine | null>, line: StoreLine): boolean {
  const surfaceId = messageSurfaceId(line.message);
  if (!isStorableSurfaceId(surfaceId)) return false;
  try {
    const next = foldSurfaceMessage(snapshots.get(surfaceId)?.message ?? null, line.message);
    snapshots.set(
      surfaceId,
      next && { seq: line.seq, callId: line.callId, ts: line.ts, message: next },
    );
    return true;
  } catch (err) {
    if (err instanceof FoldError) return false;
    throw err;
  }
}

function parseLegacyLine(text: string): StoreLine | undefined {
  try {
    return parseStoreLine(text);
  } catch {
    return undefined;
  }
}

/** Folds the full text of a legacy flat log into one snapshot line per live surface. */
export function foldLegacyLog(content: string): LegacyFoldResult {
  const snapshots = new Map<string, SnapshotLine | null>();
  let lastSeq = 0;
  let skipped = 0;
  for (const raw of content.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const line = parseLegacyLine(text);
    if (line) lastSeq = Math.max(lastSeq, line.seq);
    if (!line || !foldLegacyLine(snapshots, line)) skipped++;
  }
  const surfaces = [...snapshots.values()].filter((s): s is SnapshotLine => s !== null);
  return { surfaces, lastSeq, skipped };
}

function migrateUnderLock(dataDir: string, conversationId: string): boolean {
  if (!needsMigration(dataDir, conversationId)) return false;
  const legacy = legacyFile(dataDir, conversationId);
  const dir = conversationDir(dataDir, conversationId);
  const { surfaces, lastSeq, skipped } = foldLegacyLog(readFileSync(legacy, 'utf-8'));
  if (skipped > 0) {
    console.warn(`[SurfaceStore] Migration of ${conversationId} skipped ${skipped} legacy line(s)`);
  }
  for (const line of surfaces) {
    writeSurfaceLine(dir, line);
  }
  writeSeq(dir, lastSeq);
  renameSync(legacy, migratedFile(dataDir, conversationId));
  return true;
}

/**
 * Converts a legacy flat log, `conversations/<convId>.jsonl`, to the
 * per-surface layout: one file per live surface, `_seq` set to the last
 * legacy seq, and the legacy file renamed to `<convId>.jsonl.migrated`.
 * Runs under the conversation lock and does nothing when the conversation
 * already has `_seq` or has no legacy file.
 *
 * @returns Whether a migration ran.
 * @throws {StoreLockError} If the lock cannot be taken.
 */
export function migrateLegacyStore(
  dataDir: string,
  conversationId: string,
  opts?: LockOptions,
): boolean {
  if (!needsMigration(dataDir, conversationId)) return false;
  return withConversationLock(
    conversationDir(dataDir, conversationId),
    () => migrateUnderLock(dataDir, conversationId),
    opts,
  );
}
