import { injectHostTheme } from '@a2ui-pane/theme';
import { LineApplier, A2uiPaneView } from '@a2ui-pane/renderer';
import { StreamClient, ConnectionStatus } from './stream-client.js';
import { ActionSender } from './action-sender.js';

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
  let conversationId = urlParams.get('conversationId');
  const token = urlParams.get('token') || undefined;

  const fetchImpl = options.fetchFn ?? fetch;

  if (!conversationId && fetchImpl) {
    try {
      const resp = await fetchImpl('./api/config');
      if (resp.ok) {
        const config = (await resp.json()) as any;
        conversationId = config?.conversationId;
      }
    } catch {
      // Configuration fallback
    }
  }

  // Construct UI Layout
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
    <main style="flex: 1; overflow: hidden; position: relative;">
      <a2ui-pane-view id="pane-view"></a2ui-pane-view>
    </main>
  `;

  const statusBadge = appContainer.querySelector('#status-badge') as HTMLElement;
  const errorBanner = appContainer.querySelector('#error-banner') as HTMLElement;
  const errorMessage = appContainer.querySelector('#error-message') as HTMLElement;
  const dismissBtn = appContainer.querySelector('#dismiss-error') as HTMLButtonElement;
  const paneView = appContainer.querySelector('#pane-view') as A2uiPaneView;

  const updateStatus = (status: ConnectionStatus) => {
    if (!statusBadge) return;
    switch (status) {
      case 'connected':
        statusBadge.textContent = 'Live';
        statusBadge.style.background = '#dcffe4';
        statusBadge.style.color = '#155724';
        break;
      case 'connecting':
        statusBadge.textContent = 'Connecting...';
        statusBadge.style.background = '#f1f8ff';
        statusBadge.style.color = '#0366d6';
        break;
      case 'reconnecting':
        statusBadge.textContent = 'Reconnecting...';
        statusBadge.style.background = '#fff5b1';
        statusBadge.style.color = '#735c0f';
        break;
      case 'disconnected':
        statusBadge.textContent = 'Offline';
        statusBadge.style.background = '#f6f8fa';
        statusBadge.style.color = '#6a737d';
        break;
    }
  };

  const updateErrors = () => {
    if (!errorBanner || !errorMessage) return;
    const errors = applier.getErrors();
    if (errors.length > 0) {
      const latest = errors[errors.length - 1];
      errorMessage.textContent = `Warning: ${errors.length} A2UI update(s) failed (seq ${latest.seq}: ${latest.error})`;
      errorBanner.style.display = 'flex';
    } else {
      errorBanner.style.display = 'none';
    }
  };

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      applier.clearErrors();
      updateErrors();
    });
  }

  const actionSender = new ActionSender({
    sendMessageFn: options.sendMessageFn,
    onPendingChange: (pending) => {
      if (paneView) {
        paneView.pendingComponents = pending;
      }
    },
  });

  // Action callback - dispatches actions via ActionSender
  const onAction =
    options.onAction ??
    ((action: any, dataModel?: Record<string, unknown>) => {
      actionSender.sendAction(action, dataModel).catch((err) => {
        console.error('[main] sendAction failed:', err);
      });
    });

  const applier = new LineApplier(undefined, onAction);
  if (paneView) {
    paneView.processor = applier.getProcessor();
  }

  applier.onReset((newProcessor) => {
    if (paneView) {
      paneView.processor = newProcessor;
    }
    updateErrors();
  });

  if (!conversationId) {
    if (statusBadge) {
      statusBadge.textContent = 'No Conversation';
      statusBadge.style.background = '#ffeef0';
      statusBadge.style.color = '#b31d28';
    }
    return {
      applier,
      actionSender,
      updateStatus,
      updateErrors,
    };
  }

  const client = new StreamClient({
    conversationId,
    token,
    applier,
    eventSourceFactory: options.eventSourceFactory,
    onStatusChange: (status) => {
      updateStatus(status);
      updateErrors();
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
