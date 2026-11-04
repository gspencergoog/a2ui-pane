import { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { isValidId } from '@a2ui-pane/protocol';
import {
  conversationDir,
  legacyFile,
  StoreLockError,
  SurfaceStore,
} from '@a2ui-pane/protocol/store-fs';

/** Why the pane removed a surface. */
export type SurfaceDeleteReason = 'dismissed' | 'submitted';

/** Dependencies of `handleSurfaceDelete`. */
export interface SurfaceDeleteOptions {
  /** Plugin data directory holding `conversations/`. */
  dataDir: string;
  /** Store to delete from; defaults to a `SurfaceStore` over `dataDir`. */
  store?: SurfaceStore;
}

/** Validated body of `POST /api/surfaces/delete`. */
interface SurfaceDeleteRequest {
  conversationId: string;
  surfaceId: string;
  reason: SurfaceDeleteReason;
}

const MAX_BODY_BYTES = 4 * 1024;
const REASONS: ReadonlySet<string> = new Set<SurfaceDeleteReason>(['dismissed', 'submitted']);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Parses and validates the request body; returns an error message when it is invalid. */
function parseDeleteRequest(body: string): SurfaceDeleteRequest | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = (JSON.parse(body || '{}') ?? {}) as Record<string, unknown>;
  } catch {
    return 'Malformed JSON body';
  }
  const { conversationId, surfaceId, reason } = parsed;
  if (!isValidId(conversationId) || conversationId === '_new') {
    return `Invalid conversationId: ${String(conversationId)}`;
  }
  if (!isValidId(surfaceId)) {
    return `Invalid surfaceId: ${String(surfaceId)}`;
  }
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return `Invalid reason: ${String(reason)} (expected 'dismissed' or 'submitted')`;
  }
  return { conversationId, surfaceId, reason: reason as SurfaceDeleteReason };
}

/** Whether the conversation has a store directory or a legacy flat file to migrate. */
function conversationExists(dataDir: string, conversationId: string): boolean {
  return (
    fs.existsSync(conversationDir(dataDir, conversationId)) ||
    fs.existsSync(legacyFile(dataDir, conversationId))
  );
}

async function deleteSurface(
  res: ServerResponse,
  store: SurfaceStore,
  request: SurfaceDeleteRequest,
): Promise<void> {
  const callId = `call_pane_${request.reason}_${Date.now()}`;
  if (!conversationExists(store.dataDir, request.conversationId)) {
    // Taking the lock would create an empty conversation directory.
    sendJson(res, 200, { deleted: false });
    return;
  }
  try {
    const line = await store.deleteSurfaceAsync(request.conversationId, request.surfaceId, callId);
    sendJson(res, 200, { deleted: line !== null });
  } catch (err) {
    if (err instanceof StoreLockError) {
      sendJson(res, 423, { error: `Store is locked: ${err.message}` });
      return;
    }
    console.error('[surfaces-route] Failed to delete surface:', err);
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
  }
}

/**
 * Handles `POST /api/surfaces/delete` with body
 * `{conversationId, surfaceId, reason: 'dismissed' | 'submitted'}`.
 *
 * It unlinks the surface's file and bumps `_seq` under the conversation lock,
 * waiting for the lock asynchronously so other SSE streams keep flowing.
 * Responds `200 {deleted}` (false when the surface or the conversation was
 * already gone, in which case nothing is written), `400`
 * for an invalid body, `413` for a body over 4 KB, and `423` when the lock
 * cannot be taken in time.
 */
export function handleSurfaceDelete(
  req: IncomingMessage,
  res: ServerResponse,
  options: SurfaceDeleteOptions,
): void {
  const store = options.store ?? new SurfaceStore(options.dataDir);
  const chunks: Buffer[] = [];
  let bytesReceived = 0;

  req.on('data', (chunk: Buffer | string) => {
    if (res.writableEnded) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesReceived += buf.length;
    if (bytesReceived > MAX_BODY_BYTES) {
      // Destroy the request only once the 413 is flushed, so it is not cut off.
      res.once('finish', () => req.destroy());
      sendJson(res, 413, { error: 'Payload Too Large: Maximum size 4KB' });
      return;
    }
    chunks.push(buf);
  });

  req.on('end', () => {
    if (res.writableEnded) return;
    const request = parseDeleteRequest(Buffer.concat(chunks).toString('utf-8'));
    if (typeof request === 'string') {
      sendJson(res, 400, { error: request });
      return;
    }
    void deleteSurface(res, store, request);
  });
}
