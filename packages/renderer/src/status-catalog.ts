import { z } from 'zod';
import {
  Catalog,
  type ComponentApi,
  ChildSchema,
  DataBindingSchema,
  FunctionCallSchema,
  DynamicStringSchema,
  DynamicNumberSchema,
  DynamicBooleanSchema,
  ActionSchema,
  AccessibilityAttributesSchema,
  registerUniversalElement,
  type WebComponentImplementation,
} from '@a2ui/web_core/v1_0';
import { A2uiBadgeElement, STATUS_TONES } from './a2ui-badge.js';
import { A2uiProgressBarElement } from './a2ui-progress-bar.js';
import { A2uiCollapsibleElement } from './a2ui-collapsible.js';
import { A2uiTableElement, TABLE_COLUMN_KINDS } from './a2ui-table.js';
import { A2uiStepperElement, STEPPER_ORIENTATIONS } from './a2ui-stepper.js';

/** Canonical catalog URI for the A2UI v1.0 Status Component Catalog. */
export const STATUS_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/status/catalog.json';

/** Zod schema for a static or data-bound semantic status tone. */
export const DynamicStatusToneSchema = z
  .union([z.enum(STATUS_TONES), DataBindingSchema, FunctionCallSchema])
  .describe(
    "REF:#/$defs/DynamicStatusTone|Semantic tone ('neutral' | 'info' | 'active' | 'success' | 'warning' | 'danger').",
  );

/** Zod schema for an explicit segment in `ProgressBar.segments`. */
export const ProgressSegmentSchema = z
  .object({
    value: DynamicNumberSchema.describe(
      'REF:common_types.json#/$defs/DynamicNumber|Numeric segment value.',
    ),
    tone: DynamicStatusToneSchema.optional(),
    label: DynamicStringSchema.describe(
      'REF:common_types.json#/$defs/DynamicString|Optional segment tooltip label.',
    ).optional(),
  })
  .strict();

/** Zod schema for a static array or dynamic binding to `ProgressSegment` items. */
export const DynamicProgressSegmentListSchema = z
  .union([z.array(ProgressSegmentSchema), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicProgressSegmentList|Explicit array of {value, tone, label} segments.',
  );

/**
 * Zod schema for a status item in `ProgressBar.items`.
 * Uses `.passthrough()` so `progress_board` items (`{status, tone?, label, detail}`) validate cleanly.
 */
export const StatusItemSchema = z
  .object({
    tone: DynamicStatusToneSchema.optional(),
    status: DynamicStringSchema.optional(),
    label: DynamicStringSchema.optional(),
    detail: DynamicStringSchema.optional(),
  })
  .passthrough();

/** Zod schema for a static array or dynamic binding to `StatusItem` objects. */
export const DynamicStatusItemListSchema = z
  .union([z.array(StatusItemSchema), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicStatusItemList|Array of status items tallied automatically by tone.',
  );

/** ComponentApi definition for `Badge` in the A2UI v1.0 Status Catalog. */
export const BadgeApi = {
  name: 'Badge',
  schema: z
    .object({
      text: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Label text displayed inside the badge pill.',
      ),
      tone: DynamicStatusToneSchema.optional(),
      icon: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional icon name rendered before the badge text.',
      ).optional(),
      pulse: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|When true, renders a pulsing indicator dot.',
      ).optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** ComponentApi definition for `ProgressBar` in the A2UI v1.0 Status Catalog. */
export const ProgressBarApi = {
  name: 'ProgressBar',
  schema: z
    .object({
      value: DynamicNumberSchema.describe(
        'REF:common_types.json#/$defs/DynamicNumber|Completed numeric value in single-bar mode.',
      ).optional(),
      max: DynamicNumberSchema.describe(
        'REF:common_types.json#/$defs/DynamicNumber|Maximum numeric value in single-bar mode (defaults to 100).',
      ).optional(),
      segments: DynamicProgressSegmentListSchema.optional(),
      items: DynamicStatusItemListSchema.optional(),
      label: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional heading label above the progress track.',
      ).optional(),
      summary: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional summary text above the right end of the track.',
      ).optional(),
      indeterminate: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|When true, renders an animated indeterminate shimmer.',
      ).optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** ComponentApi definition for `Collapsible` in the A2UI v1.0 Status Catalog. */
export const CollapsibleApi = {
  name: 'Collapsible',
  schema: z
    .object({
      title: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Header title text for the collapsible section.',
      ),
      child: ChildSchema.describe(
        'REF:common_types.json#/$defs/ComponentId|The ID of the child component rendered inside the collapsible body.',
      ),
      summary: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional muted summary text displayed in the header row.',
      ).optional(),
      badge: ChildSchema.describe(
        'REF:common_types.json#/$defs/ComponentId|Optional ID of a Badge or Text component rendered in the header.',
      ).optional(),
      open: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|Whether the section is expanded (supports two-way DataBinding).',
      ).optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Zod schema for a static column definition in `Table.columns`. */
export const TableColumnSchema = z
  .object({
    key: z.string().describe('Row property read for this column.'),
    label: z.string().describe('Header text.'),
    kind: z
      .enum(TABLE_COLUMN_KINDS)
      .describe("How cell values render (defaults to 'text').")
      .optional(),
    align: z
      .enum(['start', 'center', 'end'])
      .describe("Horizontal cell alignment (number columns default to 'end').")
      .optional(),
    width: z.string().describe("Optional CSS width for the column, such as '12ch'.").optional(),
  })
  .strict();

/** Zod schema for a static array or dynamic binding to row objects in `Table.rows`. */
export const DynamicTableRowListSchema = z
  .union([z.array(z.object({}).passthrough()), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicTableRowList|Array of row objects keyed by column key, usually $/rows.',
  );

/** ComponentApi definition for `Table` in the A2UI v1.0 Status Catalog. */
export const TableApi = {
  name: 'Table',
  schema: z
    .object({
      columns: z
        .array(TableColumnSchema)
        .describe('REF:#/$defs/TableColumn|Static column definitions in display order.'),
      rows: DynamicTableRowListSchema,
      caption: DynamicStringSchema.describe(
        'REF:common_types.json#/$defs/DynamicString|Optional caption rendered above the grid.',
      ).optional(),
      sortable: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|When true, clicking a header sorts rows client-side.',
      ).optional(),
      dense: DynamicBooleanSchema.describe(
        'REF:common_types.json#/$defs/DynamicBoolean|When true, uses compact 4px cell padding.',
      ).optional(),
      selected: DynamicNumberSchema.describe(
        'REF:common_types.json#/$defs/DynamicNumber|Zero-based index of the selected row (two-way DataBinding).',
      ).optional(),
      action: ActionSchema.describe(
        'REF:common_types.json#/$defs/Action|Action dispatched when the user activates a row.',
      ).optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Zod schema for a single step in `Stepper.steps`. */
export const StepperStepSchema = z
  .object({
    label: DynamicStringSchema.describe(
      'REF:common_types.json#/$defs/DynamicString|Step label rendered next to the dot.',
    ),
    detail: DynamicStringSchema.describe(
      'REF:common_types.json#/$defs/DynamicString|Optional detail text rendered as a hover tooltip.',
    ).optional(),
  })
  .strict();

/** Zod schema for a static array or dynamic binding to `StepperStep` entries. */
export const DynamicStepperStepListSchema = z
  .union([z.array(StepperStepSchema), DataBindingSchema, FunctionCallSchema])
  .describe(
    'REF:#/$defs/DynamicStepperStepList|Ordered array of {label, detail} steps, usually $/steps.',
  );

/** ComponentApi definition for `Stepper` in the A2UI v1.0 Status Catalog. */
export const StepperApi = {
  name: 'Stepper',
  schema: z
    .object({
      steps: DynamicStepperStepListSchema,
      current: DynamicNumberSchema.describe(
        'REF:common_types.json#/$defs/DynamicNumber|Zero-based index of the current step (values past the end clamp).',
      ),
      tone: DynamicStatusToneSchema.optional(),
      orientation: z
        .enum(STEPPER_ORIENTATIONS)
        .describe("Layout direction of the steps (defaults to 'horizontal').")
        .optional(),
      weight: z
        .number()
        .describe('The relative weight of this component within a Row or Column.')
        .optional(),
      accessibility: AccessibilityAttributesSchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Web Component implementation pairing `A2uiBadgeElement` (`<a2ui-badge>`) with `BadgeApi`. */
export const A2uiBadge: WebComponentImplementation<typeof BadgeApi.schema> = {
  ...BadgeApi,
  tagName: A2uiBadgeElement.tagName,
  element: A2uiBadgeElement,
};

/** Web Component implementation pairing `A2uiProgressBarElement` (`<a2ui-progress-bar>`) with `ProgressBarApi`. */
export const A2uiProgressBar: WebComponentImplementation<typeof ProgressBarApi.schema> = {
  ...ProgressBarApi,
  tagName: A2uiProgressBarElement.tagName,
  element: A2uiProgressBarElement,
};

/** Web Component implementation pairing `A2uiCollapsibleElement` (`<a2ui-collapsible>`) with `CollapsibleApi`. */
export const A2uiCollapsible: WebComponentImplementation<typeof CollapsibleApi.schema> = {
  ...CollapsibleApi,
  tagName: A2uiCollapsibleElement.tagName,
  element: A2uiCollapsibleElement,
};

/** Web Component implementation pairing `A2uiTableElement` (`<a2ui-table>`) with `TableApi`. */
export const A2uiTable: WebComponentImplementation<typeof TableApi.schema> = {
  ...TableApi,
  tagName: A2uiTableElement.tagName,
  element: A2uiTableElement,
};

/** Web Component implementation pairing `A2uiStepperElement` (`<a2ui-stepper>`) with `StepperApi`. */
export const A2uiStepper: WebComponentImplementation<typeof StepperApi.schema> = {
  ...StepperApi,
  tagName: A2uiStepperElement.tagName,
  element: A2uiStepperElement,
};

registerUniversalElement(A2uiBadge);
registerUniversalElement(A2uiProgressBar);
registerUniversalElement(A2uiCollapsible);
registerUniversalElement(A2uiTable);
registerUniversalElement(A2uiStepper);

/** Client-side A2UI v1.0 Status Catalog containing `Badge`, `ProgressBar`, `Collapsible`, `Table`, and `Stepper`. */
export const statusCatalog = new Catalog(
  STATUS_CATALOG_ID,
  '1.0',
  [A2uiBadge, A2uiProgressBar, A2uiCollapsible, A2uiTable, A2uiStepper],
  [],
);

/** Headless schema-only Status Catalog for server-side validation. */
export const statusSchemaCatalog = new Catalog(
  STATUS_CATALOG_ID,
  '1.0',
  [BadgeApi, ProgressBarApi, CollapsibleApi, TableApi, StepperApi],
  [],
);
