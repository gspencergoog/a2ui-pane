import { injectHostTheme } from '@a2ui-pane/theme';
import { formatActionText, A2uiActionDetails, StoreLine } from '@a2ui-pane/protocol';
import { LineApplier, A2uiPaneView } from '@a2ui-pane/renderer';
import { SurfaceResizeObserver } from './surface-resize-observer.js';

export interface ActionConfig {
  port?: number;
  key?: string;
  surfaceId: string;
  conversationId?: string;
  sidecarUrl?: string;
  targetOrigin?: string;
}

export interface InitEmbedOptions {
  container?: HTMLElement;
  messagesJson?: string;
  actionConfig?: ActionConfig;
  targetOrigin?: string;
  postMessageFn?: (data: any, targetOrigin: string) => void;
  fetchFn?: typeof fetch;
  resizeObserverFactory?: (
    cb: (dims: { height: number; width: number }) => void,
  ) => SurfaceResizeObserver;
}

export interface EmbedInstance {
  applier: LineApplier;
  paneView: A2uiPaneView;
  resizeObserver: SurfaceResizeObserver;
  isSubmitted: () => boolean;
  setSubmittedState: (submitted: boolean) => void;
  destroy: () => void;
}

export function applySubmittedState(
  paneView: HTMLElement,
  footerNote: HTMLElement,
  submitted: boolean,
  hasDirectEndpoint: boolean,
  onUnlock: () => void,
): void {
  if (!submitted) {
    paneView.style.pointerEvents = '';
    paneView.style.opacity = '1';
    footerNote.textContent = hasDirectEndpoint
      ? 'Submitting triggers the agent directly.'
      : 'Submitting fills in the chat box.';
    return;
  }

  paneView.style.pointerEvents = 'none';
  paneView.style.opacity = '0.72';
  footerNote.textContent = '';

  const statusSpan = document.createElement('span');
  statusSpan.textContent = '✓ Submitted to agent. ';
  footerNote.appendChild(statusSpan);

  const resubmitBtn = document.createElement('button');
  resubmitBtn.type = 'button';
  resubmitBtn.className = 'a2ui-embed-resubmit-btn';
  resubmitBtn.textContent = 'Edit / Resubmit';
  resubmitBtn.style.cssText = `
    background: transparent;
    border: 1px solid var(--a2ui-color-border, #6a737d);
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
  `;
  resubmitBtn.addEventListener('click', onUnlock);
  footerNote.appendChild(resubmitBtn);
}

function createTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(3000)
    : undefined;
}

async function trySidecarDispatch(
  sidecarUrl: string,
  conversationId: string,
  promptText: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const resp = await fetchFn(sidecarUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({
        conversationId,
        message: promptText,
      }),
      signal: createTimeoutSignal(),
    });
    if (resp.ok) {
      return true;
    }
    console.warn(`[a2ui-embed] Sidecar endpoint returned HTTP ${resp.status}.`);
  } catch (err) {
    console.warn('[a2ui-embed] Sidecar endpoint fetch failed:', err);
  }
  return false;
}

async function tryLoopbackDispatch(
  port: number,
  key: string,
  action: A2uiActionDetails,
  dataModel: Record<string, unknown> | undefined,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const endpointUrl = `http://127.0.0.1:${port}/action`;
    const resp = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Key': key,
      },
      body: JSON.stringify({
        action,
        dataModel,
      }),
      signal: createTimeoutSignal(),
    });
    if (resp.ok) {
      return true;
    }
    console.warn(`[a2ui-embed] Side channel returned HTTP ${resp.status}, falling back to PROMPT.`);
  } catch (err) {
    console.warn('[a2ui-embed] Side channel fetch failed, falling back to PROMPT:', err);
  }
  return false;
}

async function dispatchViaSideChannel(
  actionConfig: ActionConfig,
  action: A2uiActionDetails,
  dataModel: Record<string, unknown> | undefined,
  promptText: string,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!fetchFn) return false;
  if (actionConfig.sidecarUrl && actionConfig.conversationId) {
    const ok = await trySidecarDispatch(
      actionConfig.sidecarUrl,
      actionConfig.conversationId,
      promptText,
      fetchFn,
    );
    if (ok) return true;
  }
  if (actionConfig.port && actionConfig.key) {
    return tryLoopbackDispatch(actionConfig.port, actionConfig.key, action, dataModel, fetchFn);
  }
  return false;
}

/**
 * Initializes the standalone A2UI embed iframe application.
 * Reads messages from the embedded JSON tag, mounts <a2ui-pane-view>,
 * tracks content height via SurfaceResizeObserver to emit RESIZE events to the host,
 * and posts PROMPT messages to parent when actions are clicked.
 */
export function initEmbed(options: InitEmbedOptions = {}): EmbedInstance | null {
  if (typeof document === 'undefined') return null;

  injectHostTheme();

  let rawJson = options.messagesJson;
  if (!rawJson) {
    const scriptEl = document.getElementById('a2ui-messages');
    if (scriptEl && scriptEl.textContent) {
      rawJson = scriptEl.textContent;
    }
  }

  let messages: unknown[] = [];
  if (rawJson) {
    try {
      messages = JSON.parse(rawJson);
    } catch (err) {
      console.error('[a2ui-embed] Failed to parse embedded #a2ui-messages:', err);
    }
  }

  let actionConfig: ActionConfig | undefined = options.actionConfig;
  if (!actionConfig) {
    const configEl = document.getElementById('a2ui-action-config');
    if (configEl && configEl.textContent) {
      try {
        actionConfig = JSON.parse(configEl.textContent);
      } catch (err) {
        console.error('[a2ui-embed] Failed to parse #a2ui-action-config:', err);
      }
    }
  }

  const container =
    options.container || document.getElementById('a2ui-embed-root') || document.body;

  let wrapper = container.querySelector('.a2ui-embed-container') as HTMLElement;
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'a2ui-embed-container';
    wrapper.style.cssText = `
      display: flex;
      flex-direction: column;
      width: 100%;
      box-sizing: border-box;
      padding: 0;
      margin: 0;
    `;
    container.appendChild(wrapper);
  }

  const postMsg =
    options.postMessageFn ??
    ((data: any, origin: string) => {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(data, origin);
      }
    });

  // Informative note under embed forms
  const footerNote = document.createElement('div');
  footerNote.className = 'a2ui-embed-footer';
  footerNote.style.cssText = `
    font-size: 11px;
    color: var(--a2ui-color-border, #6a737d);
    padding: 2px 8px 4px 8px;
    text-align: right;
    user-select: none;
  `;
  const hasDirectEndpoint = Boolean(
    (actionConfig?.sidecarUrl && actionConfig?.conversationId) ||
    (actionConfig?.port && actionConfig?.key),
  );
  if (hasDirectEndpoint) {
    footerNote.textContent = 'Submitting triggers the agent directly.';
  } else {
    footerNote.textContent = 'Submitting fills in the chat box.';
  }

  const promptTargetOrigin = actionConfig?.targetOrigin || options.targetOrigin || '*';
  let isSubmitting = false;
  let submittedState = false;

  const paneView = document.createElement('a2ui-pane-view') as A2uiPaneView;
  const setSubmittedState = (next: boolean) => {
    submittedState = next;
    applySubmittedState(paneView, footerNote, next, hasDirectEndpoint, () => {
      setSubmittedState(false);
    });
  };

  const onAction = async (action: A2uiActionDetails, dataModel?: Record<string, unknown>) => {
    if (isSubmitting || submittedState) return;

    const promptText = formatActionText(action, {
      label: typeof action.context?.label === 'string' ? action.context.label : undefined,
      dataModel,
    });

    if (actionConfig && hasDirectEndpoint) {
      isSubmitting = true;
      const sent = await dispatchViaSideChannel(
        actionConfig,
        action,
        dataModel,
        promptText,
        options.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined),
      );
      isSubmitting = false;
      if (sent) {
        setSubmittedState(true);
        return;
      }
    }

    // Default or fallback: post PROMPT to parent frame
    postMsg({ type: 'PROMPT', prompt: promptText }, promptTargetOrigin);
  };

  const applier = new LineApplier(undefined, onAction);
  paneView.processor = applier.getProcessor();
  wrapper.appendChild(paneView);
  wrapper.appendChild(footerNote);

  // Apply parsed messages
  if (Array.isArray(messages) && messages.length > 0) {
    const lines: StoreLine[] = messages.map((msg, index) => {
      if (msg && typeof msg === 'object' && 'seq' in msg && 'message' in msg) {
        return msg as StoreLine;
      }
      return {
        seq: index + 1,
        ts: new Date().toISOString(),
        callId: 'embed_call',
        message: msg as any,
      };
    });
    applier.apply(lines);
  }

  const AUTO_RESIZE_SLACK = 4;
  const observerFactory = options.resizeObserverFactory ?? ((cb) => new SurfaceResizeObserver(cb));

  const resizeObserver = observerFactory(({ height, width }) => {
    postMsg({ type: 'RESIZE', height: Math.ceil(height) + AUTO_RESIZE_SLACK, width }, '*');
  });

  // Perform initial measurement once view is attached, and re-measure after async Lit/markdown rendering settles
  resizeObserver.measureAndDispatch(true);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      resizeObserver.measureAndDispatch(false);
    });
  }
  setTimeout(() => {
    resizeObserver.measureAndDispatch(false);
  }, 60);

  return {
    applier,
    paneView,
    resizeObserver,
    isSubmitted: () => submittedState,
    setSubmittedState,
    destroy: () => {
      resizeObserver.destroy();
      wrapper.remove();
    },
  };
}

export function autoInit(): void {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const autoInitDisabled = (window as any).__A2UI_DISABLE_EMBED_AUTO_INIT__;
    if (!autoInitDisabled) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          initEmbed();
        });
      } else {
        initEmbed();
      }
    }
  }
}

autoInit();
