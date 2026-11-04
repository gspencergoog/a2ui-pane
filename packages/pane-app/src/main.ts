import { injectHostTheme } from '@a2ui-pane/theme';
import {
  LineApplier,
  A2uiPaneView,
  type SurfaceDismissedDetail,
  type A2uiLinkClickDetail,
  openLink,
} from '@a2ui-pane/renderer';
import { StreamClient, ConnectionStatus } from './stream-client.js';
import { ActionSender } from './action-sender.js';
import { showToast } from './toast.js';

// Inject host theme CSS variables
injectHostTheme();

/** Options for initializing the A2UI auxiliary pane application. */
export interface InitOptions {
  container?: HTMLElement | null;
  search?: string;
  fetchFn?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
  sendMessageFn?: (text: string) => Promise<any>;
  onAction?: (action: any, dataModel?: Record<string, unknown>) => void;
  /** Replaces the page reload that runs when the sidecar serves a new pane build. */
  reloadFn?: () => void;
}

/** Handle returned by `initPaneApp` for inspecting and controlling the pane instance. */
export interface PaneAppInstance {
  applier: LineApplier;
  client?: StreamClient;
  actionSender: ActionSender;
  updateStatus: (status: ConnectionStatus) => void;
  updateErrors: () => void;
}

/** How long the "new build" toast shows before the page reloads itself. */
const BUILD_RELOAD_TOAST_MS = 1200;

const STATUS_STYLES: Readonly<
  Record<ConnectionStatus, { text: string; bg: string; color: string }>
> = {
  connected: { text: 'Live', bg: '#dcffe4', color: '#155724' },
  connecting: { text: 'Connecting...', bg: '#f1f8ff', color: '#0366d6' },
  reconnecting: { text: 'Reconnecting...', bg: '#fff5b1', color: '#735c0f' },
  disconnected: { text: 'Offline', bg: '#f6f8fa', color: '#6a737d' },
};

function applyStatusBadge(statusBadge: HTMLElement, status: ConnectionStatus): void {
  const spec = STATUS_STYLES[status];
  statusBadge.textContent = spec.text;
  statusBadge.style.background = spec.bg;
  statusBadge.style.color = spec.color;
}

function applyErrorBanner(
  errorBanner: HTMLElement,
  errorMessage: HTMLElement,
  errors: Array<{ seq: number; error: string }>,
): void {
  if (errors.length > 0) {
    const latest = errors[errors.length - 1];
    errorMessage.textContent = `Warning: ${errors.length} A2UI update(s) failed (seq ${latest.seq}: ${latest.error})`;
    errorBanner.style.display = 'flex';
  } else {
    errorBanner.style.display = 'none';
  }
}

/** Why the pane removes a surface from the store. */
type SurfaceDeleteReason = 'dismissed' | 'submitted';

/**
 * Asks the sidecar to delete a surface's store file, so the surface stays
 * gone after a pane reload or a language server restart.
 *
 * Logs failures (including a `423` lock timeout) and never throws.
 *
 * @returns Whether the sidecar confirmed the request.
 */
async function deleteSurfaceOnDisk(
  conversationId: string,
  surfaceId: string,
  reason: SurfaceDeleteReason,
  token: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  if (!fetchImpl) return false;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['X-Sidecar-Token'] = token;
    }
    const resp = await fetchImpl('./api/surfaces/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId, surfaceId, reason }),
    });
    if (!resp?.ok) {
      console.warn(`[main] Deleting surface ${surfaceId} failed: HTTP ${resp?.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[main] Deleting surface ${surfaceId} failed:`, err);
    return false;
  }
}

function closeAuxPane(): void {
  try {
    (window as any).sidecar?.ui?.toggleAuxPane?.({ open: false });
  } catch {
    // Ignore host bridge errors
  }
}

async function reportPaneVisibility(
  conversationId: string,
  visible: boolean,
  token: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!fetchImpl) return;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['X-Sidecar-Token'] = token;
    }
    await fetchImpl('./api/visibility', {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId, visible }),
    });
  } catch {
    // Ignore visibility telemetry failures (e.g. relative URL in unit tests)
  }
}

function setupVisibilityTracking(
  conversationId: string,
  token: string | undefined,
  fetchImpl?: typeof fetch,
): { reannounce: () => void } {
  let seenPositiveClientBox = false;
  const isCurrentlyVisible = () => {
    if (typeof window === 'undefined') return true;
    const winVisible = window.innerWidth > 0 && window.innerHeight > 0;
    if (!winVisible) return false;
    if (typeof document !== 'undefined' && document.documentElement) {
      const docEl = document.documentElement;
      const rect =
        typeof docEl.getBoundingClientRect === 'function'
          ? docEl.getBoundingClientRect()
          : undefined;
      const clientW = Math.max(docEl.clientWidth || 0, rect?.width || 0);
      const clientH = Math.max(docEl.clientHeight || 0, rect?.height || 0);
      if (clientW > 0 && clientH > 0) {
        seenPositiveClientBox = true;
        return true;
      }
      if (seenPositiveClientBox) {
        // In Chromium, hiding an ancestor slot with `display: none` leaves
        // `window.innerWidth`/`innerHeight` at their last open dimensions
        // while collapsing `documentElement` client/bounding rects to 0x0.
        return false;
      }
    }
    return true;
  };

  let lastVisible = isCurrentlyVisible();
  let inFlightCount = 0;
  let lastSettledVisible: boolean | undefined;

  const sendVisibility = (visible: boolean) => {
    inFlightCount += 1;
    void reportPaneVisibility(conversationId, visible, token, fetchImpl).finally(() => {
      inFlightCount -= 1;
      lastSettledVisible = visible;
      if (inFlightCount === 0 && lastSettledVisible !== lastVisible) {
        sendVisibility(lastVisible);
      }
    });
  };

  const syncVisibility = (force = false) => {
    const nextVisible = isCurrentlyVisible();
    if (force || nextVisible !== lastVisible) {
      lastVisible = nextVisible;
      sendVisibility(nextVisible);
    }
  };

  sendVisibility(lastVisible);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      syncVisibility();
    });
    window.addEventListener('message', (event: MessageEvent) => {
      const msgType = event?.data && typeof event.data === 'object' ? event.data.type : undefined;
      if (msgType === 'theme-change' || msgType === 'workspace-change') {
        // IframeView mounts <IframeActiveSync> and posts theme-change/workspace-change
        // whenever the hoisted slot's `visible` prop flips from false to true.
        syncVisibility(isCurrentlyVisible());
      }
    });
    window.addEventListener('focus', () => {
      if (isCurrentlyVisible()) {
        syncVisibility(true);
      }
    });
  }

  if (typeof document !== 'undefined' && document.documentElement) {
    const docEl = document.documentElement;
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(() => {
          syncVisibility();
        });
        ro.observe(docEl);
      } catch {
        // Ignore ResizeObserver errors in restricted environments
      }
    }
    if (typeof IntersectionObserver !== 'undefined') {
      try {
        const io = new IntersectionObserver(() => {
          syncVisibility();
        });
        io.observe(docEl);
      } catch {
        // Ignore IntersectionObserver errors in restricted environments
      }
    }
  }

  return {
    reannounce: () => {
      syncVisibility(true);
    },
  };
}

const PLACEHOLDER_CONVERSATION_IDS = new Set(['_new']);

function normalizeConversationId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed || PLACEHOLDER_CONVERSATION_IDS.has(trimmed)) return null;
  return trimmed;
}

async function resolveConversationId(
  initialId: string | null,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (initialId !== null) {
    return normalizeConversationId(initialId);
  }
  if (!fetchImpl) return null;
  try {
    const resp = await fetchImpl('./api/config');
    if (resp.ok) {
      const config = (await resp.json()) as any;
      return normalizeConversationId(config?.conversationId);
    }
  } catch {
    // Configuration fallback
  }
  return null;
}

function resolveSearch(options: InitOptions): string {
  if (options.search !== undefined) return options.search;
  return typeof window !== 'undefined' ? window.location.search : '';
}

function paneTemplate(conversationId: string | null): string {
  return `
    <header style="
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      border-bottom: 1px solid var(--a2ui-color-border, #e1e4e8);
      background-color: var(--a2ui-color-surface, var(--background, #fafbfc));
      font-size: 13px;
    ">
      <div style="font-weight: 600; display: flex; align-items: center; gap: 8px;">
        <span>A2UI Pane</span>
        <span id="conv-badge" style="font-weight: normal; color: var(--a2ui-color-border, #6a737d); font-size: 11px;">
          ${conversationId ? `(${conversationId})` : ''}
        </span>
      </div>
      <div id="status-badge" style="
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 12px;
        background: #f1f8ff;
        color: #0366d6;
      ">
        Connecting...
      </div>
    </header>
    <div id="error-banner" style="
      display: none;
      background-color: #ffeef0;
      color: #b31d28;
      padding: 8px 16px;
      font-size: 12px;
      border-bottom: 1px solid #f97583;
      justify-content: space-between;
      align-items: center;
    ">
      <span id="error-message"></span>
      <button id="dismiss-error" style="
        background: transparent;
        border: none;
        color: #b31d28;
        cursor: pointer;
        font-weight: bold;
      ">✕</button>
    </div>
    <main style="flex: 1; overflow: hidden; position: relative;">
      <a2ui-pane-view id="pane-view"></a2ui-pane-view>
    </main>
  `;
}

function wireLinkClicks(paneView: A2uiPaneView): void {
  paneView.addEventListener('a2ui-link-click', (evt: Event) => {
    const detail = (evt as CustomEvent<A2uiLinkClickDetail>).detail;
    if (!detail?.href) return;
    void openLink(detail, {
      open: (url, target, features) => window.open(url, target, features),
      copy: (text) => navigator.clipboard.writeText(text),
      toast: (message) => showToast(message, false),
    }).then((result) => {
      if (result === 'failed') {
        showToast(`Could not copy ${detail.href}`);
      }
    });
  });
}

type DeleteOnDisk = (surfaceId: string, reason: SurfaceDeleteReason) => Promise<boolean>;

/**
 * Retires a surface when the user presses its ✕: hides it at once, deletes its
 * store file, and then tells the agent with a `dismiss_surface` action.
 */
function wireSurfaceDismissal(
  paneView: A2uiPaneView,
  actionSender: ActionSender,
  deleteOnDisk: DeleteOnDisk,
): void {
  paneView.addEventListener('surface-dismissed', (evt: Event) => {
    const surfaceId = (evt as CustomEvent<SurfaceDismissedDetail>).detail?.surfaceId;
    if (!surfaceId) return;
    if (!paneView.isSurfaceDismissed(surfaceId)) {
      paneView.dismissSurface(surfaceId);
    }
    void deleteOnDisk(surfaceId, 'dismissed')
      .then(() =>
        actionSender.sendAction({
          name: 'dismiss_surface',
          surfaceId,
          sourceComponentId: 'surface-close-btn',
          timestamp: new Date().toISOString(),
          context: { label: 'Dismissed' },
        }),
      )
      .catch((err) => {
        console.error('[main] dismiss sendAction failed:', err);
      });
  });
}

/**
 * Returns the default action handler: it sends the action to the agent and,
 * once a one-shot action is delivered, hides its surface and deletes the
 * surface's store file. A failed send keeps the surface; `ActionSender` has
 * already shown the error toast.
 */
function createActionHandler(
  paneView: A2uiPaneView,
  actionSender: ActionSender,
  deleteOnDisk: DeleteOnDisk,
): NonNullable<InitOptions['onAction']> {
  const onSent = (isOneShot: boolean, surfaceId: string | undefined) => {
    if (isOneShot) {
      if (surfaceId) {
        paneView.dismissSurface(surfaceId);
        void deleteOnDisk(surfaceId, 'submitted');
      }
      closeAuxPane();
    }
    showToast('Submitted to agent', false);
  };

  return (action: any, dataModel?: Record<string, unknown>) => {
    const surfaceId = typeof action?.surfaceId === 'string' ? action.surfaceId : undefined;
    if (surfaceId && paneView.isSurfaceDismissed(surfaceId)) return;
    const isOneShot = action?.oneShot !== false;
    actionSender
      .sendAction(action, dataModel)
      .then((sent) => {
        if (sent) onSent(isOneShot, surfaceId);
      })
      .catch((err) => {
        console.error('[main] sendAction failed:', err);
      });
  };
}

interface StreamWiring {
  conversationId: string;
  token: string | undefined;
  fetchImpl: typeof fetch;
  applier: LineApplier;
  updateStatus: (status: ConnectionStatus) => void;
  updateErrors: () => void;
}

function connectStream(options: InitOptions, wiring: StreamWiring): StreamClient {
  const { conversationId, token, fetchImpl, applier, updateStatus, updateErrors } = wiring;
  const visibilityTracker = setupVisibilityTracking(conversationId, token, fetchImpl);
  const client = new StreamClient({
    conversationId,
    token,
    applier,
    eventSourceFactory: options.eventSourceFactory,
    onStatusChange: (status) => {
      updateStatus(status);
      updateErrors();
      if (status === 'connected') {
        visibilityTracker.reannounce();
      }
    },
    onError: () => {
      updateErrors();
    },
    fetchImpl,
    onBuildChanged: () => {
      showToast('Pane updated to a new build', false, BUILD_RELOAD_TOAST_MS);
      const reload = options.reloadFn ?? (() => location.reload());
      setTimeout(reload, BUILD_RELOAD_TOAST_MS);
    },
  });
  client.connect();
  return client;
}

/**
 * Initializes the A2UI auxiliary pane DOM, SSE stream client, and action sender.
 */
export async function initPaneApp(options: InitOptions = {}): Promise<PaneAppInstance | undefined> {
  const appContainer =
    options.container !== undefined ? options.container : document.getElementById('app');
  if (!appContainer) return undefined;

  const urlParams = new URLSearchParams(resolveSearch(options));
  const token = urlParams.get('token') || undefined;
  const fetchImpl = options.fetchFn ?? fetch;
  const conversationId = await resolveConversationId(urlParams.get('conversationId'), fetchImpl);

  appContainer.innerHTML = paneTemplate(conversationId);

  const statusBadge = appContainer.querySelector('#status-badge') as HTMLElement;
  const errorBanner = appContainer.querySelector('#error-banner') as HTMLElement;
  const errorMessage = appContainer.querySelector('#error-message') as HTMLElement;
  const dismissBtn = appContainer.querySelector('#dismiss-error') as HTMLButtonElement;
  const paneView = appContainer.querySelector('#pane-view') as A2uiPaneView;
  paneView.dismissibleSurfaces = true;

  const updateStatus = (status: ConnectionStatus) => applyStatusBadge(statusBadge, status);
  const updateErrors = () => applyErrorBanner(errorBanner, errorMessage, applier.getErrors());

  dismissBtn.addEventListener('click', () => {
    applier.clearErrors();
    updateErrors();
  });

  const actionSender = new ActionSender({
    conversationId,
    sendMessageFn: options.sendMessageFn,
    onPendingChange: (pending) => {
      paneView.pendingComponents = pending;
    },
  });

  const deleteOnDisk: DeleteOnDisk = (surfaceId, reason) =>
    conversationId
      ? deleteSurfaceOnDisk(conversationId, surfaceId, reason, token, fetchImpl)
      : Promise.resolve(false);

  wireLinkClicks(paneView);
  wireSurfaceDismissal(paneView, actionSender, deleteOnDisk);

  const onAction = options.onAction ?? createActionHandler(paneView, actionSender, deleteOnDisk);
  const applier = new LineApplier(undefined, onAction);

  paneView.processor = applier.getProcessor();

  applier.onReset((newProcessor) => {
    paneView.clearSubmittedSurfaces();
    paneView.processor = newProcessor;
    updateErrors();
  });

  if (!conversationId) {
    statusBadge.textContent = 'No Conversation';
    statusBadge.style.background = '#ffeef0';
    statusBadge.style.color = '#b31d28';
    return { applier, actionSender, updateStatus, updateErrors };
  }

  const client = connectStream(options, {
    conversationId,
    token,
    fetchImpl,
    applier,
    updateStatus,
    updateErrors,
  });

  return { applier, client, actionSender, updateStatus, updateErrors };
}

/**
 * Bootstraps `initPaneApp` when the browser DOM is ready unless auto-init is disabled.
 */
export function startApp(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if ((window as any).__A2UI_DISABLE_AUTO_INIT__) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initPaneApp().catch((err) => console.error('[main] init failed:', err));
    });
  } else {
    const el = document.getElementById('app');
    if (el) {
      initPaneApp().catch((err) => console.error('[main] init failed:', err));
    }
  }
}

startApp();
