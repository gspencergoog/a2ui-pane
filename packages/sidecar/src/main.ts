import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupOldFiles } from './cleanup.js';
import { readSidecarEnv, SidecarEnv } from './env.js';
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

export function writeSidecarEndpointFile(
  dataDir: string,
  port: number,
  uiToken?: string,
  baseUrl?: string,
): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dataDir, 'sidecar-endpoint.json'),
      JSON.stringify({ port, uiToken, baseUrl }),
      { mode: 0o600 },
    );
  } catch {
    // Ignore file write errors if dataDir is unavailable
  }
}

export async function resolveSidecarBaseUrl(
  env: SidecarEnv,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!env.lsAddress || !env.csrfToken) return undefined;
  try {
    const resp = await fetchFn(
      `http://${env.lsAddress}/exa.language_server_pb.LanguageServerService/GetSidecars`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': env.csrfToken,
        },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as {
      sidecars?: Array<{ sidecarId?: string; webPort?: number; baseUrl?: string }>;
    };
    const match = data.sidecars?.find(
      (s) => s.webPort === env.port || s.sidecarId === 'a2ui-pane/a2ui-pane',
    );
    return match?.baseUrl || undefined;
  } catch {
    return undefined;
  }
}

function removeSidecarEndpointFile(dataDir: string): void {
  const endpointFile = path.join(dataDir, 'sidecar-endpoint.json');
  try {
    if (fs.existsSync(endpointFile)) {
      fs.unlinkSync(endpointFile);
    }
  } catch {
    // Ignore cleanup errors
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
      writeSidecarEndpointFile(env.dataDir, env.port, env.uiToken);
      void resolveSidecarBaseUrl(env).then((baseUrl) => {
        if (baseUrl) {
          writeSidecarEndpointFile(env.dataDir, env.port, env.uiToken, baseUrl);
        }
      });
      console.log(
        `[a2ui-pane-sidecar] Listening on http://127.0.0.1:${env.port} (data: ${env.dataDir})`,
      );
    });

    const shutdown = (signal: string) => {
      console.log(`[a2ui-pane-sidecar] Received ${signal}, closing server...`);
      removeSidecarEndpointFile(env.dataDir);
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
