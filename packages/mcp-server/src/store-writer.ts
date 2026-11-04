import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { A2uiServerMessage, StoreLine } from '@a2ui-pane/protocol';
import {
  conversationDir,
  conversationsDir,
  legacyFile,
  migratedFile,
  SurfaceStore,
} from '@a2ui-pane/protocol/store-fs';

/**
 * Persists A2UI messages for the MCP server in the per-surface store under
 * `${PLUGIN_DATA}/conversations/<conversationId>/` (see `docs/store-format.md`).
 *
 * This is a thin adapter over `SurfaceStore`. Each surface is one compacted
 * `createSurface` line, so `readAll` returns one line per live surface rather
 * than a history. Several MCP server processes, the sidecar, and `/monitor`
 * may write the same conversation; every write runs under the conversation
 * lock, and `generation` lets cached readers notice foreign writes.
 */
export class StoreWriter {
  private readonly store: SurfaceStore;

  constructor(readonly dataDir: string) {
    if (!dataDir) {
      throw new Error('StoreWriter requires a valid dataDir path');
    }
    this.store = new SurfaceStore(dataDir);
    const dir = conversationsDir(dataDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Returns the directory that holds a conversation's surface files. */
  getConversationDir(conversationId: string): string {
    return conversationDir(this.dataDir, conversationId);
  }

  /**
   * Returns the current live surfaces of a conversation, one `createSurface`
   * snapshot line per surface, sorted by seq. Migrates a legacy flat file
   * first. Returns an empty array when the conversation has no surfaces.
   */
  readAll(conversationId: string): StoreLine[] {
    return this.store.readSnapshot(conversationId);
  }

  /** Returns the conversation's `_seq` high-water mark, or 0. Changes on every write. */
  generation(conversationId: string): number {
    return this.store.generation(conversationId);
  }

  /**
   * Folds messages into the conversation's surface files under the lock and
   * returns the written lines, one per touched surface.
   *
   * @throws {FoldError} If a message cannot be folded (for example, an update
   *   to a surface that another writer deleted).
   * @throws {StoreLockError} If the conversation lock cannot be taken.
   * @throws {Error} For an invalid id or a reserved surface id.
   */
  append(conversationId: string, callId: string, messages: A2uiServerMessage[]): StoreLine[] {
    return this.store.commit(conversationId, callId, messages);
  }

  /** Removes a conversation's surface directory and its legacy and migrated flat files. */
  clear(conversationId: string): void {
    rmSync(this.getConversationDir(conversationId), { recursive: true, force: true });
    rmSync(legacyFile(this.dataDir, conversationId), { force: true });
    rmSync(migratedFile(this.dataDir, conversationId), { force: true });
  }
}
