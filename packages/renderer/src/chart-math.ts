/**
 * Pure geometry and scale calculations for `<a2ui-chart>` SVG rendering.
 */

/**Supported chart layout variants in the A2UI Charts Catalog. */
export type ChartVariant =
  'bar' | 'stacked-bar' | 'horizontal-bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter';

/** A 2D point datum used by scatter plots or explicit coordinate series. */
export interface ChartScatterPoint {
  x: number;
  y: number;
  label?: string;
}

/** Input datum accepted in a `ChartSeries.values` array. */
export type ChartPointInput = number | ChartScatterPoint;

/** Input series definition accepted by `Chart.series`. */
export interface ChartSeriesInput {
  name: string;
  values: ChartPointInput[];
  color?: string;
}

/** Normalized numeric point with category index, coordinates, and display label. */
export interface NormalizedPoint {
  index: number;
  x: number;
  y: number;
  label: string;
}

/** Normalized series ready for SVG layout calculation. */
export interface NormalizedSeries {
  index: number;
  name: string;
  color: string;
  points: NormalizedPoint[];
}

/** Selection payload written to `selected` and emitted on user interaction. */
export interface ChartSelection {
  seriesIndex: number;
  pointIndex: number;
  seriesName: string;
  label: string;
  value: number;
  x?: number;
}

/** Computed nice axis scale with evenly spaced tick marks. */
export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** Default 8-color categorical CSS variable references. */
export const DEFAULT_CHART_COLORS: readonly string[] = [
  'var(--a2ui-chart-color-1, #0b57d0)',
  'var(--a2ui-chart-color-2, #00897b)',
  'var(--a2ui-chart-color-3, #e65100)',
  'var(--a2ui-chart-color-4, #8e24aa)',
  'var(--a2ui-chart-color-5, #c62828)',
  'var(--a2ui-chart-color-6, #2e7d32)',
  'var(--a2ui-chart-color-7, #f9a825)',
  'var(--a2ui-chart-color-8, #0277bd)',
];

/**
 * Returns the categorical CSS color for a series or slice index.
 */
export function resolveSeriesColor(index: number, customColor?: string): string {
  if (typeof customColor === 'string' && customColor.trim().length > 0) {
    return customColor.trim();
  }
  return DEFAULT_CHART_COLORS[Math.abs(index) % DEFAULT_CHART_COLORS.length];
}

/**
 * Formats a numeric axis tick or data value concisely for SVG labels.
 */
export function formatTickNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (abs >= 10_000) {
    return `${Number((value / 1_000).toFixed(1))}k`;
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Number(value.toFixed(2)));
}

function niceNum(range: number, round: boolean): number {
  if (range <= 0 || !Number.isFinite(range)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

/**
 * Computes human-friendly axis bounds and evenly spaced tick values using Heckbert's nice numbers algorithm.
 */
export function computeNiceTicks(
  minVal: number,
  maxVal: number,
  maxTicks = 5,
  includeZero = true,
): NiceScale {
  let lo = Number.isFinite(minVal) ? minVal : 0;
  let hi = Number.isFinite(maxVal) ? maxVal : 0;
  if (includeZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    if (lo === 0) {
      return { min: 0, max: 10, step: 2, ticks: [0, 2, 4, 6, 8, 10] };
    }
    const pad = Math.abs(lo) * 0.2 || 1;
    lo -= pad;
    hi += pad;
  }
  const tickCount = Math.max(2, maxTicks);
  const range = niceNum(hi - lo, false);
  const step = niceNum(range / (tickCount - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  const count = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= count && i <= 20; i++) {
    const val = Number((niceMin + i * step).toFixed(10));
    ticks.push(val);
  }
  return { min: niceMin, max: niceMax, step, ticks };
}

/**
 * Converts polar coordinates `(cx, cy, radius, angleInDegrees)` into Cartesian SVG `(x, y)` coordinates.
 * Zero degrees points straight up (12 o'clock).
 */
export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleInDegrees: number,
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: Number((cx + radius * Math.cos(angleInRadians)).toFixed(3)),
    y: Number((cy + radius * Math.sin(angleInRadians)).toFixed(3)),
  };
}

/**
 * Builds an SVG `<path d="...">` string for a filled pie wedge or donut sector from `startAngle` to `endAngle` (degrees).
 */
export function describeSectorPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const clampedSpan = Math.min(359.999, Math.max(0, endAngle - startAngle));
  const actualEnd = startAngle + clampedSpan;
  const largeArcFlag = clampedSpan > 180 ? 1 : 0;

  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, actualEnd);

  if (innerRadius <= 0) {
    return [
      `M ${cx} ${cy}`,
      `L ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
      'Z',
    ].join(' ');
  }

  const innerEnd = polarToCartesian(cx, cy, innerRadius, actualEnd);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

/**
 * Normalizes raw `series` and optional `labels` props into finite numeric series ready for rendering.
 */
export function normalizeChartSeries(
  rawSeries: unknown,
  rawLabels?: unknown,
): { series: NormalizedSeries[]; labels: string[] } {
  const labelsArray = Array.isArray(rawLabels) ? rawLabels.map((l) => String(l ?? '')) : [];

  if (!Array.isArray(rawSeries)) {
    return { series: [], labels: labelsArray };
  }

  let maxPoints = labelsArray.length;
  const normalized: NormalizedSeries[] = [];

  for (let sIdx = 0; sIdx < rawSeries.length; sIdx++) {
    const item = rawSeries[sIdx];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name =
      typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : `Series ${sIdx + 1}`;
    const customColor = typeof rec.color === 'string' ? rec.color : undefined;
    const rawValues = Array.isArray(rec.values) ? rec.values : [];
    const points: NormalizedPoint[] = [];

    for (let pIdx = 0; pIdx < rawValues.length; pIdx++) {
      const pt = rawValues[pIdx];
      const fallbackLabel = labelsArray[pIdx] ?? String(pIdx + 1);
      if (typeof pt === 'number') {
        const y = Number.isFinite(pt) ? pt : 0;
        points.push({ index: pIdx, x: pIdx, y, label: fallbackLabel });
      } else if (pt && typeof pt === 'object') {
        const ptObj = pt as Record<string, unknown>;
        const rawX = Number(ptObj.x);
        const rawY = Number(ptObj.y);
        const x = Number.isFinite(rawX) ? rawX : pIdx;
        const y = Number.isFinite(rawY) ? rawY : 0;
        const label =
          typeof ptObj.label === 'string' && ptObj.label.trim()
            ? ptObj.label.trim()
            : fallbackLabel;
        points.push({ index: pIdx, x, y, label });
      }
    }

    if (points.length > maxPoints) {
      maxPoints = points.length;
    }

    normalized.push({
      index: sIdx,
      name,
      color: resolveSeriesColor(sIdx, customColor),
      points,
    });
  }

  const finalLabels: string[] = [];
  for (let i = 0; i < maxPoints; i++) {
    finalLabels.push(labelsArray[i] ?? normalized[0]?.points[i]?.label ?? String(i + 1));
  }

  return { series: normalized, labels: finalLabels };
}
