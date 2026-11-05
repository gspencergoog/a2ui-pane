import { html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { until } from 'lit/directives/until.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import { createStyledShadowRoot } from './styled-shadow-root.js';
import {
  A2uiBadgeElement,
  applyHostWeight,
  normalizeStatusTone,
  syncRowItemMarker,
  type StatusTone,
} from './a2ui-badge.js';
import { ICON_SVG_PATHS } from './icon-paths.js';
import { renderRichMarkdown } from './markdown-renderer.js';

/** Allowed `variant` values for `ChoiceCards`. */
export const CHOICE_CARDS_VARIANTS = ['mutuallyExclusive', 'multipleSelection'] as const;

/** Allowed `direction` values for `ChoiceCards`. */
export const CHOICE_CARDS_DIRECTIONS = ['vertical', 'horizontal'] as const;

/** Union type of supported `ChoiceCards` selection variants. */
export type ChoiceCardsVariant = (typeof CHOICE_CARDS_VARIANTS)[number];

/** Union type of supported `ChoiceCards` layout directions. */
export type ChoiceCardsDirection = (typeof CHOICE_CARDS_DIRECTIONS)[number];

/** A single option from `ChoiceCards.options` after normalization. */
export interface ChoiceCardOption {
  /** Stable value written to `value` when this option is chosen. */
  value: string;
  /** Bold option name shown at the top of the card. */
  label: string;
  /** Optional Markdown text under the label, such as the consequence of choosing it. */
  description?: string;
  /** Optional badge text shown next to the label, such as `'Recommended'`. */
  badge?: string;
  /** Badge tone; `undefined` renders as `'neutral'`. */
  tone?: StatusTone;
  /** When true, the option renders as a small text toggle after the cards. */
  quiet?: boolean;
}

/** Resolved runtime properties passed to `A2uiChoiceCardsElement` by `GenericBinder`. */
export interface ChoiceCardsResolvedProps {
  options?: unknown;
  value?: string[] | null;
  setValue?: (value: string[]) => void;
  variant?: ChoiceCardsVariant | string;
  direction?: ChoiceCardsDirection | string;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

type FocusMove = 'next' | 'prev' | 'first' | 'last';

/** Per-option render state shared by cards and quiet toggles. */
interface ChoiceItemState {
  /** Position in focus order (cards first, then quiet toggles). */
  index: number;
  checked: boolean;
  /** Whether this option holds the group's roving `tabindex="0"`. */
  focusable: boolean;
  role: 'radio' | 'checkbox';
}

/** Keyboard keys that move focus within the group, per the WAI-ARIA radio group pattern. */
const KEY_MOVES: Readonly<Record<string, FocusMove>> = {
  ArrowRight: 'next',
  ArrowDown: 'next',
  ArrowLeft: 'prev',
  ArrowUp: 'prev',
  Home: 'first',
  End: 'last',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeChoiceCardOption(entry: unknown): ChoiceCardOption | undefined {
  if (!isRecord(entry) || entry.value === undefined || entry.value === null) return undefined;
  const value = String(entry.value);
  const label = entry.label === undefined || entry.label === null ? value : String(entry.label);
  return {
    value,
    label,
    description: nonEmptyString(entry.description),
    badge: nonEmptyString(entry.badge),
    tone:
      entry.tone === undefined || entry.tone === null ? undefined : normalizeStatusTone(entry.tone),
    quiet: entry.quiet === true,
  };
}

/**
 * Normalizes an arbitrary `options` value into `ChoiceCardOption` entries.
 * Entries without a `value` are dropped; a missing `label` falls back to the value.
 */
export function normalizeChoiceCardOptions(raw: unknown): ChoiceCardOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => normalizeChoiceCardOption(entry) ?? []);
}

/**
 * Returns the selection that results from choosing `value`.
 *
 * In `mutuallyExclusive` mode the selection becomes `[value]`, so choosing any option
 * (including a quiet one) clears every other option. In `multipleSelection` mode `value`
 * is toggled: removed when present, appended otherwise.
 */
export function nextChoiceValue(
  current: readonly string[],
  value: string,
  variant: ChoiceCardsResolvedProps['variant'],
): string[] {
  if (variant !== 'multipleSelection') return [value];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/** Index reached from `index` after `move` within `count` items, wrapping at both ends. */
function moveFocusIndex(index: number, count: number, move: FocusMove): number {
  switch (move) {
    case 'next':
      return (index + 1) % count;
    case 'prev':
      return (index - 1 + count) % count;
    case 'first':
      return 0;
    default:
      return count - 1;
  }
}

/**
 * Selectable option cards Web Component (`<a2ui-choice-cards>`) for the A2UI v1.0 Status Catalog.
 *
 * Renders one card per option inside a `radiogroup` (or `group` for `multipleSelection`). Each
 * card is a `<button role="radio|checkbox">` holding the check, label, and badge, with the
 * Markdown `description` beside it and linked through `aria-describedby`; the whole card is the
 * click target. Quiet options follow the cards as small text toggles.
 * Choosing an option writes the new selection back through `setValue`. Keyboard follows the
 * WAI-ARIA radio group pattern: a roving `tabindex` across cards and quiet toggles, arrow keys
 * move focus (and select in `mutuallyExclusive`), Space toggles in `multipleSelection`, and
 * Home and End jump to the first and last option.
 */
export class A2uiChoiceCardsElement extends A2uiLitElement<any, ChoiceCardsResolvedProps> {
  static tagName = 'a2ui-choice-cards';

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return createStyledShadowRoot(this);
  }

  /**
   * Badge styles are reused so `badge` renders with the same markup and tone variables as the
   * standalone component. This element's own `:host` rule comes last so it wins over the
   * inline-flex host rule from the badge sheet.
   */
  static override styles = [
    A2uiBadgeElement.styles,
    css`
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

      .a2ui-choice-cards {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--a2ui-font-size-s, 13px);
        line-height: 1.35;
        color: var(--a2ui-text-color-text, inherit);
      }

      .a2ui-choice-cards-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .a2ui-choice-cards--horizontal .a2ui-choice-cards-list {
        flex-direction: row;
        flex-wrap: wrap;
      }

      .a2ui-choice-cards--horizontal .a2ui-choice-card {
        flex: 1 1 0%;
        min-width: min(100%, 9rem);
      }

      /* The wrapper is the visual card and the whole click target. The option's accessible
         name is the <button> inside it (check, label, badge); the description sits beside the
         button, linked through aria-describedby, so Markdown links in it are never nested
         inside the button. */
      .a2ui-choice-card {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin: 0;
        padding: 8px 10px;
        min-width: 0;
        box-sizing: border-box;
        border: 1px solid
          var(--a2ui-color-border, var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.3)));
        border-radius: 8px;
        background-color: var(--a2ui-color-surface, transparent);
        cursor: pointer;
        transition:
          border-color 120ms ease,
          background-color 120ms ease;
      }

      .a2ui-choice-card:hover {
        background-color: var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.08));
      }

      .a2ui-choice-card:has(.a2ui-choice-card-button:focus-visible),
      .a2ui-choice-quiet:focus-visible {
        outline: 2px solid var(--a2ui-color-primary, var(--a2ui-tone-active-fg, #0b57d0));
        outline-offset: 2px;
      }

      .a2ui-choice-card[data-checked='true'] {
        border-color: var(--a2ui-tone-active-fg, #185abc);
        background-color: var(--a2ui-tone-active-bg, rgba(26, 115, 232, 0.14));
        box-shadow: inset 0 0 0 1px var(--a2ui-tone-active-fg, #185abc);
      }

      .a2ui-choice-card-button {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        margin: 0;
        padding: 0;
        min-width: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        line-height: inherit;
        text-align: start;
        cursor: pointer;
        outline: none;
      }

      .a2ui-choice-card-check {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        margin-top: 1px;
        border-radius: 50%;
        box-sizing: border-box;
        border: 1.5px solid var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.45));
        color: var(--a2ui-tone-active-fg, #185abc);
      }

      .a2ui-choice-card-button[role='checkbox'] .a2ui-choice-card-check {
        border-radius: 4px;
      }

      .a2ui-choice-card[data-checked='true'] .a2ui-choice-card-check {
        border-color: var(--a2ui-tone-active-fg, #185abc);
        background-color: var(--a2ui-tone-active-fg, #185abc);
        color: var(--a2ui-color-surface, #ffffff);
      }

      .a2ui-choice-check-icon {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }

      .a2ui-choice-card-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1 1 auto;
      }

      .a2ui-choice-card-label {
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      /* Indented past the check so the description lines up under the label. */
      .a2ui-choice-card-description {
        padding-inline-start: 26px;
        font-size: 12px;
        color: var(--a2ui-text-caption-color, #70757a);
        overflow-wrap: anywhere;
      }

      .a2ui-choice-card-description a {
        color: var(--a2ui-color-primary, var(--primary, #0b57d0));
      }

      .a2ui-choice-card-description p {
        margin: 0.25em 0;
      }

      .a2ui-choice-card-description > :first-child {
        margin-top: 0;
      }

      .a2ui-choice-card-description > :last-child {
        margin-bottom: 0;
      }

      .a2ui-choice-card-description code {
        font-size: 0.95em;
      }

      .a2ui-choice-cards-quiet {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 12px;
        padding: 0 2px;
      }

      .a2ui-choice-quiet {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 0;
        padding: 2px 4px;
        border: none;
        border-radius: 4px;
        background: none;
        color: var(--a2ui-text-caption-color, #70757a);
        font: inherit;
        font-size: 12px;
        line-height: inherit;
        cursor: pointer;
      }

      .a2ui-choice-quiet:hover {
        color: var(--a2ui-text-color-text, inherit);
        text-decoration: underline;
      }

      .a2ui-choice-quiet[aria-checked='true'] {
        color: var(--a2ui-tone-active-fg, #185abc);
        font-weight: 600;
      }

      .a2ui-choice-quiet .a2ui-choice-check-icon {
        width: 12px;
        height: 12px;
      }
    `,
  ];

  /** Rendered Markdown per `description` string, so re-renders reuse the same promise. */
  private readonly descriptionCache = new Map<string, Promise<TemplateResult>>();

  static override properties = {
    ...A2uiLitElement.properties,
    focusedIndex: { state: true },
  };

  /** Focus-order index of the option that last received focus, or null before any focus. */
  declare focusedIndex: number | null;

  constructor() {
    super();
    this.focusedIndex = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    syncRowItemMarker(this);
  }

  override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    applyHostWeight(this, this.controller?.props?.weight);
  }

  /** Normalized options from the current props, in declaration order. */
  private get options(): ChoiceCardOption[] {
    return normalizeChoiceCardOptions(this.controller?.props?.options);
  }

  /** Options in focus order: cards first, then quiet toggles. */
  private get orderedOptions(): ChoiceCardOption[] {
    const options = this.options;
    return [...options.filter((o) => !o.quiet), ...options.filter((o) => o.quiet)];
  }

  private get variant(): ChoiceCardsVariant {
    return this.controller?.props?.variant === 'multipleSelection'
      ? 'multipleSelection'
      : 'mutuallyExclusive';
  }

  private get direction(): ChoiceCardsDirection {
    return this.controller?.props?.direction === 'horizontal' ? 'horizontal' : 'vertical';
  }

  /** Currently selected values as strings; non-array `value` counts as empty. */
  private get selectedValues(): string[] {
    const value = this.controller?.props?.value;
    return Array.isArray(value) ? value.map(String) : [];
  }

  /**
   * Focus-order index that holds the roving `tabindex="0"`. In `mutuallyExclusive` mode the
   * checked option wins (Tab lands on the checked radio, per WAI-ARIA), then the last focused
   * option; in `multipleSelection` mode the last focused option wins, then the first checked
   * one. Falls back to the first option.
   */
  private rovingIndex(ordered: ChoiceCardOption[], selected: ReadonlySet<string>): number {
    const checked = ordered.findIndex((o) => selected.has(o.value));
    const focused =
      this.focusedIndex !== null && this.focusedIndex < ordered.length ? this.focusedIndex : -1;
    const preferred =
      this.variant === 'mutuallyExclusive' ? [checked, focused] : [focused, checked];
    return preferred.find((i) => i >= 0) ?? 0;
  }

  /** Writes the selection that results from choosing `value` back to the data model. */
  private choose(value: string): void {
    const props = this.controller?.props;
    if (!props) return;
    props.setValue?.(nextChoiceValue(this.selectedValues, value, this.variant));
  }

  /** Click anywhere on a card chooses it, except on a link inside the description. */
  private handleCardClick(e: Event, value: string): void {
    const target = e.target as Element | null;
    if (target?.closest?.('a')) return;
    this.choose(value);
  }

  private focusOption(index: number): void {
    this.focusedIndex = index;
    this.renderRoot.querySelector<HTMLElement>(`[data-choice-index="${index}"]`)?.focus();
  }

  /**
   * Arrow keys move focus (wrapping) and Home/End jump. In `mutuallyExclusive` mode the newly
   * focused option is selected as well; Space and Enter fall through to the button's native
   * click, which calls `choose`.
   */
  private handleKeydown(e: KeyboardEvent, index: number): void {
    const move = KEY_MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const ordered = this.orderedOptions;
    if (ordered.length === 0) return;
    const target = moveFocusIndex(index, ordered.length, move);
    this.focusOption(target);
    if (this.variant === 'mutuallyExclusive') this.choose(ordered[target].value);
  }

  private renderCheckIcon(): TemplateResult {
    return html`
      <svg class="a2ui-choice-check-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d=${ICON_SVG_PATHS.check}></path>
      </svg>
    `;
  }

  private renderBadge(option: ChoiceCardOption): TemplateResult | typeof nothing {
    if (!option.badge) return nothing;
    const tone: StatusTone = normalizeStatusTone(option.tone);
    return html`
      <span class="a2ui-badge" data-tone=${tone}>
        <span class="a2ui-badge-text">${option.badge}</span>
      </span>
    `;
  }

  /** Markdown description rendered through `renderRichMarkdown`, with the raw text as a placeholder. */
  private renderDescription(description: string, id: string): TemplateResult {
    let rendered = this.descriptionCache.get(description);
    if (!rendered) {
      rendered = renderRichMarkdown(description).then((markup) => html`${unsafeHTML(markup)}`);
      this.descriptionCache.set(description, rendered);
    }
    return html`
      <div class="a2ui-choice-card-description" id=${id}>${until(rendered, description)}</div>
    `;
  }

  private renderCard(option: ChoiceCardOption, state: ChoiceItemState): TemplateResult {
    const { index, checked, focusable, role } = state;
    const descriptionId = option.description ? `a2ui-choice-desc-${index}` : undefined;
    return html`
      <div
        class="a2ui-choice-card"
        data-checked=${checked ? 'true' : 'false'}
        data-value=${option.value}
        @click=${(e: Event) => this.handleCardClick(e, option.value)}
      >
        <button
          type="button"
          class="a2ui-choice-card-button"
          role=${role}
          aria-checked=${checked ? 'true' : 'false'}
          aria-describedby=${descriptionId ?? nothing}
          tabindex=${focusable ? '0' : '-1'}
          data-choice-index=${index}
          @focus=${() => (this.focusedIndex = index)}
          @keydown=${(e: KeyboardEvent) => this.handleKeydown(e, index)}
        >
          <span class="a2ui-choice-card-check" aria-hidden="true">
            ${checked ? this.renderCheckIcon() : nothing}
          </span>
          <span class="a2ui-choice-card-head">
            <span class="a2ui-choice-card-label">${option.label}</span>
            ${this.renderBadge(option)}
          </span>
        </button>
        ${descriptionId ? this.renderDescription(option.description!, descriptionId) : nothing}
      </div>
    `;
  }

  private renderQuiet(option: ChoiceCardOption, state: ChoiceItemState): TemplateResult {
    const { index, checked, focusable, role } = state;
    return html`
      <button
        type="button"
        class="a2ui-choice-quiet"
        role=${role}
        aria-checked=${checked ? 'true' : 'false'}
        tabindex=${focusable ? '0' : '-1'}
        data-value=${option.value}
        data-choice-index=${index}
        title=${option.description ?? nothing}
        @focus=${() => (this.focusedIndex = index)}
        @click=${() => this.choose(option.value)}
        @keydown=${(e: KeyboardEvent) => this.handleKeydown(e, index)}
      >
        ${checked ? this.renderCheckIcon() : nothing}
        <span class="a2ui-choice-quiet-label">${option.label}</span>
      </button>
    `;
  }

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const ordered = this.orderedOptions;
    const selected = new Set(this.selectedValues);
    const multiple = this.variant === 'multipleSelection';
    const role = multiple ? 'checkbox' : 'radio';
    const direction = this.direction;
    const focusIndex = this.rovingIndex(ordered, selected);
    const ariaLabel = props.accessibility?.label || 'Choices';
    const cards = ordered.filter((o) => !o.quiet);
    const quiet = ordered.filter((o) => o.quiet);
    const stateAt = (option: ChoiceCardOption, index: number): ChoiceItemState => ({
      index,
      role,
      checked: selected.has(option.value),
      focusable: index === focusIndex,
    });

    return html`
      <div
        class="a2ui-choice-cards a2ui-choice-cards--${direction}"
        data-direction=${direction}
        data-variant=${this.variant}
        role=${multiple ? 'group' : 'radiogroup'}
        aria-label=${ariaLabel}
        aria-description=${props.accessibility?.description ?? nothing}
      >
        <div class="a2ui-choice-cards-list">
          ${cards.map((o, i) => this.renderCard(o, stateAt(o, i)))}
        </div>
        ${
          quiet.length > 0
            ? html`
                <div class="a2ui-choice-cards-quiet">
                  ${quiet.map((o, i) => this.renderQuiet(o, stateAt(o, cards.length + i)))}
                </div>
              `
            : nothing
        }
      </div>
    `;
  }
}
