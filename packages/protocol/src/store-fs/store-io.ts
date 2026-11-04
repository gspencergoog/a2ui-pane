import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseStoreLine, serializeStoreLine, type StoreLine } from '../store.js';
import type { SurfaceSnapshot } from '../surface-fold.js';
import { SEQ_FILE_NAME, writeFileAtomic } from './layout.js';

/** A stored line whose message is a full `createSurface` snapshot. */
export type SnapshotLine = StoreLine & { message: SurfaceSnapshot };

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** Reads a file, returning undefined when it does not exist. */
export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** Unlinks a file, ignoring a missing one. Returns whether a file was removed. */
export function unlinkIfExists(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

/** Value of `<dir>/_seq`, or 0 when it is missing or unreadable. */
export function readSeq(dir: string): number {
  const text = readIfExists(join(dir, SEQ_FILE_NAME));
  const value = text === undefined ? NaN : Number(text.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Writes `<dir>/_seq` through a temporary file and rename. */
export function writeSeq(dir: string, seq: number): void {
  writeFileAtomic(dir, SEQ_FILE_NAME, `${seq}\n`);
}

/** File name of a surface's snapshot file. */
export function surfaceFileName(surfaceId: string): string {
  return `${surfaceId}.jsonl`;
}

/**
 * Reads and validates the single line of a surface file.
 *
 * @returns The line, or undefined when the file does not exist.
 * @throws {Error} When the file is empty, unparseable, or not a snapshot of `surfaceId`.
 */
export function readSurfaceLine(dir: string, surfaceId: string): SnapshotLine | undefined {
  const text = readIfExists(join(dir, surfaceFileName(surfaceId)));
  if (text === undefined) return undefined;
  const first = text.split('\n').find((l) => l.trim().length > 0);
  if (!first) throw new Error(`Surface file for ${surfaceId} is empty`);
  const line = parseStoreLine(first.trim());
  const create = line.message.createSurface;
  if (!create || typeof create !== 'object' || create.surfaceId !== surfaceId) {
    throw new Error(`Surface file for ${surfaceId} does not hold a createSurface for it`);
  }
  if (!Array.isArray(create.components)) {
    create.components = [];
  }
  return line as SnapshotLine;
}

/**
 * Reads a surface file, logging and returning undefined when it is corrupt.
 * Used wherever a bad file should be treated as absent instead of failing.
 */
export function readSurfaceLineOrWarn(dir: string, surfaceId: string): SnapshotLine | undefined {
  try {
    return readSurfaceLine(dir, surfaceId);
  } catch (err: any) {
    console.warn(
      `[SurfaceStore] Skipping unreadable surface file ${surfaceId} in ${dir}: ${err?.message ?? err}`,
    );
    return undefined;
  }
}

/** Writes a surface's snapshot line through a temporary file and rename. */
export function writeSurfaceLine(dir: string, line: SnapshotLine): void {
  writeFileAtomic(
    dir,
    surfaceFileName(line.message.createSurface.surfaceId),
    `${serializeStoreLine(line)}\n`,
  );
}
