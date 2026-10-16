import { z } from 'zod';
import {
  Catalog,
  type ComponentApi,
  DataBindingSchema,
  FunctionCallSchema,
  DynamicStringSchema,
  DynamicNumberSchema,
  DynamicBooleanSchema,
  DynamicStringListSchema,
  DynamicValueSchema,
  ActionSchema,
  AccessibilityAttributesSchema,
  registerUniversalElement,
  type WebComponentImplementation,
} from '@a2ui/web_core/v1_0';
import { A2uiChartElement } from './a2ui-chart.js';

/** Canonical catalog URI for the A2UI v1.0 Charts Component Catalog. */
export const CHARTS_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/charts/catalog.json';

/** Zod schema for an individual numeric or `(x, y)` coordinate point. */
export const ChartPointSchema = z.union([
  z.number(),
  z
    .object({
      x: z.number(),
      y: z.number(),
      label: z.string().optional(),
    })
    .strict(),
]);

/** Zod schema for a single named data series inside `Chart.series`. */
export const ChartSeriesSchema = z
  .object({
    name: DynamicStringSchema.describe('REF:#/$defs/DynamicString|Series display name.'),
    values: z
      .union([z.array(ChartPointSchema), DataBindingSchema, FunctionCallSchema])
      .describe('REF:#/$defs/DynamicValue|Numeric values or {x, y} points for this series.'),
    color: DynamicStringSchema.describe(
      'REF:#/$defs/DynamicString|Optional CSS color override for this series.',
    ).optional(),
  })
  .strict();

/** Zod schema for a static array or dynamic binding to a list of `ChartSeries` items. */
export const DynamicChartSeriesListSchema = z
  .union([z.array(ChartSeriesSchema), DataBindingSchema, FunctionCallSchema])
  .describe('REF:#/$defs/DynamicChartSeriesList|One or more data series to plot.');

/** ComponentApi definition for `Chart` in the A2UI v1.0 Charts Catalog. */
export const ChartApi = {
  name: 'Chart',
  schema: z
    .object({
      variant: z
        .enum(['bar', 'stacked-bar', 'horizontal-bar', 'line', 'area', 'pie', 'donut', 'scatter'])
        .describe('Visual chart layout variant.'),
      series: DynamicChartSeriesListSchema,
      labels: DynamicStringListSchema.describe(
        'REF:common_types.json#/$defs/DynamicStringList|Category labels along the X axis or slice labels.',
      ).optional(),
      title: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional chart heading rendered above the plot area.',
      ).optional(),
      xAxisLabel: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional caption rendered below the horizontal axis.',
      ).optional(),
      yAxisLabel: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional caption rendered beside the vertical axis.',
      ).optional(),
      height: DynamicNumberSchema.describe(
        'REF:common_types.json#/$defs/DynamicNumber|Plot height in CSS pixels (defaults to 220).',
      ).optional(),
      showLegend: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|Whether to render the series or slice legend.',
      ).optional(),
      showGrid: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|Whether to render background grid lines.',
      ).optional(),
      selected: DynamicValueSchema.describe(
        'REF:common_types.json#/$defs/DynamicValue|Two-way bound selection state.',
      ).optional(),
      action: ActionSchema.describe(
        'REF:common_types.json#/$defs/Action|Action dispatched when the user activates a datum.',
      ).optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Web Component implementation pairing `A2uiChartElement` (`<a2ui-chart>`) with `ChartApi`. */
export const A2uiChart: WebComponentImplementation<typeof ChartApi.schema> = {
  ...ChartApi,
  tagName: A2uiChartElement.tagName,
  element: A2uiChartElement,
};

/** Client-side A2UI v1.0 Charts Catalog containing `A2uiChart`. */
registerUniversalElement(A2uiChart);

export const chartsCatalog = new Catalog(CHARTS_CATALOG_ID, '1.0', [A2uiChart], []);

/** Headless schema-only Charts Catalog for server-side validation. */
export const chartsSchemaCatalog = new Catalog(CHARTS_CATALOG_ID, '1.0', [ChartApi], []);
