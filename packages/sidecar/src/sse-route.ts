import { IncomingMessage, ServerResponse } from 'node:http';
import { formatSseEvent, formatSseKeepalive, KEEPALIVE_INTERVAL_MS } from '@a2ui-pane/protocol';
import { knownFromLines, type KnownSurfaces, StoreReader } from './store-reader.js';
import { ChangeNotifier } from './change-notifier.js';

/** Configuration options for the `/api/stream` SSE handler. */
export interface SseStreamOptions {
  keepaliveIntervalMs?: number;
}

/**
 * Handles incoming SSE GET /api/stream requests.
 *
 * On connect it sends one `snapshot` event with every live surface and ignores
 * `Last-Event-ID`: a snapshot is a few KB, so a reconnect simply starts over.
 * After that, each change notification sends `line` events for surfaces that
 * changed and `deleteSurface` tombstones for surfaces whose file is gone.
 */
export function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  storeReader: StoreReader,
  notifier: ChangeNotifier,
  options: SseStreamOptions = {},
): void {
  const keepaliveMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let known: KnownSurfaces = new Map();

  // 1. Subscribe before taking the snapshot, so a write that lands in between
  // produces a tick whose diff sends it. A write the snapshot already holds
  // diffs to nothing.
  const unsubscribe = notifier.subscribe(conversationId, () => {
    try {
      const update = storeReader.diff(conversationId, known);
      known = update.known;
      for (const line of update.lines) {
        res.write(formatSseEvent({ type: 'line', line }, line.seq));
      }
    } catch (err) {
      console.error(`[sse-route] Error processing update for ${conversationId}:`, err);
    }
  });

  // 2. Send the complete current set of surfaces.
  try {
    const lines = storeReader.snapshot(conversationId);
    known = knownFromLines(lines);
    res.write(formatSseEvent({ type: 'snapshot', lines }));
  } catch (err) {
    // The next tick's diff sends every surface, because `known` is still empty.
    console.error(`[sse-route] Error reading snapshot for ${conversationId}:`, err);
  }

  // 3. Keepalive timer
  let keepaliveTimer: NodeJS.Timeout | null = setInterval(() => {
    try {
      res.write(formatSseKeepalive());
    } catch {
      // Stream write error
    }
  }, keepaliveMs);

  // 4. Teardown on connection close
  req.on('close', () => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    unsubscribe();
  });
}
