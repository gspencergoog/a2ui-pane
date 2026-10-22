import { injectHostTheme } from '@a2ui-pane/theme';
import { StoreLine } from '@a2ui-pane/protocol';
import {
  LineApplier,
  A2uiPaneView,
  type SurfaceSubmissionChangedDetail,
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
  isSubmitted: () => boolean;
  setSubmittedState: (submitted: boolean) => void;
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

interface PersistedSurfaceEntry {
  status: 'submitted' | 'dismissed';
  label?: string;
  seq: number;
  components?: string[];
  groups?: string[];
}

type PersistedStateMap = Record<string, PersistedSurfaceEntry>;

function getLineSurfaceId(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const record = msg as Record<string, any>;
  return (
    record.createSurface?.surfaceId ||
    record.updateComponents?.surfaceId ||
    record.updateDataModel?.surfaceId ||
    record.deleteSurface?.surfaceId
  );
}

function readPersistedState(conversationId: string | null): PersistedStateMap {
  if (!conversationId || typeof sessionStorage === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(`a2ui-pane-state:${conversationId}`);
    return raw ? (JSON.parse(raw) as PersistedStateMap) : {};
  } catch {
    return {};
  }
}

function writePersistedState(conversationId: string | null, state: PersistedStateMap): void {
  if (!conversationId || typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(`a2ui-pane-state:${conversationId}`, JSON.stringify(state));
  } catch {
    // Ignore storage quota or sandbox errors
  }
}

function restorePersistedSurfaceEntry(
  paneView: A2uiPaneView,
  sid: string,
  entry: PersistedSurfaceEntry,
): void {
  if (entry.status === 'dismissed') {
    paneView.dismissSurface(sid);
    return;
  }
  const comps = entry.components ?? [];
  const groups = entry.groups ?? [];
  if (comps.length > 0 || groups.length > 0) {
    for (const compId of comps) {
      paneView.markComponentSubmitted(sid, compId);
    }
    for (const grp of groups) {
      paneView.markComponentSubmitted(sid, undefined, grp);
    }
    return;
  }
  paneView.markComponentSubmitted(sid);
}

function syncLinesWithPersistedState(
  lines: StoreLine[],
  prevLastSeq: number,
  paneView: A2uiPaneView,
  persisted: PersistedStateMap,
  conversationId: string | null,
): void {
  let changed = false;
  for (const line of lines) {
    if (!line || typeof line !== 'object' || line.seq <= prevLastSeq) continue;
    const sid = getLineSurfaceId(line.message);
    if (!sid) continue;

    const entry = persisted[sid];
    if (!entry) {
      if (paneView.isSurfaceSubmitted(sid)) {
        paneView.unsubmitSurface(sid);
      }
      continue;
    }

    if (line.seq > entry.seq) {
      delete persisted[sid];
      changed = true;
      paneView.unsubmitSurface(sid);
    } else {
      restorePersistedSurfaceEntry(paneView, sid, entry);
    }
  }
  if (changed) {
    writePersistedState(conversationId, persisted);
  }
}

function recordSubmittedComponentState(
  persistedState: PersistedStateMap,
  conversationId: string | null,
  surfaceId: string,
  seq: number,
  sourceComponentId?: string,
  group?: string,
): void {
  const prev = persistedState[surfaceId];
  const comps = new Set(prev?.status === 'submitted' ? (prev.components ?? []) : []);
  const groups = new Set(prev?.status === 'submitted' ? (prev.groups ?? []) : []);
  if (sourceComponentId) {
    comps.add(sourceComponentId);
  }
  if (group) {
    groups.add(group);
  }
  persistedState[surfaceId] = {
    status: 'submitted',
    seq,
    components: Array.from(comps),
    groups: Array.from(groups),
  };
  writePersistedState(conversationId, persistedState);
}

function applyPaneSubmittedState(
  paneView: A2uiPaneView,
  submittedBanner: HTMLElement,
  submitted: boolean,
): void {
  if (submitted) {
    if (paneView.surfaceIds.length > 0) {
      for (const id of paneView.surfaceIds) {
        if (!paneView.isSurfaceDismissed(id)) {
          paneView.dismissSurface(id);
        }
      }
      submittedBanner.style.display = 'none';
    } else {
      submittedBanner.style.display = 'flex';
    }
  } else {
    paneView.clearSubmittedSurfaces();
    submittedBanner.style.display = 'none';
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

/**
 * Initializes the A2UI auxiliary pane DOM, SSE stream client, and action sender.
 */
export async function initPaneApp(options: InitOptions = {}): Promise<PaneAppInstance | undefined> {
  const appContainer =
    options.container !== undefined ? options.container : document.getElementById('app');
  if (!appContainer) return undefined;

  const search =
    options.search !== undefined
      ? options.search
      : typeof window !== 'undefined'
        ? window.location.search
        : '';
  const urlParams = new URLSearchParams(search);
  const token = urlParams.get('token') || undefined;
  const fetchImpl = options.fetchFn ?? fetch;
  const conversationId = await resolveConversationId(urlParams.get('conversationId'), fetchImpl);

  appContainer.innerHTML = `
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
    <div id="submitted-banner" style="
      display: none;
      background-color: var(--a2ui-color-secondary, #f1f3f4);
      color: var(--a2ui-text-color-text, #1f1f1f);
      padding: 6px 16px;
      font-size: 12px;
      border-bottom: 1px solid var(--a2ui-color-border, #e1e4e8);
      justify-content: space-between;
      align-items: center;
    ">
      <span>✓ Submitted to agent.</span>
      <button id="resubmit-pane-btn" type="button" style="
        background: transparent;
        border: 1px solid var(--a2ui-color-border, #6a737d);
        border-radius: 4px;
        color: inherit;
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
      ">Edit / Resubmit</button>
    </div>
    <main style="flex: 1; overflow: hidden; position: relative;">
      <a2ui-pane-view id="pane-view"></a2ui-pane-view>
    </main>
  `;

  const statusBadge = appContainer.querySelector('#status-badge') as HTMLElement;
  const errorBanner = appContainer.querySelector('#error-banner') as HTMLElement;
  const errorMessage = appContainer.querySelector('#error-message') as HTMLElement;
  const dismissBtn = appContainer.querySelector('#dismiss-error') as HTMLButtonElement;
  const submittedBanner = appContainer.querySelector('#submitted-banner') as HTMLElement;
  const resubmitBtn = appContainer.querySelector('#resubmit-pane-btn') as HTMLButtonElement;
  const paneView = appContainer.querySelector('#pane-view') as A2uiPaneView;
  paneView.dismissibleSurfaces = true;

  let submittedState = false;
  const persistedState = readPersistedState(conversationId);

  const setSubmittedState = (next: boolean) => {
    submittedState = next;
    applyPaneSubmittedState(paneView, submittedBanner, next);
    if (!next) {
      for (const k of Object.keys(persistedState)) {
        delete persistedState[k];
      }
      writePersistedState(conversationId, persistedState);
    }
  };

  resubmitBtn.addEventListener('click', () => setSubmittedState(false));

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

  paneView.addEventListener('surface-dismissed', (evt: Event) => {
    const detail = (evt as CustomEvent<SurfaceDismissedDetail>).detail;
    if (!detail?.surfaceId) return;
    actionSender
      .sendAction({
        name: 'dismiss_surface',
        surfaceId: detail.surfaceId,
        sourceComponentId: 'surface-close-btn',
        timestamp: new Date().toISOString(),
        context: { label: 'Dismissed' },
      })
      .catch((err) => {
        console.error('[main] dismiss sendAction failed:', err);
      });
  });

  const onAction =
    options.onAction ??
    ((action: any, dataModel?: Record<string, unknown>) => {
      const targetSurfaceId = typeof action?.surfaceId === 'string' ? action.surfaceId : undefined;
      if (targetSurfaceId && paneView.isSurfaceDismissed(targetSurfaceId)) return;
      if (!targetSurfaceId && submittedState) return;

      const isOneShot = action?.oneShot !== false;
      actionSender
        .sendAction(action, dataModel)
        .then((sent) => {
          if (sent) {
            if (isOneShot) {
              submittedState = true;
              if (targetSurfaceId) {
                recordSubmittedComponentState(
                  persistedState,
                  conversationId,
                  targetSurfaceId,
                  applier.getLastAppliedSeq(),
                  typeof action.sourceComponentId === 'string'
                    ? action.sourceComponentId
                    : undefined,
                  typeof action.group === 'string' ? action.group : undefined,
                );
              } else {
                setSubmittedState(true);
              }
              try {
                (window as any).sidecar?.ui?.toggleAuxPane?.({ open: false });
              } catch {
                // Ignore host bridge errors
              }
            }
            showToast('Submitted to agent', false);
          }
        })
        .catch((err) => {
          console.error('[main] sendAction failed:', err);
        });
    });

  const applier = new LineApplier(undefined, onAction);

  paneView.addEventListener('surface-submission-changed', (evt: Event) => {
    const detail = (evt as CustomEvent<SurfaceSubmissionChangedDetail>).detail;
    if (!detail?.surfaceId) return;
    if (detail.status === 'active') {
      delete persistedState[detail.surfaceId];
    } else {
      persistedState[detail.surfaceId] = {
        status: detail.status,
        label: detail.label,
        seq: applier.getLastAppliedSeq(),
      };
    }
    writePersistedState(conversationId, persistedState);
  });

  const origApply = applier.apply.bind(applier);
  applier.apply = (lines) => {
    const prevLastSeq = applier.getLastAppliedSeq();
    if (lines.length > 0 && submittedState) {
      submittedState = false;
      submittedBanner.style.display = 'none';
    }
    origApply(lines);
    syncLinesWithPersistedState(lines, prevLastSeq, paneView, persistedState, conversationId);
  };

  paneView.processor = applier.getProcessor();

  applier.onReset((newProcessor) => {
    setSubmittedState(false);
    paneView.processor = newProcessor;
    updateErrors();
  });

  if (!conversationId) {
    statusBadge.textContent = 'No Conversation';
    statusBadge.style.background = '#ffeef0';
    statusBadge.style.color = '#b31d28';
    return {
      applier,
      actionSender,
      updateStatus,
      updateErrors,
      isSubmitted: () => submittedState,
      setSubmittedState,
    };
  }

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

  return {
    applier,
    client,
    actionSender,
    updateStatus,
    updateErrors,
    isSubmitted: () => submittedState,
    setSubmittedState,
  };
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
