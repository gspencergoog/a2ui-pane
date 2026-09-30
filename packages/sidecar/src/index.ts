export { readSidecarEnv, type SidecarEnv } from './env.js';
export { checkToken } from './auth.js';
export { StoreReader, type ReadResult } from './store-reader.js';
export { ChangeNotifier, type ChangeCallback } from './change-notifier.js';
export { handleStream, type SseStreamOptions } from './sse-route.js';
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
