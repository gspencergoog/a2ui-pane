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
 */
export class StoreWriter {
  private readonly conversationsDir: string;

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
   * Returns an empty array if the store file does not yet exist.
   */
  readAll(conversationId: string): StoreLine[] {
    const filePath = this.getConversationFilePath(conversationId);
    if (!existsSync(filePath)) {
      return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const result: StoreLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        result.push(parseStoreLine(line));
      } catch (err: any) {
        throw new Error(
          `Corrupt line at index ${i} in store file ${filePath}: ${err?.message || err}`,
        );
      }
    }
    return result;
  }

  /**
   * Appends an array of server messages to a conversation store file.
   * Assigns incrementing 1-based seq numbers continuing from the last record.
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
    const existing = this.readAll(conversationId);
    let currentSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;

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

    return newLines;
  }

  /**
   * Deletes a conversation's store file, if present.
   */
  clear(conversationId: string): void {
    const filePath = this.getConversationFilePath(conversationId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
