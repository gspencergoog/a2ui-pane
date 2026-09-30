import { parseStoreLine } from '@a2ui-pane/protocol';
import { LineApplier } from '@a2ui-pane/renderer';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface StreamClientOptions {
  conversationId: string;
  token?: string;
  baseUrl?: string;
  applier: LineApplier;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: Event | Error) => void;
  eventSourceFactory?: (url: string) => EventSource;
}

/**
 * Manages the Server-Sent Events (SSE) connection between the pane frontend and the sidecar backend.
 * Reconnects on drops with Last-Event-ID resume, applies incoming lines, and triggers resets.
 */
export class StreamClient {
  private eventSource: EventSource | null = null;
  private status: ConnectionStatus = 'disconnected';
  private closedExplicitly = false;

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

  private openStream(): void {
    if (this.closedExplicitly) return;

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
      this.setStatus('connected');
    };

    es.onerror = (evt) => {
      if (this.closedExplicitly) return;
      this.setStatus('reconnecting');
      this.options.onError?.(evt);
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
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.setStatus('disconnected');
  }
}
