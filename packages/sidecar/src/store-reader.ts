import fs from 'node:fs';
import path from 'node:path';
import { parseStoreLine, StoreLine, isValidId } from '@a2ui-pane/protocol';

export interface ReadResult {
  lines: StoreLine[];
  reset: boolean;
}

interface ConversationFileState {
  byteOffset: number;
  partialBuffer: string;
  inode?: number;
  lines: StoreLine[];
}

/**
 * Reads and tails JSONL message store files for conversations.
 * Buffers partial writes, tracks byte offsets for incremental reading,
 * and detects file truncation or inode changes to trigger client resets.
 */
export class StoreReader {
  private readonly states = new Map<string, ConversationFileState>();

  constructor(private readonly dataDir: string) {}

  private getFilePath(conversationId: string): string {
    if (!isValidId(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    return path.join(this.dataDir, 'conversations', `${conversationId}.jsonl`);
  }

  read(conversationId: string, afterSeq = 0): ReadResult {
    const filePath = this.getFilePath(conversationId);
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        byteOffset: 0,
        partialBuffer: '',
        lines: [],
      };
      this.states.set(conversationId, state);
    }

    if (!fs.existsSync(filePath)) {
      return { lines: [], reset: false };
    }

    let reset = false;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { lines: [], reset: false };
    }

    // Detect file truncation or inode replacement (e.g. atomic overwrite)
    if (stat.size < state.byteOffset || (state.inode !== undefined && stat.ino !== state.inode)) {
      reset = true;
      state.byteOffset = 0;
      state.partialBuffer = '';
      state.lines = [];
    }
    state.inode = stat.ino;

    if (stat.size > state.byteOffset) {
      const bytesToRead = stat.size - state.byteOffset;
      const buffer = Buffer.alloc(bytesToRead);
      let fd: number | null = null;
      try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, state.byteOffset);
        const chunk = buffer.subarray(0, bytesRead).toString('utf-8');
        const combined = state.partialBuffer + chunk;

        const lastNewline = combined.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const completeBlock = combined.slice(0, lastNewline);
          state.partialBuffer = combined.slice(lastNewline + 1);

          state.byteOffset += bytesRead;

          const rawLines = completeBlock.split('\n');
          for (const raw of rawLines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            try {
              const line = parseStoreLine(trimmed);
              state.lines.push(line);
            } catch (err: any) {
              console.warn(
                `[StoreReader] Skipping corrupt line in ${conversationId}:`,
                err?.message || err,
              );
            }
          }
        } else {
          // No complete line yet: keep chunk in partial buffer and advance byteOffset
          state.partialBuffer = combined;
          state.byteOffset += bytesRead;
        }
      } catch (err) {
        console.error(`[StoreReader] Error reading ${filePath}:`, err);
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Safe close
          }
        }
      }
    }

    const filtered = state.lines.filter((l) => l.seq > afterSeq);
    return {
      lines: filtered,
      reset,
    };
  }

  clear(conversationId: string): void {
    this.states.delete(conversationId);
  }
}
