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
import { currentBuildId, serveStaticFile } from './static-files.js';

/** Injectable dependencies for `createSidecarServer`. */
export interface SidecarDeps {
  storeReader: StoreReader;
  notifier: ChangeNotifier;
  staticDir: string;
  execFileFn?: ExecFileFn;
  keepaliveIntervalMs?: number;
  onVisibilityChange?: (conversationId: string, visible: boolean) => void;
}

function isAttachedConversationId(id: unknown): id is string {
  return typeof id === 'string' && id !== '_new' && isValidId(id);
}

function handleVisibility(
  req: IncomingMessage,
  res: ServerResponse,
  onVisibilityChange?: (conversationId: string, visible: boolean) => void,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as {
        conversationId?: unknown;
        visible?: unknown;
      };
      if (!isAttachedConversationId(parsed.conversationId) || typeof parsed.visible !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid conversationId or visible flag' }));
        return;
      }
      onVisibilityChange?.(parsed.conversationId, parsed.visible);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Malformed JSON body' }));
    }
  });
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
  const activeStreams = new Map<string, number>();

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);

    // Standard CORS headers for local and reverse-proxied sidecar communication
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
          buildId: currentBuildId(staticDir),
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

      const rawConvId = url.searchParams.has('conversationId')
        ? url.searchParams.get('conversationId')
        : env.conversationId;
      if (!isAttachedConversationId(rawConvId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Invalid or missing conversationId: ${String(rawConvId)}`,
          }),
        );
        return;
      }
      const convId = rawConvId;

      activeStreams.set(convId, (activeStreams.get(convId) ?? 0) + 1);
      req.on('close', () => {
        const remaining = (activeStreams.get(convId) ?? 1) - 1;
        if (remaining <= 0) {
          activeStreams.delete(convId);
          injectedDeps?.onVisibilityChange?.(convId, false);
        } else {
          activeStreams.set(convId, remaining);
        }
      });

      handleStream(req, res, convId, storeReader, notifier, {
        keepaliveIntervalMs: injectedDeps?.keepaliveIntervalMs,
      });
      return;
    }

    // Pane visibility reporting endpoint
    if (url.pathname === '/api/visibility' && req.method === 'POST') {
      if (!checkToken(req, url, env.uiToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        return;
      }
      handleVisibility(req, res, injectedDeps?.onVisibilityChange);
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
        dataDir: env.dataDir,
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
