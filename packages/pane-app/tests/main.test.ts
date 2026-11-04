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
  let originalFetch: typeof fetch;

  beforeEach(() => {
    (window as any).__A2UI_DISABLE_AUTO_INIT__ = true;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }) as any;
    FakeEventSource.instances = [];
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    expect(instance?.actionSender).toBeDefined();
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

  it('treats conversationId=_new as not attached yet without falling back to /api/config', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ conversationId: 'config-conv-456' }),
    });

    const instance = await initPaneApp({
      container,
      search: '?conversationId=_new&token=tok123',
      fetchFn: mockFetch as any,
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(instance?.client).toBeUndefined();
    expect(FakeEventSource.instances).toHaveLength(0);
    const statusBadge = container.querySelector('#status-badge');
    expect(statusBadge?.textContent?.trim()).toBe('No Conversation');
  });

  it('forwards the resolved conversationId to sendMessageFn when dispatching actions', async () => {
    const sendMessageSpy = vi.fn().mockResolvedValue({ ok: true });
    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_forward_id',
      sendMessageFn: sendMessageSpy,
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    await instance!.actionSender.sendAction({
      name: 'approve',
      surfaceId: 's1',
      sourceComponentId: 'btn1',
      timestamp: '2026-10-13T00:00:00Z',
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe('conv_forward_id');
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
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('reports pane visibility on init, resize across 0x0, and SSE reconnect', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

    await initPaneApp({
      container,
      search: '?conversationId=conv_vis&token=tok_vis',
      fetchFn: mockFetch as any,
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      './api/visibility',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': 'tok_vis',
        },
        body: JSON.stringify({ conversationId: 'conv_vis', visible: true }),
      }),
    );

    // Resize to 0x0 (AuxPane hidden)
    Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true });
    window.dispatchEvent(new Event('resize'));

    expect(mockFetch).toHaveBeenLastCalledWith(
      './api/visibility',
      expect.objectContaining({
        body: JSON.stringify({ conversationId: 'conv_vis', visible: false }),
      }),
    );

    // Restore size and trigger SSE open to verify reannounce
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    FakeEventSource.instances[0].triggerOpen();

    expect(mockFetch).toHaveBeenLastCalledWith(
      './api/visibility',
      expect.objectContaining({
        body: JSON.stringify({ conversationId: 'conv_vis', visible: true }),
      }),
    );
  });

  it('tracks HoistedFrameHost display:none transitions via ResizeObserver/IntersectionObserver, host postMessage, focus, and out-of-order fetch settlement', async () => {
    let roCallback: (() => void) | undefined;
    let ioCallback: (() => void) | undefined;
    const origRO = (globalThis as any).ResizeObserver;
    const origIO = (globalThis as any).IntersectionObserver;
    (globalThis as any).ResizeObserver = class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
    };
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: () => void) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {}
    };

    const pendingResolvers: Array<() => void> = [];
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolvers.push(() =>
            resolve({
              ok: true,
              json: async () => ({ ok: true }),
            }),
          );
        }),
    );

    Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 0,
      configurable: true,
    });

    await initPaneApp({
      container,
      search: '?conversationId=conv_hoisted&token=tok_hoisted',
      fetchFn: mockFetch as any,
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    // Request #1: initial visible=false (still in flight)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: false,
    });

    // Slot opens to 420x600 while Request #1 is still in flight
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 420,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    roCallback?.();

    // Request #2: visible=true sent while Request #1 is still in flight
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: true,
    });

    // Simulate out-of-order network completion: Request #2 (true) finishes first, Request #1 (false) finishes last!
    pendingResolvers[1]();
    await new Promise((r) => setTimeout(r, 0));
    pendingResolvers[0]();
    await new Promise((r) => setTimeout(r, 0));

    // Corrective Request #3 (visible=true) automatically sent because Request #1 settled last with false
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: true,
    });
    pendingResolvers[2]();
    await new Promise((r) => setTimeout(r, 0));

    // Now HoistedFrameHost hides the slot with display:none -> window.innerWidth stays 420, but documentElement.clientWidth collapses to 0
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 0,
      configurable: true,
    });
    ioCallback?.();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: false,
    });
    pendingResolvers[3]();
    await new Promise((r) => setTimeout(r, 0));

    // HoistedFrameHost re-shows the slot with display:block and IframeActiveSync posts theme-change
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 420,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'theme-change' } }));
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(JSON.parse(mockFetch.mock.calls[4][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: true,
    });
    pendingResolvers[4]();
    await new Promise((r) => setTimeout(r, 0));

    // Focus while visible re-announces visible:true
    window.dispatchEvent(new Event('focus'));
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(JSON.parse(mockFetch.mock.calls[5][1].body)).toEqual({
      conversationId: 'conv_hoisted',
      visible: true,
    });
    pendingResolvers[5]();
    await new Promise((r) => setTimeout(r, 0));

    (globalThis as any).ResizeObserver = origRO;
    (globalThis as any).IntersectionObserver = origIO;
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 0,
      configurable: true,
    });
  });

  describe('surface removal on dismiss and submit', () => {
    interface Harness {
      instance: NonNullable<Awaited<ReturnType<typeof initPaneApp>>>;
      paneView: A2uiPaneView;
      log: string[];
      deleteBodies: Array<Record<string, unknown>>;
      deleteHeaders: Array<Record<string, string>>;
    }

    const flush = () => new Promise((r) => setTimeout(r, 20));

    function buttonSurfaceLines(surfaceId: string) {
      return [
        {
          seq: 1,
          ts: new Date().toISOString(),
          callId: 'c1',
          message: { version: 'v0.9', createSurface: { surfaceId, catalogId: 'basic' } },
        },
        {
          seq: 2,
          ts: new Date().toISOString(),
          callId: 'c1',
          message: {
            version: 'v0.9',
            updateComponents: {
              surfaceId,
              components: [
                { id: 'root', component: 'Row', children: ['submit_btn', 'helper_btn'] },
                { id: 'submit_txt', component: 'Text', text: 'Submit' },
                { id: 'helper_txt', component: 'Text', text: 'Filter' },
                {
                  id: 'submit_btn',
                  component: 'Button',
                  variant: 'primary',
                  child: 'submit_txt',
                  action: { event: { name: 'submit', context: { label: 'Submit' } } },
                },
                {
                  id: 'helper_btn',
                  component: 'Button',
                  variant: 'borderless',
                  child: 'helper_txt',
                  action: { event: { name: 'filter', context: { _oneShot: false } } },
                },
              ],
            },
          },
        },
      ];
    }

    async function setup(
      opts: { sendFails?: boolean; deleteStatus?: number; surfaceId?: string } = {},
    ): Promise<Harness> {
      const log: string[] = [];
      const deleteBodies: Array<Record<string, unknown>> = [];
      const deleteHeaders: Array<Record<string, string>> = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === './api/surfaces/delete') {
          log.push('delete');
          deleteBodies.push(JSON.parse(String(init?.body)));
          deleteHeaders.push(init?.headers as Record<string, string>);
          const status = opts.deleteStatus ?? 200;
          return { ok: status === 200, status, json: async () => ({ deleted: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });
      const instance = await initPaneApp({
        container,
        search: '?conversationId=conv_remove&token=tok_remove',
        fetchFn: fetchFn as any,
        sendMessageFn: async (text: string) => {
          log.push(text.includes('dismiss_surface') ? 'send:dismiss' : 'send');
          if (opts.sendFails) throw new Error('host offline');
          return { ok: true };
        },
        eventSourceFactory: (url) => new FakeEventSource(url) as any,
      });
      instance!.applier.apply(buttonSurfaceLines(opts.surfaceId ?? 'surf') as any);
      const paneView = container.querySelector('#pane-view') as A2uiPaneView;
      await paneView.updateComplete;
      return { instance: instance!, paneView, log, deleteBodies, deleteHeaders };
    }

    afterEach(() => {
      delete (window as any).sidecar;
    });

    it('posts the delete route on dismiss and then sends dismiss_surface', async () => {
      const { paneView, log, deleteBodies, deleteHeaders } = await setup();

      const closeBtn = paneView.shadowRoot!.querySelector(
        '.a2ui-surface-close-btn',
      ) as HTMLButtonElement;
      closeBtn.click();
      expect(paneView.isSurfaceDismissed('surf')).toBe(true);
      await flush();

      expect(log).toEqual(['delete', 'send:dismiss']);
      expect(deleteBodies).toEqual([
        { conversationId: 'conv_remove', surfaceId: 'surf', reason: 'dismissed' },
      ]);
      expect(deleteHeaders[0]['X-Sidecar-Token']).toBe('tok_remove');
    });

    it('still sends dismiss_surface when the delete route reports a lock timeout', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { paneView, log } = await setup({ deleteStatus: 423 });

      (paneView.shadowRoot!.querySelector('.a2ui-surface-close-btn') as HTMLButtonElement).click();
      await flush();

      expect(log).toEqual(['delete', 'send:dismiss']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 423'));
      warn.mockRestore();
    });

    it('deletes a surface after a one-shot action is sent', async () => {
      const toggleSpy = vi.fn();
      (window as any).sidecar = { ui: { toggleAuxPane: toggleSpy } };
      const { instance, paneView, log, deleteBodies } = await setup();
      const surface = instance.applier.getProcessor().getSurface('surf');

      surface?.dispatchAction({ name: 'submit', context: { label: 'Submit' } }, 'submit_btn');
      await flush();

      expect(log).toEqual(['send', 'delete']);
      expect(deleteBodies).toEqual([
        { conversationId: 'conv_remove', surfaceId: 'surf', reason: 'submitted' },
      ]);
      expect(paneView.isSurfaceDismissed('surf')).toBe(true);
      expect(toggleSpy).toHaveBeenCalledWith({ open: false });
    });

    it('keeps the surface and skips the delete when the send fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { instance, paneView, log } = await setup({ sendFails: true });
      const surface = instance.applier.getProcessor().getSurface('surf');

      surface?.dispatchAction({ name: 'submit', context: { label: 'Submit' } }, 'submit_btn');
      await flush();

      expect(log).toEqual(['send']);
      expect(paneView.isSurfaceDismissed('surf')).toBe(false);
      expect(instance.applier.getProcessor().getSurface('surf')).toBeDefined();
      error.mockRestore();
    });

    it('never deletes for a repeatable button', async () => {
      const toggleSpy = vi.fn();
      (window as any).sidecar = { ui: { toggleAuxPane: toggleSpy } };
      const { instance, paneView, log } = await setup();
      const surface = instance.applier.getProcessor().getSurface('surf');

      surface?.dispatchAction({ name: 'filter', context: { _oneShot: false } }, 'helper_btn');
      await flush();

      expect(log).toEqual(['send']);
      expect(paneView.isSurfaceDismissed('surf')).toBe(false);
      expect(toggleSpy).not.toHaveBeenCalled();
    });

    it('drops actions from a surface the user already dismissed', async () => {
      const { instance, paneView, log } = await setup();
      const surface = instance.applier.getProcessor().getSurface('surf');
      paneView.dismissSurface('surf');

      surface?.dispatchAction({ name: 'submit', context: { label: 'Submit' } }, 'submit_btn');
      await flush();

      expect(log).toEqual([]);
    });

    it('stores no surface outcome in sessionStorage', async () => {
      sessionStorage.clear();
      const { paneView } = await setup();
      (paneView.shadowRoot!.querySelector('.a2ui-surface-close-btn') as HTMLButtonElement).click();
      await flush();
      expect(sessionStorage.getItem('a2ui-pane-state:conv_remove')).toBeNull();
    });

    it('shows a surface again when a re-created snapshot arrives after the tombstone', async () => {
      const { instance, paneView } = await setup();
      (paneView.shadowRoot!.querySelector('.a2ui-surface-close-btn') as HTMLButtonElement).click();
      await flush();

      // The sidecar streams the tombstone for the deleted file, then a re-render.
      instance.applier.apply([
        {
          seq: 3,
          ts: new Date().toISOString(),
          callId: 'store',
          message: { version: 'v0.9', deleteSurface: { surfaceId: 'surf' } },
        },
      ]);
      instance.applier.apply([
        {
          seq: 4,
          ts: new Date().toISOString(),
          callId: 'c2',
          message: { version: 'v0.9', createSurface: { surfaceId: 'surf', catalogId: 'basic' } },
        },
      ]);
      await paneView.updateComplete;

      expect(paneView.isSurfaceDismissed('surf')).toBe(false);
      expect(paneView.shadowRoot!.querySelector('[data-surface-id="surf"]')).not.toBeNull();
    });
  });
});
