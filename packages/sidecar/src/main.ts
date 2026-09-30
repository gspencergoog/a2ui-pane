import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanupOldFiles } from './cleanup.js';
import { readSidecarEnv } from './env.js';
import { createSidecarServer } from './server.js';

export function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fs.realpathSync(process.argv[1]);
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

export function run(): void {
  try {
    const env = readSidecarEnv();

    // Run housekeeping cleanup on startup
    const cleanup = cleanupOldFiles(env.dataDir);
    if (cleanup.deleted > 0) {
      console.log(`[a2ui-pane-sidecar] Cleaned up ${cleanup.deleted} stale files.`);
    }

    const server = createSidecarServer(env);

    server.listen(env.port, '127.0.0.1', () => {
      console.log(
        `[a2ui-pane-sidecar] Listening on http://127.0.0.1:${env.port} (data: ${env.dataDir})`,
      );
    });

    const shutdown = (signal: string) => {
      console.log(`[a2ui-pane-sidecar] Received ${signal}, closing server...`);
      server.close(() => {
        console.log('[a2ui-pane-sidecar] Server closed.');
        process.exit(0);
      });
      setTimeout(() => {
        process.exit(0);
      }, 3000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    console.error('[a2ui-pane-sidecar] Fatal startup error:', err?.message || err);
    process.exit(1);
  }
}

// Auto-run when executed directly
if (isMainModule()) {
  run();
}
