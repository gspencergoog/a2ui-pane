import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseStoreLine, StoreLine, isValidId } from '@a2ui-pane/protocol';

/** Incremental batch of parsed `StoreLine` entries and whether the store was reset. */
export interface ReadResult {
  lines: StoreLine[];
  reset: boolean;
}

interface ConversationFileState {
  byteOffset: number;
  partialBuffer: string;
  decoder: StringDecoder;
  inode?: number;
  lines: StoreLine[];
  epoch: number;
  subscriberEpochs: Map<string | symbol, number>;
}

const DEFAULT_SUBSCRIBER = '__default__';

/**
 * Reads and tails JSONL message store files for conversations.
 * Buffers partial writes, decodes multi-byte UTF-8 safely across chunk boundaries,
 * tracks byte offsets for incremental reading, and tracks reset epochs per subscriber
 * so concurrent SSE clients all detect file truncation or inode replacement.
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

  read(
    conversationId: string,
    afterSeq = 0,
    subscriberId: string | symbol = DEFAULT_SUBSCRIBER,
  ): ReadResult {
    const filePath = this.getFilePath(conversationId);
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        byteOffset: 0,
        partialBuffer: '',
        decoder: new StringDecoder('utf-8'),
        lines: [],
        epoch: 0,
        subscriberEpochs: new Map(),
      };
      this.states.set(conversationId, state);
    }

    if (!state.subscriberEpochs.has(subscriberId)) {
      state.subscriberEpochs.set(subscriberId, state.epoch);
    }

    if (!fs.existsSync(filePath)) {
      return { lines: [], reset: false };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { lines: [], reset: false };
    }

    // Detect file truncation or inode replacement (e.g. atomic overwrite)
    if (stat.size < state.byteOffset || (state.inode !== undefined && stat.ino !== state.inode)) {
      state.epoch += 1;
      state.byteOffset = 0;
      state.partialBuffer = '';
      state.decoder = new StringDecoder('utf-8');
      state.lines = [];
    }
    state.inode = stat.ino;

    const prevEpoch = state.subscriberEpochs.get(subscriberId) ?? state.epoch;
    const reset = prevEpoch !== state.epoch;
    state.subscriberEpochs.set(subscriberId, state.epoch);

    if (stat.size > state.byteOffset) {
      const bytesToRead = stat.size - state.byteOffset;
      const buffer = Buffer.alloc(bytesToRead);
      let fd: number | null = null;
      try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, state.byteOffset);
        const chunk = state.decoder.write(buffer.subarray(0, bytesRead));
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

    const effectiveAfterSeq = reset ? 0 : afterSeq;
    const filtered = state.lines.filter((l) => l.seq > effectiveAfterSeq);
    return {
      lines: filtered,
      reset,
    };
  }

  removeSubscriber(conversationId: string, subscriberId: string | symbol): void {
    this.states.get(conversationId)?.subscriberEpochs.delete(subscriberId);
  }

  clear(conversationId: string): void {
    this.states.delete(conversationId);
  }
}
