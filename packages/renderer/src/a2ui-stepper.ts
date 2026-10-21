import { html, css, nothing, type PropertyValues } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import {
  applyHostWeight,
  normalizeStatusTone,
  syncRowItemMarker,
  type StatusTone,
} from './a2ui-badge.js';

/** Allowed `orientation` values for a `Stepper`. */
export const STEPPER_ORIENTATIONS = ['horizontal', 'vertical'] as const;

/** Union type of supported `Stepper` orientations. */
export type StepperOrientation = (typeof STEPPER_ORIENTATIONS)[number];

/** A single step from `Stepper.steps` after normalization. */
export interface StepperStep {
  label: string;
  detail?: string;
}

/** Resolved runtime properties passed to `A2uiStepperElement` by `GenericBinder`. */
export interface StepperResolvedProps {
  steps?: unknown;
  current?: number | string | null;
  tone?: StatusTone | string;
  orientation?: StepperOrientation | string;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStepperStep(entry: unknown): StepperStep | undefined {
  if (typeof entry === 'string') return { label: entry };
  if (!isRecord(entry) || entry.label === undefined || entry.label === null) return undefined;
  const detail = entry.detail;
  return {
    label: String(entry.label),
    detail: typeof detail === 'string' && detail.length > 0 ? detail : undefined,
  };
}

/**
 * Normalizes an arbitrary `steps` value into `StepperStep` entries.
 * Plain strings become labels; objects without a `label` are dropped.
 */
export function normalizeStepperSteps(value: unknown): StepperStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => normalizeStepperStep(entry) ?? []);
}

/**
 * Clamps a `current` value to a valid step index: non-numeric or negative values become 0 and
 * values past the last step become the last index. Returns -1 when there are no steps.
 */
export function clampStepperIndex(current: unknown, stepCount: number): number {
  if (stepCount <= 0) return -1;
  const parsed = typeof current === 'number' ? current : Number(current ?? 0);
  const index = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  return Math.min(Math.max(index, 0), stepCount - 1);
}

/**
 * Ordered lifecycle Web Component (`<a2ui-stepper>`) for the A2UI v1.0 Status Catalog.
 *
 * Renders one dot and label per step. Steps before `current` are complete (success), the
 * current step pulses in `tone` (default `'active'`), and later steps are pending (neutral).
 */
export class A2uiStepperElement extends A2uiLitElement<any, StepperResolvedProps> {
  static tagName = 'a2ui-stepper';

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
      align-self: stretch;
      box-sizing: border-box;
    }

    /* Inside a Row the host is a flex item: follow the row's alignment, share the row, and
       shrink instead of claiming its full width (a weight on the component overrides this
       stylesheet default through the inline flex set on the host). */
    :host([data-a2ui-row-item]) {
      align-self: auto;
      flex: 1 1 0%;
    }

    .a2ui-stepper {
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      gap: 0;
      margin: 0;
      padding: 3px 0 0;
      list-style: none;
      font-size: 11.5px;
      line-height: 1.3;
      color: var(--a2ui-tone-neutral-fg, #5f6368);
    }

    .a2ui-stepper-step {
      position: relative;
      display: flex;
      flex: 1 1 0%;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      min-width: 0;
      text-align: center;
    }

    /* Connector drawn behind the dot, from this step's center to the next step's center. */
    .a2ui-stepper-step:not(:last-child)::after {
      content: '';
      position: absolute;
      top: 5px;
      left: 50%;
      width: 100%;
      height: 2px;
      background-color: var(
        --_step-line,
        var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.25))
      );
    }

    .a2ui-stepper-dot {
      position: relative;
      z-index: 1;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      box-sizing: border-box;
      flex-shrink: 0;
      border: 2px solid var(--_step-fg, var(--a2ui-tone-neutral-fg, #5f6368));
      background-color: var(--_step-bg, var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.1)));
    }

    .a2ui-stepper-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
      color: var(--_step-fg, inherit);
    }

    .a2ui-stepper-step[data-tone='neutral'] {
      --_step-fg: var(--a2ui-tone-neutral-fg, #5f6368);
      --_step-bg: var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.1));
    }

    .a2ui-stepper-step[data-tone='info'] {
      --_step-fg: var(--a2ui-tone-info-fg, #0b57d0);
      --_step-bg: var(--a2ui-tone-info-bg, rgba(11, 87, 208, 0.12));
    }

    .a2ui-stepper-step[data-tone='active'] {
      --_step-fg: var(--a2ui-tone-active-fg, #185abc);
      --_step-bg: var(--a2ui-tone-active-bg, rgba(26, 115, 232, 0.14));
    }

    .a2ui-stepper-step[data-tone='success'] {
      --_step-fg: var(--a2ui-tone-success-fg, #137333);
      --_step-bg: var(--a2ui-tone-success-fg, #137333);
      --_step-line: var(--a2ui-tone-success-fg, #137333);
    }

    .a2ui-stepper-step[data-tone='warning'] {
      --_step-fg: var(--a2ui-tone-warning-fg, #b06000);
      --_step-bg: var(--a2ui-tone-warning-bg, rgba(227, 116, 0, 0.15));
    }

    .a2ui-stepper-step[data-tone='danger'] {
      --_step-fg: var(--a2ui-tone-danger-fg, #c5221f);
      --_step-bg: var(--a2ui-tone-danger-bg, rgba(217, 48, 37, 0.14));
    }

    .a2ui-stepper-step[data-current] .a2ui-stepper-dot {
      background-color: var(--_step-fg);
      animation: a2ui-badge-pulse 1.6s ease-in-out infinite;
    }

    .a2ui-stepper-step[data-current] .a2ui-stepper-label {
      font-weight: 600;
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

    .a2ui-stepper--vertical {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }

    .a2ui-stepper--vertical .a2ui-stepper-step {
      flex: 0 0 auto;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      text-align: start;
    }

    .a2ui-stepper--vertical .a2ui-stepper-step:not(:last-child)::after {
      top: 12px;
      left: 5px;
      width: 2px;
      height: calc(100% + 10px);
    }

    .a2ui-stepper--vertical .a2ui-stepper-label {
      white-space: normal;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    syncRowItemMarker(this);
  }

  override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    applyHostWeight(this, this.controller?.props?.weight);
  }

  /** Normalized steps from the current props. */
  private get steps(): StepperStep[] {
    return normalizeStepperSteps(this.controller?.props?.steps);
  }

  /** Clamped index of the current step, or -1 when there are no steps. */
  private get currentIndex(): number {
    return clampStepperIndex(this.controller?.props?.current, this.steps.length);
  }

  /** Tone for the step at `index`: success before `current`, `tone ?? 'active'` at it, neutral after. */
  private stepTone(index: number): StatusTone {
    const current = this.currentIndex;
    if (index < current) return 'success';
    if (index > current) return 'neutral';
    const override = this.controller?.props?.tone;
    return override === undefined || override === null ? 'active' : normalizeStatusTone(override);
  }

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const steps = this.steps;
    const current = this.currentIndex;
    const orientation: StepperOrientation =
      props.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const currentLabel = steps[current]?.label ?? '';
    const ariaLabel =
      props.accessibility?.label || (currentLabel ? `Step: ${currentLabel}` : 'Steps');

    return html`
      <ol
        class="a2ui-stepper a2ui-stepper--${orientation}"
        data-orientation=${orientation}
        aria-label=${ariaLabel}
        aria-description=${props.accessibility?.description ?? nothing}
      >
        ${steps.map(
          (step, index) => html`
            <li
              class="a2ui-stepper-step"
              data-tone=${this.stepTone(index)}
              ?data-current=${index === current}
              aria-current=${index === current ? 'step' : nothing}
              title=${step.detail ?? nothing}
            >
              <span class="a2ui-stepper-dot" aria-hidden="true"></span>
              <span class="a2ui-stepper-label">${step.label}</span>
            </li>
          `,
        )}
      </ol>
    `;
  }
}
