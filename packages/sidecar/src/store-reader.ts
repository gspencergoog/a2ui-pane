import { messageSurfaceId, type StoreLine } from '@a2ui-pane/protocol';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';

/** What a stream subscriber last sent for one surface. */
export interface KnownSurface {
  seq: number;
  /** Protocol version of the surface, used for its tombstone when the file disappears. */
  version: string;
}

/** Surfaces a subscriber has sent, keyed by surfaceId. */
export type KnownSurfaces = Map<string, KnownSurface>;

/** Lines to send since the last diff, and the subscriber's updated view. */
export interface DiffResult {
  lines: StoreLine[];
  known: KnownSurfaces;
}

/** callId of the synthetic tombstones `diff` emits for vanished surface files. */
export const STORE_TOMBSTONE_CALL_ID = 'store';

/**
 * How long a read waits for the lock when it must migrate a legacy flat file.
 * A busy lock only defers the migration to a later read, and the sidecar's
 * event loop must not block for the default 2 s.
 */
const READ_LOCK_TIMEOUT_MS = 50;

/** Builds the `known` map for a set of snapshot lines. */
export function knownFromLines(lines: StoreLine[]): KnownSurfaces {
  const known: KnownSurfaces = new Map();
  for (const line of lines) {
    const surfaceId = messageSurfaceId(line.message);
    if (surfaceId) known.set(surfaceId, { seq: line.seq, version: line.message.version });
  }
  return known;
}

/**
 * Reads the per-surface conversation store for SSE streaming. Each surface is
 * one compacted snapshot file, so a stream starts from `snapshot` and then
 * follows changes with `diff` against what it has already sent.
 */
export class StoreReader {
  private readonly store: SurfaceStore;

  constructor(dataDir: string) {
    this.store = new SurfaceStore(dataDir, { lockTimeoutMs: READ_LOCK_TIMEOUT_MS });
  }

  /** Current live surfaces, one line each, sorted by seq. Migrates a legacy flat file first. */
  snapshot(conversationId: string): StoreLine[] {
    return this.store.readSnapshot(conversationId);
  }

  /** The conversation's `_seq` high-water mark, or 0. */
  generation(conversationId: string): number {
    return this.store.generation(conversationId);
  }

  /**
   * Returns the lines a subscriber has not seen: each surface that is new or
   * has a higher seq than `known`, and a synthetic `deleteSurface` tombstone
   * for each known surface whose file is gone.
   *
   * `_seq` is read before the directory listing. A surface deleted and then
   * re-created in between keeps its file, so it gets no tombstone, and its
   * new line has a seq above any tombstone seq, so the client never skips it.
   */
  diff(conversationId: string, known: KnownSurfaces): DiffResult {
    const generation = this.generation(conversationId);
    const current = this.snapshot(conversationId);
    const next = knownFromLines(current);
    const lines = current.filter((line) => isNewer(line, known));
    const ts = new Date().toISOString();
    for (const [surfaceId, prev] of known) {
      if (next.has(surfaceId)) continue;
      lines.push({
        seq: Math.max(generation, prev.seq),
        callId: STORE_TOMBSTONE_CALL_ID,
        ts,
        message: { version: prev.version, deleteSurface: { surfaceId } },
      });
    }
    lines.sort((a, b) => a.seq - b.seq);
    return { lines, known: next };
  }
}

function isNewer(line: StoreLine, known: KnownSurfaces): boolean {
  const surfaceId = messageSurfaceId(line.message);
  const prev = surfaceId === undefined ? undefined : known.get(surfaceId);
  return prev === undefined || line.seq > prev.seq;
}
