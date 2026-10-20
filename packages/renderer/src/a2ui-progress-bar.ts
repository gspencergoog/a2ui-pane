import { html, css, nothing } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import { normalizeStatusTone, type StatusTone } from './a2ui-badge.js';

/** Raw segment input inside `ProgressBar.segments`. */
export interface ProgressSegmentInput {
  value?: number;
  tone?: StatusTone | string;
  label?: string;
}

/** Raw item input inside `ProgressBar.items` (such as `progress_board` `$/items`). */
export interface StatusItemInput {
  tone?: StatusTone | string;
  status?: string;
  label?: string;
  detail?: string;
}

/** Normalized progress segment with percentage width for rendering. */
export interface NormalizedProgressSegment {
  value: number;
  widthPercent: number;
  tone: StatusTone;
  label?: string;
}

/** Resolved runtime properties passed to `A2uiProgressBarElement` by `GenericBinder`. */
export interface ProgressBarResolvedProps {
  value?: number;
  max?: number;
  segments?: unknown;
  items?: unknown;
  label?: string;
  summary?: string;
  indeterminate?: boolean;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

/** Canonical segment order when auto-tallying `items` by tone. */
const TALLY_TONE_ORDER: readonly StatusTone[] = [
  'success',
  'active',
  'info',
  'warning',
  'danger',
  'neutral',
];

function normalizeExplicitSegments(
  rawSegments: unknown[],
  explicitMax?: number,
): { segments: NormalizedProgressSegment[]; defaultSummary?: string; total: number } {
  const valid: Array<{ value: number; tone: StatusTone; label?: string }> = [];
  let sum = 0;
  for (const item of rawSegments) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as ProgressSegmentInput;
    const val = Number(rec.value ?? 0);
    if (!Number.isFinite(val) || val <= 0) continue;
    sum += val;
    valid.push({
      value: val,
      tone: normalizeStatusTone(rec.tone),
      label: typeof rec.label === 'string' ? rec.label : undefined,
    });
  }
  const denom =
    typeof explicitMax === 'number' && Number.isFinite(explicitMax) && explicitMax > sum
      ? explicitMax
      : sum;
  if (denom <= 0) {
    return { segments: [], total: 0 };
  }
  return {
    segments: valid.map((seg) => ({
      ...seg,
      widthPercent: Math.min(100, Math.max(0, (seg.value / denom) * 100)),
    })),
    total: denom,
  };
}

function normalizeTalliedItems(rawItems: unknown[]): {
  segments: NormalizedProgressSegment[];
  defaultSummary?: string;
  total: number;
} {
  const counts = new Map<StatusTone, number>();
  let total = 0;
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const tone = normalizeStatusTone((item as StatusItemInput).tone);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) {
    return { segments: [], defaultSummary: '0 items', total: 0 };
  }
  const segments: NormalizedProgressSegment[] = [];
  for (const tone of TALLY_TONE_ORDER) {
    const count = counts.get(tone) ?? 0;
    if (count > 0) {
      segments.push({
        value: count,
        widthPercent: (count / total) * 100,
        tone,
        label: `${count} ${tone}`,
      });
    }
  }
  const successCount = counts.get('success') ?? 0;
  const activeCount = counts.get('active') ?? 0;
  const defaultSummary =
    activeCount > 0
      ? `${successCount} / ${total} complete · ${activeCount} active`
      : `${successCount} / ${total} complete`;
  return { segments, defaultSummary, total };
}

/**
 * Computes normalized progress segments and default summary text from `ProgressBarResolvedProps`.
 */
export function computeProgressSegments(props: ProgressBarResolvedProps): {
  segments: NormalizedProgressSegment[];
  defaultSummary?: string;
  total: number;
} {
  if (Array.isArray(props.segments)) {
    return normalizeExplicitSegments(props.segments, props.max);
  }
  if (Array.isArray(props.items)) {
    return normalizeTalliedItems(props.items);
  }
  const rawMax = props.max === undefined ? 100 : Number(props.max);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;
  const rawVal = Number(props.value ?? 0);
  const value = Number.isFinite(rawVal) && rawVal > 0 ? rawVal : 0;
  if (max <= 0) {
    return { segments: [], total: 0 };
  }
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const tone: StatusTone = value >= max ? 'success' : 'active';
  return {
    segments: pct > 0 ? [{ value, widthPercent: pct, tone }] : [],
    defaultSummary: `${Math.round(pct)}%`,
    total: max,
  };
}

/**
 * Horizontal single-value or multi-segment progress bar Web Component (`<a2ui-progress-bar>`)
 * for the A2UI v1.0 Status Catalog.
 */
export class A2uiProgressBarElement extends A2uiLitElement<any, ProgressBarResolvedProps> {
  static tagName = 'a2ui-progress-bar';

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      box-sizing: border-box;
    }

    .a2ui-progress-container {
      display: flex;
      flex-direction: column;
      gap: 5px;
      width: 100%;
      padding-inline-end: var(--a2ui-progress-close-clearance, 0px);
      box-sizing: border-box;
    }

    .a2ui-progress-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      line-height: 1.3;
    }

    .a2ui-progress-label {
      font-weight: 600;
      color: var(--a2ui-text-color-text, inherit);
    }

    .a2ui-progress-summary {
      color: var(--a2ui-text-caption-color, #70757a);
      font-variant-numeric: tabular-nums;
      margin-inline-start: auto;
    }

    .a2ui-progress-track {
      position: relative;
      display: flex;
      width: 100%;
      height: 7px;
      border-radius: 999px;
      overflow: hidden;
      background-color: var(
        --a2ui-tone-neutral-bg,
        color-mix(in srgb, var(--a2ui-color-border, #dadce0) 45%, transparent)
      );
    }

    .a2ui-progress-segment {
      height: 100%;
      transition: width 220ms ease;
    }

    .a2ui-progress-segment + .a2ui-progress-segment {
      border-inline-start: 1px solid var(--a2ui-color-surface, #ffffff);
    }

    .a2ui-progress-segment[data-tone='neutral'] {
      background-color: var(--a2ui-tone-neutral-bar, #9aa0a6);
    }

    .a2ui-progress-segment[data-tone='info'] {
      background-color: var(--a2ui-tone-info-bar, #0b57d0);
    }

    .a2ui-progress-segment[data-tone='active'] {
      background-color: var(--a2ui-tone-active-bar, #1a73e8);
    }

    .a2ui-progress-segment[data-tone='success'] {
      background-color: var(--a2ui-tone-success-bar, #1e8e3e);
    }

    .a2ui-progress-segment[data-tone='warning'] {
      background-color: var(--a2ui-tone-warning-bar, #f29900);
    }

    .a2ui-progress-segment[data-tone='danger'] {
      background-color: var(--a2ui-tone-danger-bar, #d93025);
    }

    .a2ui-progress-indeterminate {
      position: absolute;
      inset: 0;
      width: 40%;
      border-radius: 999px;
      background-color: var(--a2ui-tone-active-bar, #1a73e8);
      animation: a2ui-progress-shimmer 1.4s ease-in-out infinite;
    }

    @keyframes a2ui-progress-shimmer {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(250%);
      }
    }
  `;

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const { segments, defaultSummary, total } = computeProgressSegments(props);
    const label = typeof props.label === 'string' ? props.label.trim() : '';
    const summaryText =
      typeof props.summary === 'string' && props.summary.trim().length > 0
        ? props.summary.trim()
        : (defaultSummary ?? '');
    const indeterminate = props.indeterminate === true;
    const completedValue = Array.isArray(props.items)
      ? segments.filter((s) => s.tone === 'success').reduce((acc, s) => acc + s.value, 0)
      : segments.reduce((acc, s) => acc + s.value, 0);
    const ariaLabel = props.accessibility?.label || label || 'Progress';
    const flexStyle = typeof props.weight === 'number' ? `flex: ${props.weight};` : nothing;

    return html`
      <div class="a2ui-progress-container" style=${flexStyle}>
        ${
          label || summaryText
            ? html`
                <div class="a2ui-progress-header">
                  ${label ? html`<span class="a2ui-progress-label">${label}</span>` : nothing}
                  ${
                    summaryText
                      ? html`<span class="a2ui-progress-summary">${summaryText}</span>`
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        <div
          class="a2ui-progress-track"
          role="progressbar"
          aria-label=${ariaLabel}
          aria-valuemin="0"
          aria-valuemax=${String(total || 100)}
          aria-valuenow=${indeterminate ? nothing : String(completedValue)}
        >
          ${
            indeterminate
              ? html`<div class="a2ui-progress-indeterminate"></div>`
              : segments.map(
                  (seg) => html`
                    <div
                      class="a2ui-progress-segment"
                      data-tone=${seg.tone}
                      title=${seg.label ?? nothing}
                      style=${`width: ${seg.widthPercent.toFixed(2)}%;`}
                    ></div>
                  `,
                )
          }
        </div>
      </div>
    `;
  }
}
