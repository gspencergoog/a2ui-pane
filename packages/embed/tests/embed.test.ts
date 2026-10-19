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

    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toContain(
      '✓ Submitted to agent.',
    );
    expect(instance?.isSubmitted()).toBe(true);
    expect(instance?.paneView.style.pointerEvents).toBe('none');
    expect(instance?.paneView.style.opacity).toBe('0.72');
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(false);

    // Duplicate click while locked is ignored
    await surface?.dispatchAction({
      name: 'duplicateClick',
      context: { label: 'Duplicate Button' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clicking "Edit / Resubmit" unlocks the card and restores footer text
    const resubmitBtn = container.querySelector('.a2ui-embed-resubmit-btn') as HTMLButtonElement;
    expect(resubmitBtn).not.toBeNull();
    resubmitBtn.click();

    expect(instance?.isSubmitted()).toBe(false);
    expect(instance?.paneView.style.pointerEvents).toBe('');
    expect(instance?.paneView.style.opacity).toBe('1');
    expect(container.querySelector('.a2ui-embed-footer')?.textContent).toBe(
      'Submitting triggers the agent directly.',
    );

    // Resubmission now succeeds
    await surface?.dispatchAction({
      name: 'resubmitClick',
      context: { label: 'Resubmit Button' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(instance?.isSubmitted()).toBe(true);

    instance?.destroy();
  });

  it('dispatches via sidecarUrl (with text/plain and credentials: include) and falls back to loopback port if sidecarUrl fails', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfSidecarUrl', catalogId: 'basic' },
        },
      ]),
      actionConfig: {
        port: 54321,
        key: 'loopback-key',
        surfaceId: 'surfSidecarUrl',
        conversationId: 'conv-proxy-1',
        sidecarUrl: 'https://sidecar.example.com/_sidecar/send-message?token=tok1',
      },
      fetchFn: mockFetch as any,
    });

    const surface = instance?.applier.getProcessor().getSurface('surfSidecarUrl');

    // 1. Primary path: sidecarUrl succeeds
    await surface?.dispatchAction({
      name: 'proxyClick',
      context: { label: 'Proxy Button' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://sidecar.example.com/_sidecar/send-message?token=tok1',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      }),
    );
    expect(instance?.isSubmitted()).toBe(true);

    // Unlock and test fallback from sidecarUrl (502) to loopback port (200)
    instance?.setSubmittedState(false);
    await surface?.dispatchAction({
      name: 'fallbackLoopbackClick',
      context: { label: 'Loopback Fallback' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:54321/action',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(instance?.isSubmitted()).toBe(true);

    consoleWarnSpy.mockRestore();
    instance?.destroy();
  });

  it('ignores concurrent action clicks while side-channel fetch is in flight', async () => {
    let resolveFetch!: (val: any) => void;
    const mockFetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfInFlight', catalogId: 'basic' },
        },
      ]),
      actionConfig: {
        port: 54321,
        key: 'inflight-key',
        surfaceId: 'surfInFlight',
      },
      fetchFn: mockFetch as any,
    });

    const surface = instance?.applier.getProcessor().getSurface('surfInFlight');
    surface?.dispatchAction({ name: 'click1' });
    // Trigger second click while first is still pending
    surface?.dispatchAction({ name: 'click2' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200 });
    await new Promise((r) => setTimeout(r, 0));
    expect(instance?.isSubmitted()).toBe(true);

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

    // 1. Non-ok response falls back to PROMPT and locks one-shot card
    await surface?.dispatchAction({ name: 'action1' });
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(true);
    expect(instance?.isSubmitted()).toBe(true);
    expect(instance?.paneView.style.pointerEvents).toBe('none');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Side channel returned HTTP 500'),
    );

    // Unlock and test 2. Network error / rejection falls back to PROMPT and locks one-shot card
    instance?.setSubmittedState(false);
    postedEvents.length = 0;
    await surface?.dispatchAction({ name: 'action2' });
    expect(postedEvents.some((e) => e.type === 'PROMPT')).toBe(true);
    expect(instance?.isSubmitted()).toBe(true);
    expect(instance?.paneView.style.pointerEvents).toBe('none');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Side channel fetch failed'),
      expect.any(Error),
    );

    // 3. setSubmittedState(false) on non-direct embed resets to chat box message
    const fallbackInstance = initEmbed({
      container,
      messagesJson: JSON.stringify([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfNoEndpoint', catalogId: 'basic' },
        },
      ]),
    });
    fallbackInstance?.setSubmittedState(false);
    fallbackInstance?.destroy();

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

  it('restores submittedComponents and submittedGroups from actionConfig on startup, unlocks via Edit/Resubmit, and keeps repeatable actions unlocked', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const messages = [
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfPersist', catalogId: 'basic' },
      },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'surfPersist',
          components: [
            { id: 'root', component: 'Row', children: ['submit_btn', 'helper_btn'] },
            { id: 'submit_txt', component: 'Text', text: 'Submit' },
            { id: 'helper_txt', component: 'Text', text: 'Refresh' },
            {
              id: 'submit_btn',
              component: 'Button',
              variant: 'primary',
              child: 'submit_txt',
              action: {
                event: {
                  name: 'submit_form',
                  context: { _oneShot: true, _group: 'form_group' },
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
                  name: 'refresh_data',
                  context: { _oneShot: false },
                },
              },
            },
          ],
        },
      },
    ];

    const instance = initEmbed({
      container,
      messagesJson: JSON.stringify(messages),
      actionConfig: {
        port: 54321,
        key: 'persist-key',
        surfaceId: 'surfPersist',
        embedFile: 'embed_surfPersist_1700000000000_abcdef0123456789.html',
        submittedComponents: ['submit_btn'],
        submittedGroups: ['form_group'],
      },
      fetchFn: mockFetch as any,
    });

    expect(instance?.isSubmitted()).toBe(true);
    await instance!.paneView.updateComplete;
    const surfaceEl = instance!.paneView.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    await new Promise((r) => setTimeout(r, 30));

    const buttonHosts = Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-button'));
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }

    const submitBtn = buttonHosts[0].querySelector('button') as HTMLButtonElement;
    const helperBtn = buttonHosts[1].querySelector('button') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(helperBtn.disabled).toBe(false);

    // Click "Edit / Resubmit" -> unlocks card and re-enables submitBtn
    const resubmitBtn = container.querySelector('.a2ui-embed-resubmit-btn') as HTMLButtonElement;
    resubmitBtn.click();
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }

    expect(instance?.isSubmitted()).toBe(false);
    expect(submitBtn.disabled).toBe(false);

    // Clicking repeatable helper button sends action without locking card or passing sourceComponentId
    helperBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(instance?.isSubmitted()).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const helperPayload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(helperPayload.embedFile).toBe('embed_surfPersist_1700000000000_abcdef0123456789.html');
    expect(helperPayload.sourceComponentId).toBeUndefined();

    // Clicking one-shot submit button disables it, locks card, and sends sourceComponentId + group
    submitBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }
    expect(instance?.isSubmitted()).toBe(true);
    expect(submitBtn.disabled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const submitPayload = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(submitPayload.embedFile).toBe('embed_surfPersist_1700000000000_abcdef0123456789.html');
    expect(submitPayload.sourceComponentId).toBe('submit_btn');
    expect(submitPayload.group).toBe('form_group');

    instance?.destroy();
  });
});
