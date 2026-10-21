import { injectHostTheme } from '@a2ui-pane/theme';
import { formatActionText, A2uiActionDetails, StoreLine } from '@a2ui-pane/protocol';
import {
  LineApplier,
  A2uiPaneView,
  type DispatchedActionDetails,
  type A2uiLinkClickDetail,
} from '@a2ui-pane/renderer';
import { SurfaceResizeObserver } from './surface-resize-observer.js';
// The router is shared source with the pane app; the embed bundles it directly (no workspace
// dependency) because pane-app is an application, not a library package.
import { openLink } from '../../pane-app/src/link-router.js';

/** Side-channel endpoint and routing metadata injected into an inline embed iframe. */
export interface ActionConfig {
  port?: number;
  key?: string;
  surfaceId: string;
  conversationId?: string;
  sidecarUrl?: string;
  targetOrigin?: string;
  embedFile?: string;
  submittedComponents?: string[];
  submittedGroups?: string[];
}

/** Options for initializing a standalone A2UI inline embed iframe. */
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

/** Handle returned by `initEmbed` for inspecting, unlocking, or destroying the embed view. */
export interface EmbedInstance {
  applier: LineApplier;
  paneView: A2uiPaneView;
  resizeObserver: SurfaceResizeObserver;
  isSubmitted: () => boolean;
  setSubmittedState: (submitted: boolean) => void;
  destroy: () => void;
}

interface SideChannelEmbedMeta {
  embedFile?: string;
  sourceComponentId?: string;
  group?: string;
}

/**
 * Updates the embed container visual lock state and footer note after submission or unlock.
 */
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
    ? AbortSignal.timeout(15000)
    : undefined;
}

/**
 * Copies text inside the sandboxed embed iframe. The iframe has an opaque origin and no
 * `clipboard-write` permission, so `navigator.clipboard.writeText` may throw; this falls back
 * to `document.execCommand('copy')` on a hidden textarea and rejects when both paths fail.
 */
export async function copyTextInEmbed(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the execCommand path.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position: fixed; top: -1000px; left: -1000px; opacity: 0;';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  if (!copied) {
    throw new Error('Clipboard is unavailable in this embed');
  }
}

/**
 * Wires `a2ui-link-click` events from the embed's pane view to `openLink`. Copy results are
 * announced in `status`; when copying is impossible the status shows the destination itself so
 * the user can select it.
 */
function installLinkRouting(paneView: A2uiPaneView, status: HTMLElement): void {
  paneView.addEventListener('a2ui-link-click', (evt: Event) => {
    const detail = (evt as CustomEvent<A2uiLinkClickDetail>).detail;
    if (!detail?.href) return;
    void openLink(detail, {
      open: (url, target, features) => window.open(url, target, features),
      copy: copyTextInEmbed,
      toast: (message) => {
        status.textContent = message;
      },
    }).then((result) => {
      if (result === 'failed') {
        status.textContent = detail.href;
      }
    });
  });
}

async function trySidecarDispatch(
  sidecarUrl: string,
  conversationId: string,
  promptText: string,
  meta: SideChannelEmbedMeta,
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
        ...meta,
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
  meta: SideChannelEmbedMeta,
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
        ...meta,
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
  action: DispatchedActionDetails,
  dataModel: Record<string, unknown> | undefined,
  promptText: string,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!fetchFn) return false;
  const isOneShot = action.oneShot !== false;
  const meta: SideChannelEmbedMeta = {
    embedFile: actionConfig.embedFile,
    sourceComponentId: isOneShot ? action.sourceComponentId : undefined,
    group: isOneShot ? action.group : undefined,
  };
  if (actionConfig.sidecarUrl && actionConfig.conversationId) {
    const ok = await trySidecarDispatch(
      actionConfig.sidecarUrl,
      actionConfig.conversationId,
      promptText,
      meta,
      fetchFn,
    );
    if (ok) return true;
  }
  if (actionConfig.port && actionConfig.key) {
    return tryLoopbackDispatch(
      actionConfig.port,
      actionConfig.key,
      action,
      dataModel,
      meta,
      fetchFn,
    );
  }
  return false;
}

function restorePersistedEmbedSubmission(
  paneView: A2uiPaneView,
  actionConfig: ActionConfig | undefined,
  setSubmittedState: (submitted: boolean) => void,
): void {
  const comps = actionConfig?.submittedComponents ?? [];
  const groups = actionConfig?.submittedGroups ?? [];
  if (comps.length === 0 && groups.length === 0) return;

  const surfaceIds = paneView.processor
    ? Array.from(paneView.processor.getSurfaces().keys())
    : paneView.surfaceIds;

  for (const sid of surfaceIds) {
    for (const compId of comps) {
      paneView.markComponentSubmitted(sid, compId);
    }
    for (const grp of groups) {
      paneView.markComponentSubmitted(sid, undefined, grp);
    }
  }
  setSubmittedState(true);
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
    if (!next && paneView.processor) {
      for (const sid of paneView.processor.getSurfaces().keys()) {
        paneView.clearSubmittedState(sid);
      }
    }
    applySubmittedState(paneView, footerNote, next, hasDirectEndpoint, () => {
      setSubmittedState(false);
    });
  };

  const onAction = async (action: DispatchedActionDetails, dataModel?: Record<string, unknown>) => {
    const isOneShot = action.oneShot !== false;
    if (isSubmitting || (isOneShot && submittedState)) return;

    const promptText = formatActionText(action, {
      label: typeof action.context?.label === 'string' ? action.context.label : undefined,
      dataModel,
    });

    if (isOneShot) {
      setSubmittedState(true);
    }

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
        return;
      }
    }

    // Default or fallback: post PROMPT to parent frame
    postMsg({ type: 'PROMPT', prompt: promptText }, promptTargetOrigin);
  };

  const applier = new LineApplier(undefined, onAction);
  paneView.processor = applier.getProcessor();
  wrapper.appendChild(paneView);

  // One-line status under the surface for link copies (the embed has no toast helper)
  const linkStatus = document.createElement('div');
  linkStatus.className = 'a2ui-embed-link-status';
  linkStatus.setAttribute('role', 'status');
  linkStatus.style.cssText = `
    font-size: 11px;
    color: var(--a2ui-color-border, #6a737d);
    padding: 0 8px;
    overflow-wrap: anywhere;
    user-select: text;
  `;
  wrapper.appendChild(linkStatus);
  installLinkRouting(paneView, linkStatus);

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

  restorePersistedEmbedSubmission(paneView, actionConfig, setSubmittedState);

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

/**
 * Bootstraps `initEmbed` when the iframe document finishes loading unless disabled.
 */
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
