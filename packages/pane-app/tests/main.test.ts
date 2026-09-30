import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initPaneApp } from '../src/main.js';
import { A2uiPaneView } from '@a2ui-pane/renderer';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Map<string, Array<(event: any) => void>> = new Map();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: any) {
    const list = this.listeners.get(type) ?? [];
    for (const l of list) l(data);
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

describe('initPaneApp', () => {
  let container: HTMLElement;

  beforeEach(() => {
    (window as any).__A2UI_DISABLE_AUTO_INIT__ = true;
    FakeEventSource.instances = [];
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentElement) {
      document.body.removeChild(container);
    }
  });

  it('returns undefined if container is not found', async () => {
    const result = await initPaneApp({ container: null });
    expect(result).toBeUndefined();
  });

  it('initializes pane with conversationId from query search and connects stream', async () => {
    const instance = await initPaneApp({
      container,
      search: '?conversationId=test-conv-1&token=tok123',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    expect(instance).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('conversationId=test-conv-1');

    const convBadge = container.querySelector('#conv-badge');
    expect(convBadge?.textContent).toContain('(test-conv-1)');

    const statusBadge = container.querySelector('#status-badge');
    expect(statusBadge?.textContent?.trim()).toBe('Connecting...');

    // Trigger open
    FakeEventSource.instances[0].triggerOpen();
    expect(statusBadge?.textContent?.trim()).toBe('Live');
  });

  it('falls back to fetch /api/config when conversationId is absent from query', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ conversationId: 'config-conv-456' }),
    });

    const instance = await initPaneApp({
      container,
      search: '',
      fetchFn: mockFetch as any,
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    expect(mockFetch).toHaveBeenCalledWith('./api/config');
    expect(instance).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('conversationId=config-conv-456');
  });

  it('handles missing conversationId when config fetch fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const instance = await initPaneApp({
      container,
      search: '',
      fetchFn: mockFetch as any,
    });

    expect(instance).toBeDefined();
    expect(instance?.client).toBeUndefined();
    const statusBadge = container.querySelector('#status-badge');
    expect(statusBadge?.textContent?.trim()).toBe('No Conversation');
  });

  it('handles non-ok config response gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const instance = await initPaneApp({
      container,
      search: '',
      fetchFn: mockFetch as any,
    });

    expect(instance?.client).toBeUndefined();
    const statusBadge = container.querySelector('#status-badge');
    expect(statusBadge?.textContent?.trim()).toBe('No Conversation');
  });

  it('updates status badge across all connection states', async () => {
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_states',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    const statusBadge = container.querySelector('#status-badge') as HTMLElement;

    instance!.updateStatus('connected');
    expect(statusBadge.textContent?.trim()).toBe('Live');

    instance!.updateStatus('connecting');
    expect(statusBadge.textContent?.trim()).toBe('Connecting...');

    instance!.updateStatus('reconnecting');
    expect(statusBadge.textContent?.trim()).toBe('Reconnecting...');

    instance!.updateStatus('disconnected');
    expect(statusBadge.textContent?.trim()).toBe('Offline');
  });

  it('displays error banner when lines fail and dismiss button clears errors', async () => {
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_errs',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    const errorBanner = container.querySelector('#error-banner') as HTMLElement;
    const errorMessage = container.querySelector('#error-message') as HTMLElement;
    const dismissBtn = container.querySelector('#dismiss-error') as HTMLButtonElement;

    expect(errorBanner.style.display).toBe('none');

    // Apply an invalid line to produce an error
    instance!.applier.apply([
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          updateDataModel: {
            surfaceId: 'nonexistent',
            path: '/',
            value: 1,
          },
        },
      },
    ]);

    instance!.updateErrors();
    expect(errorBanner.style.display).toBe('flex');
    expect(errorMessage.textContent).toContain('Warning: 1 A2UI update(s) failed');

    // Click dismiss button
    dismissBtn.click();
    expect(errorBanner.style.display).toBe('none');
    expect(instance!.applier.getErrors()).toHaveLength(0);
  });

  it('re-binds new processor to a2ui-pane-view on reset', async () => {
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_reset',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    const paneView = container.querySelector('#pane-view') as A2uiPaneView;
    const initialProcessor = paneView.processor;

    instance!.applier.reset();
    expect(paneView.processor).not.toBe(initialProcessor);
  });

  it('triggers onAction callback when provided', async () => {
    const onActionSpy = vi.fn();
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_action',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
      onAction: onActionSpy,
    });

    instance?.applier.apply([
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfAct', catalogId: 'basic' },
        },
      },
    ]);

    const surface = instance?.applier.getProcessor().getSurface('surfAct');
    surface?.dispatchAction({ name: 'click' });
    expect(onActionSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers onError callback when stream fails', async () => {
    await initPaneApp({
      container,
      search: '?conversationId=conv_stream_err',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });
    const es = FakeEventSource.instances[0];
    es.triggerError();
    const statusBadge = container.querySelector('#status-badge');
    expect(statusBadge?.textContent?.trim()).toBe('Reconnecting...');
  });

  it('uses default onAction logger when none is passed', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_default_action',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });
    instance?.applier.apply([
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfDef', catalogId: 'basic' },
        },
      },
    ]);
    const surface = instance?.applier.getProcessor().getSurface('surfDef');
    surface?.dispatchAction({ name: 'testDefaultAction' });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses globalThis.fetch when fetchFn is omitted', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ conversationId: 'global-fetch-conv' }),
    }) as any;
    const instance = await initPaneApp({
      container,
      search: '',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('./api/config');
    expect(instance?.client).toBeDefined();
    globalThis.fetch = originalFetch;
  });

  it('covers startApp branches', async () => {
    const { startApp } = await import('../src/main.js');

    // Case 1: auto init disabled
    (window as any).__A2UI_DISABLE_AUTO_INIT__ = true;
    expect(() => startApp()).not.toThrow();

    // Case 2: auto init enabled with existing container
    (window as any).__A2UI_DISABLE_AUTO_INIT__ = false;
    expect(() => startApp()).not.toThrow();

    // Case 3: loading state
    Object.defineProperty(document, 'readyState', {
      value: 'loading',
      configurable: true,
    });
    expect(() => startApp()).not.toThrow();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    Object.defineProperty(document, 'readyState', {
      value: 'complete',
      configurable: true,
    });
  });
});
