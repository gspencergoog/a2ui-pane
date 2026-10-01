import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initEmbed } from '../src/embed-main.js';
import { parseActionText } from '@a2ui-pane/protocol';

describe('initEmbed', () => {
  let container: HTMLElement;

  beforeEach(() => {
    (window as any).__A2UI_DISABLE_EMBED_AUTO_INIT__ = true;
    container = document.createElement('div');
    container.id = 'a2ui-embed-root';
    document.body.appendChild(container);

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 200,
      configurable: true,
    });
    Object.defineProperty(document.body, 'scrollWidth', {
      value: 300,
      configurable: true,
    });
  });

  afterEach(() => {
    container.remove();
    const existing = document.getElementById('a2ui-messages');
    if (existing) existing.remove();
  });

  it('mounts <a2ui-pane-view>, renders messages, and emits RESIZE event', () => {
    const postedEvents: any[] = [];
    const mockPostMessage = (data: any) => {
      postedEvents.push(data);
    };

    const messages = [
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'embedSurf', catalogId: 'basic' },
      },
    ];

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify(messages),
      postMessageFn: mockPostMessage,
    });

    expect(instance).not.toBeNull();
    expect(container.querySelector('a2ui-pane-view')).not.toBeNull();
    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toBe(
      'Submitting fills in the chat box.',
    );

    // Initial measurement dispatched RESIZE
    expect(postedEvents.some((e) => e.type === 'RESIZE')).toBe(true);

    instance?.destroy();
    expect(container.querySelector('.a2ui-embed-container')).toBeNull();
  });

  it('dispatches PROMPT postMessage when an action is triggered on the surface', () => {
    const postedEvents: any[] = [];
    const mockPostMessage = (data: any) => {
      postedEvents.push(data);
    };

    const messages = [
      {
        version: 'v0.9',
        createSurface: {
          surfaceId: 'formSurf',
          catalogId: 'basic',
          sendDataModel: true,
        },
      },
      {
        version: 'v0.9',
        updateDataModel: {
          surfaceId: 'formSurf',
          path: '/counter',
          value: 42,
        },
      },
    ];

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify(messages),
      postMessageFn: mockPostMessage,
    });

    const surface = instance?.applier.getProcessor().getSurface('formSurf');
    expect(surface).toBeDefined();

    surface?.dispatchAction({
      name: 'submitCount',
      context: { label: 'Submit Counter' },
    });

    const promptEvent = postedEvents.find((e) => e.type === 'PROMPT');
    expect(promptEvent).toBeDefined();
    expect(promptEvent.prompt).toContain(
      '[A2UI] Triggered "Submit Counter" (submitCount) on surface formSurf.',
    );

    const parsed = parseActionText(promptEvent.prompt);
    expect(parsed?.action.name).toBe('submitCount');
    expect((parsed?.dataModel as any)?.surfaces.formSurf.counter).toBe(42);

    instance?.destroy();
  });

  it('reads messages from #a2ui-messages script tag if messagesJson option is omitted', () => {
    const scriptEl = document.createElement('script');
    scriptEl.id = 'a2ui-messages';
    scriptEl.type = 'application/json';
    scriptEl.textContent = JSON.stringify([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'fromScriptTag', catalogId: 'basic' },
      },
    ]);
    document.body.appendChild(scriptEl);

    const instance = initEmbed({ container });
    expect(instance?.applier.getProcessor().getSurface('fromScriptTag')).toBeDefined();
    instance?.destroy();
  });

  it('handles malformed JSON in #a2ui-messages gracefully', () => {
    const scriptEl = document.createElement('script');
    scriptEl.id = 'a2ui-messages';
    scriptEl.type = 'application/json';
    scriptEl.textContent = '{invalid-json}';
    document.body.appendChild(scriptEl);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = initEmbed({ container });
    expect(instance).not.toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    instance?.destroy();
  });

  it('handles messages that are already formatted as StoreLine objects', () => {
    const storeLines = [
      {
        seq: 1,
        ts: '2026-09-30T00:00:00.000Z',
        callId: 'call_1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'storeLineSurf', catalogId: 'basic' },
        },
      },
    ];

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify(storeLines),
    });

    expect(instance?.applier.getProcessor().getSurface('storeLineSurf')).toBeDefined();
    instance?.destroy();
  });

  it('executes autoInit when enabled and attaches listener if document is loading', async () => {
    const { autoInit } = await import('../src/embed-main.js');

    const originalReadyState = document.readyState;
    Object.defineProperty(document, 'readyState', {
      value: 'loading',
      configurable: true,
    });

    // Enabled
    (window as any).__A2UI_DISABLE_EMBED_AUTO_INIT__ = false;

    autoInit();

    // Dispatch DOMContentLoaded while loading to execute the listener
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Now complete
    Object.defineProperty(document, 'readyState', {
      value: 'complete',
      configurable: true,
    });

    autoInit();

    // Disabled again
    (window as any).__A2UI_DISABLE_EMBED_AUTO_INIT__ = true;
    autoInit();

    Object.defineProperty(document, 'readyState', {
      value: originalReadyState,
      configurable: true,
    });
  });

  it('uses default window.parent.postMessage when postMessageFn is omitted', () => {
    const mockParent = {
      postMessage: vi.fn(),
    };
    const originalParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: mockParent,
      configurable: true,
    });

    try {
      const instance = initEmbed({
        container,
        messagesJson: JSON.stringify([
          {
            version: 'v0.9',
            createSurface: { surfaceId: 'defParent', catalogId: 'basic' },
          },
        ]),
      });

      const surf = instance?.applier.getProcessor().getSurface('defParent');
      expect(surf).toBeDefined();

      // Trigger action without context label
      surf?.dispatchAction({
        name: 'noLabelAction',
      });

      expect(mockParent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PROMPT',
          prompt: expect.stringContaining('noLabelAction'),
        }),
        '*',
      );

      instance?.destroy();
    } finally {
      Object.defineProperty(window, 'parent', {
        value: originalParent,
        configurable: true,
      });
    }
  });

  it('dispatches action via fetch when actionConfig is present and fetch succeeds', async () => {
    const postedEvents: any[] = [];
    const mockPostMessage = vi.fn((data: any) => postedEvents.push(data));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfSide', catalogId: 'basic' },
        },
      ]),
      actionConfig: {
        port: 54321,
        key: 'secret-embed-token',
        surfaceId: 'surfSide',
      },
      postMessageFn: mockPostMessage,
      fetchFn: mockFetch as any,
    });

    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toBe(
      'Submitting triggers the agent directly.',
    );

    const surface = instance?.applier.getProcessor().getSurface('surfSide');
    await surface?.dispatchAction({
      name: 'directClick',
      context: { label: 'Direct Button' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:54321/action',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-A2UI-Key': 'secret-embed-token',
        }),
        body: expect.not.stringContaining('secret-embed-token'),
      }),
    );

    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toBe(
      'Action sent directly to agent.',
    );
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(false);

    instance?.destroy();
  });

  it('uses configured targetOrigin when posting PROMPT messages (M5)', () => {
    const calls: Array<{ data: any; origin: string }> = [];
    const instance = initEmbed({
      container,
      targetOrigin: 'https://host.example.com',
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'originSurf', catalogId: 'basic' },
        },
      ]),
      postMessageFn: (data, origin) => calls.push({ data, origin }),
    });

    const surface = instance?.applier.getProcessor().getSurface('originSurf');
    surface?.dispatchAction({ name: 'submitOrigin' });

    const promptCall = calls.find((c) => c.data.type === 'PROMPT');
    expect(promptCall).toBeDefined();
    expect(promptCall?.origin).toBe('https://host.example.com');

    instance?.destroy();
  });

  it('falls back to PROMPT postMessage when side-channel fetch fails or returns HTTP error', async () => {
    const postedEvents: any[] = [];
    const mockPostMessage = vi.fn((data: any) => postedEvents.push(data));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockRejectedValueOnce(new Error('PNA / Local network access blocked'));

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfFail', catalogId: 'basic' },
        },
      ]),
      actionConfig: {
        port: 54321,
        key: 'test-key',
        surfaceId: 'surfFail',
      },
      postMessageFn: mockPostMessage,
      fetchFn: mockFetch as any,
    });

    const surface = instance?.applier.getProcessor().getSurface('surfFail');

    // 1. Non-ok response falls back to PROMPT
    await surface?.dispatchAction({ name: 'action1' });
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Side channel returned HTTP 500'),
    );

    // 2. Network error / rejection falls back to PROMPT
    postedEvents.length = 0;
    await surface?.dispatchAction({ name: 'action2' });
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Side channel fetch failed'),
      expect.any(Error),
    );

    consoleWarnSpy.mockRestore();
    instance?.destroy();
  });

  it('reads actionConfig from #a2ui-action-config and handles malformed JSON', () => {
    const configScript = document.createElement('script');
    configScript.id = 'a2ui-action-config';
    configScript.type = 'application/json';
    configScript.textContent = JSON.stringify({
      port: 1234,
      key: 'dom-key',
      surfaceId: 'dom-surf',
    });
    document.body.appendChild(configScript);

    const instance1 = initEmbed({ container });
    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toBe(
      'Submitting triggers the agent directly.',
    );
    instance1?.destroy();
    configScript.remove();

    // Malformed JSON
    const badScript = document.createElement('script');
    badScript.id = 'a2ui-action-config';
    badScript.type = 'application/json';
    badScript.textContent = '{invalid-json';
    document.body.appendChild(badScript);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance2 = initEmbed({ container });
    expect(consoleErrorSpy).toHaveBeenCalled();
    instance2?.destroy();
    badScript.remove();
    consoleErrorSpy.mockRestore();
  });
});
