import fs from 'node:fs';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidId } from '@a2ui-pane/protocol';
import { SidecarEnv } from './env.js';
import { checkToken } from './auth.js';
import { StoreReader } from './store-reader.js';
import { ChangeNotifier } from './change-notifier.js';
import { handleStream } from './sse-route.js';
import { handlePreload } from './preload-route.js';
import { handleSendMessage, ExecFileFn } from './send-message-route.js';
import { serveStaticFile } from './static-files.js';

export interface SidecarDeps {
  storeReader: StoreReader;
  notifier: ChangeNotifier;
  staticDir: string;
  execFileFn?: ExecFileFn;
  keepaliveIntervalMs?: number;
}

/**
 * Creates and configures the Sidecar HTTP server with all API routes and static asset serving.
 * Designed with dependency injection to allow running on port 0 with mock stores during testing.
 */
export function createSidecarServer(
  env: SidecarEnv,
  injectedDeps?: Partial<SidecarDeps>,
): http.Server {
  const storeReader = injectedDeps?.storeReader ?? new StoreReader(env.dataDir);
  const notifier = injectedDeps?.notifier ?? new ChangeNotifier(env.dataDir);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidateDirs = [
    path.resolve(here, 'pane'),
    path.resolve(here, '../../pane-app/dist'),
    path.resolve(here, '../../../packages/pane-app/dist'),
  ];
  let defaultStaticDir = candidateDirs[0];
  for (const cand of candidateDirs) {
    if (fs.existsSync(cand)) {
      defaultStaticDir = cand;
      break;
    }
  }
  const staticDir = injectedDeps?.staticDir ?? defaultStaticDir;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);

    // Standard CORS headers for local and PEN-proxied sidecar communication
    const reqOrigin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', reqOrigin || '*');
    if (reqOrigin) {
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-sidecar-token, x-token, Last-Event-ID',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // Configuration endpoint
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          conversationId: env.conversationId,
          projectId: env.projectId,
        }),
      );
      return;
    }

    // Preload script
    if (url.pathname === '/preload.js') {
      handlePreload(res);
      return;
    }

    // SSE Stream endpoint
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      if (!checkToken(req, url, env.uiToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        return;
      }

      const convId = url.searchParams.get('conversationId') || env.conversationId;
      if (!convId || !isValidId(convId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Invalid or missing conversationId: ${convId}`,
          }),
        );
        return;
      }

      handleStream(req, res, convId, storeReader, notifier, {
        keepaliveIntervalMs: injectedDeps?.keepaliveIntervalMs,
      });
      return;
    }

    // Action dispatch endpoint
    if (url.pathname === '/_sidecar/send-message' && req.method === 'POST') {
      if (!checkToken(req, url, env.uiToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        return;
      }

      handleSendMessage(req, res, {
        agentapiExe: env.agentapiExe,
        execFileFn: injectedDeps?.execFileFn,
      });
      return;
    }

    // Static assets fallback (SPA index.html / bundled assets)
    if (req.method === 'GET') {
      const served = serveStaticFile(staticDir, url.pathname, res);
      if (served) return;
    }

    // 404 for all other unhandled routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not Found: ${url.pathname}` }));
  });

  return server;
}
