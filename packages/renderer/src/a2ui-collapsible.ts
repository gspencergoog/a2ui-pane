import { html, css, nothing, unsafeCSS, type PropertyValues } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import { SURFACE_LAYOUT_CSS } from './surface-layout-css.js';
import { applyHostWeight, syncRowItemMarker } from './a2ui-badge.js';

/** Resolved runtime properties passed to `A2uiCollapsibleElement` by `GenericBinder`. */
export interface CollapsibleResolvedProps {
  title?: string;
  child?: string;
  summary?: string;
  badge?: string;
  open?: boolean;
  setOpen?: (value: boolean) => void;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

/**
 * Expandable disclosure section Web Component (`<a2ui-collapsible>`) for the A2UI v1.0 Status Catalog.
 */
export class A2uiCollapsibleElement extends A2uiLitElement<any, CollapsibleResolvedProps> {
  static tagName = 'a2ui-collapsible';

  static override properties = {
    ...A2uiLitElement.properties,
    localOpen: { state: true },
  };

  declare localOpen: boolean | null;
  private lastPropOpen: boolean | undefined = undefined;

  constructor() {
    super();
    this.localOpen = null;
  }

  static override styles = [
    unsafeCSS(SURFACE_LAYOUT_CSS),
    css`
      :host {
        display: block;
        min-width: 0;
        align-self: stretch;
        box-sizing: border-box;
      }

      :host([hidden]) {
        display: none;
      }

      /* Inside a Row the host is a flex item: follow the row's alignment, share the row, and
         shrink instead of claiming its full width (a weight on the component overrides this
         stylesheet default through the inline flex set on the host). */
      :host([data-a2ui-row-item]) {
        align-self: auto;
        flex: 1 1 0%;
      }

      .a2ui-collapsible {
        border: 1px solid var(--a2ui-color-border, #dadce0);
        border-radius: var(--a2ui-border-radius, 8px);
        background-color: var(--a2ui-color-surface, #ffffff);
        overflow: hidden;
        min-width: 0;
        container: a2ui-collapsible / inline-size;
      }

      .a2ui-collapsible-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 8px calc(12px + var(--a2ui-collapsible-close-clearance, 0px)) 8px 12px;
        cursor: pointer;
        user-select: none;
        background-color: color-mix(in srgb, var(--a2ui-color-secondary, #f1f3f4) 45%, transparent);
        transition: background-color 140ms ease;
      }

      .a2ui-collapsible-header:hover {
        background-color: var(--a2ui-color-secondary, #f1f3f4);
      }

      .a2ui-collapsible-header:focus-visible {
        outline: 2px solid var(--a2ui-color-primary, #0b57d0);
        outline-offset: -2px;
      }

      .a2ui-collapsible-heading {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }

      .a2ui-collapsible-chevron {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        fill: var(--a2ui-text-caption-color, #70757a);
        transition: transform 160ms ease;
      }

      .a2ui-collapsible[data-open='true'] .a2ui-collapsible-chevron {
        transform: rotate(90deg);
      }

      .a2ui-collapsible-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--a2ui-text-color-text, inherit);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .a2ui-collapsible-summary {
        font-size: 12px;
        color: var(--a2ui-text-caption-color, #70757a);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* When the header gets narrow (for example in a Row), let the title wrap instead of
         collapsing to an unreadable sliver next to the chevron. */
      @container a2ui-collapsible (max-width: 220px) {
        .a2ui-collapsible-heading {
          flex-wrap: wrap;
        }
        .a2ui-collapsible-title {
          white-space: normal;
          overflow-wrap: anywhere;
        }
      }

      .a2ui-collapsible-badge {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }

      .a2ui-collapsible-body {
        --a2ui-collapsible-close-clearance: 0px;
        padding: 10px 12px;
        border-top: 1px solid color-mix(in srgb, var(--a2ui-color-border, #dadce0) 65%, transparent);
      }
    `,
  ];

  private isExpanded(props: CollapsibleResolvedProps): boolean {
    if (props.open !== this.lastPropOpen) {
      this.lastPropOpen = props.open;
      this.localOpen = null;
    }
    if (this.localOpen !== null) {
      return this.localOpen;
    }
    return props.open === true;
  }

  private toggle(props: CollapsibleResolvedProps): void {
    const next = !this.isExpanded(props);
    this.localOpen = next;
    props.setOpen?.(next);
  }

  private handleKeydown(e: KeyboardEvent, props: CollapsibleResolvedProps): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.toggle(props);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    syncRowItemMarker(this);
  }

  override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    applyHostWeight(this, this.controller?.props?.weight);
  }

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const isOpen = this.isExpanded(props);
    const title = typeof props.title === 'string' ? props.title : String(props.title ?? '');
    if (title.trim() === '') {
      this.hidden = true;
      return nothing;
    }
    this.hidden = false;
    const summary = typeof props.summary === 'string' ? props.summary.trim() : '';

    return html`
      <div class="a2ui-collapsible" data-open=${String(isOpen)}>
        <div
          class="a2ui-collapsible-header"
          role="button"
          tabindex="0"
          aria-expanded=${String(isOpen)}
          aria-label=${props.accessibility?.label || title}
          @click=${() => this.toggle(props)}
          @keydown=${(e: KeyboardEvent) => this.handleKeydown(e, props)}
        >
          <div class="a2ui-collapsible-heading">
            <svg class="a2ui-collapsible-chevron" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path>
            </svg>
            <span class="a2ui-collapsible-title">${title}</span>
            ${summary ? html`<span class="a2ui-collapsible-summary">${summary}</span>` : nothing}
          </div>
          ${
            props.badge
              ? html`<div class="a2ui-collapsible-badge">${this.renderNode(props.badge)}</div>`
              : nothing
          }
        </div>
        ${
          isOpen && props.child
            ? html`<div class="a2ui-collapsible-body">${this.renderNode(props.child)}</div>`
            : nothing
        }
      </div>
    `;
  }
}
