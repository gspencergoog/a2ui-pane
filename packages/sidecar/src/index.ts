export { readSidecarEnv, type SidecarEnv } from './env.js';
export { checkToken } from './auth.js';
export {
  StoreReader,
  knownFromLines,
  STORE_TOMBSTONE_CALL_ID,
  type DiffResult,
  type KnownSurface,
  type KnownSurfaces,
} from './store-reader.js';
export { ChangeNotifier, conversationIdForPath, type ChangeCallback } from './change-notifier.js';
export { handleStream, type SseStreamOptions } from './sse-route.js';
export {
  handleSurfaceDelete,
  type SurfaceDeleteOptions,
  type SurfaceDeleteReason,
} from './surfaces-route.js';
export { handlePreload } from './preload-route.js';
export {
  handleSendMessage,
  type SendMessageOptions,
  type ExecFileFn,
} from './send-message-route.js';
export { serveStaticFile } from './static-files.js';
export { cleanupOldFiles, type CleanupResult } from './cleanup.js';
export { createSidecarServer, type SidecarDeps } from './server.js';
export { run, isMainModule } from './main.js';
