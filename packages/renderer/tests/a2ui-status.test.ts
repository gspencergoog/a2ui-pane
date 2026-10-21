import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  A2uiPaneView,
  createProcessor,
  STATUS_CATALOG_ID,
  STATUS_TONES,
  normalizeStatusTone,
  computeProgressSegments,
} from '../src/index.js';

describe('status catalog helpers', () => {
  it('normalizes valid tones and falls back to neutral for missing or unknown values', () => {
    for (const tone of STATUS_TONES) {
      expect(normalizeStatusTone(tone)).toBe(tone);
    }
    expect(normalizeStatusTone(undefined)).toBe('neutral');
    expect(normalizeStatusTone(null)).toBe('neutral');
    expect(normalizeStatusTone('unknown-tone')).toBe('neutral');
    expect(normalizeStatusTone(42)).toBe('neutral');
  });

  it('computes progress segments for single value, explicit segments, and tallied items', () => {
    const single = computeProgressSegments({ value: 25, max: 50 });
    expect(single.segments).toEqual([{ value: 25, widthPercent: 50, tone: 'active' }]);
    expect(single.defaultSummary).toBe('50%');

    const complete = computeProgressSegments({ value: 50, max: 50 });
    expect(complete.segments).toEqual([{ value: 50, widthPercent: 100, tone: 'success' }]);
    expect(complete.defaultSummary).toBe('100%');

    const zeroMax = computeProgressSegments({ value: 0, max: 0 });
    expect(zeroMax.segments).toEqual([]);
    expect(zeroMax.total).toBe(0);

    const explicit = computeProgressSegments({
      segments: [
        { value: 2, tone: 'success', label: 'Submitted' },
        { value: 8, tone: 'active', label: 'In review' },
      ],
    });
    expect(explicit.total).toBe(10);
    expect(explicit.segments).toEqual([
      { value: 2, widthPercent: 20, tone: 'success', label: 'Submitted' },
      { value: 8, widthPercent: 80, tone: 'active', label: 'In review' },
    ]);

    const tallied = computeProgressSegments({
      items: [
        { status: 'Submitted', tone: 'success' },
        { status: 'Submitted', tone: 'success' },
        { status: 'Awaiting review', tone: 'active' },
        { status: 'Queued' }, // missing tone -> neutral
      ],
    });
    expect(tallied.total).toBe(4);
    expect(tallied.defaultSummary).toBe('2 / 4 complete · 1 active');
    expect(tallied.segments.map((s) => ({ tone: s.tone, value: s.value }))).toEqual([
      { tone: 'success', value: 2 },
      { tone: 'active', value: 1 },
      { tone: 'neutral', value: 1 },
    ]);

    const emptyItems = computeProgressSegments({ items: [] });
    expect(emptyItems.segments).toEqual([]);
    expect(emptyItems.defaultSummary).toBe('0 items');
  });
});

describe('status catalog Web Components (<a2ui-badge>, <a2ui-progress-bar>, <a2ui-collapsible>)', () => {
  let pane: A2uiPaneView;

  beforeEach(() => {
    pane = document.createElement('a2ui-pane-view') as A2uiPaneView;
    document.body.appendChild(pane);
  });

  afterEach(() => {
    pane.remove();
  });

  it('renders Badge with semantic tones, icon SVG, pulse dot, and neutral fallback', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'badgeSurface',
          sendDataModel: true,
        },
      },
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'badgeSurface',
          path: '/',
          value: {
            items: [
              { status: 'Submitted', tone: 'success' },
              { status: 'Legacy row without tone' },
            ],
          },
        },
      },
      {
        version: 'v1.0',
        updateComponents: {
          surfaceId: 'badgeSurface',
          components: [
            {
              id: 'root',
              component: 'Column',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              children: ['static_badge', 'templated_col'],
            },
            {
              id: 'static_badge',
              component: 'Badge',
              catalogId: STATUS_CATALOG_ID,
              text: 'Awaiting review',
              tone: 'active',
              icon: 'check',
              pulse: true,
            },
            {
              id: 'templated_col',
              component: 'Column',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              children: {
                path: '/items',
                componentId: 'row_badge',
              },
            },
            {
              id: 'row_badge',
              component: 'Badge',
              catalogId: STATUS_CATALOG_ID,
              text: { '@path': 'status' },
              tone: { '@path': 'tone' },
            },
          ],
        },
      },
    ] as any);

    pane.processor = processor;
    await pane.updateComplete;

    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    for (const col of Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-column'))) {
      await (col as any).updateComplete;
    }
    for (const col of Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-column'))) {
      await (col as any).updateComplete;
    }

    const badgeEls = Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-badge'));
    expect(badgeEls).toHaveLength(3);
    for (const el of badgeEls) {
      await (el as any).updateComplete;
    }

    const firstSpan = badgeEls[0].shadowRoot!.querySelector('.a2ui-badge')!;
    expect(firstSpan.getAttribute('data-tone')).toBe('active');
    expect(badgeEls[0].shadowRoot!.querySelector('.a2ui-badge-dot')).not.toBeNull();
    expect(badgeEls[0].shadowRoot!.querySelector('svg.a2ui-badge-icon')).not.toBeNull();
    expect(badgeEls[0].shadowRoot!.querySelector('.a2ui-badge-text')?.textContent).toBe(
      'Awaiting review',
    );

    const secondSpan = badgeEls[1].shadowRoot!.querySelector('.a2ui-badge')!;
    expect(secondSpan.getAttribute('data-tone')).toBe('success');

    const thirdSpan = badgeEls[2].shadowRoot!.querySelector('.a2ui-badge')!;
    expect(thirdSpan.getAttribute('data-tone')).toBe('neutral');
  });

  it('renders ProgressBar from auto-tallied items and indeterminate mode', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'progressSurface',
          sendDataModel: true,
        },
      },
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'progressSurface',
          path: '/',
          value: {
            items: [
              { status: 'Submitted', tone: 'success', label: 'CL 1', detail: 'merged' },
              { status: 'In review', tone: 'active', label: 'CL 2', detail: 'pending' },
              { status: 'Draft', tone: 'warning', label: 'CL 3', detail: 'local' },
            ],
          },
        },
      },
      {
        version: 'v1.0',
        updateComponents: {
          surfaceId: 'progressSurface',
          components: [
            {
              id: 'root',
              component: 'Column',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              children: ['tallied_bar', 'indeterminate_bar'],
            },
            {
              id: 'tallied_bar',
              component: 'ProgressBar',
              catalogId: STATUS_CATALOG_ID,
              items: { '@path': '/items' },
              label: 'Phase 2 CLs',
            },
            {
              id: 'indeterminate_bar',
              component: 'ProgressBar',
              catalogId: STATUS_CATALOG_ID,
              indeterminate: true,
              summary: 'Running TAP...',
            },
          ],
        },
      },
    ] as any);

    pane.processor = processor;
    await pane.updateComplete;

    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;

    const bars = Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-progress-bar'));
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      await (bar as any).updateComplete;
    }

    const segments = bars[0].shadowRoot!.querySelectorAll('.a2ui-progress-segment');
    expect(segments).toHaveLength(3);
    expect(segments[0].getAttribute('data-tone')).toBe('success');
    expect(segments[1].getAttribute('data-tone')).toBe('active');
    expect(segments[2].getAttribute('data-tone')).toBe('warning');
    expect(bars[0].shadowRoot!.querySelector('.a2ui-progress-summary')?.textContent).toBe(
      '1 / 3 complete · 1 active',
    );
    const track0 = bars[0].shadowRoot!.querySelector('.a2ui-progress-track')!;
    expect(track0.getAttribute('aria-valuenow')).toBe('1');
    expect(track0.getAttribute('aria-valuemax')).toBe('3');

    expect(bars[1].shadowRoot!.querySelector('.a2ui-progress-indeterminate')).not.toBeNull();
  });

  it('renders Collapsible with badge and child slots and toggles via click and keyboard', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'collapsibleSurface',
          sendDataModel: true,
        },
      },
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'collapsibleSurface',
          path: '/',
          value: {
            expanded: false,
          },
        },
      },
      {
        version: 'v1.0',
        updateComponents: {
          surfaceId: 'collapsibleSurface',
          components: [
            {
              id: 'root',
              component: 'Collapsible',
              catalogId: STATUS_CATALOG_ID,
              title: 'Submitted CLs',
              summary: '2 merged',
              badge: 'header_badge',
              child: 'inner_text',
              open: { '@path': '/expanded' },
            },
            {
              id: 'header_badge',
              component: 'Badge',
              catalogId: STATUS_CATALOG_ID,
              text: '100%',
              tone: 'success',
            },
            {
              id: 'inner_text',
              component: 'Text',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              text: 'cl/1002512025 and cl/1002515061',
            },
          ],
        },
      },
    ] as any);

    pane.processor = processor;
    await pane.updateComplete;

    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;

    const collapsibleEl = surfaceEl.shadowRoot!.querySelector('a2ui-collapsible')!;
    expect(collapsibleEl).not.toBeNull();
    await (collapsibleEl as any).updateComplete;

    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).toBeNull();
    expect(collapsibleEl.shadowRoot!.querySelector('a2ui-badge')).not.toBeNull();

    const header = collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-header')!;
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (collapsibleEl as any).updateComplete;

    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).not.toBeNull();

    header.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    await (collapsibleEl as any).updateComplete;

    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).toBeNull();
  });

  it('toggles Collapsible when open is passed as a literal boolean', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'literalCollapsibleSurface',
        },
      },
      {
        version: 'v1.0',
        updateComponents: {
          surfaceId: 'literalCollapsibleSurface',
          components: [
            {
              id: 'root',
              component: 'Collapsible',
              catalogId: STATUS_CATALOG_ID,
              title: 'Literal Open Section',
              child: 'inner_text',
              open: true,
            },
            {
              id: 'inner_text',
              component: 'Text',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
              text: 'Expanded by default',
            },
          ],
        },
      },
    ] as any);

    pane.processor = processor;
    await pane.updateComplete;

    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;

    const collapsibleEl = surfaceEl.shadowRoot!.querySelector('a2ui-collapsible')!;
    expect(collapsibleEl).not.toBeNull();
    await (collapsibleEl as any).updateComplete;

    // Starts expanded (open: true)
    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).not.toBeNull();

    const header = collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-header')!;
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (collapsibleEl as any).updateComplete;

    // Collapses on click despite GenericBinder attaching a no-op setOpen function
    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).toBeNull();

    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
    await (collapsibleEl as any).updateComplete;

    // Re-expands on Space key
    expect(collapsibleEl.shadowRoot!.querySelector('.a2ui-collapsible-body')).not.toBeNull();
  });

  describe('weight and Row layout', () => {
    const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

    function hostCssText(el: Element): string {
      const styles = (el.constructor as any).styles;
      return (Array.isArray(styles) ? styles.flat() : [styles])
        .map((s: any) => s.cssText ?? String(s))
        .join('\n');
    }

    async function renderRowSurface(): Promise<ShadowRoot> {
      const processor = createProcessor();
      processor.processMessages([
        {
          version: 'v1.0',
          createSurface: { surfaceId: 'rowSurface', sendDataModel: true },
        },
        {
          version: 'v1.0',
          updateComponents: {
            surfaceId: 'rowSurface',
            components: [
              {
                id: 'root',
                component: 'Column',
                catalogId: BASIC_CATALOG_ID,
                children: ['row', 'column_bar', 'column_collapsible'],
              },
              {
                id: 'row',
                component: 'Row',
                catalogId: BASIC_CATALOG_ID,
                children: ['label_col', 'row_bar', 'row_badge', 'row_collapsible'],
              },
              {
                id: 'label_col',
                component: 'Column',
                catalogId: BASIC_CATALOG_ID,
                children: ['label_text'],
                weight: 3,
              },
              {
                id: 'label_text',
                component: 'Text',
                catalogId: BASIC_CATALOG_ID,
                text: 'Correctness',
              },
              {
                id: 'row_bar',
                component: 'ProgressBar',
                catalogId: STATUS_CATALOG_ID,
                value: 9,
                max: 10,
                weight: 2,
              },
              {
                id: 'row_badge',
                component: 'Badge',
                catalogId: STATUS_CATALOG_ID,
                text: '9/10',
                tone: 'success',
                weight: 1,
              },
              {
                id: 'row_collapsible',
                component: 'Collapsible',
                catalogId: STATUS_CATALOG_ID,
                title: 'Rationale',
                child: 'rationale_text',
              },
              {
                id: 'rationale_text',
                component: 'Text',
                catalogId: BASIC_CATALOG_ID,
                text: 'Looks right.',
              },
              {
                id: 'column_bar',
                component: 'ProgressBar',
                catalogId: STATUS_CATALOG_ID,
                value: 1,
                max: 2,
              },
              {
                id: 'column_collapsible',
                component: 'Collapsible',
                catalogId: STATUS_CATALOG_ID,
                title: 'Details',
                child: 'rationale_text',
              },
            ],
          },
        },
      ] as any);

      pane.processor = processor;
      await pane.updateComplete;
      const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
      await (surfaceEl as any).updateComplete;
      const root = surfaceEl.shadowRoot!;
      for (let pass = 0; pass < 2; pass++) {
        for (const el of Array.from(
          root.querySelectorAll(
            'a2ui-basic-column, a2ui-basic-row, a2ui-progress-bar, a2ui-badge, a2ui-collapsible',
          ),
        )) {
          await (el as any).updateComplete;
        }
      }
      return root;
    }

    it('applies weight as flex on the host elements, matching the basic catalog Column', async () => {
      const root = await renderRowSurface();
      const rowEl = root.querySelector('a2ui-basic-row') as HTMLElement;
      const labelCol = rowEl.querySelector('a2ui-basic-column') as HTMLElement;
      const bar = rowEl.querySelector('a2ui-progress-bar') as HTMLElement;
      const badge = rowEl.querySelector('a2ui-badge') as HTMLElement;

      expect(labelCol.style.flexGrow).toBe('3');
      expect(bar.style.flexGrow).toBe('2');
      expect(badge.style.flexGrow).toBe('1');
      // Same inline property as the basic catalog host (web_core sets this.style.flex).
      expect(bar.getAttribute('style')).toContain('flex');
      expect(labelCol.getAttribute('style')).toContain('flex');

      // The inner elements no longer carry the flex rule; only the host does.
      const barInner = bar.shadowRoot!.querySelector('.a2ui-progress-container') as HTMLElement;
      const badgeInner = badge.shadowRoot!.querySelector('.a2ui-badge') as HTMLElement;
      expect(barInner.getAttribute('style') ?? '').not.toContain('flex');
      expect(badgeInner.getAttribute('style') ?? '').not.toContain('flex');
    });

    it('removes the host flex when a component has no weight, like web_core does', async () => {
      const root = await renderRowSurface();
      const rowCollapsible = root.querySelector('a2ui-basic-row a2ui-collapsible') as HTMLElement;
      const columnBar = root.querySelector('a2ui-progress-bar:not([data-a2ui-row-item])');
      expect(rowCollapsible.style.flex).toBe('');
      expect((columnBar as HTMLElement).style.flex).toBe('');
      const inner = rowCollapsible.shadowRoot!.querySelector('.a2ui-collapsible') as HTMLElement;
      expect(inner.getAttribute('style') ?? '').not.toContain('flex');
    });

    it('marks hosts inside a Row so they shrink and share the row instead of claiming its full width', async () => {
      const root = await renderRowSurface();
      const rowEl = root.querySelector('a2ui-basic-row')!;
      const rowBar = rowEl.querySelector('a2ui-progress-bar')!;
      const rowCollapsible = rowEl.querySelector('a2ui-collapsible')!;
      const columnBars = Array.from(root.querySelectorAll('a2ui-progress-bar')).filter(
        (el) => el.parentElement?.localName !== 'a2ui-basic-row',
      );
      const columnCollapsibles = Array.from(root.querySelectorAll('a2ui-collapsible')).filter(
        (el) => el.parentElement?.localName !== 'a2ui-basic-row',
      );

      expect(rowBar.hasAttribute('data-a2ui-row-item')).toBe(true);
      expect(rowCollapsible.hasAttribute('data-a2ui-row-item')).toBe(true);
      expect(columnBars).toHaveLength(1);
      expect(columnCollapsibles).toHaveLength(1);
      expect(columnBars[0].hasAttribute('data-a2ui-row-item')).toBe(false);
      expect(columnCollapsibles[0].hasAttribute('data-a2ui-row-item')).toBe(false);

      // happy-dom does not run layout, so the width guarantee is checked through the host
      // stylesheet: no fixed 100% width (which made a Row sibling with weight collapse to
      // 0px), a shrinkable flex basis for Row items, and full-width stretch inside a Column.
      for (const el of [rowBar, rowCollapsible]) {
        const cssText = hostCssText(el);
        const hostRule = /:host\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? '';
        expect(hostRule).not.toContain('width: 100%');
        expect(hostRule).toContain('min-width: 0');
        expect(hostRule).toContain('align-self: stretch');
        expect(cssText).toMatch(/:host\(\[data-a2ui-row-item\]\)\s*\{[^}]*flex: 1 1 0%/);
      }
    });

    it('keeps the Collapsible header readable when its container is narrow', async () => {
      const root = await renderRowSurface();
      const rowCollapsible = root.querySelector('a2ui-basic-row a2ui-collapsible')!;
      await (rowCollapsible as any).updateComplete;
      const title = rowCollapsible.shadowRoot!.querySelector('.a2ui-collapsible-title');
      expect(title?.textContent).toBe('Rationale');
      const cssText = hostCssText(rowCollapsible);
      expect(cssText).toContain('container: a2ui-collapsible / inline-size');
      expect(cssText).toMatch(/@container a2ui-collapsible \(max-width: 220px\)/);
    });
  });
});
