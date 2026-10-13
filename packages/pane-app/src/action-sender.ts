import { formatActionText, A2uiActionDetails } from '@a2ui-pane/protocol';
import { showToast } from './toast.js';

export interface ActionSenderOptions {
  conversationId?: string | null;
  onPendingChange?: (pendingComponents: ReadonlySet<string>) => void;
  showToastFn?: (message: string, isError?: boolean) => void;
  sendMessageFn?: (text: string, conversationId?: string) => Promise<any>;
}

/**
 * Handles outgoing A2UI user actions from the pane.
 * Formats actions into human-readable + <a2ui-action> text, manages pending state
 * to prevent duplicate clicks, and surfaces error toasts on delivery failures.
 */
export class ActionSender {
  private readonly pendingComponents = new Set<string>();

  constructor(private readonly options: ActionSenderOptions = {}) {}

  getPendingComponents(): ReadonlySet<string> {
    return new Set(this.pendingComponents);
  }

  isPending(componentId: string): boolean {
    return this.pendingComponents.has(componentId);
  }

  async sendAction(
    action: A2uiActionDetails,
    dataModel?: Record<string, unknown>,
  ): Promise<boolean> {
    const sourceId = action.sourceComponentId;

    // Prevent duplicate clicks while an action from this component is in flight
    if (sourceId && this.pendingComponents.has(sourceId)) {
      return false;
    }

    if (sourceId) {
      this.pendingComponents.add(sourceId);
      this.options.onPendingChange?.(new Set(this.pendingComponents));
    }

    const text = formatActionText(action, {
      label: typeof action.context?.label === 'string' ? action.context.label : undefined,
      dataModel,
    });

    const sendFn =
      this.options.sendMessageFn ??
      (typeof window !== 'undefined' && (window as any).sidecar?.agent?.sendMessage
        ? (window as any).sidecar.agent.sendMessage
        : undefined);

    const toastFn = this.options.showToastFn ?? showToast;

    if (!sendFn) {
      console.warn(
        '[ActionSender] window.sidecar.agent.sendMessage is not available. Simulating action dispatch in standalone mode:',
        text,
      );
      this.releaseComponent(sourceId);
      toastFn('Action dispatched (standalone mode)', false);
      return true;
    }

    try {
      if (this.options.conversationId) {
        await sendFn(text, this.options.conversationId);
      } else {
        await sendFn(text);
      }
      this.releaseComponent(sourceId);
      return true;
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to send action to agent';
      console.error('[ActionSender] Error sending action to agent:', err);
      this.releaseComponent(sourceId);
      toastFn(`Action failed: ${errMsg}`, true);
      return false;
    }
  }

  private releaseComponent(sourceId?: string): void {
    if (sourceId && this.pendingComponents.has(sourceId)) {
      this.pendingComponents.delete(sourceId);
      this.options.onPendingChange?.(new Set(this.pendingComponents));
    }
  }
}
