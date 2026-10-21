import { parseStoreLine } from '@a2ui-pane/protocol';
import { LineApplier } from '@a2ui-pane/renderer';

/** Lifecycle states of the SSE connection to the sidecar stream endpoint. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Minimum time between two build-change callbacks, so a flapping `buildId` cannot loop reloads. */
export const BUILD_RELOAD_MIN_INTERVAL_MS = 30_000;

/** `sessionStorage` key holding the time of the last build-change callback (epoch ms). */
export const BUILD_RELOAD_STORAGE_KEY = 'a2ui-pane:last-build-reload';

/** The subset of `Storage` the reload guard needs; `sessionStorage` satisfies it. */
export interface BuildReloadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Configuration options for `StreamClient`. */
export interface StreamClientOptions {
  conversationId: string;
  token?: string;
  baseUrl?: string;
  applier: LineApplier;
  reconnectDelayMs?: number;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: Event | Error) => void;
  eventSourceFactory?: (url: string) => EventSource;
  /** Called once when the sidecar starts serving a different pane build than this page loaded. */
  onBuildChanged?: () => void;
  /** URL of the config endpoint that reports `buildId`. Defaults to `./api/config`. */
  configUrl?: string;
  /** `fetch` used for the build check. Defaults to the global `fetch` when available. */
  fetchImpl?: typeof fetch;
  /** Storage for the reload guard. Defaults to `sessionStorage` when available. */
  storage?: BuildReloadStorage;
}

function defaultStorage(): BuildReloadStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    // Sandboxed documents throw on access; fall back to an in-memory guard.
    return undefined;
  }
}

/**
 * Manages the Server-Sent Events (SSE) connection between the pane frontend and the sidecar backend.
 * Reconnects on drops with Last-Event-ID resume, applies incoming lines, and triggers resets.
 *
 * On every successful (re)connect it also fetches `/api/config` and compares `buildId` with
 * the first value it saw. A different value means the sidecar now serves a new bundle while
 * this page still runs the old one, so `onBuildChanged` fires (at most once per
 * `BUILD_RELOAD_MIN_INTERVAL_MS`, tracked in `sessionStorage` so it survives the reload).
 */
export class StreamClient {
  private eventSource: EventSource | null = null;
  private status: ConnectionStatus = 'disconnected';
  private closedExplicitly = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private knownBuildId: string | null = null;
  private memoryLastReload = 0;

  constructor(private readonly options: StreamClientOptions) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.options.onStatusChange?.(newStatus);
    }
  }

  connect(): void {
    this.closedExplicitly = false;
    this.openStream();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Reads the served `buildId`; undefined when the endpoint is unavailable or has none. */
  private async fetchBuildId(): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchImpl) return undefined;
    try {
      const resp = await fetchImpl(this.options.configUrl ?? './api/config');
      if (!resp.ok) return undefined;
      const config = (await resp.json()) as { buildId?: unknown };
      return typeof config.buildId === 'string' && config.buildId ? config.buildId : undefined;
    } catch {
      return undefined;
    }
  }

  private lastReloadAt(): number {
    const storage = this.options.storage ?? defaultStorage();
    const stored = Number(storage?.getItem(BUILD_RELOAD_STORAGE_KEY) ?? Number.NaN);
    return Number.isFinite(stored) ? stored : this.memoryLastReload;
  }

  private recordReload(now: number): void {
    this.memoryLastReload = now;
    const storage = this.options.storage ?? defaultStorage();
    try {
      storage?.setItem(BUILD_RELOAD_STORAGE_KEY, String(now));
    } catch {
      // Storage may be full or disabled; the in-memory value still guards this page.
    }
  }

  /** Compares the served build with the one this page loaded and fires `onBuildChanged`. */
  private async checkBuild(): Promise<void> {
    if (!this.options.onBuildChanged) return;
    const buildId = await this.fetchBuildId();
    if (buildId === undefined || this.closedExplicitly) return;
    if (this.knownBuildId === null) {
      this.knownBuildId = buildId;
      return;
    }
    if (buildId === this.knownBuildId) return;
    const now = Date.now();
    if (now - this.lastReloadAt() < BUILD_RELOAD_MIN_INTERVAL_MS) return;
    this.recordReload(now);
    this.knownBuildId = buildId;
    this.options.onBuildChanged();
  }

  private openStream(): void {
    if (this.closedExplicitly) return;
    this.clearReconnectTimer();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const base = this.options.baseUrl ?? './api/stream';
    const params = new URLSearchParams();
    params.set('conversationId', this.options.conversationId);
    if (this.options.token) {
      params.set('token', this.options.token);
    }

    const streamUrl = `${base}?${params.toString()}`;
    this.setStatus(this.status === 'disconnected' ? 'connecting' : 'reconnecting');

    const createEs = this.options.eventSourceFactory ?? ((url: string) => new EventSource(url));
    const es = createEs(streamUrl);
    this.eventSource = es;

    es.onopen = () => {
      void this.checkBuild();
      this.setStatus('connected');
    };

    es.onerror = (evt) => {
      if (this.closedExplicitly) return;
      this.setStatus('reconnecting');
      this.options.onError?.(evt);
      // EventSource.CLOSED === 2: browser halted automatic retries
      if ((es as any).readyState === 2 && !this.reconnectTimer) {
        const delay = this.options.reconnectDelayMs ?? 3000;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.closedExplicitly) {
            this.openStream();
          }
        }, delay);
      }
    };

    es.addEventListener('line', (event: MessageEvent) => {
      try {
        const line = parseStoreLine(event.data);
        this.options.applier.apply([line]);
      } catch (err) {
        console.error('[StreamClient] Failed to parse stream line:', err);
      }
    });

    es.addEventListener('reset', () => {
      console.warn(
        '[StreamClient] Received reset event from server. Resetting applier and reconnecting.',
      );
      this.options.applier.reset();
      // Reopening creates a new EventSource instance, clearing Last-Event-ID to restart from seq 1
      this.openStream();
    });
  }

  disconnect(): void {
    this.closedExplicitly = true;
    this.clearReconnectTimer();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.setStatus('disconnected');
  }
}
