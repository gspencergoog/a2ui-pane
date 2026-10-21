import { z } from 'zod';
import {
  Catalog,
  type ComponentApi,
  basicCatalog as v1BasicCatalog,
  ChildSchema,
  DataBindingSchema,
  FunctionCallSchema,
  DynamicStringSchema,
  DynamicNumberSchema,
  DynamicBooleanSchema,
  DynamicStringListSchema,
  DynamicValueSchema,
  ActionSchema,
  AccessibilityAttributesSchema,
} from '@a2ui/web_core/v1_0';
import { basicCatalog as v09BasicCatalog } from '@a2ui/web_core/v0_9';

/** Canonical catalog URI for the A2UI v1.0 Charts Component Catalog. */
export const CHARTS_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/charts/catalog.json';

/** Canonical catalog URI for the A2UI v1.0 Status Component Catalog. */
export const STATUS_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/status/catalog.json';

/** Allowed semantic tone values for `Badge` and `ProgressBar` segments. */
export const STATUS_TONES = ['neutral', 'info', 'active', 'success', 'warning', 'danger'] as const;

const DynamicStatusToneSchema = z
  .union([z.enum(STATUS_TONES), DataBindingSchema, FunctionCallSchema])
  .describe(
    "REF:#/$defs/DynamicStatusTone|Semantic tone ('neutral' | 'info' | 'active' | 'success' | 'warning' | 'danger').",
  );

const ProgressSegmentSchema = z
  .object({
    value: DynamicNumberSchema,
    tone: DynamicStatusToneSchema.optional(),
    label: DynamicStringSchema.optional(),
  })
  .strict();

const DynamicProgressSegmentListSchema = z
  .union([z.array(ProgressSegmentSchema), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicProgressSegmentList|Explicit array of {value, tone, label} segments.',
  );

const StatusItemSchema = z
  .object({
    tone: DynamicStatusToneSchema.optional(),
    status: DynamicStringSchema.optional(),
    label: DynamicStringSchema.optional(),
    detail: DynamicStringSchema.optional(),
  })
  .passthrough();

const DynamicStatusItemListSchema = z
  .union([z.array(StatusItemSchema), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicStatusItemList|Array of status items tallied automatically by tone.',
  );

/** Headless ComponentApi definition for `Badge` in the A2UI v1.0 Status Catalog. */
export const BadgeApi = {
  name: 'Badge',
  schema: z
    .object({
      text: DynamicStringSchema,
      tone: DynamicStatusToneSchema.optional(),
      icon: DynamicStringSchema.optional(),
      pulse: DynamicBooleanSchema.optional(),
      weight: z.number().optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Headless ComponentApi definition for `ProgressBar` in the A2UI v1.0 Status Catalog. */
export const ProgressBarApi = {
  name: 'ProgressBar',
  schema: z
    .object({
      value: DynamicNumberSchema.optional(),
      max: DynamicNumberSchema.optional(),
      segments: DynamicProgressSegmentListSchema.optional(),
      items: DynamicStatusItemListSchema.optional(),
      label: DynamicStringSchema.optional(),
      summary: DynamicStringSchema.optional(),
      indeterminate: DynamicBooleanSchema.optional(),
      weight: z.number().optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Headless ComponentApi definition for `Collapsible` in the A2UI v1.0 Status Catalog. */
export const CollapsibleApi = {
  name: 'Collapsible',
  schema: z
    .object({
      title: DynamicStringSchema,
      child: ChildSchema,
      summary: DynamicStringSchema.optional(),
      badge: ChildSchema.optional(),
      open: DynamicBooleanSchema.optional(),
      weight: z.number().optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

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

const TableColumnSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(TABLE_COLUMN_KINDS).optional(),
    align: z.enum(['start', 'center', 'end']).optional(),
    width: z.string().optional(),
  })
  .strict();

const DynamicTableRowListSchema = z
  .union([z.array(z.object({}).passthrough()), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicTableRowList|Array of row objects keyed by column key, usually $/rows.',
  );

/** Headless ComponentApi definition for `Table` in the A2UI v1.0 Status Catalog. */
export const TableApi = {
  name: 'Table',
  schema: z
    .object({
      columns: z.array(TableColumnSchema),
      rows: DynamicTableRowListSchema,
      caption: DynamicStringSchema.optional(),
      sortable: DynamicBooleanSchema.optional(),
      dense: DynamicBooleanSchema.optional(),
      selected: DynamicNumberSchema.optional(),
      action: ActionSchema.optional(),
      weight: z.number().optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Headless A2UI v1.0 Status Catalog for server-side validation and fallback prompt generation. */
export const statusSchemaCatalog = new Catalog(
  STATUS_CATALOG_ID,
  '1.0',
  [BadgeApi, ProgressBarApi, CollapsibleApi, TableApi],
  [],
);

const ChartPointSchema = z.union([
  z.number(),
  z
    .object({
      x: z.number(),
      y: z.number(),
      label: z.string().optional(),
    })
    .strict(),
]);

const ChartSeriesSchema = z
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

const DynamicChartSeriesListSchema = z
  .union([z.array(ChartSeriesSchema), DataBindingSchema, FunctionCallSchema])
  .describe('REF:#/$defs/DynamicChartSeriesList|One or more data series to plot.');

/** Headless ComponentApi definition for `Chart` in the A2UI v1.0 Charts Catalog. */
export const ChartApi = {
  name: 'Chart',
  schema: z
    .object({
      variant: z
        .enum(['bar', 'stacked-bar', 'horizontal-bar', 'line', 'area', 'pie', 'donut', 'scatter'])
        .describe('Visual chart layout variant.'),
      series: DynamicChartSeriesListSchema,
      labels: DynamicStringListSchema.optional(),
      title: DynamicStringSchema.optional(),
      xAxisLabel: DynamicStringSchema.optional(),
      yAxisLabel: DynamicStringSchema.optional(),
      height: DynamicNumberSchema.optional(),
      showLegend: DynamicBooleanSchema.optional(),
      showGrid: DynamicBooleanSchema.optional(),
      selected: DynamicValueSchema.optional(),
      action: ActionSchema.optional(),
      weight: z.number().optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Headless A2UI v1.0 Charts Catalog for server-side validation and fallback prompt generation. */
export const chartsSchemaCatalog = new Catalog(CHARTS_CATALOG_ID, '1.0', [ChartApi], []);

/**
 * Registry holding available A2UI component catalogs for validation and instructions.
 * Supports canonical catalog registration and alias mappings so MessageProcessor matches
 * short IDs (e.g. "charts", "basic") while instructions output only primary catalogs.
 */
export class CatalogRegistry {
  private readonly primaryCatalogs = new Map<string, Catalog<any>>();
  private readonly allCatalogs = new Map<string, Catalog<any>>();
  private readonly defaultCatalogId: string;

  constructor() {
    this.defaultCatalogId = v1BasicCatalog.id || 'v1_0/basic';
    this.register(v1BasicCatalog as unknown as Catalog<any>);
    this.register(chartsSchemaCatalog as unknown as Catalog<any>);
    this.register(statusSchemaCatalog as unknown as Catalog<any>);

    this.registerAlias(v1BasicCatalog as unknown as Catalog<any>, 'v1_0/basic');
    this.registerAlias(chartsSchemaCatalog as unknown as Catalog<any>, 'charts');
    this.registerAlias(chartsSchemaCatalog as unknown as Catalog<any>, 'v1_0/charts');
    this.registerAlias(statusSchemaCatalog as unknown as Catalog<any>, 'status');
    this.registerAlias(statusSchemaCatalog as unknown as Catalog<any>, 'v1_0/status');

    // Retain v0.9 basicCatalog and aliases for backward compatibility
    const v09Id =
      v09BasicCatalog.id || 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
    this.allCatalogs.set(v09Id, v09BasicCatalog as unknown as Catalog<any>);
    this.registerAlias(v09BasicCatalog as unknown as Catalog<any>, 'basic');
    this.registerAlias(v09BasicCatalog as unknown as Catalog<any>, 'v0_9/basic');
    this.registerAlias(
      v09BasicCatalog as unknown as Catalog<any>,
      'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json',
    );
  }

  /**
   * Registers a primary catalog.
   */
  register(catalog: Catalog<any>): void {
    const id = catalog.id || 'custom-catalog';
    this.primaryCatalogs.set(id, catalog);
    this.allCatalogs.set(id, catalog);
  }

  /**
   * Registers an alias pointing to a primary catalog.
   * Creates a dedicated wrapper object preserving component maps but reporting the alias ID.
   */
  registerAlias(targetCatalog: Catalog<any>, aliasId: string): void {
    const aliasCatalog = Object.create(targetCatalog) as Catalog<any>;
    aliasCatalog.id = aliasId;
    this.allCatalogs.set(aliasId, aliasCatalog);
  }

  /**
   * Retrieves a catalog by canonical ID or alias.
   */
  get(id: string): Catalog<any> | undefined {
    return this.allCatalogs.get(id);
  }

  /**
   * Returns the default basic catalog.
   */
  getDefaultCatalog(): Catalog<any> {
    return (
      this.primaryCatalogs.get(this.defaultCatalogId) || (v1BasicCatalog as unknown as Catalog<any>)
    );
  }

  /**
   * Lists all catalogs registered (including alias wrappers) so MessageProcessor resolves any alias.
   */
  list(): Catalog<any>[] {
    return Array.from(this.allCatalogs.values());
  }

  /**
   * Lists primary unique catalogs (excluding aliases) for human-facing prompt generation.
   */
  listPrimary(): Catalog<any>[] {
    return Array.from(this.primaryCatalogs.values());
  }
}
