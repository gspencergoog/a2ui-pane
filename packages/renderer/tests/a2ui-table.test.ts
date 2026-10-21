import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import HTMLElementConfig from 'happy-dom/lib/config/HTMLElementConfig.js';
import {
  A2uiPaneView,
  createProcessor,
  STATUS_CATALOG_ID,
  TableApi,
  TableColumnSchema,
  normalizeTableColumns,
  normalizeTableRows,
  sortTableRows,
  tableSortValue,
  type TableColumn,
} from '../src/index.js';
import type { A2uiActionDetails } from '@a2ui-pane/protocol';

// Lit prepares each sub-template (`html\`<tr>...</tr>\``) by parsing it inside a detached
// <template>. Browsers keep table parts there ("in template" insertion mode), but happy-dom
// 17 drops <tr>, <th>, and <td> whose parent is not a table section, which makes Lit throw
// "Detected duplicate attribute bindings". Relax that rule for this file only.
for (const tag of ['tr', 'th', 'td'] as const) {
  delete (HTMLElementConfig as Record<string, { permittedParents?: string[] }>)[tag]
    .permittedParents;
}

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'state', label: 'State', kind: 'badge' },
  { key: 'pr', label: 'PR', kind: 'link' },
  { key: 'pct', label: 'Progress', kind: 'progress' },
  { key: 'ok', label: 'CI', kind: 'check' },
  { key: 'icon', label: 'Icon', kind: 'icon' },
  { key: 'count', label: 'Count', kind: 'number' },
];

const ROWS = [
  {
    name: 'bravo',
    state: { text: 'Merged', tone: 'success' },
    pr: { text: 'PR 1', url: 'https://example.com/pr/1' },
    pct: { value: 3, max: 4 },
    ok: true,
    icon: 'check',
    count: 20,
  },
  {
    name: 'alpha',
    state: 'Queued',
    pr: { text: 'file', url: 'file:///tmp/notes.md' },
    pct: { value: 1, max: 4 },
    ok: false,
    count: 3,
  },
  {
    name: 'charlie',
    state: { text: 'Failing', tone: 'danger' },
    count: 100,
  },
];

interface TableSurfaceOptions {
  columns?: unknown[];
  rows?: unknown;
  sortable?: boolean;
  dense?: boolean;
  withSelection?: boolean;
  withAction?: boolean;
  caption?: string;
  weight?: number;
}

function tableMessages(surfaceId: string, opts: TableSurfaceOptions) {
  const table: Record<string, unknown> = {
    id: 'grid',
    component: 'Table',
    catalogId: STATUS_CATALOG_ID,
    columns: opts.columns ?? COLUMNS,
    rows: { '@path': '/rows' },
  };
  if (opts.caption) table.caption = opts.caption;
  if (opts.weight !== undefined) table.weight = opts.weight;
  if (opts.sortable !== undefined) table.sortable = opts.sortable;
  if (opts.dense !== undefined) table.dense = opts.dense;
  if (opts.withSelection) table.selected = { '@path': '/picked' };
  if (opts.withAction) {
    table.action = { event: { name: 'pick_row', context: { picked: { '@path': '/picked' } } } };
  }
  return [
    { version: 'v1.0', createSurface: { surfaceId, sendDataModel: true } },
    {
      version: 'v1.0',
      updateDataModel: {
        surfaceId,
        path: '/',
        value: { rows: opts.rows ?? ROWS, picked: opts.withSelection ? -1 : undefined },
      },
    },
    {
      version: 'v1.0',
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'root',
            component: 'Column',
            catalogId: BASIC_CATALOG_ID,
            children: ['grid'],
          },
          table,
        ],
      },
    },
  ];
}

describe('Table schema', () => {
  it('accepts three static columns with a $/rows binding and optional props', () => {
    const result = TableApi.schema.safeParse({
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'state', label: 'State', kind: 'badge' },
        { key: 'count', label: 'Count', kind: 'number', align: 'end', width: '8ch' },
      ],
      rows: { '@path': '/rows' },
      caption: 'CLs',
      sortable: true,
      dense: { '@path': '/dense' },
      selected: { '@path': '/picked' },
      action: { event: { name: 'pick_row' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a static array of row objects', () => {
    const result = TableApi.schema.safeParse({
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ name: 'a' }, { name: 'b', extra: 1 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown column kind and unknown table properties', () => {
    expect(TableColumnSchema.safeParse({ key: 'x', label: 'X', kind: 'emoji' }).success).toBe(
      false,
    );
    expect(
      TableApi.schema.safeParse({
        columns: [{ key: 'x', label: 'X', kind: 'emoji' }],
        rows: { '@path': '/rows' },
      }).success,
    ).toBe(false);
    expect(
      TableApi.schema.safeParse({
        columns: [{ key: 'x', label: 'X' }],
        rows: { '@path': '/rows' },
        striped: true,
      }).success,
    ).toBe(false);
  });
});

describe('Table helpers', () => {
  it('normalizes columns and rows, dropping malformed entries', () => {
    const columns = normalizeTableColumns([
      { key: 'a', label: 'A', kind: 'badge', align: 'center', width: '10ch' },
      { key: 'b' },
      { key: 'c', label: 'C', kind: 'bogus', align: 'sideways' },
      { label: 'no key' },
      'not an object',
    ]);
    expect(columns).toEqual([
      { key: 'a', label: 'A', kind: 'badge', align: 'center', width: '10ch' },
      { key: 'b', label: 'b', kind: 'text', align: undefined, width: undefined },
      { key: 'c', label: 'C', kind: 'text', align: undefined, width: undefined },
    ]);
    expect(normalizeTableColumns('nope')).toEqual([]);
    expect(normalizeTableRows([{ a: 1 }, null, 'x', [1], { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(normalizeTableRows(undefined)).toEqual([]);
  });

  it('derives sort values per kind and sorts stably', () => {
    expect(tableSortValue('number', '7')).toBe(7);
    expect(tableSortValue('progress', { value: 2, max: 5 })).toBe(2);
    expect(tableSortValue('check', true)).toBe(1);
    expect(tableSortValue('check', 'yes')).toBe(0);
    expect(tableSortValue('badge', { text: 'Merged', tone: 'success' })).toBe('Merged');
    expect(tableSortValue('link', 'plain')).toBe('plain');
    expect(tableSortValue('text', 42)).toBe(42);
    expect(tableSortValue('text', undefined)).toBe('');

    const rows = [{ n: 2, k: 'x' }, { n: 1, k: 'y' }, { n: 2, k: 'z' }, { k: 'none' }];
    const column: TableColumn = { key: 'n', label: 'N', kind: 'number' };
    const asc = sortTableRows(rows, column, 'asc');
    expect(asc.map((e) => e.index)).toEqual([1, 0, 2, 3]);
    const desc = sortTableRows(rows, column, 'desc');
    expect(desc.map((e) => e.index)).toEqual([0, 2, 1, 3]);
    expect(sortTableRows(rows, undefined, 'asc').map((e) => e.index)).toEqual([0, 1, 2, 3]);

    const text = sortTableRows(
      [{ s: 'item10' }, { s: 'Item2' }, { s: 'item1' }],
      { key: 's', label: 'S', kind: 'text' },
      'asc',
    );
    expect(text.map((e) => e.index)).toEqual([2, 1, 0]);
  });
});

describe('<a2ui-table>', () => {
  let pane: A2uiPaneView;

  beforeEach(() => {
    pane = document.createElement('a2ui-pane-view') as A2uiPaneView;
    document.body.appendChild(pane);
  });

  afterEach(() => {
    pane.remove();
  });

  async function mount(
    surfaceId: string,
    opts: TableSurfaceOptions,
    onAction?: (action: A2uiActionDetails, dataModel?: Record<string, unknown>) => void,
  ) {
    const processor = createProcessor(onAction);
    processor.processMessages(tableMessages(surfaceId, opts) as any);
    pane.processor = processor;
    await pane.updateComplete;
    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    for (const col of Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-column'))) {
      await (col as any).updateComplete;
    }
    const tableEl = surfaceEl.shadowRoot!.querySelector('a2ui-table')!;
    expect(tableEl).not.toBeNull();
    await (tableEl as any).updateComplete;
    return { processor, tableEl, root: tableEl.shadowRoot! };
  }

  function bodyRows(root: ShadowRoot): HTMLTableRowElement[] {
    return Array.from(root.querySelectorAll('tbody tr'));
  }

  function firstCellTexts(root: ShadowRoot): string[] {
    return bodyRows(root).map((tr) => tr.querySelector('td')!.textContent!.trim());
  }

  it('renders a caption, one header per column, and one row per data row', async () => {
    const { root, tableEl } = await mount('tableBasic', { caption: 'Pending CLs', dense: true });
    expect(root.querySelector('caption')?.textContent?.trim()).toBe('Pending CLs');
    expect(root.querySelectorAll('thead th')).toHaveLength(COLUMNS.length);
    expect(bodyRows(root)).toHaveLength(ROWS.length);
    expect(root.querySelector('table')!.hasAttribute('data-dense')).toBe(true);
    expect(firstCellTexts(root)).toEqual(['bravo', 'alpha', 'charlie']);
    expect((tableEl as HTMLElement).style.flex).toBe('');
  });

  it('applies weight as flex on the host element', async () => {
    const { tableEl } = await mount('tableWeight', { weight: 2 });
    expect((tableEl as HTMLElement).style.flexGrow).toBe('2');
  });

  it('renders typed cells: badge, link, progress, check, icon, and number', async () => {
    const { root } = await mount('tableCells', {});
    const [first, second] = bodyRows(root);

    const badge = first.querySelector('td[data-kind="badge"] .a2ui-badge')!;
    expect(badge.getAttribute('data-tone')).toBe('success');
    expect(badge.textContent?.trim()).toBe('Merged');
    const plainBadge = second.querySelector('td[data-kind="badge"] .a2ui-badge')!;
    expect(plainBadge.getAttribute('data-tone')).toBe('neutral');
    expect(plainBadge.textContent?.trim()).toBe('Queued');

    const httpLink = first.querySelector('td[data-kind="link"] a')!;
    expect(httpLink.getAttribute('href')).toBe('https://example.com/pr/1');
    expect(httpLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(httpLink.textContent?.trim()).toBe('PR 1');
    const fileLink = second.querySelector('td[data-kind="link"] a')!;
    expect(fileLink.hasAttribute('href')).toBe(false);
    expect(fileLink.getAttribute('data-a2ui-href')).toBe('file:///tmp/notes.md');

    const track = first.querySelector('td[data-kind="progress"] .a2ui-progress-track')!;
    expect(track.getAttribute('aria-valuenow')).toBe('3');
    expect(track.getAttribute('aria-valuemax')).toBe('4');
    expect(track.querySelector('.a2ui-progress-segment')?.getAttribute('data-tone')).toBe('active');

    expect(
      first.querySelector('td[data-kind="check"] .a2ui-table-check')?.getAttribute('data-checked'),
    ).toBe('true');
    expect(first.querySelector('td[data-kind="check"] svg')?.getAttribute('data-icon')).toBe(
      'check',
    );
    expect(second.querySelector('td[data-kind="check"] svg')?.getAttribute('data-icon')).toBe(
      'close',
    );

    expect(first.querySelector('td[data-kind="icon"] svg')?.getAttribute('data-icon')).toBe(
      'check',
    );

    const number = first.querySelector('td[data-kind="number"]')!;
    expect(number.textContent?.trim()).toBe('20');
    expect(number.getAttribute('data-align')).toBe('end');
  });

  it('renders an empty cell for missing row keys without throwing', async () => {
    const { root } = await mount('tableMissing', {});
    const third = bodyRows(root)[2];
    const cells = Array.from(third.querySelectorAll('td'));
    expect(cells).toHaveLength(COLUMNS.length);
    expect(cells[2].textContent?.trim()).toBe('');
    expect(cells[2].querySelector('a')).toBeNull();
    expect(cells[3].querySelector('.a2ui-progress-track')).toBeNull();
    expect(cells[4].querySelector('svg')).toBeNull();
    expect(cells[5].querySelector('svg')).toBeNull();
  });

  it('toggles sort order on header click when sortable', async () => {
    const { root, tableEl } = await mount('tableSort', { sortable: true });
    const nameHeader = root.querySelector('thead th[data-key="name"]')!;
    expect(nameHeader.hasAttribute('data-sortable')).toBe(true);
    expect(nameHeader.hasAttribute('aria-sort')).toBe(false);

    nameHeader.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(firstCellTexts(root)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(root.querySelector('thead th[data-key="name"]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );

    root
      .querySelector('thead th[data-key="name"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(firstCellTexts(root)).toEqual(['charlie', 'bravo', 'alpha']);
    expect(root.querySelector('thead th[data-key="name"]')?.getAttribute('aria-sort')).toBe(
      'descending',
    );

    // Keyboard activation on a numeric column sorts numerically, ascending.
    root
      .querySelector('thead th[data-key="count"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(firstCellTexts(root)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(root.querySelector('thead th[data-key="name"]')?.hasAttribute('aria-sort')).toBe(false);
    expect(root.querySelector('thead th[data-key="count"]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
  });

  it('ignores header clicks when sortable is false', async () => {
    const { root, tableEl } = await mount('tableNoSort', { sortable: false });
    const nameHeader = root.querySelector('thead th[data-key="name"]')!;
    expect(nameHeader.hasAttribute('data-sortable')).toBe(false);
    nameHeader.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(firstCellTexts(root)).toEqual(['bravo', 'alpha', 'charlie']);
    expect(root.querySelector('thead th[aria-sort]')).toBeNull();
  });

  it('writes the clicked row index to selected and dispatches the action', async () => {
    const actions: Array<{ action: A2uiActionDetails; dataModel?: Record<string, unknown> }> = [];
    const { root, tableEl } = await mount(
      'tableSelect',
      { withSelection: true, withAction: true, sortable: true },
      (action, dataModel) => actions.push({ action, dataModel }),
    );
    const rows = bodyRows(root);
    expect(rows.every((tr) => tr.hasAttribute('data-interactive'))).toBe(true);
    expect(rows.every((tr) => tr.getAttribute('aria-selected') === 'false')).toBe(true);

    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(actions).toHaveLength(1);
    expect(actions[0].action.name).toBe('pick_row');
    expect((actions[0].dataModel as any)?.surfaces?.tableSelect?.picked).toBe(1);
    expect(bodyRows(root)[1].getAttribute('aria-selected')).toBe('true');
    expect(bodyRows(root)[0].getAttribute('aria-selected')).toBe('false');

    // Sorting keeps the selection attached to the original row index.
    root
      .querySelector('thead th[data-key="name"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    const sorted = bodyRows(root);
    expect(sorted[0].querySelector('td')?.textContent?.trim()).toBe('alpha');
    expect(sorted[0].getAttribute('aria-selected')).toBe('true');

    sorted[2].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    await (tableEl as any).updateComplete;
    expect(actions).toHaveLength(2);
    expect((actions[1].dataModel as any)?.surfaces?.tableSelect?.picked).toBe(2);
  });

  it('highlights the selected row without dispatching when no action is set', async () => {
    const actions: A2uiActionDetails[] = [];
    const { root, tableEl, processor } = await mount(
      'tableHighlight',
      { withSelection: true },
      (action) => actions.push(action),
    );
    bodyRows(root)[2].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (tableEl as any).updateComplete;
    expect(actions).toHaveLength(0);
    expect(bodyRows(root)[2].getAttribute('aria-selected')).toBe('true');
    expect(processor.getSurface('tableHighlight')?.dataModel?.get('/picked')).toBe(2);
  });

  it('renders 200 rows and reports the render time', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      name: `row-${i}`,
      state: { text: i % 2 ? 'Open' : 'Merged', tone: i % 2 ? 'active' : 'success' },
      pr: { text: `PR ${i}`, url: `https://example.com/pr/${i}` },
      pct: { value: i % 10, max: 10 },
      ok: i % 3 === 0,
      icon: 'check',
      count: i,
    }));
    const start = performance.now();
    const { root } = await mount('tableLarge', { rows, sortable: true });
    const elapsed = performance.now() - start;
    console.log(`<a2ui-table> rendered 200 rows in ${elapsed.toFixed(1)} ms`);
    expect(bodyRows(root)).toHaveLength(200);
    expect(root.querySelectorAll('tbody .a2ui-badge')).toHaveLength(200);
  });
});
