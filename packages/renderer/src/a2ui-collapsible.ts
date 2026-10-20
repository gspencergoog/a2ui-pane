import { html, css, nothing, unsafeCSS } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import { SURFACE_LAYOUT_CSS } from './surface-layout-css.js';

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
        width: 100%;
        box-sizing: border-box;
      }

      .a2ui-collapsible {
        border: 1px solid var(--a2ui-color-border, #dadce0);
        border-radius: var(--a2ui-border-radius, 8px);
        background-color: var(--a2ui-color-surface, #ffffff);
        overflow: hidden;
      }

      .a2ui-collapsible-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
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
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .a2ui-collapsible-summary {
        font-size: 12px;
        color: var(--a2ui-text-caption-color, #70757a);
        white-space: nowrap;
      }

      .a2ui-collapsible-badge {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }

      .a2ui-collapsible-body {
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

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const isOpen = this.isExpanded(props);
    const title = typeof props.title === 'string' ? props.title : String(props.title ?? '');
    const summary = typeof props.summary === 'string' ? props.summary.trim() : '';
    const flexStyle = typeof props.weight === 'number' ? `flex: ${props.weight};` : nothing;

    return html`
      <div class="a2ui-collapsible" data-open=${String(isOpen)} style=${flexStyle}>
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
