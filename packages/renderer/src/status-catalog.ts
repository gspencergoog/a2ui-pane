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
  AccessibilityAttributesSchema,
  registerUniversalElement,
  type WebComponentImplementation,
} from '@a2ui/web_core/v1_0';
import { A2uiBadgeElement, STATUS_TONES } from './a2ui-badge.js';
import { A2uiProgressBarElement } from './a2ui-progress-bar.js';
import { A2uiCollapsibleElement } from './a2ui-collapsible.js';

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

registerUniversalElement(A2uiBadge);
registerUniversalElement(A2uiProgressBar);
registerUniversalElement(A2uiCollapsible);

/** Client-side A2UI v1.0 Status Catalog containing `Badge`, `ProgressBar`, and `Collapsible`. */
export const statusCatalog = new Catalog(
  STATUS_CATALOG_ID,
  '1.0',
  [A2uiBadge, A2uiProgressBar, A2uiCollapsible],
  [],
);

/** Headless schema-only Status Catalog for server-side validation. */
export const statusSchemaCatalog = new Catalog(
  STATUS_CATALOG_ID,
  '1.0',
  [BadgeApi, ProgressBarApi, CollapsibleApi],
  [],
);
