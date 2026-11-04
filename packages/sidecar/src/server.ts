import fs from 'node:fs';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidId } from '@a2ui-pane/protocol';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';
import { SidecarEnv } from './env.js';
import { checkToken } from './auth.js';
import { StoreReader } from './store-reader.js';
import { ChangeNotifier } from './change-notifier.js';
import { handleStream } from './sse-route.js';
import { handlePreload } from './preload-route.js';
import { handleSendMessage, ExecFileFn } from './send-message-route.js';
import { handleSurfaceDelete } from './surfaces-route.js';
import { currentBuildId, serveStaticFile } from './static-files.js';

/** Injectable dependencies for `createSidecarServer`. */
export interface SidecarDeps {
  storeReader: StoreReader;
  notifier: ChangeNotifier;
  /** Store the delete route writes to; defaults to a `SurfaceStore` over `env.dataDir`. */
  surfaceStore: SurfaceStore;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Standard CORS headers for local and reverse-proxied sidecar communication. */
function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
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
}

/** Returns the first candidate pane-app build directory that exists. */
function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidateDirs = [
    path.resolve(here, 'pane'),
    path.resolve(here, '../../pane-app/dist'),
    path.resolve(here, '../../../packages/pane-app/dist'),
  ];
  return candidateDirs.find((cand) => fs.existsSync(cand)) ?? candidateDirs[0];
}

/** Resolved dependencies and per-server state shared by the route handlers. */
interface RouteContext {
  env: SidecarEnv;
  storeReader: StoreReader;
  notifier: ChangeNotifier;
  surfaceStore: SurfaceStore;
  staticDir: string;
  injectedDeps?: Partial<SidecarDeps>;
  activeStreams: Map<string, number>;
}

/** A token-protected API route. */
interface ProtectedRoute {
  method: string;
  path: string;
  handle: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext) => void;
}

/** Counts open streams per conversation and reports a hidden pane when the last one closes. */
function trackStream(req: IncomingMessage, convId: string, ctx: RouteContext): void {
  const { activeStreams } = ctx;
  activeStreams.set(convId, (activeStreams.get(convId) ?? 0) + 1);
  req.on('close', () => {
    const remaining = (activeStreams.get(convId) ?? 1) - 1;
    if (remaining <= 0) {
      activeStreams.delete(convId);
      ctx.injectedDeps?.onVisibilityChange?.(convId, false);
    } else {
      activeStreams.set(convId, remaining);
    }
  });
}

function handleStreamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): void {
  const rawConvId = url.searchParams.has('conversationId')
    ? url.searchParams.get('conversationId')
    : ctx.env.conversationId;
  if (!isAttachedConversationId(rawConvId)) {
    sendJson(res, 400, { error: `Invalid or missing conversationId: ${String(rawConvId)}` });
    return;
  }
  trackStream(req, rawConvId, ctx);
  handleStream(req, res, rawConvId, ctx.storeReader, ctx.notifier, {
    keepaliveIntervalMs: ctx.injectedDeps?.keepaliveIntervalMs,
  });
}

const PROTECTED_ROUTES: ProtectedRoute[] = [
  // SSE Stream endpoint
  { method: 'GET', path: '/api/stream', handle: handleStreamRoute },
  // Pane visibility reporting endpoint
  {
    method: 'POST',
    path: '/api/visibility',
    handle: (req, res, _url, ctx) =>
      handleVisibility(req, res, ctx.injectedDeps?.onVisibilityChange),
  },
  // Surface removal on dismiss or submit
  {
    method: 'POST',
    path: '/api/surfaces/delete',
    handle: (req, res, _url, ctx) =>
      handleSurfaceDelete(req, res, { dataDir: ctx.env.dataDir, store: ctx.surfaceStore }),
  },
  // Action dispatch endpoint
  {
    method: 'POST',
    path: '/_sidecar/send-message',
    handle: (req, res, _url, ctx) =>
      handleSendMessage(req, res, {
        agentapiExe: ctx.env.agentapiExe,
        execFileFn: ctx.injectedDeps?.execFileFn,
        dataDir: ctx.env.dataDir,
      }),
  },
];

/** Serves the routes that need no token. Returns whether the request was handled. */
function handlePublicRoute(res: ServerResponse, url: URL, ctx: RouteContext): boolean {
  switch (url.pathname) {
    case '/api/health':
      sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
      return true;
    case '/api/config':
      sendJson(res, 200, {
        conversationId: ctx.env.conversationId,
        projectId: ctx.env.projectId,
        buildId: currentBuildId(ctx.staticDir),
      });
      return true;
    case '/preload.js':
      handlePreload(res);
      return true;
    default:
      return false;
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (handlePublicRoute(res, url, ctx)) return;

  const route = PROTECTED_ROUTES.find((r) => r.path === url.pathname && r.method === req.method);
  if (route) {
    if (!checkToken(req, url, ctx.env.uiToken)) {
      sendJson(res, 401, { error: 'Unauthorized: Invalid token' });
      return;
    }
    route.handle(req, res, url, ctx);
    return;
  }

  // Static assets fallback (SPA index.html / bundled assets)
  if (req.method === 'GET' && serveStaticFile(ctx.staticDir, url.pathname, res)) return;

  // 404 for all other unhandled routes
  sendJson(res, 404, { error: `Not Found: ${url.pathname}` });
}

/**
 * Creates and configures the Sidecar HTTP server with all API routes and static asset serving.
 * Designed with dependency injection to allow running on port 0 with mock stores during testing.
 */
export function createSidecarServer(
  env: SidecarEnv,
  injectedDeps?: Partial<SidecarDeps>,
): http.Server {
  const ctx: RouteContext = {
    env,
    storeReader: injectedDeps?.storeReader ?? new StoreReader(env.dataDir),
    notifier: injectedDeps?.notifier ?? new ChangeNotifier(env.dataDir),
    surfaceStore: injectedDeps?.surfaceStore ?? new SurfaceStore(env.dataDir),
    staticDir: injectedDeps?.staticDir ?? defaultStaticDir(),
    injectedDeps,
    activeStreams: new Map<string, number>(),
  };
  return http.createServer((req: IncomingMessage, res: ServerResponse) =>
    handleRequest(req, res, ctx),
  );
}
