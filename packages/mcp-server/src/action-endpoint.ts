import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { formatActionText, type A2uiActionDetails } from '@a2ui-pane/protocol';

/** Configuration options for the loopback HTTP action endpoint. */
export interface ActionEndpointOptions {
  dataDir: string;
  agentapiExe?: string;
  port?: number;
  sendActionDirectly?: (conversationId: string, text: string) => Promise<void>;
}

/** Metadata recorded for an active inline `<agent-embed>` surface token. */
export interface RegisteredEmbed {
  conversationId: string;
  surfaceId: string;
  allowedActions?: string[];
  expiresAt: number;
}

/** Result returned by `await_a2ui_action` when an action arrives or times out. */
export interface AwaitActionResult {
  status: 'received' | 'timeout';
  surfaceId?: string;
  action?: A2uiActionDetails;
  dataModel?: Record<string, unknown>;
  message?: string;
}

interface PendingAwait {
  resolve: (result: AwaitActionResult) => void;
  timer: NodeJS.Timeout;
}

const MAX_BODY_BYTES = 120 * 1024; // 120 KB limit (below Linux MAX_ARG_STRLEN 128 KB)
const AGENTAPI_TIMEOUT_MS = 30_000;

/**
 * Loopback HTTP server on 127.0.0.1 providing a direct side-channel for inline <agent-embed> cards
 * to dispatch actions without requiring user interaction in the chat composer.
 *
 * Implements CORS and Chrome Private Network Access (PNA) preflight responses, authenticates
 * per-embed random tokens, and routes actions either to waiting await_a2ui_action tool promises
 * or directly to agentapi send-message.
 */
export class ActionEndpoint {
  private server?: http.Server;
  private port = 0;
  private readonly activeEmbeds = new Map<string, RegisteredEmbed>();
  private readonly pendingAwaits = new Map<string, PendingAwait>();

  constructor(private readonly options: ActionEndpointOptions) {
    if (!options.dataDir) {
      throw new Error('ActionEndpoint requires a valid dataDir');
    }
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Registers an active inline embed surface, issuing a high-entropy random key.
   */
  registerEmbed(
    conversationId: string,
    surfaceId: string,
    allowedActions?: string[],
    ttlMs = 3600000,
  ): string {
    const now = Date.now();
    for (const [k, entry] of this.activeEmbeds.entries()) {
      if (entry.expiresAt < now) {
        this.activeEmbeds.delete(k);
      }
    }

    const key = crypto.randomBytes(32).toString('hex');
    this.activeEmbeds.set(key, {
      conversationId,
      surfaceId,
      allowedActions,
      expiresAt: now + ttlMs,
    });
    return key;
  }

  /**
   * Registers a pending await_a2ui_action request for a specific surface.
   */
  awaitAction(
    conversationId: string,
    surfaceId: string,
    timeoutSeconds = 300,
  ): Promise<AwaitActionResult> {
    const waiterKey = `${conversationId}:${surfaceId}`;

    const existing = this.pendingAwaits.get(waiterKey);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({
        status: 'timeout',
        message: 'Replaced by newer await request',
      });
      this.pendingAwaits.delete(waiterKey);
    }

    return new Promise<AwaitActionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAwaits.delete(waiterKey);
        resolve({
          status: 'timeout',
          message: `Timed out waiting for action on surface ${surfaceId} after ${timeoutSeconds}s`,
        });
      }, timeoutSeconds * 1000);

      this.pendingAwaits.set(waiterKey, { resolve, timer });
    });
  }

  /**
   * Starts the HTTP loopback server on 127.0.0.1.
   */
  async start(): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.server = server;

          try {
            fs.mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(this.options.dataDir, 'action-port'), String(this.port), {
              mode: 0o600,
            });
          } catch (err: any) {
            console.error('[ActionEndpoint] Failed writing action-port file:', err);
          }

          resolve(this.port);
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url?.split('?')[0] || '';
    const method = req.method?.toUpperCase();

    // 1. CORS & Private Network Access preflight
    if (method === 'OPTIONS' && url === '/action') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-A2UI-Key',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // 2. Action submission
    if (method === 'POST' && url === '/action') {
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let oversized = false;

      req.on('data', (chunk: Buffer) => {
        if (oversized) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesReceived += buf.length;
        if (bytesReceived > MAX_BODY_BYTES) {
          oversized = true;
          res.writeHead(413, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Private-Network': 'true',
          });
          res.end(JSON.stringify({ error: 'Payload Too Large: Maximum size 120KB' }));
          req.destroy();
          return;
        }
        chunks.push(buf);
      });

      req.on('end', async () => {
        if (oversized || res.writableEnded) return;

        const bodyData = Buffer.concat(chunks).toString('utf-8');
        let payload: any;
        try {
          payload = JSON.parse(bodyData);
        } catch (err: any) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Private-Network': 'true',
          });
          res.end(JSON.stringify({ error: `Malformed JSON: ${err?.message || err}` }));
          return;
        }

        try {
          await this.processAction(payload, req, res);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Private-Network': 'true',
            });
            res.end(JSON.stringify({ error: `Internal error: ${err?.message || err}` }));
          }
        }
      });
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async processAction(
    payload: any,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const headerKey =
      typeof req.headers['x-a2ui-key'] === 'string' ? req.headers['x-a2ui-key'] : '';
    const key = headerKey || (typeof payload?.key === 'string' ? payload.key : '');
    const action = payload?.action;
    const dataModel = payload?.dataModel;

    const embed = this.activeEmbeds.get(key);
    if (!embed || embed.expiresAt < Date.now()) {
      if (embed) {
        this.activeEmbeds.delete(key);
      }
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(JSON.stringify({ error: 'Invalid or expired embed key' }));
      return;
    }

    if (!action || typeof action.name !== 'string') {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(JSON.stringify({ error: 'Missing or invalid action payload' }));
      return;
    }

    if (embed.allowedActions && !embed.allowedActions.includes(action.name)) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(JSON.stringify({ error: `Action "${action.name}" is not permitted for this embed` }));
      return;
    }

    const waiterKey = `${embed.conversationId}:${embed.surfaceId}`;
    const pending = this.pendingAwaits.get(waiterKey);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAwaits.delete(waiterKey);
      pending.resolve({
        status: 'received',
        surfaceId: embed.surfaceId,
        action,
        dataModel,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(JSON.stringify({ ok: true, routedTo: 'await_action' }));
      return;
    }

    // Direct forwarding to agent session
    const promptText = formatActionText(action, {
      label: typeof action.context?.label === 'string' ? action.context.label : undefined,
      dataModel,
    });

    if (this.options.sendActionDirectly) {
      await this.options.sendActionDirectly(embed.conversationId, promptText);
    } else {
      await this.dispatchAgentapi(embed.conversationId, promptText);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end(JSON.stringify({ ok: true, routedTo: 'agentapi' }));
  }

  private async dispatchAgentapi(conversationId: string, message: string): Promise<void> {
    const endpointFile = path.join(this.options.dataDir, 'sidecar-endpoint.json');
    if (
      !this.options.agentapiExe &&
      !process.env.ANTIGRAVITY_AGENTAPI_EXE &&
      !process.env.ANTIGRAVITY_LS_ADDRESS &&
      fs.existsSync(endpointFile)
    ) {
      await this.dispatchViaSidecar(endpointFile, conversationId, message);
      return;
    }

    return new Promise((resolve, reject) => {
      const customExe = this.options.agentapiExe || process.env.ANTIGRAVITY_AGENTAPI_EXE;
      const file = customExe || 'agentapi';
      const args = customExe
        ? ['agentapi', 'send-message', conversationId, message]
        : ['send-message', conversationId, message];

      execFile(file, args, { timeout: AGENTAPI_TIMEOUT_MS }, (err, _stdout, stderr) => {
        if (err) {
          console.error('[ActionEndpoint] Failed invoking agentapi:', err, stderr);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async dispatchViaSidecar(
    endpointFile: string,
    conversationId: string,
    message: string,
  ): Promise<void> {
    const raw = fs.readFileSync(endpointFile, 'utf-8');
    const { port, uiToken } = JSON.parse(raw) as { port: number; uiToken?: string };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (uiToken) {
      headers['x-sidecar-token'] = uiToken;
    }
    const resp = await fetch(`http://127.0.0.1:${port}/_sidecar/send-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId, message }),
      signal: AbortSignal.timeout(AGENTAPI_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Sidecar send-message failed (${resp.status}): ${errText}`);
    }
  }

  /**
   * Closes the loopback server, cancels pending timers, and removes the port file.
   */
  async close(): Promise<void> {
    for (const pending of this.pendingAwaits.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        status: 'timeout',
        message: 'ActionEndpoint closed',
      });
    }
    this.pendingAwaits.clear();
    this.activeEmbeds.clear();

    const portFile = path.join(this.options.dataDir, 'action-port');
    try {
      if (fs.existsSync(portFile)) {
        fs.unlinkSync(portFile);
      }
    } catch {
      // Ignore cleanup error
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
      this.port = 0;
    }
  }
}
