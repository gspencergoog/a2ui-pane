import { html, svg, css, nothing, type TemplateResult } from 'lit';
import { A2uiLitElement } from '@a2ui/web_core/universal';
import {
  type ChartVariant,
  type ChartSelection,
  type NormalizedSeries,
  computeNiceTicks,
  describeSectorPath,
  formatTickNumber,
  normalizeChartSeries,
  polarToCartesian,
  resolveSeriesColor,
} from './chart-math.js';

/** Resolved runtime properties passed to `A2uiChartElement` by `GenericBinder`. */
export interface ChartResolvedProps {
  variant?: ChartVariant;
  series?: unknown;
  labels?: unknown;
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  height?: number;
  showLegend?: boolean;
  showGrid?: boolean;
  selected?: ChartSelection | null;
  setSelected?: (value: ChartSelection | null) => void;
  action?: () => Promise<void>;
  weight?: number;
  accessibility?: {
    label?: string;
    description?: string;
  };
}

interface CartesianPlotBox {
  viewWidth: number;
  viewHeight: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  plotWidth: number;
  plotHeight: number;
}

/**
 * Interactive SVG chart Web Component (`<a2ui-chart>`) for the A2UI v1.0 Charts Catalog.
 *
 * Supports `bar`, `stacked-bar`, `horizontal-bar`, `line`, `area`, `pie`, `donut`, and `scatter`
 * variants with reactive `@path` bindings, two-way `selected` state, and `action` dispatch.
 */
export class A2uiChartElement extends A2uiLitElement<any, ChartResolvedProps> {
  static tagName = 'a2ui-chart';

  static override properties = {
    ...A2uiLitElement.properties,
    hoveredItem: { state: true },
  };

  declare hoveredItem: ChartSelection | null;

  constructor() {
    super();
    this.hoveredItem = null;
  }

  private isSelected(sel: ChartSelection | null | undefined, sIdx: number, pIdx: number): boolean {
    if (!sel || typeof sel !== 'object') return false;
    return sel.seriesIndex === sIdx && sel.pointIndex === pIdx;
  }

  private activateDatum(props: ChartResolvedProps, item: ChartSelection): void {
    this.hoveredItem = item;
    props.setSelected?.(item);
    if (typeof props.action === 'function') {
      void props.action();
    }
  }

  private handleKeydown(e: KeyboardEvent, props: ChartResolvedProps, item: ChartSelection): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.activateDatum(props, item);
    }
  }

  private createBox(
    viewHeight: number,
    hasXAxisLabel: boolean,
    hasYAxisLabel: boolean,
  ): CartesianPlotBox {
    const viewWidth = 560;
    const padLeft = hasYAxisLabel ? 58 : 44;
    const padRight = 20;
    const padTop = 16;
    const padBottom = hasXAxisLabel ? 46 : 30;
    return {
      viewWidth,
      viewHeight,
      padLeft,
      padRight,
      padTop,
      padBottom,
      plotWidth: Math.max(100, viewWidth - padLeft - padRight),
      plotHeight: Math.max(60, viewHeight - padTop - padBottom),
    };
  }

  private renderCartesianGridAndAxes(
    box: CartesianPlotBox,
    ticks: number[],
    scaleMin: number,
    scaleMax: number,
    showGrid: boolean,
    xAxisLabel?: string,
    yAxisLabel?: string,
  ): TemplateResult {
    const span = scaleMax - scaleMin || 1;
    const yFor = (val: number) =>
      box.padTop + box.plotHeight - ((val - scaleMin) / span) * box.plotHeight;
    const zeroY = scaleMin <= 0 && scaleMax >= 0 ? yFor(0) : box.padTop + box.plotHeight;

    return svg`
      ${ticks.map((tick) => {
        const y = Number(yFor(tick).toFixed(2));
        return svg`
          ${
            showGrid
              ? svg`<line class="a2ui-chart-grid-line" x1="${box.padLeft}" y1="${y}" x2="${box.padLeft + box.plotWidth}" y2="${y}" />`
              : nothing
          }
          <text class="a2ui-chart-axis-tick" x="${box.padLeft - 8}" y="${y + 4}" text-anchor="end">${formatTickNumber(tick)}</text>
        `;
      })}
      <line class="a2ui-chart-axis-line" x1="${box.padLeft}" y1="${box.padTop}" x2="${box.padLeft}" y2="${box.padTop + box.plotHeight}" />
      <line class="a2ui-chart-axis-line" x1="${box.padLeft}" y1="${Number(zeroY.toFixed(2))}" x2="${box.padLeft + box.plotWidth}" y2="${Number(zeroY.toFixed(2))}" />
      ${
        xAxisLabel
          ? svg`<text class="a2ui-chart-axis-title" x="${box.padLeft + box.plotWidth / 2}" y="${box.viewHeight - 6}" text-anchor="middle">${xAxisLabel}</text>`
          : nothing
      }
      ${
        yAxisLabel
          ? svg`<text class="a2ui-chart-axis-title" transform="translate(14, ${box.padTop + box.plotHeight / 2}) rotate(-90)" text-anchor="middle">${yAxisLabel}</text>`
          : nothing
      }
    `;
  }

  private renderBarOrStackedSvg(
    props: ChartResolvedProps,
    series: NormalizedSeries[],
    labels: string[],
    viewHeight: number,
    stacked: boolean,
  ): TemplateResult {
    const box = this.createBox(viewHeight, Boolean(props.xAxisLabel), Boolean(props.yAxisLabel));
    const categoryCount = Math.max(1, labels.length);
    let minVal = 0;
    let maxVal = 0;

    if (stacked) {
      for (let c = 0; c < categoryCount; c++) {
        let posSum = 0;
        let negSum = 0;
        for (const s of series) {
          const val = s.points[c]?.y ?? 0;
          if (val >= 0) posSum += val;
          else negSum += val;
        }
        maxVal = Math.max(maxVal, posSum);
        minVal = Math.min(minVal, negSum);
      }
    } else {
      for (const s of series) {
        for (const pt of s.points) {
          minVal = Math.min(minVal, pt.y);
          maxVal = Math.max(maxVal, pt.y);
        }
      }
    }

    const scale = computeNiceTicks(minVal, maxVal, 5, true);
    const span = scale.max - scale.min || 1;
    const yFor = (val: number) =>
      box.padTop + box.plotHeight - ((val - scale.min) / span) * box.plotHeight;
    const zeroY = yFor(0);
    const groupSlot = box.plotWidth / categoryCount;
    const groupPad = Math.min(18, groupSlot * 0.22);
    const groupWidth = Math.max(8, groupSlot - groupPad * 2);
    const barCount = stacked ? 1 : Math.max(1, series.length);
    const barGap = barCount > 1 ? 3 : 0;
    const singleBarWidth = Math.max(4, (groupWidth - barGap * (barCount - 1)) / barCount);

    const bars: TemplateResult[] = [];
    for (let c = 0; c < categoryCount; c++) {
      const catLabel = labels[c] ?? String(c + 1);
      const groupStartX = box.padLeft + c * groupSlot + groupPad;
      let runningPos = 0;
      let runningNeg = 0;

      for (let sIdx = 0; sIdx < series.length; sIdx++) {
        const s = series[sIdx];
        const val = s.points[c]?.y ?? 0;
        const x = stacked ? groupStartX : groupStartX + sIdx * (singleBarWidth + barGap);
        let yTop: number;
        let yBottom: number;
        if (stacked) {
          if (val >= 0) {
            yBottom = yFor(runningPos);
            runningPos += val;
            yTop = yFor(runningPos);
          } else {
            yTop = yFor(runningNeg);
            runningNeg += val;
            yBottom = yFor(runningNeg);
          }
        } else {
          yTop = val >= 0 ? yFor(val) : zeroY;
          yBottom = val >= 0 ? zeroY : yFor(val);
        }

        const barHeight = Math.max(2, Math.abs(yBottom - yTop));
        const rectY = Math.min(yTop, yBottom);
        const selItem: ChartSelection = {
          seriesIndex: sIdx,
          pointIndex: c,
          seriesName: s.name,
          label: catLabel,
          value: val,
        };
        const selected = this.isSelected(props.selected, sIdx, c);

        bars.push(svg`
          <rect
            class="a2ui-chart-mark a2ui-chart-bar ${selected ? 'selected' : ''}"
            data-series-index="${sIdx}"
            data-point-index="${c}"
            x="${Number(x.toFixed(2))}"
            y="${Number(rectY.toFixed(2))}"
            width="${Number(singleBarWidth.toFixed(2))}"
            height="${Number(barHeight.toFixed(2))}"
            rx="3"
            fill="${s.color}"
            tabindex="0"
            role="graphics-symbol"
            aria-label="${`${s.name}, ${catLabel}: ${val}`}"
            aria-selected="${selected ? 'true' : 'false'}"
            @mouseenter="${() => {
              this.hoveredItem = selItem;
            }}"
            @focus="${() => {
              this.hoveredItem = selItem;
            }}"
            @click="${() => this.activateDatum(props, selItem)}"
            @keydown="${(e: KeyboardEvent) => this.handleKeydown(e, props, selItem)}"
          />
        `);
      }
    }

    return svg`
      <svg class="a2ui-chart-svg" viewBox="0 0 ${box.viewWidth} ${box.viewHeight}" role="img" aria-label="${props.accessibility?.label || props.title || 'Bar chart'}">
        ${this.renderCartesianGridAndAxes(
          box,
          scale.ticks,
          scale.min,
          scale.max,
          props.showGrid !== false,
          props.xAxisLabel,
          props.yAxisLabel,
        )}
        ${bars}
        ${labels.map((lbl, c) => {
          const cx = box.padLeft + (c + 0.5) * groupSlot;
          return svg`<text class="a2ui-chart-axis-tick" x="${Number(cx.toFixed(2))}" y="${box.padTop + box.plotHeight + 16}" text-anchor="middle">${lbl}</text>`;
        })}
      </svg>
    `;
  }

  private renderHorizontalBarSvg(
    props: ChartResolvedProps,
    series: NormalizedSeries[],
    labels: string[],
    viewHeight: number,
  ): TemplateResult {
    const viewWidth = 560;
    const maxLabelChars = labels.reduce(
      (max, lbl) => Math.max(max, Math.min(32, String(lbl).length)),
      0,
    );
    const padLeft = Math.min(220, Math.max(56, Math.ceil(maxLabelChars * 6) + 16));
    const padRight = 24;
    const padTop = 16;
    const padBottom = props.xAxisLabel ? 42 : 28;
    const plotWidth = Math.max(100, viewWidth - padLeft - padRight);
    const plotHeight = Math.max(60, viewHeight - padTop - padBottom);
    const categoryCount = Math.max(1, labels.length);

    let minVal = 0;
    let maxVal = 0;
    for (const s of series) {
      for (const pt of s.points) {
        minVal = Math.min(minVal, pt.y);
        maxVal = Math.max(maxVal, pt.y);
      }
    }
    const scale = computeNiceTicks(minVal, maxVal, 5, true);
    const span = scale.max - scale.min || 1;
    const xFor = (val: number) => padLeft + ((val - scale.min) / span) * plotWidth;
    const zeroX = xFor(0);

    const rowSlot = plotHeight / categoryCount;
    const rowPad = Math.min(10, rowSlot * 0.2);
    const groupHeight = Math.max(8, rowSlot - rowPad * 2);
    const barCount = Math.max(1, series.length);
    const barGap = barCount > 1 ? 2 : 0;
    const singleBarHeight = Math.max(4, (groupHeight - barGap * (barCount - 1)) / barCount);

    return svg`
      <svg class="a2ui-chart-svg" viewBox="0 0 ${viewWidth} ${viewHeight}" role="img" aria-label="${props.accessibility?.label || props.title || 'Horizontal bar chart'}">
        ${scale.ticks.map((tick) => {
          const x = Number(xFor(tick).toFixed(2));
          return svg`
            ${
              props.showGrid !== false
                ? svg`<line class="a2ui-chart-grid-line" x1="${x}" y1="${padTop}" x2="${x}" y2="${padTop + plotHeight}" />`
                : nothing
            }
            <text class="a2ui-chart-axis-tick" x="${x}" y="${padTop + plotHeight + 16}" text-anchor="middle">${formatTickNumber(tick)}</text>
          `;
        })}
        <line class="a2ui-chart-axis-line" x1="${Number(zeroX.toFixed(2))}" y1="${padTop}" x2="${Number(zeroX.toFixed(2))}" y2="${padTop + plotHeight}" />
        <line class="a2ui-chart-axis-line" x1="${padLeft}" y1="${padTop + plotHeight}" x2="${padLeft + plotWidth}" y2="${padTop + plotHeight}" />
        ${labels.map((catLabel, c) => {
          const rowStartY = padTop + c * rowSlot + rowPad;
          const labelY = padTop + (c + 0.5) * rowSlot + 3.5;
          const displayLabel = catLabel.length > 32 ? `${catLabel.slice(0, 31)}\u2026` : catLabel;
          return svg`
            <text class="a2ui-chart-axis-tick" x="${padLeft - 8}" y="${Number(labelY.toFixed(2))}" text-anchor="end">${displayLabel}</text>
            ${series.map((s, sIdx) => {
              const val = s.points[c]?.y ?? 0;
              const y = rowStartY + sIdx * (singleBarHeight + barGap);
              const xStart = Math.min(zeroX, xFor(val));
              const width = Math.max(2, Math.abs(xFor(val) - zeroX));
              const selItem: ChartSelection = {
                seriesIndex: sIdx,
                pointIndex: c,
                seriesName: s.name,
                label: catLabel,
                value: val,
              };
              const selected = this.isSelected(props.selected, sIdx, c);
              return svg`
                <rect
                  class="a2ui-chart-mark a2ui-chart-bar ${selected ? 'selected' : ''}"
                  data-series-index="${sIdx}"
                  data-point-index="${c}"
                  x="${Number(xStart.toFixed(2))}"
                  y="${Number(y.toFixed(2))}"
                  width="${Number(width.toFixed(2))}"
                  height="${Number(singleBarHeight.toFixed(2))}"
                  rx="3"
                  fill="${s.color}"
                  tabindex="0"
                  role="graphics-symbol"
                  aria-label="${`${s.name}, ${catLabel}: ${val}`}"
                  aria-selected="${selected ? 'true' : 'false'}"
                  @mouseenter="${() => {
                    this.hoveredItem = selItem;
                  }}"
                  @focus="${() => {
                    this.hoveredItem = selItem;
                  }}"
                  @click="${() => this.activateDatum(props, selItem)}"
                  @keydown="${(e: KeyboardEvent) => this.handleKeydown(e, props, selItem)}"
                />
              `;
            })}
          `;
        })}
        ${
          props.xAxisLabel
            ? svg`<text class="a2ui-chart-axis-title" x="${padLeft + plotWidth / 2}" y="${viewHeight - 4}" text-anchor="middle">${props.xAxisLabel}</text>`
            : nothing
        }
      </svg>
    `;
  }

  private renderLineOrAreaSvg(
    props: ChartResolvedProps,
    series: NormalizedSeries[],
    labels: string[],
    viewHeight: number,
    isArea: boolean,
  ): TemplateResult {
    const box = this.createBox(viewHeight, Boolean(props.xAxisLabel), Boolean(props.yAxisLabel));
    let minVal = 0;
    let maxVal = 0;
    for (const s of series) {
      for (const pt of s.points) {
        minVal = Math.min(minVal, pt.y);
        maxVal = Math.max(maxVal, pt.y);
      }
    }
    const scale = computeNiceTicks(minVal, maxVal, 5, true);
    const span = scale.max - scale.min || 1;
    const yFor = (val: number) =>
      box.padTop + box.plotHeight - ((val - scale.min) / span) * box.plotHeight;
    const baselineY = Number(yFor(Math.max(0, scale.min)).toFixed(2));
    const count = Math.max(1, labels.length);
    const xForIndex = (idx: number) =>
      count === 1
        ? box.padLeft + box.plotWidth / 2
        : box.padLeft + (idx / (count - 1)) * box.plotWidth;

    return svg`
      <svg class="a2ui-chart-svg" viewBox="0 0 ${box.viewWidth} ${box.viewHeight}" role="img" aria-label="${props.accessibility?.label || props.title || (isArea ? 'Area chart' : 'Line chart')}">
        ${this.renderCartesianGridAndAxes(
          box,
          scale.ticks,
          scale.min,
          scale.max,
          props.showGrid !== false,
          props.xAxisLabel,
          props.yAxisLabel,
        )}
        ${series.map((s, sIdx) => {
          if (s.points.length === 0) return nothing;
          const coords = s.points.map((pt, pIdx) => ({
            x: Number(xForIndex(pIdx).toFixed(2)),
            y: Number(yFor(pt.y).toFixed(2)),
            pt,
            pIdx,
          }));
          const polyPoints = coords.map((c) => `${c.x},${c.y}`).join(' ');
          const firstX = coords[0].x;
          const lastX = coords[coords.length - 1].x;
          const areaPath = `M ${firstX} ${baselineY} L ${coords.map((c) => `${c.x} ${c.y}`).join(' L ')} L ${lastX} ${baselineY} Z`;

          return svg`
            ${
              isArea
                ? svg`<path class="a2ui-chart-area" d="${areaPath}" fill="${s.color}" fill-opacity="0.2" />`
                : nothing
            }
            <polyline
              class="a2ui-chart-line"
              fill="none"
              stroke="${s.color}"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              points="${polyPoints}"
            />
            ${coords.map(({ x, y, pt, pIdx }) => {
              const catLabel = labels[pIdx] ?? pt.label;
              const selItem: ChartSelection = {
                seriesIndex: sIdx,
                pointIndex: pIdx,
                seriesName: s.name,
                label: catLabel,
                value: pt.y,
              };
              const selected = this.isSelected(props.selected, sIdx, pIdx);
              return svg`
                <circle
                  class="a2ui-chart-mark a2ui-chart-point ${selected ? 'selected' : ''}"
                  data-series-index="${sIdx}"
                  data-point-index="${pIdx}"
                  cx="${x}"
                  cy="${y}"
                  r="${selected ? 6 : 4.5}"
                  fill="${s.color}"
                  tabindex="0"
                  role="graphics-symbol"
                  aria-label="${`${s.name}, ${catLabel}: ${pt.y}`}"
                  aria-selected="${selected ? 'true' : 'false'}"
                  @mouseenter="${() => {
                    this.hoveredItem = selItem;
                  }}"
                  @focus="${() => {
                    this.hoveredItem = selItem;
                  }}"
                  @click="${() => this.activateDatum(props, selItem)}"
                  @keydown="${(e: KeyboardEvent) => this.handleKeydown(e, props, selItem)}"
                />
              `;
            })}
          `;
        })}
        ${labels.map((lbl, idx) => {
          const x = Number(xForIndex(idx).toFixed(2));
          return svg`<text class="a2ui-chart-axis-tick" x="${x}" y="${box.padTop + box.plotHeight + 16}" text-anchor="middle">${lbl}</text>`;
        })}
      </svg>
    `;
  }

  private renderPieOrDonutSvg(
    props: ChartResolvedProps,
    series: NormalizedSeries[],
    labels: string[],
    viewHeight: number,
    isDonut: boolean,
  ): TemplateResult {
    const viewWidth = 560;
    const primary = series[0];
    const points = primary ? primary.points : [];
    const positiveValues = points.map((p) => Math.max(0, p.y));
    const total = positiveValues.reduce((acc, v) => acc + v, 0);
    const cx = viewWidth / 2;
    const cy = viewHeight / 2;
    const outerRadius = Math.max(44, Math.min(cx, cy) - 24);
    const innerRadius = isDonut ? Number((outerRadius * 0.56).toFixed(2)) : 0;

    let currentAngle = 0;
    const slices = points.map((pt, idx) => {
      const val = Math.max(0, pt.y);
      const angleSpan = total > 0 ? (val / total) * 360 : 360 / Math.max(1, points.length);
      const startAngle = currentAngle;
      const endAngle = currentAngle + angleSpan;
      currentAngle = endAngle;

      const midAngle = startAngle + angleSpan / 2;
      const labelRadius = isDonut ? (outerRadius + innerRadius) / 2 : outerRadius * 0.66;
      const labelPos = polarToCartesian(cx, cy, labelRadius, midAngle);
      const sliceColor = resolveSeriesColor(
        idx,
        series.length > 1 ? series[idx]?.color : undefined,
      );
      const sliceLabel = labels[idx] ?? pt.label;
      const pct = total > 0 ? Math.round((val / total) * 100) : 0;
      const selItem: ChartSelection = {
        seriesIndex: 0,
        pointIndex: idx,
        seriesName: primary?.name ?? 'Slice',
        label: sliceLabel,
        value: pt.y,
      };
      const selected = this.isSelected(props.selected, 0, idx);

      return svg`
        <path
          class="a2ui-chart-mark a2ui-chart-slice ${selected ? 'selected' : ''}"
          data-series-index="0"
          data-point-index="${idx}"
          d="${describeSectorPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle)}"
          fill="${sliceColor}"
          tabindex="0"
          role="graphics-symbol"
          aria-label="${`${sliceLabel}: ${pt.y} (${pct}%)`}"
          aria-selected="${selected ? 'true' : 'false'}"
          @mouseenter="${() => {
            this.hoveredItem = selItem;
          }}"
          @focus="${() => {
            this.hoveredItem = selItem;
          }}"
          @click="${() => this.activateDatum(props, selItem)}"
          @keydown="${(e: KeyboardEvent) => this.handleKeydown(e, props, selItem)}"
        />
        ${
          pct >= 7
            ? svg`<text class="a2ui-chart-slice-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${pct}%</text>`
            : nothing
        }
      `;
    });

    const activeReadout = this.hoveredItem ?? props.selected;
    return svg`
      <svg class="a2ui-chart-svg" viewBox="0 0 ${viewWidth} ${viewHeight}" role="img" aria-label="${props.accessibility?.label || props.title || (isDonut ? 'Donut chart' : 'Pie chart')}">
        ${slices}
        ${
          isDonut
            ? svg`
                <text class="a2ui-chart-donut-total-label" x="${cx}" y="${cy - 4}" text-anchor="middle">
                  ${activeReadout ? activeReadout.label : 'Total'}
                </text>
                <text class="a2ui-chart-donut-total-value" x="${cx}" y="${cy + 16}" text-anchor="middle">
                  ${formatTickNumber(activeReadout ? activeReadout.value : total)}
                </text>
              `
            : nothing
        }
      </svg>
    `;
  }

  private renderScatterSvg(
    props: ChartResolvedProps,
    series: NormalizedSeries[],
    viewHeight: number,
  ): TemplateResult {
    const box = this.createBox(viewHeight, Boolean(props.xAxisLabel), Boolean(props.yAxisLabel));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of series) {
      for (const pt of s.points) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
    }
    const xScale = computeNiceTicks(
      Number.isFinite(minX) ? minX : 0,
      Number.isFinite(maxX) ? maxX : 10,
      5,
      false,
    );
    const yScale = computeNiceTicks(
      Number.isFinite(minY) ? minY : 0,
      Number.isFinite(maxY) ? maxY : 10,
      5,
      true,
    );
    const xSpan = xScale.max - xScale.min || 1;
    const ySpan = yScale.max - yScale.min || 1;
    const xFor = (val: number) => box.padLeft + ((val - xScale.min) / xSpan) * box.plotWidth;
    const yFor = (val: number) =>
      box.padTop + box.plotHeight - ((val - yScale.min) / ySpan) * box.plotHeight;

    return svg`
      <svg class="a2ui-chart-svg" viewBox="0 0 ${box.viewWidth} ${box.viewHeight}" role="img" aria-label="${props.accessibility?.label || props.title || 'Scatter chart'}">
        ${this.renderCartesianGridAndAxes(
          box,
          yScale.ticks,
          yScale.min,
          yScale.max,
          props.showGrid !== false,
          props.xAxisLabel,
          props.yAxisLabel,
        )}
        ${xScale.ticks.map((tick) => {
          const x = Number(xFor(tick).toFixed(2));
          return svg`<text class="a2ui-chart-axis-tick" x="${x}" y="${box.padTop + box.plotHeight + 16}" text-anchor="middle">${formatTickNumber(tick)}</text>`;
        })}
        ${series.map((s, sIdx) =>
          s.points.map((pt, pIdx) => {
            const cx = Number(xFor(pt.x).toFixed(2));
            const cy = Number(yFor(pt.y).toFixed(2));
            const selItem: ChartSelection = {
              seriesIndex: sIdx,
              pointIndex: pIdx,
              seriesName: s.name,
              label: pt.label,
              value: pt.y,
              x: pt.x,
            };
            const selected = this.isSelected(props.selected, sIdx, pIdx);
            return svg`
              <circle
                class="a2ui-chart-mark a2ui-chart-point ${selected ? 'selected' : ''}"
                data-series-index="${sIdx}"
                data-point-index="${pIdx}"
                cx="${cx}"
                cy="${cy}"
                r="${selected ? 6.5 : 5}"
                fill="${s.color}"
                fill-opacity="0.85"
                tabindex="0"
                role="graphics-symbol"
                aria-label="${`${s.name} (${pt.x}, ${pt.y})`}"
                aria-selected="${selected ? 'true' : 'false'}"
                @mouseenter="${() => {
                  this.hoveredItem = selItem;
                }}"
                @focus="${() => {
                  this.hoveredItem = selItem;
                }}"
                @click="${() => this.activateDatum(props, selItem)}"
                @keydown="${(e: KeyboardEvent) => this.handleKeydown(e, props, selItem)}"
              />
            `;
          }),
        )}
      </svg>
    `;
  }

  private renderLegend(
    variant: ChartVariant,
    series: NormalizedSeries[],
    labels: string[],
  ): TemplateResult | typeof nothing {
    if (variant === 'pie' || variant === 'donut') {
      const pts = series[0]?.points ?? [];
      if (pts.length === 0) return nothing;
      return html`
        <div class="a2ui-chart-legend" role="list">
          ${pts.map((pt, idx) => {
            const color = resolveSeriesColor(idx);
            const lbl = labels[idx] ?? pt.label;
            return html`
              <span class="a2ui-chart-legend-item" role="listitem">
                <span class="a2ui-chart-legend-swatch" style="background: ${color}"></span>
                <span class="a2ui-chart-legend-label">${lbl}</span>
              </span>
            `;
          })}
        </div>
      `;
    }

    if (series.length === 0) return nothing;
    return html`
      <div class="a2ui-chart-legend" role="list">
        ${series.map(
          (s) => html`
            <span class="a2ui-chart-legend-item" role="listitem">
              <span class="a2ui-chart-legend-swatch" style="background: ${s.color}"></span>
              <span class="a2ui-chart-legend-label">${s.name}</span>
            </span>
          `,
        )}
      </div>
    `;
  }

  override render() {
    const props = this.controller?.props;
    if (!props) return nothing;

    const variant: ChartVariant = props.variant ?? 'bar';
    const viewHeight =
      typeof props.height === 'number' && props.height >= 100 && props.height <= 900
        ? props.height
        : 220;
    const { series, labels } = normalizeChartSeries(props.series, props.labels);
    const showLegend =
      typeof props.showLegend === 'boolean'
        ? props.showLegend
        : variant === 'pie' || variant === 'donut' || series.length > 1;
    const activeReadout = this.hoveredItem ?? props.selected;

    let chartSvg: TemplateResult;
    if (series.length === 0 || series.every((s) => s.points.length === 0)) {
      chartSvg = html`<div class="a2ui-chart-empty">No chart data</div>`;
    } else {
      switch (variant) {
        case 'stacked-bar':
          chartSvg = this.renderBarOrStackedSvg(props, series, labels, viewHeight, true);
          break;
        case 'horizontal-bar':
          chartSvg = this.renderHorizontalBarSvg(props, series, labels, viewHeight);
          break;
        case 'line':
          chartSvg = this.renderLineOrAreaSvg(props, series, labels, viewHeight, false);
          break;
        case 'area':
          chartSvg = this.renderLineOrAreaSvg(props, series, labels, viewHeight, true);
          break;
        case 'pie':
          chartSvg = this.renderPieOrDonutSvg(props, series, labels, viewHeight, false);
          break;
        case 'donut':
          chartSvg = this.renderPieOrDonutSvg(props, series, labels, viewHeight, true);
          break;
        case 'scatter':
          chartSvg = this.renderScatterSvg(props, series, viewHeight);
          break;
        case 'bar':
        default:
          chartSvg = this.renderBarOrStackedSvg(props, series, labels, viewHeight, false);
          break;
      }
    }

    return html`
      <div class="a2ui-chart-container" data-variant="${variant}">
        ${
          props.title || activeReadout
            ? html`
                <div class="a2ui-chart-header">
                  ${props.title ? html`<div class="a2ui-chart-title">${props.title}</div>` : html`<div></div>`}
                  ${
                    activeReadout
                      ? html`
                          <div class="a2ui-chart-readout" aria-live="polite">
                            <strong>${activeReadout.seriesName}</strong> · ${activeReadout.label}:
                            <code>${formatTickNumber(activeReadout.value)}</code>
                          </div>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        <div
          class="a2ui-chart-stage"
          @mouseleave="${() => {
            this.hoveredItem = null;
          }}"
        >
          ${chartSvg}
        </div>
        ${showLegend ? this.renderLegend(variant, series, labels) : nothing}
      </div>
    `;
  }

  static override styles = css`
    .a2ui-chart-container {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-sizing: border-box;
      padding: 4px 0;
    }
    .a2ui-chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 20px;
    }
    .a2ui-chart-title {
      font-size: var(--a2ui-font-size-m, 14px);
      font-weight: 600;
      color: var(--a2ui-text-color-text, #1f1f1f);
    }
    .a2ui-chart-readout {
      font-size: var(--a2ui-font-size-xs, 12px);
      color: var(--a2ui-text-caption-color, #70757a);
      background: var(--a2ui-color-secondary, rgba(175, 184, 193, 0.2));
      padding: 2px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .a2ui-chart-stage {
      width: 100%;
      overflow: hidden;
    }
    .a2ui-chart-svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .a2ui-chart-grid-line {
      stroke: var(--a2ui-chart-grid-color, rgba(128, 134, 139, 0.22));
      stroke-width: 1;
      stroke-dasharray: 3 3;
    }
    .a2ui-chart-axis-line {
      stroke: var(--a2ui-chart-axis-color, rgba(128, 134, 139, 0.55));
      stroke-width: 1.2;
    }
    .a2ui-chart-axis-tick {
      fill: var(--a2ui-text-caption-color, #70757a);
      font-size: 9.5px;
      font-family: inherit;
    }
    .a2ui-chart-axis-title {
      fill: var(--a2ui-text-color-text, #1f1f1f);
      font-size: 10px;
      font-weight: 600;
      font-family: inherit;
    }
    .a2ui-chart-mark {
      cursor: pointer;
      transition:
        opacity 0.12s ease,
        stroke-width 0.12s ease;
      outline: none;
    }
    .a2ui-chart-mark:hover,
    .a2ui-chart-mark:focus-visible {
      opacity: 0.88;
      stroke: var(--a2ui-text-color-text, #1f1f1f);
      stroke-width: 1.5px;
    }
    .a2ui-chart-mark.selected {
      stroke: var(--a2ui-text-color-text, #1f1f1f);
      stroke-width: 2.2px;
    }
    .a2ui-chart-slice-label {
      fill: #ffffff;
      font-size: 11px;
      font-weight: 600;
      pointer-events: none;
    }
    .a2ui-chart-donut-total-label {
      fill: var(--a2ui-text-caption-color, #70757a);
      font-size: 11px;
    }
    .a2ui-chart-donut-total-value {
      fill: var(--a2ui-text-color-text, #1f1f1f);
      font-size: 15px;
      font-weight: 700;
    }
    .a2ui-chart-legend {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding-top: 2px;
    }
    .a2ui-chart-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: var(--a2ui-font-size-xs, 12px);
      color: var(--a2ui-text-caption-color, #70757a);
    }
    .a2ui-chart-legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .a2ui-chart-empty {
      padding: 16px;
      text-align: center;
      font-size: var(--a2ui-font-size-s, 12px);
      color: var(--a2ui-text-caption-color, #70757a);
    }
  `;
}
