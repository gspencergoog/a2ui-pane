import { html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import {
  A2uiBadgeElement,
  applyHostWeight,
  normalizeStatusTone,
  type StatusTone,
} from './a2ui-badge.js';
import { A2uiProgressBarElement, computeProgressSegments } from './a2ui-progress-bar.js';
import { resolveIconSvgPath } from './icon-paths.js';

/** Allowed `kind` values for a `Table` column. */
export const TABLE_COLUMN_KINDS = [
  'text',
  'badge',
  'link',
  'progress',
  'check',
  'icon',
  'number',
] as const;

/** Union type of supported `Table` column kinds. */
export type TableColumnKind = (typeof TABLE_COLUMN_KINDS)[number];

/** Allowed horizontal alignments for a `Table` column. */
export type TableColumnAlign = 'start' | 'center' | 'end';

/** A static column definition from `Table.columns`. */
export interface TableColumn {
  key: string;
  label: string;
  kind?: TableColumnKind;
  align?: TableColumnAlign;
  width?: string;
}

/** A single data row: an object keyed by column `key`. */
export type TableRow = Record<string, unknown>;

/** Resolved runtime properties passed to `A2uiTableElement` by `GenericBinder`. */
export interface TableResolvedProps {
  columns?: unknown;
  rows?: unknown;
  caption?: string;
  sortable?: boolean;
  dense?: boolean;
  selected?: number | null;
  setSelected?: (value: number | null) => void;
  action?: () => Promise<void>;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

/** Sort direction applied to the active sort column. */
export type TableSortDirection = 'asc' | 'desc';

/** A row paired with its index in the original `rows` array. */
export interface TableIndexedRow {
  row: TableRow;
  index: number;
}

const KIND_SET: ReadonlySet<string> = new Set(TABLE_COLUMN_KINDS);
const ALIGN_SET: ReadonlySet<string> = new Set(['start', 'center', 'end']);
const HTTP_URL_RE = /^https?:\/\//i;

/** Default `min-width` of the first column when it has no `width` hint. */
const FIRST_COLUMN_MIN_WIDTH = '10ch';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumOrUndefined<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined;
}

function normalizeTableColumn(entry: unknown): TableColumn | undefined {
  if (!isRecord(entry) || typeof entry.key !== 'string') return undefined;
  return {
    key: entry.key,
    label: typeof entry.label === 'string' ? entry.label : entry.key,
    kind: enumOrUndefined<TableColumnKind>(entry.kind, KIND_SET) ?? 'text',
    align: enumOrUndefined<TableColumnAlign>(entry.align, ALIGN_SET),
    width: typeof entry.width === 'string' ? entry.width : undefined,
  };
}

/**
 * Normalizes an arbitrary `columns` value into well-formed `TableColumn` entries.
 * Entries without a string `key` are dropped; unknown kinds fall back to `'text'`.
 */
export function normalizeTableColumns(value: unknown): TableColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => normalizeTableColumn(entry) ?? []);
}

/** Normalizes an arbitrary `rows` value into an array of row objects, skipping non-objects. */
export function normalizeTableRows(value: unknown): TableRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function textOf(value: unknown): string {
  return String((isRecord(value) ? value.text : value) ?? '');
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? Number.NaN);
}

const SORT_VALUE_BY_KIND: Record<TableColumnKind, (value: unknown) => number | string> = {
  number: numberOf,
  progress: (value) => Number((isRecord(value) ? value.value : value) ?? 0),
  check: (value) => (value === true ? 1 : 0),
  badge: textOf,
  link: textOf,
  icon: textOf,
  text: (value) => (typeof value === 'number' ? value : textOf(value)),
};

/**
 * Returns the primitive used to sort a cell of the given kind: numbers for `number`,
 * `progress`, and `check` cells, and the visible text for everything else.
 */
export function tableSortValue(kind: TableColumnKind, value: unknown): number | string {
  return (SORT_VALUE_BY_KIND[kind] ?? SORT_VALUE_BY_KIND.text)(value);
}

function compareSortValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Rows whose sort value is `NaN` (missing or non-numeric cells) sort last in both directions. */
function isMissingSortValue(value: number | string): boolean {
  return typeof value === 'number' && Number.isNaN(value);
}

function compareIndexedRows(
  a: TableIndexedRow,
  b: TableIndexedRow,
  column: TableColumn,
  sign: 1 | -1,
): number {
  const kind = column.kind ?? 'text';
  const av = tableSortValue(kind, a.row[column.key]);
  const bv = tableSortValue(kind, b.row[column.key]);
  const missing = Number(isMissingSortValue(av)) - Number(isMissingSortValue(bv));
  if (missing !== 0) return missing;
  const cmp = compareSortValues(av, bv) * sign;
  return cmp !== 0 ? cmp : a.index - b.index;
}

/**
 * Stable-sorts `rows` by the given column, keeping each row's original index.
 * Returns the rows in input order when `column` is undefined.
 */
export function sortTableRows(
  rows: TableRow[],
  column: TableColumn | undefined,
  direction: TableSortDirection,
): TableIndexedRow[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  if (!column) return indexed;
  const sign = direction === 'desc' ? -1 : 1;
  return indexed.sort((a, b) => compareIndexedRows(a, b, column, sign));
}

/**
 * Typed-cell grid Web Component (`<a2ui-table>`) for the A2UI v1.0 Status Catalog.
 *
 * Columns are static definitions; rows are data-bound objects. Supports client-side
 * sorting on header click, a two-way `selected` row index, and `action` dispatch on row click.
 */
export class A2uiTableElement extends A2uiLitElement<any, TableResolvedProps> {
  static tagName = 'a2ui-table';

  static override properties = {
    ...A2uiLitElement.properties,
    sortKey: { state: true },
    sortDir: { state: true },
  };

  declare sortKey: string | null;
  declare sortDir: TableSortDirection;

  /**
   * Badge and ProgressBar styles are reused so `badge` and `progress` cells render with the
   * same markup and tone variables as the standalone components. The table's own `:host`
   * rule comes last so it wins over the inline-flex host rule from the badge sheet.
   */
  static override styles = [
    A2uiBadgeElement.styles,
    A2uiProgressBarElement.styles,
    css`
      :host {
        display: block;
        min-width: 0;
        max-width: 100%;
        align-self: stretch;
        flex-shrink: 1;
        box-sizing: border-box;
      }

      .a2ui-table-container {
        width: 100%;
        padding-inline-end: var(--a2ui-table-close-clearance, 0px);
        box-sizing: border-box;
      }

      /* Horizontal scroll is the fallback when columns cannot shrink any further. */
      .a2ui-table-scroll {
        max-width: 100%;
        overflow-x: auto;
      }

      .a2ui-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: auto;
        font-size: var(--a2ui-font-size-s, 13px);
        line-height: 1.35;
        color: var(--a2ui-text-color-text, inherit);
      }

      .a2ui-table caption {
        text-align: start;
        caption-side: top;
        padding: 0 0 6px;
        font-size: 13.5px;
        font-weight: 600;
      }

      .a2ui-table th,
      .a2ui-table td {
        padding: 6px 8px;
        text-align: start;
        vertical-align: middle;
        overflow-wrap: anywhere;
        border-bottom: 1px solid var(--a2ui-tone-neutral-border, rgba(128, 128, 128, 0.22));
      }

      .a2ui-table[data-dense] th,
      .a2ui-table[data-dense] td {
        padding: 4px;
      }

      .a2ui-table thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background-color: var(--a2ui-color-surface, #ffffff);
        font-size: 12px;
        font-weight: 600;
        color: var(--a2ui-text-caption-color, #70757a);
        white-space: nowrap;
        user-select: none;
      }

      .a2ui-table thead th[data-sortable] {
        cursor: pointer;
      }

      .a2ui-table thead th[data-sortable]:hover,
      .a2ui-table thead th[data-sortable]:focus-visible {
        color: var(--a2ui-text-color-text, inherit);
      }

      .a2ui-table thead th[aria-sort='ascending']::after {
        content: ' \\2191';
      }

      .a2ui-table thead th[aria-sort='descending']::after {
        content: ' \\2193';
      }

      .a2ui-table tbody tr:last-child td {
        border-bottom: none;
      }

      .a2ui-table tbody tr[data-interactive] {
        cursor: pointer;
      }

      .a2ui-table tbody tr[data-interactive]:hover,
      .a2ui-table tbody tr[data-interactive]:focus-visible {
        background-color: var(--a2ui-tone-neutral-bg, rgba(128, 128, 128, 0.1));
        outline: none;
      }

      .a2ui-table tbody tr[aria-selected='true'] {
        background-color: var(--a2ui-tone-active-bg, rgba(26, 115, 232, 0.14));
      }

      .a2ui-table [data-align='center'] {
        text-align: center;
      }

      .a2ui-table [data-align='end'] {
        text-align: end;
      }

      .a2ui-table td[data-kind='number'] {
        font-variant-numeric: tabular-nums;
      }

      /* Long badge text wraps inside the pill instead of widening the column. */
      .a2ui-table td[data-kind='badge'] .a2ui-badge {
        white-space: normal;
        overflow-wrap: anywhere;
      }

      .a2ui-table td[data-kind='progress'] {
        min-width: 72px;
      }

      .a2ui-table td[data-kind='progress'] .a2ui-progress-track {
        min-width: 56px;
      }

      .a2ui-table a,
      .a2ui-table [data-a2ui-href] {
        color: var(--a2ui-color-primary, var(--primary, #0b57d0));
        text-decoration: none;
        cursor: pointer;
      }

      .a2ui-table a:hover,
      .a2ui-table a:focus-visible,
      .a2ui-table [data-a2ui-href]:hover,
      .a2ui-table [data-a2ui-href]:focus-visible {
        text-decoration: underline;
      }

      .a2ui-table-icon {
        width: 16px;
        height: 16px;
        vertical-align: middle;
        fill: currentColor;
      }

      .a2ui-table-check[data-checked='true'] {
        color: var(--a2ui-tone-success-fg, #137333);
      }

      .a2ui-table-check[data-checked='false'] {
        color: var(--a2ui-text-caption-color, #70757a);
        opacity: 0.7;
      }

      .a2ui-table-empty {
        padding: 10px 8px;
        text-align: center;
        color: var(--a2ui-text-caption-color, #70757a);
      }
    `,
  ];

  constructor() {
    super();
    this.sortKey = null;
    this.sortDir = 'asc';
  }

  override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    applyHostWeight(this, this.controller?.props?.weight);
  }

  /** Toggles the sort direction for `key`, or starts an ascending sort on a new column. */
  private toggleSort(key: string): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      return;
    }
    this.sortKey = key;
    this.sortDir = 'asc';
  }

  /** Writes the clicked row's original index to `selected` and dispatches `action` when set. */
  private activateRow(props: TableResolvedProps, index: number): void {
    props.setSelected?.(index);
    if (typeof props.action === 'function') {
      void props.action();
    }
  }

  private handleRowKeydown(e: KeyboardEvent, props: TableResolvedProps, index: number): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.activateRow(props, index);
    }
  }

  private handleHeaderKeydown(e: KeyboardEvent, key: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.toggleSort(key);
    }
  }

  /** Rows in display order: sorted by the active column when `sortable`, input order otherwise. */
  private sortedRows(props: TableResolvedProps, columns: TableColumn[]): TableIndexedRow[] {
    const rows = normalizeTableRows(props.rows);
    if (props.sortable !== true || this.sortKey === null) {
      return sortTableRows(rows, undefined, 'asc');
    }
    const column = columns.find((c) => c.key === this.sortKey);
    return sortTableRows(rows, column, this.sortDir);
  }

  private renderBadgeCell(value: unknown): TemplateResult {
    const text = isRecord(value) ? String(value.text ?? '') : String(value ?? '');
    const tone: StatusTone = normalizeStatusTone(isRecord(value) ? value.tone : undefined);
    return html`
      <span class="a2ui-badge" data-tone=${tone} role="status">
        <span class="a2ui-badge-text">${text}</span>
      </span>
    `;
  }

  private renderLinkCell(value: unknown): TemplateResult | typeof nothing {
    const url = isRecord(value) ? String(value.url ?? '') : String(value ?? '');
    if (!url) return nothing;
    const text = isRecord(value) && value.text !== undefined ? String(value.text) : url;
    if (HTTP_URL_RE.test(url)) {
      return html`<a href=${url} rel="noopener noreferrer">${text}</a>`;
    }
    return html`<a data-a2ui-href=${url} role="link" tabindex="0">${text}</a>`;
  }

  private renderProgressCell(value: unknown): TemplateResult {
    const current = isRecord(value) ? Number(value.value ?? 0) : Number(value ?? 0);
    const max = isRecord(value) && value.max !== undefined ? Number(value.max) : 100;
    const { segments, defaultSummary, total } = computeProgressSegments({ value: current, max });
    return html`
      <div
        class="a2ui-progress-track"
        role="progressbar"
        aria-label=${defaultSummary ?? ''}
        aria-valuemin="0"
        aria-valuemax=${String(total || 100)}
        aria-valuenow=${String(current)}
        title=${defaultSummary ?? nothing}
      >
        ${segments.map(
          (seg) => html`
            <div
              class="a2ui-progress-segment"
              data-tone=${seg.tone}
              style=${`width: ${seg.widthPercent.toFixed(2)}%;`}
            ></div>
          `,
        )}
      </div>
    `;
  }

  private renderIconSvg(name: string, className: string): TemplateResult | typeof nothing {
    const path = resolveIconSvgPath(name);
    if (!path) return nothing;
    return html`
      <svg class=${className} data-icon=${name} viewBox="0 0 24 24" aria-hidden="true">
        <path d=${path}></path>
      </svg>
    `;
  }

  private renderCheckCell(value: unknown): TemplateResult {
    const checked = value === true;
    return html`
      <span
        class="a2ui-table-check"
        data-checked=${checked ? 'true' : 'false'}
        role="img"
        aria-label=${checked ? 'yes' : 'no'}
      >
        ${this.renderIconSvg(checked ? 'check' : 'close', 'a2ui-table-icon')}
      </span>
    `;
  }

  private renderIconCell(value: unknown): TemplateResult | typeof nothing {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return nothing;
    return this.renderIconSvg(name, 'a2ui-table-icon');
  }

  private renderTextCell(value: unknown): TemplateResult | typeof nothing {
    if (value === undefined || value === null) return nothing;
    return html`${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
  }

  /**
   * Renders the content of one cell by column kind; missing keys render an empty cell.
   *
   * Badge and progress cells deliberately do not nest `<a2ui-badge>` or `<a2ui-progress-bar>`
   * elements: an `A2uiLitElement` without an A2UI controller (no `context` from a surface)
   * returns early from `update()` and renders nothing. The helpers below emit the same inner
   * markup those components render, and `static styles` adopts their stylesheets, so the DOM
   * and tone variables match the standalone components.
   */
  private renderCell(column: TableColumn, row: TableRow): TemplateResult | typeof nothing {
    const value = row[column.key];
    if (value === undefined || value === null) return nothing;
    switch (column.kind) {
      case 'badge':
        return this.renderBadgeCell(value);
      case 'link':
        return this.renderLinkCell(value);
      case 'progress':
        return this.renderProgressCell(value);
      case 'check':
        return this.renderCheckCell(value);
      case 'icon':
        return this.renderIconCell(value);
      case 'number':
      case 'text':
      default:
        return this.renderTextCell(value);
    }
  }

  private alignFor(column: TableColumn): TableColumnAlign | undefined {
    if (column.align) return column.align;
    if (column.kind === 'number') return 'end';
    if (column.kind === 'check' || column.kind === 'icon') return 'center';
    return undefined;
  }

  /**
   * Inline style for a header or body cell of `column`. A `width` hint always wins; without
   * one, the first column gets `min-width: 10ch` so row labels do not collapse to one word
   * per line when badge cells wrap.
   */
  private columnStyle(column: TableColumn, index: number): string | typeof nothing {
    if (column.width) return `width: ${column.width};`;
    return index === 0 ? `min-width: ${FIRST_COLUMN_MIN_WIDTH};` : nothing;
  }

  private renderHeader(column: TableColumn, index: number, sortable: boolean): TemplateResult {
    const active = sortable && this.sortKey === column.key;
    const ariaSort = active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : nothing;
    return html`
      <th
        scope="col"
        data-key=${column.key}
        data-align=${this.alignFor(column) ?? nothing}
        data-sortable=${sortable ? '' : nothing}
        aria-sort=${ariaSort}
        tabindex=${sortable ? '0' : nothing}
        style=${this.columnStyle(column, index)}
        @click=${sortable ? () => this.toggleSort(column.key) : nothing}
        @keydown=${sortable ? (e: KeyboardEvent) => this.handleHeaderKeydown(e, column.key) : nothing}
      >
        ${column.label}
      </th>
    `;
  }

  private renderRow(
    props: TableResolvedProps,
    columns: TableColumn[],
    entry: TableIndexedRow,
    interactive: boolean,
  ): TemplateResult {
    const selected = props.selected === entry.index;
    return html`
      <tr
        data-index=${entry.index}
        data-interactive=${interactive ? '' : nothing}
        aria-selected=${selected ? 'true' : 'false'}
        tabindex=${interactive ? '0' : nothing}
        @click=${() => this.activateRow(props, entry.index)}
        @keydown=${(e: KeyboardEvent) => this.handleRowKeydown(e, props, entry.index)}
      >
        ${columns.map(
          (column, index) => html`
            <td
              data-key=${column.key}
              data-kind=${column.kind ?? 'text'}
              data-align=${this.alignFor(column) ?? nothing}
              style=${this.columnStyle(column, index)}
            >
              ${this.renderCell(column, entry.row)}
            </td>
          `,
        )}
      </tr>
    `;
  }

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const columns = normalizeTableColumns(props.columns);
    const rows = this.sortedRows(props, columns);
    const sortable = props.sortable === true;
    const interactive =
      typeof props.action === 'function' ||
      (props.selected !== undefined && props.selected !== null);
    const ariaLabel = props.accessibility?.label || props.caption || 'Table';

    return html`
      <div class="a2ui-table-container">
        <div class="a2ui-table-scroll">
          <table
            class="a2ui-table"
            part="table"
            data-dense=${props.dense === true ? '' : nothing}
            aria-label=${ariaLabel}
            aria-description=${props.accessibility?.description ?? nothing}
          >
            ${
              props.caption
                ? html`<caption>
                    ${props.caption}
                  </caption>`
                : nothing
            }
            <thead>
              <tr>
                ${columns.map((column, index) => this.renderHeader(column, index, sortable))}
              </tr>
            </thead>
            <tbody>
              ${rows.map((entry) => this.renderRow(props, columns, entry, interactive))}
            </tbody>
          </table>
        </div>
        ${rows.length === 0 ? html`<div class="a2ui-table-empty">No rows</div>` : nothing}
      </div>
    `;
  }
}
