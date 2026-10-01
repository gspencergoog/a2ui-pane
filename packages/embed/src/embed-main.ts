import { injectHostTheme } from '@a2ui-pane/theme';
import { formatActionText, A2uiActionDetails, StoreLine } from '@a2ui-pane/protocol';
import { LineApplier, A2uiPaneView } from '@a2ui-pane/renderer';
import { SurfaceResizeObserver } from './surface-resize-observer.js';

export interface ActionConfig {
  port: number;
  key: string;
  surfaceId: string;
}

export interface InitEmbedOptions {
  container?: HTMLElement;
  messagesJson?: string;
  actionConfig?: ActionConfig;
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
  destroy: () => void;
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
    padding: 8px 16px 12px 16px;
    text-align: right;
    user-select: none;
  `;
  if (actionConfig?.port && actionConfig?.key) {
    footerNote.textContent = 'Submitting triggers the agent directly.';
  } else {
    footerNote.textContent = 'Submitting fills in the chat box.';
  }

  const onAction = async (action: A2uiActionDetails, dataModel?: Record<string, unknown>) => {
    const promptText = formatActionText(action, {
      label: typeof action.context?.label === 'string' ? action.context.label : undefined,
      dataModel,
    });

    if (actionConfig && actionConfig.port && actionConfig.key) {
      const fetchFn = options.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
      if (fetchFn) {
        try {
          const endpointUrl = `http://127.0.0.1:${actionConfig.port}/action`;
          const resp = await fetchFn(endpointUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-A2UI-Key': actionConfig.key,
            },
            body: JSON.stringify({
              key: actionConfig.key,
              action,
              dataModel,
            }),
          });
          if (resp.ok) {
            footerNote.textContent = 'Action sent directly to agent.';
            return;
          }
          console.warn(
            `[a2ui-embed] Side channel returned HTTP ${resp.status}, falling back to PROMPT.`,
          );
        } catch (err) {
          console.warn('[a2ui-embed] Side channel fetch failed, falling back to PROMPT:', err);
        }
      }
    }

    // Default or fallback: post PROMPT to parent frame
    postMsg({ type: 'PROMPT', prompt: promptText }, '*');
  };

  const applier = new LineApplier(undefined, onAction);
  const paneView = document.createElement('a2ui-pane-view') as A2uiPaneView;
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

  const observerFactory = options.resizeObserverFactory ?? ((cb) => new SurfaceResizeObserver(cb));

  const resizeObserver = observerFactory(({ height, width }) => {
    postMsg({ type: 'RESIZE', height, width }, '*');
  });

  // Perform initial measurement once view is attached
  resizeObserver.measureAndDispatch(true);

  return {
    applier,
    paneView,
    resizeObserver,
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
