import { IncomingMessage, ServerResponse } from 'node:http';
import { formatSseEvent, formatSseKeepalive, KEEPALIVE_INTERVAL_MS } from '@a2ui-pane/protocol';
import { StoreReader } from './store-reader.js';
import { ChangeNotifier } from './change-notifier.js';

/** Configuration options for the `/api/stream` SSE handler. */
export interface SseStreamOptions {
  keepaliveIntervalMs?: number;
}

/**
 * Handles incoming SSE GET /api/stream requests.
 * Replays history starting from Last-Event-ID, streams newly appended lines in real-time,
 * emits reset events on file rotation/truncation, and maintains connection with keepalives.
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

  // Extract starting sequence from Last-Event-ID header or ?after= query parameter
  const rawLastId = req.headers['last-event-id'];
  let afterSeq = 0;
  if (typeof rawLastId === 'string') {
    const parsed = parseInt(rawLastId, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      afterSeq = parsed;
    }
  }

  let currentSeq = afterSeq;
  const subscriberId = Symbol('sse-subscriber');

  // 1. Initial replay of existing committed lines
  const initial = storeReader.read(conversationId, afterSeq, subscriberId);
  if (initial.reset) {
    res.write(formatSseEvent({ type: 'reset' }));
    currentSeq = 0;
  }
  for (const line of initial.lines) {
    res.write(formatSseEvent({ type: 'line', line }, line.seq));
    currentSeq = Math.max(currentSeq, line.seq);
  }

  // 2. Subscribe to file modification notifications
  const unsubscribe = notifier.subscribe(conversationId, () => {
    try {
      const update = storeReader.read(conversationId, currentSeq, subscriberId);
      if (update.reset) {
        res.write(formatSseEvent({ type: 'reset' }));
        currentSeq = 0;
      }
      for (const line of update.lines) {
        res.write(formatSseEvent({ type: 'line', line }, line.seq));
        currentSeq = Math.max(currentSeq, line.seq);
      }
    } catch (err) {
      console.error(`[sse-route] Error processing update for ${conversationId}:`, err);
    }
  });

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
    storeReader.removeSubscriber(conversationId, subscriberId);
    unsubscribe();
  });
}
