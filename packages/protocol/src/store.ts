/**
 * Generic A2UI v0.9 Server-to-Client layout message representation.
 */
export interface A2uiServerMessage {
  version: string;
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    sendDataModel?: boolean;
    [key: string]: unknown;
  };
  updateComponents?: {
    surfaceId: string;
    components: unknown[];
    [key: string]: unknown;
  };
  updateDataModel?: {
    surfaceId: string;
    path?: string;
    value: unknown;
    [key: string]: unknown;
  };
  deleteSurface?: {
    surfaceId: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * A single line stored in a conversation's JSONL message store.
 */
export interface StoreLine {
  /** 1-based, strictly increasing sequence number within a single conversation file. */
  seq: number;
  /** Unique ID grouping the lines written by a single render_a2ui invocation. */
  callId: string;
  /** ISO 8601 UTC timestamp of when the line was committed. */
  ts: string;
  /** Exactly one A2UI v0.9 server-to-client message. */
  message: A2uiServerMessage;
}

const ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validates that an identifier (conversation ID, surface ID, catalog ID slug)
 * is safe for use in paths, URLs, and JSON keys without directory traversal risks.
 */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_REGEX.test(id);
}

/**
 * Serializes a StoreLine to a single JSON line without trailing newline.
 */
export function serializeStoreLine(line: StoreLine): string {
  return JSON.stringify(line);
}

/**
 * Parses and validates a JSON string as a StoreLine.
 * Throws an Error if the line is malformed, missing fields, or contains invalid structures.
 */
export function parseStoreLine(text: string): StoreLine {
  if (!text || typeof text !== 'string') {
    throw new Error('Store line must be a non-empty string');
  }
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Store line must be an object');
  }
  if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq <= 0) {
    throw new Error(`Store line 'seq' must be a positive integer, got: ${obj.seq}`);
  }
  if (!isValidId(obj.callId)) {
    throw new Error(`Store line 'callId' is invalid: ${obj.callId}`);
  }
  if (typeof obj.ts !== 'string' || !obj.ts) {
    throw new Error(`Store line 'ts' must be a non-empty timestamp string`);
  }
  if (!obj.message || typeof obj.message !== 'object' || Array.isArray(obj.message)) {
    throw new Error(`Store line 'message' must be an object`);
  }
  return obj as StoreLine;
}
