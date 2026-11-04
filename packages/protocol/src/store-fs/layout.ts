import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidId } from '../store.js';

/** Directory mode for conversation directories. */
export const DIR_MODE = 0o700;

/** File mode for every store file. */
export const FILE_MODE = 0o600;

/** Name of the per-conversation high-water seq file. */
export const SEQ_FILE_NAME = '_seq';

/** Name of the per-conversation writer lock file. */
export const LOCK_FILE_NAME = '.lock';

/** Matches the names of surface files; ignores `_seq`, the lock, and temporary files. */
export const SURFACE_FILE_PATTERN = /^[A-Za-z0-9-][A-Za-z0-9_-]*\.jsonl$/;

const SURFACE_FILE_SUFFIX = '.jsonl';

function requireId(kind: string, id: string): string {
  if (!isValidId(id)) {
    throw new Error(`Invalid ${kind}: ${id}`);
  }
  return id;
}

/**
 * Whether a surface id may be stored. Ids that start with `_` or `.` are
 * reserved for store files such as `_seq` and `.lock`.
 */
export function isStorableSurfaceId(id: unknown): id is string {
  return isValidId(id) && !id.startsWith('_') && !id.startsWith('.');
}

/** `<dataDir>/conversations`. */
export function conversationsDir(dataDir: string): string {
  return join(dataDir, 'conversations');
}

/** `<dataDir>/conversations/<conversationId>`. */
export function conversationDir(dataDir: string, conversationId: string): string {
  return join(conversationsDir(dataDir), requireId('conversationId', conversationId));
}

/** `<dataDir>/conversations/<conversationId>/<surfaceId>.jsonl`. */
export function surfaceFile(dataDir: string, conversationId: string, surfaceId: string): string {
  requireId('surfaceId', surfaceId);
  return join(conversationDir(dataDir, conversationId), `${surfaceId}${SURFACE_FILE_SUFFIX}`);
}

/** `<dataDir>/conversations/<conversationId>/_seq`. */
export function seqFile(dataDir: string, conversationId: string): string {
  return join(conversationDir(dataDir, conversationId), SEQ_FILE_NAME);
}

/** `<dataDir>/conversations/<conversationId>/.lock`. */
export function lockFile(dataDir: string, conversationId: string): string {
  return join(conversationDir(dataDir, conversationId), LOCK_FILE_NAME);
}

/** `<dataDir>/conversations/<conversationId>.jsonl`, the legacy flat log. */
export function legacyFile(dataDir: string, conversationId: string): string {
  return join(
    conversationsDir(dataDir),
    `${requireId('conversationId', conversationId)}${SURFACE_FILE_SUFFIX}`,
  );
}

/** `<dataDir>/conversations/<conversationId>.jsonl.migrated`. */
export function migratedFile(dataDir: string, conversationId: string): string {
  return `${legacyFile(dataDir, conversationId)}.migrated`;
}

/** Returns the surface id for a surface file name, or undefined for any other file. */
export function surfaceIdFromFileName(name: string): string | undefined {
  return SURFACE_FILE_PATTERN.test(name) ? name.slice(0, -SURFACE_FILE_SUFFIX.length) : undefined;
}

/** Creates a directory (and its parents) with mode 0700 if it is missing. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * Writes `content` to `<dir>/<name>` atomically: it writes `.<base>.tmp-<pid>`
 * with mode 0600 and renames it into place. `base` is `name` without `.jsonl`.
 */
export function writeFileAtomic(dir: string, name: string, content: string): void {
  const base = name.endsWith(SURFACE_FILE_SUFFIX)
    ? name.slice(0, -SURFACE_FILE_SUFFIX.length)
    : name;
  const tmp = join(dir, `.${base}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: FILE_MODE });
    renameSync(tmp, join(dir, name));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file was never created or was already renamed.
    }
    throw err;
  }
}
