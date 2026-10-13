import { injectHostTheme } from '@a2ui-pane/theme';
import { StoreLine } from '@a2ui-pane/protocol';
import {
  LineApplier,
  A2uiPaneView,
  type SurfaceSubmissionChangedDetail,
  type SurfaceDismissedDetail,
} from '@a2ui-pane/renderer';
import { StreamClient, ConnectionStatus } from './stream-client.js';
import { ActionSender } from './action-sender.js';
import { showToast } from './toast.js';

// Inject host theme CSS variables
injectHostTheme();

export interface InitOptions {
  container?: HTMLElement | null;
  search?: string;
  fetchFn?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
  sendMessageFn?: (text: string) => Promise<any>;
  onAction?: (action: any, dataModel?: Record<string, unknown>) => void;
}

export interface PaneAppInstance {
  applier: LineApplier;
  client?: StreamClient;
  actionSender: ActionSender;
  updateStatus: (status: ConnectionStatus) => void;
  updateErrors: () => void;
  isSubmitted: () => boolean;
  setSubmittedState: (submitted: boolean) => void;
}

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
    } else if (entry.status === 'submitted') {
      paneView.markSurfaceSubmitted(sid, entry.label);
    } else if (entry.status === 'dismissed') {
      paneView.dismissSurface(sid);
    }
  }
  if (changed) {
    writePersistedState(conversationId, persisted);
  }
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
  const isCurrentlyVisible = () =>
    typeof window !== 'undefined' ? window.innerWidth > 0 && window.innerHeight > 0 : true;

  let lastVisible = isCurrentlyVisible();
  void reportPaneVisibility(conversationId, lastVisible, token, fetchImpl);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      const nextVisible = isCurrentlyVisible();
      if (nextVisible !== lastVisible) {
        lastVisible = nextVisible;
        void reportPaneVisibility(conversationId, nextVisible, token, fetchImpl);
      }
    });
  }

  return {
    reannounce: () => {
      lastVisible = isCurrentlyVisible();
      void reportPaneVisibility(conversationId, lastVisible, token, fetchImpl);
    },
  };
}

async function resolveConversationId(
  initialId: string | null,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (initialId || !fetchImpl) return initialId;
  try {
    const resp = await fetchImpl('./api/config');
    if (resp.ok) {
      const config = (await resp.json()) as any;
      return config?.conversationId ?? null;
    }
  } catch {
    // Configuration fallback
  }
  return null;
}

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
    sendMessageFn: options.sendMessageFn,
    onPendingChange: (pending) => {
      paneView.pendingComponents = pending;
    },
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

      actionSender
        .sendAction(action, dataModel)
        .then((sent) => {
          if (sent) {
            submittedState = true;
            if (targetSurfaceId) {
              paneView.dismissSurface(targetSurfaceId);
            } else {
              setSubmittedState(true);
            }
            showToast('Submitted to agent', false);
            try {
              (window as any).sidecar?.ui?.toggleAuxPane?.({ open: false });
            } catch {
              // Ignore host bridge errors
            }
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
