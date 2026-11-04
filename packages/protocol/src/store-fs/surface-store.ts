import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type A2uiServerMessage, isValidId, type StoreLine } from '../store.js';
import { foldSurfaceMessage, messageSurfaceId, type SurfaceSnapshot } from '../surface-fold.js';
import { conversationDir, isStorableSurfaceId, surfaceIdFromFileName } from './layout.js';
import {
  type LockOptions,
  StoreLockError,
  withConversationLock,
  withConversationLockAsync,
} from './lock.js';
import { migrateLegacyStore } from './migrate.js';
import {
  readSeq,
  readSurfaceLineOrWarn,
  type SnapshotLine,
  surfaceFileName,
  unlinkIfExists,
  writeSeq,
  writeSurfaceLine,
} from './store-io.js';

/** Version used for tombstones when the deleted surface's version is unknown. */
const DEFAULT_VERSION = '1.0';

function requireCallId(callId: string): void {
  if (!isValidId(callId)) {
    throw new Error(`Invalid callId: ${callId}`);
  }
}

function requireStorableSurfaceId(msg: A2uiServerMessage, index: number): string {
  const surfaceId = messageSurfaceId(msg);
  if (!isStorableSurfaceId(surfaceId)) {
    throw new Error(
      `Message ${index} has an invalid or reserved surfaceId: ${String(surfaceId)} ` +
        `(ids must match [A-Za-z0-9_-]{1,128} and must not start with '_')`,
    );
  }
  return surfaceId;
}

function tombstone(
  surfaceId: string,
  version: string,
  seq: number,
  callId: string,
  ts: string,
): StoreLine {
  return { seq, callId, ts, message: { version, deleteSurface: { surfaceId } } };
}

/** In-memory state of one surface while a commit folds its messages. */
interface PendingSurface {
  prior: SnapshotLine | undefined;
  snapshot: SurfaceSnapshot | null;
  version: string;
}

/**
 * Per-surface compacted store: `conversations/<convId>/<surfaceId>.jsonl`,
 * each holding one `createSurface` snapshot line, plus a `_seq` high-water
 * file. Writes run under the conversation lock; reads never take it. See
 * `docs/store-format.md` for the on-disk contract.
 */
export class SurfaceStore {
  constructor(
    readonly dataDir: string,
    private readonly opts: LockOptions = {},
  ) {
    if (!dataDir) {
      throw new Error('SurfaceStore requires a valid dataDir path');
    }
  }

  /** Current live surfaces, one line each, sorted by seq. Migrates a legacy flat file first. */
  readSnapshot(conversationId: string): StoreLine[] {
    const dir = conversationDir(this.dataDir, conversationId);
    this.migrateForRead(conversationId);
    const lines: StoreLine[] = [];
    for (const name of listDir(dir)) {
      const surfaceId = surfaceIdFromFileName(name);
      const line = surfaceId === undefined ? undefined : readSurfaceLineOrWarn(dir, surfaceId);
      if (line) lines.push(line);
    }
    return lines.sort((a, b) => a.seq - b.seq);
  }

  /** Value of `_seq`, or 0. Cheap change detector for cached readers. */
  generation(conversationId: string): number {
    return readSeq(conversationDir(this.dataDir, conversationId));
  }

  /**
   * Folds messages into per-surface files under the lock and returns the
   * written lines, one per touched surface in first-touch order. A surface
   * whose final state is deleted yields a `deleteSurface` tombstone line (its
   * file is unlinked) and still consumes a seq.
   *
   * @throws {FoldError} If a message cannot be folded; nothing is written.
   * @throws {StoreLockError} If the lock cannot be taken.
   * @throws {Error} For an invalid callId or an invalid or reserved surfaceId.
   */
  commit(conversationId: string, callId: string, messages: A2uiServerMessage[]): StoreLine[] {
    const dir = conversationDir(this.dataDir, conversationId);
    requireCallId(callId);
    if (!messages || messages.length === 0) return [];
    const surfaceIds = messages.map(requireStorableSurfaceId);
    migrateLegacyStore(this.dataDir, conversationId, this.opts);
    return withConversationLock(
      dir,
      () => commitUnderLock(dir, callId, messages, surfaceIds),
      this.opts,
    );
  }

  /** Unlinks one surface under the lock and bumps `_seq`. Returns the tombstone line or null. */
  deleteSurface(conversationId: string, surfaceId: string, callId: string): StoreLine | null {
    const dir = this.prepareDelete(conversationId, surfaceId, callId);
    if (!dir) return null;
    return withConversationLock(dir, () => deleteUnderLock(dir, surfaceId, callId), this.opts);
  }

  /** Same as deleteSurface but waits for the lock asynchronously (used by the sidecar). */
  async deleteSurfaceAsync(
    conversationId: string,
    surfaceId: string,
    callId: string,
  ): Promise<StoreLine | null> {
    const dir = this.prepareDelete(conversationId, surfaceId, callId);
    if (!dir) return null;
    return withConversationLockAsync(dir, () => deleteUnderLock(dir, surfaceId, callId), this.opts);
  }

  /** Validates delete arguments and migrates; returns the directory, or null for a reserved id. */
  private prepareDelete(conversationId: string, surfaceId: string, callId: string): string | null {
    const dir = conversationDir(this.dataDir, conversationId);
    requireCallId(callId);
    if (!isValidId(surfaceId)) {
      throw new Error(`Invalid surfaceId: ${surfaceId}`);
    }
    if (!isStorableSurfaceId(surfaceId)) return null;
    migrateLegacyStore(this.dataDir, conversationId, this.opts);
    return dir;
  }

  /** Migrates before a read; a busy lock only delays the migration to a later read. */
  private migrateForRead(conversationId: string): void {
    try {
      migrateLegacyStore(this.dataDir, conversationId, this.opts);
    } catch (err) {
      if (!(err instanceof StoreLockError)) throw err;
      console.warn(`[SurfaceStore] Deferred migration of ${conversationId}: ${err.message}`);
    }
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

function loadPending(dir: string, surfaceIds: string[]): Map<string, PendingSurface> {
  const pending = new Map<string, PendingSurface>();
  for (const surfaceId of surfaceIds) {
    if (pending.has(surfaceId)) continue;
    const prior = readSurfaceLineOrWarn(dir, surfaceId);
    const version = prior?.message.version ?? DEFAULT_VERSION;
    pending.set(surfaceId, { prior, snapshot: prior?.message ?? null, version });
  }
  return pending;
}

function commitUnderLock(
  dir: string,
  callId: string,
  messages: A2uiServerMessage[],
  surfaceIds: string[],
): StoreLine[] {
  const pending = loadPending(dir, surfaceIds);
  messages.forEach((msg, i) => {
    const entry = pending.get(surfaceIds[i])!;
    entry.snapshot = foldSurfaceMessage(entry.snapshot, msg);
    entry.version = msg.version || entry.version;
  });
  const priorSeqs = [...pending.values()].map((p) => p.prior?.seq ?? 0);
  const base = Math.max(readSeq(dir), ...priorSeqs);
  const ts = new Date().toISOString();
  const lines = [...pending.entries()].map(([surfaceId, entry], i): StoreLine => {
    const seq = base + i + 1;
    if (!entry.snapshot) return tombstone(surfaceId, entry.version, seq, callId, ts);
    return { seq, callId, ts, message: entry.snapshot };
  });
  for (const line of lines) {
    const deleted = line.message.deleteSurface?.surfaceId;
    if (deleted) {
      unlinkIfExists(join(dir, surfaceFileName(deleted)));
    } else {
      writeSurfaceLine(dir, line as SnapshotLine);
    }
  }
  writeSeq(dir, base + lines.length);
  return lines;
}

function deleteUnderLock(dir: string, surfaceId: string, callId: string): StoreLine | null {
  const prior = readSurfaceLineOrWarn(dir, surfaceId);
  if (!unlinkIfExists(join(dir, surfaceFileName(surfaceId)))) return null;
  const seq = Math.max(readSeq(dir), prior?.seq ?? 0) + 1;
  writeSeq(dir, seq);
  const version = prior?.message.version ?? DEFAULT_VERSION;
  return tombstone(surfaceId, version, seq, callId, new Date().toISOString());
}
