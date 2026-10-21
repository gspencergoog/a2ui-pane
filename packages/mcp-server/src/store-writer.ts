import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  unlinkSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  A2uiServerMessage,
  isValidId,
  parseStoreLine,
  serializeStoreLine,
  StoreLine,
} from '@a2ui-pane/protocol';

/** How many bytes of the file tail `readLastSeq` inspects. Store lines are far smaller. */
const TAIL_BYTES = 64 * 1024;

/** Reads at most the last `maxBytes` of `filePath` as UTF-8 text. */
function readTail(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Manages persisting and reading newline-delimited JSONL lines
 * for conversations under ${PLUGIN_DATA}/conversations/<conversationId>.jsonl.
 *
 * Several MCP server processes may append to the same conversation file: each Jetski
 * conversation runs its own server, and a swarm worker can render into another
 * conversation's store. Every append therefore re-reads the last `seq` from the file tail
 * and takes the larger of that and the in-process cache, so `seq` stays monotonic across
 * processes and a single process never goes backwards.
 */
export class StoreWriter {
  private readonly conversationsDir: string;
  private readonly lastSeqMap = new Map<string, number>();

  constructor(dataDir: string) {
    if (!dataDir) {
      throw new Error('StoreWriter requires a valid dataDir path');
    }
    this.conversationsDir = join(dataDir, 'conversations');
    if (!existsSync(this.conversationsDir)) {
      mkdirSync(this.conversationsDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Returns the file path for a given conversation's JSONL store.
   */
  getConversationFilePath(conversationId: string): string {
    if (!isValidId(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    return join(this.conversationsDir, `${conversationId}.jsonl`);
  }

  /**
   * Reads and parses all StoreLines currently recorded for a conversation.
   * Tolerates and skips an unparseable trailing line (e.g. from an interrupted write).
   * Returns an empty array if the store file does not yet exist.
   */
  readAll(conversationId: string): StoreLine[] {
    const filePath = this.getConversationFilePath(conversationId);
    if (!existsSync(filePath)) {
      this.lastSeqMap.set(conversationId, 0);
      return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const rawLines = content.split('\n');
    const nonEmptyIndices: number[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim()) {
        nonEmptyIndices.push(i);
      }
    }

    const result: StoreLine[] = [];
    const lastNonEmptyIndex =
      nonEmptyIndices.length > 0 ? nonEmptyIndices[nonEmptyIndices.length - 1] : -1;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;
      try {
        result.push(parseStoreLine(line));
      } catch (err: any) {
        // If the error occurred on the very last non-empty line, treat as truncated write and recover
        if (i === lastNonEmptyIndex) {
          console.warn(
            `[StoreWriter] Warning: skipping truncated trailing line at index ${i} in ${filePath}: ${err?.message || err}`,
          );
          break;
        }
        throw new Error(
          `Corrupt line at index ${i} in store file ${filePath}: ${err?.message || err}`,
        );
      }
    }

    const lastSeq = result.length > 0 ? result[result.length - 1].seq : 0;
    this.lastSeqMap.set(conversationId, lastSeq);
    return result;
  }

  /**
   * Returns the `seq` of the last complete record in a conversation file by reading only
   * its tail (the last 64 KiB). Returns 0 when the file is missing or the tail holds no
   * parseable line. A truncated trailing line from an interrupted write is skipped.
   */
  private readLastSeq(conversationId: string): number {
    const filePath = this.getConversationFilePath(conversationId);
    if (!existsSync(filePath)) return 0;
    const tail = readTail(filePath, TAIL_BYTES);
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        return parseStoreLine(line).seq;
      } catch {
        // Truncated or partial line; keep looking at earlier lines.
      }
    }
    return 0;
  }

  /**
   * Appends an array of server messages to a conversation store file.
   * Assigns incrementing 1-based seq numbers continuing from the last record on disk,
   * or from this process's own last write if that is higher.
   * All lines are committed in a single append call.
   */
  append(conversationId: string, callId: string, messages: A2uiServerMessage[]): StoreLine[] {
    if (!isValidId(conversationId)) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    if (!isValidId(callId)) {
      throw new Error(`Invalid callId: ${callId}`);
    }
    if (!messages || messages.length === 0) {
      return [];
    }

    const filePath = this.getConversationFilePath(conversationId);

    let currentSeq = Math.max(
      this.lastSeqMap.get(conversationId) ?? 0,
      this.readLastSeq(conversationId),
    );

    const newLines: StoreLine[] = [];
    const timestamp = new Date().toISOString();

    for (const msg of messages) {
      currentSeq++;
      newLines.push({
        seq: currentSeq,
        callId,
        ts: timestamp,
        message: msg,
      });
    }

    const payload = newLines.map(serializeStoreLine).join('\n') + '\n';
    appendFileSync(filePath, payload, { encoding: 'utf-8', flag: 'a' });

    this.lastSeqMap.set(conversationId, currentSeq);
    return newLines;
  }

  /**
   * Deletes a conversation's store file and clears cached sequence state.
   */
  clear(conversationId: string): void {
    this.lastSeqMap.delete(conversationId);
    const filePath = this.getConversationFilePath(conversationId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
