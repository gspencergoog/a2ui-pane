/**
 * Node-only file system store for A2UI pane surfaces. Import it as
 * `@a2ui-pane/protocol/store-fs`; the main entry point stays browser-safe.
 * See `docs/store-format.md` for the on-disk contract.
 */
export { SurfaceStore } from './surface-store.js';
export {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  StoreLockError,
  withConversationLock,
  withConversationLockAsync,
} from './lock.js';
export type { LockOptions } from './lock.js';
export { foldLegacyLog, migrateLegacyStore } from './migrate.js';
export {
  conversationDir,
  conversationsDir,
  isStorableSurfaceId,
  legacyFile,
  lockFile,
  migratedFile,
  seqFile,
  surfaceFile,
  surfaceIdFromFileName,
  LOCK_FILE_NAME,
  SEQ_FILE_NAME,
  SURFACE_FILE_PATTERN,
} from './layout.js';
