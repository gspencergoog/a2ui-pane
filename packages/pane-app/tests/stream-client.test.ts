import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamClient, ConnectionStatus } from '../src/stream-client.js';
import { LineApplier } from '@a2ui-pane/renderer';
import { serializeStoreLine, StoreLine } from '@a2ui-pane/protocol';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Map<string, Array<(event: any) => void>> = new Map();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  emit(type: string, eventData: any) {
    const list = this.listeners.get(type) ?? [];
    for (const listener of list) {
      listener(eventData);
    }
  }

  triggerOpen() {
    this.onopen?.(new Event('open'));
  }

  triggerError(err = new Event('error')) {
    this.onerror?.(err);
  }

  close() {
    this.closed = true;
  }
}

describe('StreamClient', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
  });

  it('connects to stream with conversationId and token in query params', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const statusChanges: ConnectionStatus[] = [];

    const client = new StreamClient({
      conversationId: 'conv_123',
      token: 'secret-token',
      baseUrl: 'http://localhost:3000/api/stream',
      applier,
      onStatusChange: (status) => statusChanges.push(status),
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();

    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];
    expect(es.url).toContain('conversationId=conv_123');
    expect(es.url).toContain('token=secret-token');
    expect(statusChanges).toEqual(['connecting']);
    expect(client.getStatus()).toBe('connecting');

    es.triggerOpen();
    expect(statusChanges).toEqual(['connecting', 'connected']);
    expect(client.getStatus()).toBe('connected');
  });

  it('receives line event, parses JSON, and forwards to applier', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const applySpy = vi.spyOn(applier, 'apply');

    const client = new StreamClient({
      conversationId: 'conv_abc',
      applier,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    const es = MockEventSource.instances[0];

    const storeLine: StoreLine = {
      seq: 1,
      ts: new Date().toISOString(),
      callId: 'call_1',
      message: {
        version: 'v0.9',
        createSurface: { surfaceId: 'surf1', catalogId: 'basic' },
      },
    };

    es.emit('line', { data: serializeStoreLine(storeLine).trim() });

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith([storeLine]);
  });

  it('handles malformed line event gracefully without crashing', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const applySpy = vi.spyOn(applier, 'apply');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = new StreamClient({
      conversationId: 'conv_abc',
      applier,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    const es = MockEventSource.instances[0];

    es.emit('line', { data: 'invalid-json' });

    expect(applySpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles reset event by resetting applier and reopening stream', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const resetSpy = vi.spyOn(applier, 'reset');

    const client = new StreamClient({
      conversationId: 'conv_reset',
      applier,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    expect(MockEventSource.instances).toHaveLength(1);
    const firstEs = MockEventSource.instances[0];

    firstEs.emit('reset', {});

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(firstEs.closed).toBe(true);
    // Should have opened a new EventSource instance
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(false);
  });

  it('transitions to reconnecting on error and invokes onError callback', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const errorSpy = vi.fn();
    const statusChanges: ConnectionStatus[] = [];

    const client = new StreamClient({
      conversationId: 'conv_err',
      applier,
      onError: errorSpy,
      onStatusChange: (s) => statusChanges.push(s),
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    const es = MockEventSource.instances[0];
    es.triggerOpen();

    const errEvent = new Event('error');
    es.triggerError(errEvent);

    expect(errorSpy).toHaveBeenCalledWith(errEvent);
    expect(client.getStatus()).toBe('reconnecting');
  });

  it('disconnects explicitly and closes active EventSource', () => {
    MockEventSource.instances = [];
    const applier = new LineApplier();
    const statusChanges: ConnectionStatus[] = [];

    const client = new StreamClient({
      conversationId: 'conv_disc',
      applier,
      onStatusChange: (s) => statusChanges.push(s),
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    client.disconnect();
    expect(es.closed).toBe(true);
    expect(client.getStatus()).toBe('disconnected');

    // Triggering error after disconnect should not change status to reconnecting
    es.triggerError();
    expect(client.getStatus()).toBe('disconnected');
  });

  it('uses default baseUrl ./api/stream when omitted', () => {
    const applier = new LineApplier();
    const client = new StreamClient({
      conversationId: 'default_base',
      applier,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });
    client.connect();
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(es.url).toMatch(/^\.\/api\/stream\?/);
  });

  it('handles error safely when onError is omitted', () => {
    const applier = new LineApplier();
    const client = new StreamClient({
      conversationId: 'no_err_cb',
      applier,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });
    client.connect();
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(() => es.triggerError()).not.toThrow();
    expect(client.getStatus()).toBe('reconnecting');
  });

  it('schedules reconnect timer when EventSource enters fatal CLOSED state (M7)', () => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    const applier = new LineApplier();

    const client = new StreamClient({
      conversationId: 'fatal_closed_conv',
      applier,
      reconnectDelayMs: 500,
      eventSourceFactory: (url) => new MockEventSource(url) as any,
    });

    client.connect();
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0] as any;
    es.readyState = 2; // EventSource.CLOSED

    es.triggerError();
    expect(client.getStatus()).toBe('reconnecting');

    vi.advanceTimersByTime(500);
    expect(MockEventSource.instances).toHaveLength(2);

    client.disconnect();
    vi.useRealTimers();
  });
});
