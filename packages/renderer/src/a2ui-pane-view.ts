import { LitElement, html, css, nothing, PropertyValues } from 'lit';
import { ContextProvider } from '@lit/context';
import { Context } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9';
import { renderRichMarkdown } from './markdown-renderer.js';
import { MessageProcessor } from '@a2ui/web_core/v0_9';

export interface SurfaceChangedDetail {
  surfaceId: string;
  action: 'created' | 'deleted';
}

const SURFACE_LAYOUT_CSS = `
  a2ui-basic-row > a2ui-card {
    display: flex;
    flex-direction: column;
  }
  a2ui-basic-row > a2ui-card > .a2ui-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  a2ui-basic-text .a2ui-text {
    font-size: var(--a2ui-font-size-m, 14px);
    line-height: var(--a2ui-line-height-body, 1.4);
  }
  a2ui-basic-text .a2ui-text ul,
  a2ui-basic-text .a2ui-text ol {
    padding-inline-start: 18px;
    font-size: var(--a2ui-font-size-m, 14px);
    line-height: var(--a2ui-line-height-body, 1.4);
  }
  a2ui-basic-text .a2ui-text li + li {
    margin-top: 2px;
  }
  .a2ui-math-block {
    margin: 4px 0;
    overflow-x: auto;
  }
  .a2ui-mermaid {
    margin: 4px 0;
    overflow-x: auto;
    text-align: center;
  }
  .a2ui-mermaid-svg {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    height: auto;
  }
`;

/**
 * Lit custom element rendering multiple A2UI surfaces in creation order.
 * Provides the required markdown context to descendant text components
 * and dispatches 'surface-changed' events when surfaces are added or removed.
 */
export class A2uiPaneView extends LitElement {
  static override properties = {
    processor: { type: Object },
    pendingComponents: { type: Object },
    surfaceIds: { state: true },
  };

  declare processor?: MessageProcessor<any>;
  declare pendingComponents: ReadonlySet<string>;
  declare surfaceIds: string[];

  private unsubscribeCreated?: { unsubscribe: () => void };
  private unsubscribeDeleted?: { unsubscribe: () => void };

  constructor() {
    super();
    this.surfaceIds = [];
    this.pendingComponents = new Set();
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
      overflow-x: auto;
    }

    .a2ui-mermaid {
      margin: 6px 0;
      overflow-x: auto;
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
      display: flex;
      flex-direction: column;
      width: 100%;
      box-sizing: border-box;
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

  override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('processor')) {
      this.cleanupSubscriptions();

      if (this.processor) {
        this.surfaceIds = Array.from(this.processor.getSurfaces().keys());

        this.unsubscribeCreated = this.processor.onSurfaceCreated((surface: any) => {
          const id = surface?.id;
          if (id && !this.surfaceIds.includes(id)) {
            this.surfaceIds = [...this.surfaceIds, id];
            this.dispatchEvent(
              new CustomEvent<SurfaceChangedDetail>('surface-changed', {
                detail: { surfaceId: id, action: 'created' },
                bubbles: true,
                composed: true,
              }),
            );
          }
        });

        this.unsubscribeDeleted = this.processor.onSurfaceDeleted((id: string) => {
          if (id && this.surfaceIds.includes(id)) {
            this.surfaceIds = this.surfaceIds.filter((s) => s !== id);
            this.dispatchEvent(
              new CustomEvent<SurfaceChangedDetail>('surface-changed', {
                detail: { surfaceId: id, action: 'deleted' },
                bubbles: true,
                composed: true,
              }),
            );
          }
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

  override render() {
    if (!this.processor || this.surfaceIds.length === 0) {
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
        ${this.surfaceIds.map((id) => {
          const surface = this.processor?.getSurface(id);
          if (!surface) return nothing;
          return html`
            <div class="a2ui-surface-wrapper" data-surface-id="${id}">
              <a2ui-surface .surface=${surface}></a2ui-surface>
            </div>
          `;
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
