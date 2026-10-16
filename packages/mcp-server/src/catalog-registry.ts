import { z } from 'zod';
import {
  Catalog,
  type ComponentApi,
  basicCatalog as v1BasicCatalog,
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

    this.registerAlias(v1BasicCatalog as unknown as Catalog<any>, 'v1_0/basic');
    this.registerAlias(chartsSchemaCatalog as unknown as Catalog<any>, 'charts');
    this.registerAlias(chartsSchemaCatalog as unknown as Catalog<any>, 'v1_0/charts');

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
