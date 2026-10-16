import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  A2uiPaneView,
  createProcessor,
  computeNiceTicks,
  describeSectorPath,
  formatTickNumber,
  normalizeChartSeries,
  polarToCartesian,
  resolveSeriesColor,
  type ChartVariant,
} from '../src/index.js';
import type { A2uiActionDetails } from '@a2ui-pane/protocol';

describe('chart-math helpers', () => {
  it('computes nice axis ticks across zero, negative, and constant ranges', () => {
    const basic = computeNiceTicks(0, 142, 5, true);
    expect(basic.min).toBe(0);
    expect(basic.max).toBeGreaterThanOrEqual(142);
    expect(basic.ticks.length).toBeGreaterThanOrEqual(3);

    const zeroOnly = computeNiceTicks(0, 0, 5, true);
    expect(zeroOnly.min).toBe(0);
    expect(zeroOnly.max).toBe(10);

    const neg = computeNiceTicks(-45, 85, 5, true);
    expect(neg.min).toBeLessThanOrEqual(-45);
    expect(neg.max).toBeGreaterThanOrEqual(85);
    expect(neg.ticks).toContain(0);

    const flat = computeNiceTicks(50, 50, 5, false);
    expect(flat.min).toBeLessThan(50);
    expect(flat.max).toBeGreaterThan(50);
  });

  it('formats tick numbers concisely and computes polar/sector SVG paths', () => {
    expect(formatTickNumber(0)).toBe('0');
    expect(formatTickNumber(42)).toBe('42');
    expect(formatTickNumber(12500)).toBe('12.5k');
    expect(formatTickNumber(2500000)).toBe('2.5M');
    expect(formatTickNumber(3.14159)).toBe('3.14');
    expect(formatTickNumber(Number.NaN)).toBe('0');

    const top = polarToCartesian(100, 100, 50, 0);
    expect(top).toEqual({ x: 100, y: 50 });

    const piePath = describeSectorPath(100, 100, 50, 0, 0, 90);
    expect(piePath).toContain('M 100 100');
    expect(piePath).toContain('A 50 50 0 0 1');

    const donutPath = describeSectorPath(100, 100, 50, 25, 0, 240);
    expect(donutPath).toContain('A 50 50 0 1 1');
    expect(donutPath).toContain('A 25 25 0 1 0');

    expect(resolveSeriesColor(0)).toContain('--a2ui-chart-color-1');
    expect(resolveSeriesColor(1, '#ff0055')).toBe('#ff0055');
  });

  it('normalizes numeric and scatter point series with labels', () => {
    const { series, labels } = normalizeChartSeries(
      [
        { name: 'P50', values: [10, 20, 30] },
        {
          name: 'Scatter',
          color: '#123456',
          values: [
            { x: 1, y: 5, label: 'A' },
            { x: 2, y: 15, label: 'B' },
          ],
        },
      ],
      ['Q1', 'Q2'],
    );
    expect(labels).toEqual(['Q1', 'Q2', '3']);
    expect(series).toHaveLength(2);
    expect(series[0].points.map((p) => p.y)).toEqual([10, 20, 30]);
    expect(series[1].color).toBe('#123456');
    expect(series[1].points[0]).toEqual({ index: 0, x: 1, y: 5, label: 'A' });
  });
});

describe('<a2ui-chart> component via v1.0 MessageProcessor', () => {
  let pane: A2uiPaneView;

  beforeEach(() => {
    pane = document.createElement('a2ui-pane-view');
    document.body.appendChild(pane);
  });

  afterEach(() => {
    if (pane.parentElement) {
      document.body.removeChild(pane);
    }
  });

  const variants: ChartVariant[] = [
    'bar',
    'stacked-bar',
    'horizontal-bar',
    'line',
    'area',
    'pie',
    'donut',
    'scatter',
  ];

  for (const variant of variants) {
    it(`renders ${variant} chart variant with SVG marks and legend`, async () => {
      const processor = createProcessor();
      const values =
        variant === 'scatter'
          ? [
              { x: 10, y: 25, label: 'Node A' },
              { x: 30, y: 65, label: 'Node B' },
              { x: 50, y: 40, label: 'Node C' },
            ]
          : [42, 78, 55];

      processor.processMessages([
        {
          version: 'v1.0',
          createSurface: {
            surfaceId: `surf-${variant}`,
            sendDataModel: true,
          },
        },
        {
          version: 'v1.0',
          updateDataModel: {
            surfaceId: `surf-${variant}`,
            path: '/',
            value: {
              labels: ['Jan', 'Feb', 'Mar'],
              series: [
                { name: 'Primary', values },
                ...(variant === 'pie' || variant === 'donut'
                  ? []
                  : [{ name: 'Secondary', values }]),
              ],
            },
          },
        },
        {
          version: 'v1.0',
          updateComponents: {
            surfaceId: `surf-${variant}`,
            components: [
              {
                id: 'root',
                component: 'Chart',
                catalogId: 'https://a2ui.org/specification/v1_0/catalogs/charts/catalog.json',
                variant,
                title: `${variant} Title`,
                labels: { '@path': '/labels' },
                series: { '@path': '/series' },
                xAxisLabel: 'X Axis',
                yAxisLabel: 'Y Axis',
                showLegend: true,
                showGrid: true,
              },
            ],
          },
        },
      ] as any);

      pane.processor = processor;
      await pane.updateComplete;

      const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
      await (surfaceEl as any).updateComplete;
      const chartEl = surfaceEl.shadowRoot!.querySelector('a2ui-chart')!;
      expect(chartEl).not.toBeNull();
      await (chartEl as any).updateComplete;

      const container = chartEl.shadowRoot!.querySelector('.a2ui-chart-container')!;
      expect(container).not.toBeNull();
      expect(container.getAttribute('data-variant')).toBe(variant);
      expect(chartEl.shadowRoot!.querySelector('.a2ui-chart-title')?.textContent).toBe(
        `${variant} Title`,
      );

      const svgEl = chartEl.shadowRoot!.querySelector('svg.a2ui-chart-svg');
      expect(svgEl).not.toBeNull();
      const marks = chartEl.shadowRoot!.querySelectorAll('.a2ui-chart-mark');
      expect(marks.length).toBeGreaterThanOrEqual(3);
      expect(chartEl.shadowRoot!.querySelector('.a2ui-chart-legend')).not.toBeNull();
    });
  }

  it('updates reactively on updateDataModel and writes selected state + dispatches action on click/keydown', async () => {
    const actions: Array<{ action: A2uiActionDetails; dataModel?: Record<string, unknown> }> = [];
    const processor = createProcessor((action, dataModel) => {
      actions.push({ action, dataModel });
    });

    processor.processMessages([
      {
        version: 'v1.0',
        createSurface: {
          surfaceId: 'interactiveChart',
          sendDataModel: true,
        },
      },
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'interactiveChart',
          path: '/',
          value: {
            labels: ['Q1', 'Q2'],
            series: [{ name: 'Revenue', values: [120, 180] }],
            picked: null,
          },
        },
      },
      {
        version: 'v1.0',
        updateComponents: {
          surfaceId: 'interactiveChart',
          components: [
            {
              id: 'root',
              component: 'Chart',
              catalogId: 'https://a2ui.org/specification/v1_0/catalogs/charts/catalog.json',
              variant: 'bar',
              title: 'Interactive Revenue',
              labels: { '@path': '/labels' },
              series: { '@path': '/series' },
              selected: { '@path': '/picked' },
              action: {
                event: {
                  name: 'drilldown',
                  context: { picked: { '@path': '/picked' } },
                },
              },
            },
          ],
        },
      },
    ] as any);

    pane.processor = processor;
    await pane.updateComplete;

    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    const chartEl = surfaceEl.shadowRoot!.querySelector('a2ui-chart')!;
    await (chartEl as any).updateComplete;

    let bars = chartEl.shadowRoot!.querySelectorAll('rect.a2ui-chart-bar');
    expect(bars).toHaveLength(2);

    // Click the second bar (Q2: 180)
    bars[1].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await (chartEl as any).updateComplete;

    expect(actions).toHaveLength(1);
    expect(actions[0].action.name).toBe('drilldown');
    expect((actions[0].dataModel as any)?.surfaces?.interactiveChart?.picked).toEqual({
      seriesIndex: 0,
      pointIndex: 1,
      seriesName: 'Revenue',
      label: 'Q2',
      value: 180,
    });

    // Keyboard activation on first bar (Q1: 120)
    bars[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await (chartEl as any).updateComplete;
    expect(actions).toHaveLength(2);
    expect((actions[1].dataModel as any)?.surfaces?.interactiveChart?.picked).toMatchObject({
      pointIndex: 0,
      label: 'Q1',
      value: 120,
    });

    // Reactive update via updateDataModel adds Q3 without recreating component tree
    processor.processMessages([
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'interactiveChart',
          path: '/labels',
          value: ['Q1', 'Q2', 'Q3'],
        },
      },
      {
        version: 'v1.0',
        updateDataModel: {
          surfaceId: 'interactiveChart',
          path: '/series',
          value: [{ name: 'Revenue', values: [120, 180, 240] }],
        },
      },
    ] as any);

    await (chartEl as any).updateComplete;
    bars = chartEl.shadowRoot!.querySelectorAll('rect.a2ui-chart-bar');
    expect(bars).toHaveLength(3);
  });
});
