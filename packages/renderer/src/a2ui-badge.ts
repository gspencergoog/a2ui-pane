import { html, css, nothing } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import { resolveIconSvgPath } from './icon-paths.js';

/** Allowed semantic tone values for `Badge` and `ProgressBar` segments. */
export const STATUS_TONES = ['neutral', 'info', 'active', 'success', 'warning', 'danger'] as const;

/** Union type of supported semantic status tones. */
export type StatusTone = (typeof STATUS_TONES)[number];

const STATUS_TONE_SET: ReadonlySet<string> = new Set(STATUS_TONES);

/**
 * Normalizes an arbitrary tone value to a valid `StatusTone`, falling back to `'neutral'`.
 */
export function normalizeStatusTone(value: unknown): StatusTone {
  if (typeof value === 'string' && STATUS_TONE_SET.has(value)) {
    return value as StatusTone;
  }
  return 'neutral';
}

/** Resolved runtime properties passed to `A2uiBadgeElement` by `GenericBinder`. */
export interface BadgeResolvedProps {
  text?: string;
  tone?: StatusTone | string;
  icon?: string;
  pulse?: boolean;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

/**
 * Semantic status pill Web Component (`<a2ui-badge>`) for the A2UI v1.0 Status Catalog.
 */
export class A2uiBadgeElement extends A2uiLitElement<any, BadgeResolvedProps> {
  static tagName = 'a2ui-badge';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      vertical-align: middle;
    }

    .a2ui-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      line-height: 1.4;
      letter-spacing: 0.01em;
      white-space: nowrap;
      box-sizing: border-box;
      border: 1px solid
        var(--_badge-border, var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.25)));
      background-color: var(--_badge-bg, var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.1)));
      color: var(--_badge-fg, var(--a2ui-tone-neutral-fg, inherit));
    }

    .a2ui-badge[data-tone='neutral'] {
      --_badge-bg: var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.1));
      --_badge-fg: var(--a2ui-tone-neutral-fg, #5f6368);
      --_badge-border: var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.22));
    }

    .a2ui-badge[data-tone='info'] {
      --_badge-bg: var(--a2ui-tone-info-bg, rgba(11, 87, 208, 0.12));
      --_badge-fg: var(--a2ui-tone-info-fg, #0b57d0);
      --_badge-border: var(--a2ui-tone-info-border, rgba(11, 87, 208, 0.28));
    }

    .a2ui-badge[data-tone='active'] {
      --_badge-bg: var(--a2ui-tone-active-bg, rgba(26, 115, 232, 0.14));
      --_badge-fg: var(--a2ui-tone-active-fg, #185abc);
      --_badge-border: var(--a2ui-tone-active-border, rgba(26, 115, 232, 0.32));
    }

    .a2ui-badge[data-tone='success'] {
      --_badge-bg: var(--a2ui-tone-success-bg, rgba(24, 128, 56, 0.14));
      --_badge-fg: var(--a2ui-tone-success-fg, #137333);
      --_badge-border: var(--a2ui-tone-success-border, rgba(24, 128, 56, 0.3));
    }

    .a2ui-badge[data-tone='warning'] {
      --_badge-bg: var(--a2ui-tone-warning-bg, rgba(227, 116, 0, 0.15));
      --_badge-fg: var(--a2ui-tone-warning-fg, #b06000);
      --_badge-border: var(--a2ui-tone-warning-border, rgba(227, 116, 0, 0.32));
    }

    .a2ui-badge[data-tone='danger'] {
      --_badge-bg: var(--a2ui-tone-danger-bg, rgba(217, 48, 37, 0.14));
      --_badge-fg: var(--a2ui-tone-danger-fg, #c5221f);
      --_badge-border: var(--a2ui-tone-danger-border, rgba(217, 48, 37, 0.3));
    }

    .a2ui-badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: currentColor;
      flex-shrink: 0;
      animation: a2ui-badge-pulse 1.6s ease-in-out infinite;
    }

    @keyframes a2ui-badge-pulse {
      0%,
      100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.4;
        transform: scale(0.85);
      }
    }

    .a2ui-badge-icon {
      width: 13px;
      height: 13px;
      fill: currentColor;
      flex-shrink: 0;
    }
  `;

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const text = typeof props.text === 'string' ? props.text : String(props.text ?? '');
    const tone = normalizeStatusTone(props.tone);
    const iconName = typeof props.icon === 'string' ? props.icon.trim() : '';
    const svgPath = iconName ? resolveIconSvgPath(iconName) : undefined;
    const showPulse = props.pulse === true;
    const ariaLabel = props.accessibility?.label || text;
    const flexStyle = typeof props.weight === 'number' ? `flex: ${props.weight};` : nothing;

    return html`
      <span
        class="a2ui-badge"
        data-tone=${tone}
        role="status"
        aria-label=${ariaLabel}
        style=${flexStyle}
      >
        ${showPulse ? html`<span class="a2ui-badge-dot" aria-hidden="true"></span>` : nothing}
        ${
          svgPath
            ? html`
                <svg
                  class="a2ui-badge-icon"
                  data-icon=${iconName}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d=${svgPath}></path>
                </svg>
              `
            : nothing
        }
        <span class="a2ui-badge-text">${text}</span>
      </span>
    `;
  }
}
