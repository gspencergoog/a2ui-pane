import { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isValidId } from '@a2ui-pane/protocol';

/** Function signature matching `node:child_process.execFile` for dependency injection. */
export type ExecFileFn = typeof execFile;

/** Options for routing action messages through the host `agentapi` CLI. */
export interface SendMessageOptions {
  agentapiExe?: string;
  execFileFn?: ExecFileFn;
  dataDir?: string;
}

const EMBED_FILE_REGEX = /^embed_[A-Za-z0-9_-]+_\d+_[a-f0-9]+\.html$/;
const ACTION_CONFIG_SCRIPT_RE =
  /(<script id="a2ui-action-config" type="application\/json">\r?\n)([\s\S]*?)(\r?\n\s*<\/script>)/;

function appendUniqueString(existing: unknown, candidate?: string): string[] | undefined {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (!trimmed) return undefined;
  const list = Array.isArray(existing) ? existing : [];
  return list.includes(trimmed) ? list : [...list, trimmed];
}

function updateActionConfigJson(
  rawJson: string,
  componentId?: string,
  group?: string,
): string | null {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const nextComponents = appendUniqueString(parsed.submittedComponents, componentId);
  if (nextComponents) parsed.submittedComponents = nextComponents;

  const nextGroups = appendUniqueString(parsed.submittedGroups, group);
  if (nextGroups) parsed.submittedGroups = nextGroups;

  return JSON.stringify(parsed).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function stampEmbedActionConfig(
  dataDir: string,
  conversationId: string,
  embedFile?: string,
  componentId?: string,
  group?: string,
): void {
  if (!dataDir || !embedFile || !EMBED_FILE_REGEX.test(embedFile)) return;
  const filePath = path.resolve(dataDir, 'embeds', conversationId, embedFile);
  if (!fs.existsSync(filePath)) return;

  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const match = ACTION_CONFIG_SCRIPT_RE.exec(html);
    if (!match) return;

    const updatedJson = updateActionConfigJson(match[2], componentId, group);
    if (!updatedJson) return;

    const updatedHtml = html.replace(ACTION_CONFIG_SCRIPT_RE, `$1${updatedJson}$3`);
    fs.writeFileSync(filePath, updatedHtml, { mode: 0o600 });
  } catch {
    // Ignore filesystem errors during best-effort embed stamping
  }
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
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Unsupported Media Type: Expected application/json or text/plain',
      }),
    );
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

    if (typeof message !== 'string' || !message.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Missing required 'message' string content" }));
      return;
    }

    if (options.dataDir && typeof parsed?.embedFile === 'string') {
      stampEmbedActionConfig(
        options.dataDir,
        conversationId,
        parsed.embedFile,
        typeof parsed.sourceComponentId === 'string' ? parsed.sourceComponentId : undefined,
        typeof parsed.group === 'string' ? parsed.group : undefined,
      );
    }

    const execFn = options.execFileFn ?? execFile;
    // ANTIGRAVITY_AGENTAPI_EXE points to the host language server executable,
    // which requires 'agentapi' as argv[1] (matching sidecar_sdk/node/index.mjs).
    const file = options.agentapiExe || 'agentapi';
    const args = options.agentapiExe
      ? ['agentapi', 'send-message', conversationId, message]
      : ['send-message', conversationId, message];

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
