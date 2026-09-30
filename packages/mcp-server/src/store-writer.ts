import { existsSync, mkdirSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  A2uiServerMessage,
  isValidId,
  parseStoreLine,
  serializeStoreLine,
  StoreLine,
} from '@a2ui-pane/protocol';

/**
 * Manages persisting and reading newline-delimited JSONL lines
 * for conversations under ${PLUGIN_DATA}/conversations/<conversationId>.jsonl.
 * Caches latest sequence numbers to avoid O(N) re-reads on every append.
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
   * Appends an array of server messages to a conversation store file.
   * Assigns incrementing 1-based seq numbers continuing from the last record.
   * Uses cached in-memory sequence counter to avoid re-reading disk on every call.
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

    let currentSeq: number;
    if (this.lastSeqMap.has(conversationId)) {
      currentSeq = this.lastSeqMap.get(conversationId)!;
    } else {
      const existing = this.readAll(conversationId);
      currentSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;
    }

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
