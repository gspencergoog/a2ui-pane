import fs from 'node:fs';
import path from 'node:path';
import { isValidId } from '@a2ui-pane/protocol';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';

/** Listener callback invoked when a watched conversation store changes on disk. */
export type ChangeCallback = () => void;

/**
 * Matches a path relative to `conversations/` and captures the conversation id:
 * `<convId>/<file>`, the `<convId>` directory itself, or the legacy flat files
 * `<convId>.jsonl` and `<convId>.jsonl.migrated`.
 */
const WATCHED_PATH = /^([A-Za-z0-9_-]+)(?:[/\\](.+)|\.jsonl(?:\.migrated)?)?$/;

/**
 * Maps a watcher file name to the conversation it belongs to. Returns
 * undefined for unrelated names and for dot files inside a conversation
 * directory (the lock and temporary files), which change on every commit
 * without changing what readers see.
 */
export function conversationIdForPath(filename: string): string | undefined {
  const match = WATCHED_PATH.exec(filename);
  if (!match) return undefined;
  const inner = match[2];
  if (inner !== undefined && path.basename(inner).startsWith('.')) return undefined;
  return match[1];
}

/**
 * Notifies subscribers when a conversation's store changes on disk.
 *
 * It watches `conversations/` recursively, so a write to
 * `<convId>/<surfaceId>.jsonl` or `<convId>/_seq` reaches the conversation's
 * listeners. A polling fallback compares each subscribed conversation's
 * `_seq` generation, which every commit and delete bumps.
 */
export class ChangeNotifier {
  private readonly listeners = new Map<string, Set<ChangeCallback>>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastGenerations = new Map<string, number>();
  private dirWatcher: fs.FSWatcher | null = null;
  private readonly conversationsDir: string;
  private readonly store: SurfaceStore;
  private isClosed = false;

  constructor(
    private readonly dataDir: string,
    private readonly pollIntervalMs = 1000,
  ) {
    this.conversationsDir = path.join(this.dataDir, 'conversations');
    this.store = new SurfaceStore(this.dataDir);
    this.initWatcher();
  }

  private initWatcher(): void {
    if (!fs.existsSync(this.conversationsDir)) {
      try {
        fs.mkdirSync(this.conversationsDir, { recursive: true, mode: 0o700 });
      } catch {
        // Safe mkdir fallback
      }
    }

    try {
      // Recursive watching is supported on Linux from Node 20.
      this.dirWatcher = fs.watch(this.conversationsDir, { recursive: true }, (_event, filename) =>
        this.onWatchEvent(filename),
      );
    } catch {
      // If fs.watch fails (e.g. platform unsupported), polling serves as full backup
    }
  }

  private onWatchEvent(filename: string | Buffer | null): void {
    if (!filename) {
      // If filename is not provided by OS, notify all subscribed conversations
      for (const convId of this.listeners.keys()) {
        this.notify(convId);
      }
      return;
    }
    const convId = conversationIdForPath(filename.toString());
    if (convId) this.notify(convId);
  }

  private notify(conversationId: string): void {
    const callbacks = this.listeners.get(conversationId);
    if (!callbacks || callbacks.size === 0) return;

    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error(`[ChangeNotifier] Error in listener for ${conversationId}:`, err);
      }
    }
  }

  subscribe(conversationId: string, onChange: ChangeCallback): () => void {
    if (!isValidId(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }

    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
      this.startPolling(conversationId);
    }

    set.add(onChange);

    return () => {
      set?.delete(onChange);
      if (set && set.size === 0) {
        this.listeners.delete(conversationId);
        this.stopPolling(conversationId);
      }
    };
  }

  /** Reads the conversation's generation, or undefined when `_seq` is unreadable. */
  private readGeneration(conversationId: string): number | undefined {
    try {
      return this.store.generation(conversationId);
    } catch {
      return undefined;
    }
  }

  private startPolling(conversationId: string): void {
    if (this.isClosed || this.pollTimers.has(conversationId)) return;

    // Baseline now: the subscriber reads its snapshot right after subscribing.
    this.lastGenerations.set(conversationId, this.readGeneration(conversationId) ?? 0);
    const check = () => {
      if (this.isClosed) return;
      const generation = this.readGeneration(conversationId);
      if (generation === undefined || generation === this.lastGenerations.get(conversationId)) {
        return;
      }
      this.lastGenerations.set(conversationId, generation);
      this.notify(conversationId);
    };

    const timer = setInterval(check, this.pollIntervalMs);
    this.pollTimers.set(conversationId, timer);
  }

  private stopPolling(conversationId: string): void {
    const timer = this.pollTimers.get(conversationId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(conversationId);
      this.lastGenerations.delete(conversationId);
    }
  }

  async waitForChange(conversationId: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          unsubscribe();
          resolve(false);
        }
      }, timeoutMs);

      const unsubscribe = this.subscribe(conversationId, () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          unsubscribe();
          resolve(true);
        }
      });
    });
  }

  close(): void {
    this.isClosed = true;
    if (this.dirWatcher) {
      try {
        this.dirWatcher.close();
      } catch {
        // Safe close
      }
      this.dirWatcher = null;
    }

    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    this.listeners.clear();
    this.lastGenerations.clear();
  }
}
