import fs from 'node:fs';
import path from 'node:path';
import { isValidId } from '@a2ui-pane/protocol';

export type ChangeCallback = () => void;

/**
 * Notifies subscribers when conversation store files change on disk.
 * Uses fs.watch on the conversations/ directory with polling backup and debouncing.
 */
export class ChangeNotifier {
  private readonly listeners = new Map<string, Set<ChangeCallback>>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastSizes = new Map<string, number>();
  private dirWatcher: fs.FSWatcher | null = null;
  private readonly conversationsDir: string;
  private isClosed = false;

  constructor(
    private readonly dataDir: string,
    private readonly pollIntervalMs = 1000,
  ) {
    this.conversationsDir = path.join(this.dataDir, 'conversations');
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
      this.dirWatcher = fs.watch(this.conversationsDir, (_eventType, filename) => {
        if (!filename) {
          // If filename is not provided by OS, notify all subscribed conversations
          for (const convId of this.listeners.keys()) {
            this.notify(convId);
          }
          return;
        }

        const match = filename.match(/^([A-Za-z0-9_-]+)\.jsonl$/);
        if (match && match[1]) {
          this.notify(match[1]);
        }
      });
    } catch {
      // If fs.watch fails (e.g. platform unsupported), polling serves as full backup
    }
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

  private startPolling(conversationId: string): void {
    if (this.isClosed || this.pollTimers.has(conversationId)) return;

    const filePath = path.join(this.conversationsDir, `${conversationId}.jsonl`);
    const checkFile = () => {
      if (this.isClosed) return;
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          const prevSize = this.lastSizes.get(conversationId);
          if (prevSize === undefined || stat.size !== prevSize) {
            this.lastSizes.set(conversationId, stat.size);
            this.notify(conversationId);
          }
        }
      } catch {
        // Safe check
      }
    };

    const timer = setInterval(checkFile, this.pollIntervalMs);
    this.pollTimers.set(conversationId, timer);
  }

  private stopPolling(conversationId: string): void {
    const timer = this.pollTimers.get(conversationId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(conversationId);
      this.lastSizes.delete(conversationId);
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
    this.lastSizes.clear();
  }
}
