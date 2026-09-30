import { describe, it, expect } from 'vitest';
import * as protocol from './index.js';
import { isValidId, parseStoreLine, serializeStoreLine, StoreLine } from './store.js';

describe('index barrel exports', () => {
  it('re-exports store, stream-events, and action-text symbols', () => {
    expect(protocol.isValidId).toBeDefined();
    expect(protocol.formatSseEvent).toBeDefined();
    expect(protocol.formatActionText).toBeDefined();
  });
});

describe('isValidId', () => {
  it('accepts valid alphanumeric, hyphen, and underscore IDs', () => {
    expect(isValidId('conv-123')).toBe(true);
    expect(isValidId('surface_abc')).toBe(true);
    expect(isValidId('12345')).toBe(true);
    expect(isValidId('A-B_c')).toBe(true);
  });

  it('rejects path traversal and illegal characters', () => {
    expect(isValidId('../conv')).toBe(false);
    expect(isValidId('conv/123')).toBe(false);
    expect(isValidId('conv\\123')).toBe(false);
    expect(isValidId('conv.jsonl')).toBe(false);
    expect(isValidId('conv 123')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(undefined)).toBe(false);
  });

  it('rejects IDs longer than 128 characters', () => {
    const longId = 'a'.repeat(129);
    expect(isValidId(longId)).toBe(false);
    const valid128 = 'a'.repeat(128);
    expect(isValidId(valid128)).toBe(true);
  });
});

describe('StoreLine serialization and parsing', () => {
  const sampleLine: StoreLine = {
    seq: 1,
    callId: 'call_abc123',
    ts: '2026-09-30T20:00:00.000Z',
    message: {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'surface-1',
        catalogId: 'basic',
        sendDataModel: true,
      },
    },
  };

  it('round-trips serialize and parse', () => {
    const serialized = serializeStoreLine(sampleLine);
    expect(typeof serialized).toBe('string');
    const parsed = parseStoreLine(serialized);
    expect(parsed).toEqual(sampleLine);
  });

  it('rejects invalid inputs on parse', () => {
    expect(() => parseStoreLine('')).toThrow(/non-empty/);
    expect(() => parseStoreLine('not json')).toThrow();
    expect(() => parseStoreLine('[]')).toThrow(/object/);
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, seq: -1 }))).toThrow(/seq/);
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, seq: 0 }))).toThrow(/seq/);
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, seq: 1.5 }))).toThrow(/seq/);
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, callId: '../bad' }))).toThrow(
      /callId/,
    );
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, ts: '' }))).toThrow(/ts/);
    expect(() => parseStoreLine(JSON.stringify({ ...sampleLine, message: 'bad' }))).toThrow(
      /message/,
    );
  });
});
