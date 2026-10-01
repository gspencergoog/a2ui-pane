import { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { isValidId } from '@a2ui-pane/protocol';

export type ExecFileFn = typeof execFile;

export interface SendMessageOptions {
  agentapiExe?: string;
  expectedConversationId?: string;
  execFileFn?: ExecFileFn;
}

const MAX_BODY_BYTES = 120 * 1024; // 120 KB (below Linux MAX_ARG_STRLEN 128 KB)
const EXEC_TIMEOUT_MS = 30_000;

/**
 * Handles POST /_sidecar/send-message requests from the pane frontend.
 * Invokes the host agentapi binary without a shell to route user actions into the active conversation.
 */
export function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  options: SendMessageOptions = {},
): void {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unsupported Media Type: Expected application/json' }));
    return;
  }

  const chunks: Buffer[] = [];
  let bytesReceived = 0;
  let oversized = false;

  req.on('data', (chunk: Buffer) => {
    if (oversized) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesReceived += buf.length;
    if (bytesReceived > MAX_BODY_BYTES) {
      oversized = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: Maximum size 120KB' }));
      req.destroy();
      return;
    }
    chunks.push(buf);
  });

  req.on('end', () => {
    if (oversized || res.writableEnded) return;

    const body = Buffer.concat(chunks).toString('utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
      return;
    }

    const { conversationId, message } = parsed || {};

    if (!conversationId || typeof conversationId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Missing required 'conversationId' string" }));
      return;
    }

    if (!isValidId(conversationId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid conversationId: ${conversationId}` }));
      return;
    }

    if (options.expectedConversationId && conversationId !== options.expectedConversationId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Forbidden conversationId '${conversationId}'. Restricted to '${options.expectedConversationId}'.`,
        }),
      );
      return;
    }

    if (typeof message !== 'string' || !message.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Missing required 'message' string content" }));
      return;
    }

    const execFn = options.execFileFn ?? execFile;
    const file = options.agentapiExe || 'agentapi';
    const args = ['send-message', conversationId, message];

    execFn(file, args, { shell: false, timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error('[send-message] Failed to execute agentapi:', err, stderr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: err.message,
            stderr: stderr?.trim() || undefined,
          }),
        );
        return;
      }

      let resultObj: any = { ok: true };
      const trimmedOut = stdout?.trim();
      if (trimmedOut) {
        try {
          resultObj = JSON.parse(trimmedOut);
        } catch {
          resultObj = { ok: true, output: trimmedOut };
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultObj));
    });
  });
}
