import { LitElement, html, css, nothing, PropertyValues } from 'lit';
import { ContextProvider } from '@lit/context';
import { Context } from '@a2ui/lit';
import '@a2ui/lit';
import '@a2ui/lit/v0_9';
import './charts-catalog.js';
import './status-catalog.js';
import { renderRichMarkdown } from './markdown-renderer.js';
import { installIconSvgRenderer, installRichTextVariantRenderer } from './icon-paths.js';
import { installButtonStateRenderer } from './button-state.js';
import { markComponentSubmitted, clearSubmittedState } from './processor.js';
import { SURFACE_LAYOUT_CSS } from './surface-layout-css.js';
import { MessageProcessor } from '@a2ui/web_core/v1_0';

installIconSvgRenderer();
installRichTextVariantRenderer();
installButtonStateRenderer();

/** Event detail dispatched when a surface is created or deleted. */
export interface SurfaceChangedDetail {
  surfaceId: string;
  action: 'created' | 'deleted';
}

/** Event detail dispatched when a surface's submission status changes. */
export interface SurfaceSubmissionChangedDetail {
  surfaceId: string;
  status: 'active' | 'submitted' | 'dismissed';
  label?: string;
}

/** Event detail dispatched when a user explicitly dismisses a surface. */
export interface SurfaceDismissedDetail {
  surfaceId: string;
}

/**
 * Lit custom element rendering multiple A2UI surfaces in creation order.
 * Provides the required markdown context to descendant text components
 * and dispatches 'surface-changed' events when surfaces are added or removed.
 */
export class A2uiPaneView extends LitElement {
  static override properties = {
    processor: { type: Object },
    pendingComponents: { type: Object },
    dismissibleSurfaces: { type: Boolean },
    surfaceIds: { state: true },
    submittedSurfaces: { state: true },
    dismissedSurfaces: { state: true },
  };

  declare processor?: MessageProcessor<any>;
  declare pendingComponents: ReadonlySet<string>;
  declare dismissibleSurfaces: boolean;
  declare surfaceIds: string[];
  declare submittedSurfaces: ReadonlyMap<string, string>;
  declare dismissedSurfaces: ReadonlySet<string>;

  private unsubscribeCreated?: { unsubscribe: () => void };
  private unsubscribeDeleted?: { unsubscribe: () => void };

  constructor() {
    super();
    this.surfaceIds = [];
    this.pendingComponents = new Set();
    this.dismissibleSurfaces = false;
    this.submittedSurfaces = new Map();
    this.dismissedSurfaces = new Set();
    // Provide markdown renderer context to descendant components (e.g. Text)
    new ContextProvider(this, {
      context: Context.markdown,
      initialValue: renderRichMarkdown,
    });
  }

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      overflow-y: auto;
      color: var(--a2ui-text-color-text, var(--foreground, #24292f));
      background-color: var(--a2ui-color-surface, var(--background, #ffffff));
      font-family:
        -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    .a2ui-surfaces {
      display: flex;
      flex-direction: column;
      gap: var(--a2ui-surfaces-gap, 16px);
      padding: var(--a2ui-surfaces-padding, 16px);
      box-sizing: border-box;
    }

    .a2ui-math-block {
      margin: 6px 0;
      padding: 2px 0;
      overflow-x: auto;
      overflow-y: hidden;
    }

    .a2ui-mermaid {
      margin: 6px 0;
      overflow-x: auto;
      overflow-y: hidden;
      text-align: center;
    }

    .a2ui-mermaid-svg {
      display: block;
      margin: 0 auto;
      max-width: 100%;
      height: auto;
    }

    .a2ui-surfaces[data-busy] {
      opacity: 0.75;
      pointer-events: none;
    }

    .a2ui-surface-wrapper {
      position: relative;
      display: flex;
      flex-direction: column;
      width: 100%;
      box-sizing: border-box;
    }

    .a2ui-surface-close-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--a2ui-color-border, #6e7781);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
    }

    .a2ui-surface-close-btn:hover {
      background-color: var(--a2ui-color-secondary, rgba(175, 184, 193, 0.2));
      border-color: var(--a2ui-color-border, #d0d7de);
      color: var(--a2ui-text-color-text, #24292f);
    }

    .a2ui-surface-submitted-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-radius: var(--a2ui-card-border-radius, 8px);
      border: 1px solid var(--a2ui-color-border, #d0d7de);
      background-color: var(--a2ui-color-secondary, #f6f8fa);
      color: var(--a2ui-text-color-text, #24292f);
      font-size: 13px;
    }

    .a2ui-submitted-text {
      font-weight: 500;
    }

    .a2ui-submitted-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .a2ui-surface-resubmit-btn,
    .a2ui-surface-dismiss-btn {
      background: transparent;
      border: 1px solid var(--a2ui-color-border, #6a737d);
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
    }

    .a2ui-empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 16px;
      color: var(--a2ui-color-border, #6e7781);
      font-size: 14px;
      text-align: center;
    }
  `;

  private emitSubmissionChanged(
    surfaceId: string,
    status: 'active' | 'submitted' | 'dismissed',
    label?: string,
  ): void {
    this.dispatchEvent(
      new CustomEvent<SurfaceSubmissionChangedDetail>('surface-submission-changed', {
        detail: { surfaceId, status, label },
        bubbles: true,
        composed: true,
      }),
    );
  }

  markSurfaceSubmitted(surfaceId: string, label = ''): void {
    const nextSubmitted = new Map(this.submittedSurfaces);
    nextSubmitted.set(surfaceId, label);
    this.submittedSurfaces = nextSubmitted;

    if (this.dismissedSurfaces.has(surfaceId)) {
      const nextDismissed = new Set(this.dismissedSurfaces);
      nextDismissed.delete(surfaceId);
      this.dismissedSurfaces = nextDismissed;
    }
    this.emitSubmissionChanged(surfaceId, 'submitted', label);
  }

  unsubmitSurface(surfaceId: string): void {
    this.clearSubmittedState(surfaceId);
    if (this.submittedSurfaces.has(surfaceId)) {
      const nextSubmitted = new Map(this.submittedSurfaces);
      nextSubmitted.delete(surfaceId);
      this.submittedSurfaces = nextSubmitted;
    }
    if (this.dismissedSurfaces.has(surfaceId)) {
      const nextDismissed = new Set(this.dismissedSurfaces);
      nextDismissed.delete(surfaceId);
      this.dismissedSurfaces = nextDismissed;
    }
    this.emitSubmissionChanged(surfaceId, 'active');
  }

  /**
   * Marks a button component (and optional `_group`) as submitted on the given surface.
   */
  markComponentSubmitted(surfaceId: string, componentId?: string, group?: string): void {
    markComponentSubmitted(this.processor, surfaceId, componentId, group);
  }

  /**
   * Clears all one-shot button submission flags on the given surface.
   */
  clearSubmittedState(surfaceId: string): void {
    clearSubmittedState(this.processor, surfaceId);
  }

  dismissSurface(surfaceId: string): void {
    if (this.submittedSurfaces.has(surfaceId)) {
      const nextSubmitted = new Map(this.submittedSurfaces);
      nextSubmitted.delete(surfaceId);
      this.submittedSurfaces = nextSubmitted;
    }
    const nextDismissed = new Set(this.dismissedSurfaces);
    nextDismissed.add(surfaceId);
    this.dismissedSurfaces = nextDismissed;
    this.emitSubmissionChanged(surfaceId, 'dismissed');
  }

  clearSubmittedSurfaces(): void {
    this.submittedSurfaces = new Map();
    this.dismissedSurfaces = new Set();
  }

  isSurfaceSubmitted(surfaceId: string): boolean {
    return this.submittedSurfaces.has(surfaceId);
  }

  isSurfaceDismissed(surfaceId: string): boolean {
    return this.dismissedSurfaces.has(surfaceId);
  }

  private handleSurfaceCreated(surface: any): void {
    const id = surface?.id;
    if (!id) return;

    // Auto-dismiss any previously submitted surfaces when a new surface arrives
    const autoDismissed: string[] = [];
    const nextDismissed = new Set(this.dismissedSurfaces);
    nextDismissed.delete(id);
    for (const prevSubmittedId of this.submittedSurfaces.keys()) {
      if (prevSubmittedId !== id) {
        nextDismissed.add(prevSubmittedId);
        autoDismissed.push(prevSubmittedId);
      }
    }
    this.dismissedSurfaces = nextDismissed;
    this.submittedSurfaces = new Map();
    for (const prevId of autoDismissed) {
      this.emitSubmissionChanged(prevId, 'dismissed');
    }

    if (!this.surfaceIds.includes(id)) {
      this.surfaceIds = [...this.surfaceIds, id];
      this.dispatchEvent(
        new CustomEvent<SurfaceChangedDetail>('surface-changed', {
          detail: { surfaceId: id, action: 'created' },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private handleSurfaceDeleted(id: string): void {
    if (!id || !this.surfaceIds.includes(id)) return;
    this.surfaceIds = this.surfaceIds.filter((s) => s !== id);
    this.unsubmitSurface(id);
    this.dispatchEvent(
      new CustomEvent<SurfaceChangedDetail>('surface-changed', {
        detail: { surfaceId: id, action: 'deleted' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('processor')) {
      this.cleanupSubscriptions();

      if (this.processor) {
        this.surfaceIds = Array.from(this.processor.getSurfaces().keys());

        this.unsubscribeCreated = this.processor.onSurfaceCreated((surface: any) => {
          this.handleSurfaceCreated(surface);
        });

        this.unsubscribeDeleted = this.processor.onSurfaceDeleted((id: string) => {
          this.handleSurfaceDeleted(id);
        });
      } else {
        this.surfaceIds = [];
      }
    }
  }

  override updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    this.injectSurfaceStyles();
  }

  private injectSurfaceStyles(): void {
    const surfaces = this.renderRoot.querySelectorAll('a2ui-surface');
    for (const surfaceEl of Array.from(surfaces)) {
      const sr = surfaceEl.shadowRoot;
      if (!sr || sr.querySelector('style[data-a2ui-surface-layout]')) {
        continue;
      }
      const style = document.createElement('style');
      style.setAttribute('data-a2ui-surface-layout', 'true');
      style.textContent = SURFACE_LAYOUT_CSS;
      sr.appendChild(style);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cleanupSubscriptions();
  }

  private cleanupSubscriptions(): void {
    if (this.unsubscribeCreated) {
      this.unsubscribeCreated.unsubscribe();
      this.unsubscribeCreated = undefined;
    }
    if (this.unsubscribeDeleted) {
      this.unsubscribeDeleted.unsubscribe();
      this.unsubscribeDeleted = undefined;
    }
  }

  private handleCloseSurfaceClick(surfaceId: string): void {
    this.dismissSurface(surfaceId);
    this.dispatchEvent(
      new CustomEvent<SurfaceDismissedDetail>('surface-dismissed', {
        detail: { surfaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderSurfaceEntry(id: string, surface: any) {
    if (this.submittedSurfaces.has(id)) {
      const label = this.submittedSurfaces.get(id);
      return html`
        <div class="a2ui-surface-wrapper" data-surface-id="${id}">
          <div class="a2ui-surface-submitted-banner" data-submitted-surface="${id}">
            <span class="a2ui-submitted-text">
              ✓ Submitted${label ? ` "${label}"` : ''} to agent.
            </span>
            <div class="a2ui-submitted-actions">
              <button
                type="button"
                class="a2ui-surface-resubmit-btn"
                @click=${() => this.unsubmitSurface(id)}
              >
                Edit / Resubmit
              </button>
              <button
                type="button"
                class="a2ui-surface-dismiss-btn"
                @click=${() => this.dismissSurface(id)}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <div
        class="a2ui-surface-wrapper"
        data-surface-id="${id}"
        ?data-dismissible=${this.dismissibleSurfaces}
      >
        ${
          this.dismissibleSurfaces
            ? html`
                <button
                  type="button"
                  class="a2ui-surface-close-btn"
                  title="Dismiss"
                  aria-label="Dismiss surface"
                  @click=${() => this.handleCloseSurfaceClick(id)}
                >
                  ✕
                </button>
              `
            : nothing
        }
        <a2ui-surface
          .surface=${surface}
          ?data-dismissible=${this.dismissibleSurfaces}
        ></a2ui-surface>
      </div>
    `;
  }

  override render() {
    const visibleIds = this.processor
      ? this.surfaceIds.filter(
          (id) => !this.dismissedSurfaces.has(id) && Boolean(this.processor?.getSurface(id)),
        )
      : [];

    if (!this.processor || visibleIds.length === 0) {
      return html`
        <slot name="empty">
          <div class="a2ui-empty-state">No surfaces rendered. Waiting for A2UI messages...</div>
        </slot>
      `;
    }

    const pendingList = this.pendingComponents ? Array.from(this.pendingComponents) : [];
    const isBusy = pendingList.length > 0;

    return html`
      <div
        class="a2ui-surfaces"
        ?data-busy=${isBusy}
        data-pending-components=${isBusy ? pendingList.join(',') : nothing}
      >
        ${visibleIds.map((id) => {
          const surface = this.processor?.getSurface(id);
          return this.renderSurfaceEntry(id, surface);
        })}
      </div>
    `;
  }
}

if (!customElements.get('a2ui-pane-view')) {
  customElements.define('a2ui-pane-view', A2uiPaneView);
}

declare global {
  interface HTMLElementTagNameMap {
    'a2ui-pane-view': A2uiPaneView;
  }
}
