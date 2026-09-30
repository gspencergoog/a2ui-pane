import { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { isValidId } from '@a2ui-pane/protocol';

export type ExecFileFn = typeof execFile;

export interface SendMessageOptions {
  agentapiExe?: string;
  execFileFn?: ExecFileFn;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * Handles POST /_sidecar/send-message requests from the pane frontend.
 * Invokes the host agentapi binary without a shell to route user actions into the active conversation.
 */
export function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  options: SendMessageOptions = {},
): void {
  let body = '';
  let bytesReceived = 0;

  req.on('data', (chunk: Buffer) => {
    bytesReceived += chunk.length;
    if (bytesReceived > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: Maximum size 1MB' }));
      req.destroy();
      return;
    }
    body += chunk.toString('utf-8');
  });

  req.on('end', () => {
    if (res.writableEnded) return;

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

    if (typeof message !== 'string' || !message.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Missing required 'message' string content" }));
      return;
    }

    const execFn = options.execFileFn ?? execFile;
    const [file, args] = options.agentapiExe
      ? [options.agentapiExe, ['agentapi', 'send-message', conversationId, message]]
      : ['agentapi', ['send-message', conversationId, message]];

    execFn(file, args, { shell: false }, (err, stdout, stderr) => {
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
