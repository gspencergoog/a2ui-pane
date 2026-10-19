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

  it('keeps surface visible with one-shot button disabled after action submission, notifies agent on X dismiss button click, and restores submitted and dismissed state from sessionStorage', async () => {
    const toggleSpy = vi.fn();
    const sentMessages: string[] = [];
    (window as any).sidecar = { ui: { toggleAuxPane: toggleSpy } };
    sessionStorage.clear();

    const instance = await initPaneApp({
      container,
      search: '?conversationId=conv_submit_lock',
      sendMessageFn: async (text: string) => {
        sentMessages.push(text);
        return { ok: true };
      },
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });

    instance!.applier.apply([
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfLock', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'surfLock',
            components: [
              { id: 'root', component: 'Row', children: ['submit_btn', 'helper_btn'] },
              { id: 'submit_txt', component: 'Text', text: 'Submit Alignment' },
              { id: 'helper_txt', component: 'Text', text: 'Filter' },
              {
                id: 'submit_btn',
                component: 'Button',
                variant: 'primary',
                child: 'submit_txt',
                action: {
                  event: {
                    name: 'submit_alignment',
                    context: { label: 'Submit Alignment', _group: 'align_grp' },
                  },
                },
              },
              {
                id: 'helper_btn',
                component: 'Button',
                variant: 'borderless',
                child: 'helper_txt',
                action: {
                  event: {
                    name: 'filter_items',
                    context: { _oneShot: false },
                  },
                },
              },
            ],
          },
        },
      },
    ]);

    const paneView = container.querySelector('#pane-view') as A2uiPaneView;
    await paneView.updateComplete;

    const surface = instance!.applier.getProcessor().getSurface('surfLock');

    // Repeatable helper button does not close AuxPane or set submittedState
    surface?.dispatchAction({ name: 'filter_items', context: { _oneShot: false } }, 'helper_btn');
    await new Promise((r) => setTimeout(r, 20));
    expect(instance!.isSubmitted()).toBe(false);
    expect(toggleSpy).not.toHaveBeenCalled();

    // One-shot primary button disables button while keeping surface visible
    surface?.dispatchAction(
      { name: 'submit_alignment', context: { label: 'Submit Alignment', _group: 'align_grp' } },
      'submit_btn',
    );
    await new Promise((r) => setTimeout(r, 20));
    await paneView.updateComplete;

    expect(instance!.isSubmitted()).toBe(true);
    expect(paneView.isSurfaceDismissed('surfLock')).toBe(false);
    expect(paneView.shadowRoot!.querySelector('[data-surface-id="surfLock"]')).not.toBeNull();
    expect(surface?.dataModel.get('/_submitted/submit_btn')).toBe(true);
    expect(surface?.dataModel.get('/_submitted/_group/align_grp')).toBe(true);
    expect(toggleSpy).toHaveBeenCalledWith({ open: false });

    // Apply a new surface surfLock2 -> renders with X dismiss button
    instance!.applier.apply([
      {
        seq: 3,
        ts: new Date().toISOString(),
        callId: 'c2',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfLock2', catalogId: 'basic' },
        },
      },
    ]);
    await paneView.updateComplete;
    expect(instance!.isSubmitted()).toBe(false);
    expect(paneView.shadowRoot!.querySelector('[data-surface-id="surfLock2"]')).not.toBeNull();

    // Clicking the built-in X dismiss button clears surfLock2 and notifies the agent
    const closeBtns = paneView.shadowRoot!.querySelectorAll('.a2ui-surface-close-btn');
    const closeBtn2 = closeBtns[closeBtns.length - 1] as HTMLButtonElement;
    expect(closeBtn2).not.toBeNull();
    closeBtn2.click();
    await new Promise((r) => setTimeout(r, 20));
    await paneView.updateComplete;

    expect(paneView.isSurfaceDismissed('surfLock2')).toBe(true);
    expect(sentMessages.some((m) => m.includes('dismiss_surface') && m.includes('surfLock2'))).toBe(
      true,
    );

    // Reload initPaneApp to verify sessionStorage restores surfLock's disabled button and surfLock2's dismissed state
    const reloadedContainer = document.createElement('div');
    document.body.appendChild(reloadedContainer);
    const reloaded = await initPaneApp({
      container: reloadedContainer,
      search: '?conversationId=conv_submit_lock',
      eventSourceFactory: (url) => new FakeEventSource(url) as any,
    });
    reloaded!.applier.apply([
      {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfLock', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'surfLock',
            components: [
              { id: 'root', component: 'Row', children: ['submit_btn'] },
              { id: 'submit_txt', component: 'Text', text: 'Submit Alignment' },
              {
                id: 'submit_btn',
                component: 'Button',
                variant: 'primary',
                child: 'submit_txt',
                action: { event: { name: 'submit_alignment' } },
              },
            ],
          },
        },
      },
      {
        seq: 3,
        ts: new Date().toISOString(),
        callId: 'c2',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfLock2', catalogId: 'basic' },
        },
      },
    ]);
    const reloadedPaneView = reloadedContainer.querySelector('#pane-view') as A2uiPaneView;
    await reloadedPaneView.updateComplete;
    const reloadedSurfLock = reloaded!.applier.getProcessor().getSurface('surfLock');
    expect(reloadedSurfLock?.dataModel.get('/_submitted/submit_btn')).toBe(true);
    expect(reloadedSurfLock?.dataModel.get('/_submitted/_group/align_grp')).toBe(true);
    expect(reloadedPaneView.isSurfaceDismissed('surfLock2')).toBe(true);

    // Applying a newer seq (seq 4) for surfLock and surfLock2 clears their persisted state
    reloaded!.applier.apply([
      {
        seq: 4,
        ts: new Date().toISOString(),
        callId: 'c3',
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surfLock', path: '/updated', value: true },
        },
      },
      {
        seq: 5,
        ts: new Date().toISOString(),
        callId: 'c4',
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surfLock2', path: '/updated', value: true },
        },
      },
    ]);
    await reloadedPaneView.updateComplete;
    expect(reloadedSurfLock?.dataModel.get('/_submitted/submit_btn')).toBeUndefined();
    expect(reloadedPaneView.isSurfaceDismissed('surfLock2')).toBe(false);

    document.body.removeChild(reloadedContainer);
    delete (window as any).sidecar;
  });
});
