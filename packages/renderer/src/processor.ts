import { Catalog, MessageProcessor, basicCatalog as v1BasicCatalog } from '@a2ui/web_core/v1_0';
import { basicCatalog as v09BasicCatalog } from '@a2ui/lit/v0_9';
import { A2uiActionDetails } from '@a2ui-pane/protocol';
import { chartsCatalog } from './charts-catalog.js';
import { statusCatalog } from './status-catalog.js';
import { isOneShotButton } from './button-state.js';

/** Extended action details including resolved one-shot and group metadata. */
export interface DispatchedActionDetails extends A2uiActionDetails {
  oneShot?: boolean;
  group?: string;
}

/** Callback invoked when a user interacts with an A2UI surface component. */
export type ActionHandler = (
  action: DispatchedActionDetails,
  dataModel?: Record<string, unknown>,
) => unknown;

/**
 * Creates an alias Catalog proxy with a rewritten `id` property.
 */
function createCatalogAlias(baseCatalog: Catalog<any>, aliasId: string): Catalog<any> {
  const proxy = Object.create(baseCatalog);
  Object.defineProperty(proxy, 'id', {
    value: aliasId,
    writable: false,
    enumerable: true,
    configurable: true,
  });
  return proxy;
}

let submittedButtonRevision = 0;

function notifySurfaceButtons(surface: any): void {
  const values: Iterable<any> | undefined = surface?.componentsModel?.values;
  if (!values) return;
  const rev = ++submittedButtonRevision;
  for (const comp of values) {
    if (comp?.type === 'Button' && comp.properties && typeof comp.properties === 'object') {
      comp.properties = { ...comp.properties, _submittedRev: rev };
    }
  }
}

/**
 * Marks a button component (and optional `_group`) as submitted in the surface data model
 * and triggers a Lit update on all `Button` components in the surface.
 */
export function markComponentSubmitted(
  processor: MessageProcessor<any> | undefined,
  surfaceId: string,
  componentId?: string,
  group?: string,
): void {
  const surface = processor?.getSurface(surfaceId);
  const dataModel = surface?.dataModel;
  if (!dataModel) return;

  if (componentId) {
    dataModel.set(`/_submitted/${componentId}`, true);
  }
  if (group) {
    dataModel.set(`/_submitted/_group/${group}`, true);
  }
  dataModel.set('/_submitted/_any', true);
  notifySurfaceButtons(surface);
}

/**
 * Clears all `/_submitted` entries on the given surface and re-enables its one-shot buttons.
 */
export function clearSubmittedState(
  processor: MessageProcessor<any> | undefined,
  surfaceId: string,
): void {
  const surface = processor?.getSurface(surfaceId);
  const dataModel = surface?.dataModel;
  if (!dataModel) return;

  dataModel.set('/_submitted', undefined);
  notifySurfaceButtons(surface);
}

/** Data model roots of the surfaces in one view, keyed by surface ID. */
export type SurfaceDataSnapshot = Record<string, Record<string, unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Copies the data model root of every surface, leaving out the internal `/_submitted` flags.
 *
 * Unlike the data model attached to an action, the snapshot covers surfaces that did not
 * enable `sendDataModel`, so it holds everything needed to show the user's entries again
 * with `restoreSurfaceData`. The copy is detached from the live data model.
 */
export function snapshotSurfaceData(
  processor: MessageProcessor<any> | undefined,
): SurfaceDataSnapshot {
  const snapshot: SurfaceDataSnapshot = {};
  if (!processor) return snapshot;

  for (const [surfaceId, surface] of processor.getSurfaces()) {
    const root: unknown = (surface as any)?.dataModel?.get('/');
    if (!isPlainObject(root)) continue;
    const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
    delete copy._submitted;
    snapshot[surfaceId] = copy;
  }
  return snapshot;
}

/**
 * Replaces the data model root of each surface named in `snapshot`.
 *
 * Entries for unknown surfaces and entries that are not objects are skipped. Replacing the
 * root drops the `/_submitted` flags, so call this before `markComponentSubmitted`.
 */
export function restoreSurfaceData(
  processor: MessageProcessor<any> | undefined,
  snapshot: unknown,
): void {
  if (!processor || !isPlainObject(snapshot)) return;

  for (const [surfaceId, root] of Object.entries(snapshot)) {
    const dataModel = processor.getSurface(surfaceId)?.dataModel;
    if (!dataModel || !isPlainObject(root)) continue;
    dataModel.set('/', root);
  }
}

function stripSubmittedFromDataModel(
  rawDataModel: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!rawDataModel || typeof rawDataModel !== 'object') return rawDataModel;
  const clone: Record<string, any> = { ...rawDataModel };
  delete clone._submitted;

  if (clone.surfaces && typeof clone.surfaces === 'object') {
    const nextSurfaces: Record<string, any> = {};
    for (const [sid, surfData] of Object.entries(clone.surfaces)) {
      if (surfData && typeof surfData === 'object' && !Array.isArray(surfData)) {
        const surfClone = { ...(surfData as Record<string, unknown>) };
        delete surfClone._submitted;
        nextSurfaces[sid] = surfClone;
      } else {
        nextSurfaces[sid] = surfData;
      }
    }
    clone.surfaces = nextSurfaces;
  }
  return clone;
}

function resolveActionOneShotMetadata(
  surface: any,
  action: Record<string, any>,
): { oneShot: boolean; group?: string } {
  const contextObj =
    action?.context && typeof action.context === 'object' && !Array.isArray(action.context)
      ? (action.context as Record<string, unknown>)
      : undefined;

  const sourceId = typeof action?.sourceComponentId === 'string' ? action.sourceComponentId : '';
  const compModel = sourceId ? surface?.componentsModel?.get?.(sourceId) : undefined;
  const surfaceComponents = surface?.componentsModel?.values;

  let result: { oneShot: boolean; group?: string };
  if (compModel) {
    result = isOneShotButton(compModel, surfaceComponents, false, contextObj);
  } else {
    const explicitOneShot = contextObj?._oneShot;
    const rawGroup = contextObj?._group;
    result = {
      oneShot: typeof explicitOneShot === 'boolean' ? explicitOneShot : true,
      group: typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined,
    };
  }

  if (contextObj && ('_oneShot' in contextObj || '_group' in contextObj)) {
    const cleanedContext = { ...contextObj };
    delete cleanedContext._oneShot;
    delete cleanedContext._group;
    action.context = cleanedContext;
  }

  return result;
}

function getActionDataModel(
  processor: MessageProcessor<any>,
  surface: any,
): Record<string, unknown> | undefined {
  if (!surface?.sendDataModel) return undefined;
  const targetVersion =
    (surface.protocolVersion ?? surface.defaultCatalog?.protocolVersion) === '1.0' ? '1.0' : 'v0.9';
  const rawDataModel = processor.getClientDataModel(targetVersion) as
    Record<string, unknown> | undefined;
  return stripSubmittedFromDataModel(rawDataModel);
}

function handleProcessorAction(
  processor: MessageProcessor<any>,
  action: any,
  onAction?: ActionHandler,
): unknown {
  const surfaceId = action?.surfaceId;
  const surface = surfaceId ? processor.getSurface(surfaceId) : undefined;
  const { oneShot, group } = resolveActionOneShotMetadata(surface, action);

  if (action && typeof action === 'object') {
    action.oneShot = oneShot;
    if (group !== undefined) {
      action.group = group;
    }
  }

  const dataModel = getActionDataModel(processor, surface);
  if (surfaceId && oneShot) {
    markComponentSubmitted(processor, surfaceId, action?.sourceComponentId, group);
  }

  if (onAction) {
    return onAction(action as DispatchedActionDetails, dataModel);
  }
  return undefined;
}

/**
 * Creates a configured MessageProcessor with v1.0 basicCatalog, chartsCatalog, statusCatalog, and v0.9 compatibility aliases.
 * Evaluates one-shot button state, strips internal `_oneShot`/`_group`/`/_submitted` metadata,
 * and attaches the client data model if `sendDataModel` was enabled for the surface.
 */
export function createProcessor(
  onAction?: ActionHandler,
  additionalCatalogs: Catalog<any>[] = [],
): MessageProcessor<any> {
  const aliases: Catalog<any>[] = [
    v1BasicCatalog as unknown as Catalog<any>,
    createCatalogAlias(v1BasicCatalog as unknown as Catalog<any>, 'v1_0/basic'),
    chartsCatalog as unknown as Catalog<any>,
    createCatalogAlias(chartsCatalog as unknown as Catalog<any>, 'charts'),
    createCatalogAlias(chartsCatalog as unknown as Catalog<any>, 'v1_0/charts'),
    statusCatalog as unknown as Catalog<any>,
    createCatalogAlias(statusCatalog as unknown as Catalog<any>, 'status'),
    createCatalogAlias(statusCatalog as unknown as Catalog<any>, 'v1_0/status'),
    v09BasicCatalog as unknown as Catalog<any>,
    createCatalogAlias(v09BasicCatalog as unknown as Catalog<any>, 'basic'),
    createCatalogAlias(v09BasicCatalog as unknown as Catalog<any>, 'v0_9/basic'),
    createCatalogAlias(
      v09BasicCatalog as unknown as Catalog<any>,
      'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json',
    ),
  ];

  const allCatalogs = [...aliases, ...additionalCatalogs];

  const processor: MessageProcessor<any> = new MessageProcessor(allCatalogs, undefined, {
    validationConfig: {
      allowUnknownElements: false,
      allowOrphanComponents: false,
      allowDanglingReferences: false,
      allowMissingRoot: false,
    },
  });

  processor.model.onSurfaceCreated.subscribe((surface: any) => {
    surface.onAction.subscribe((action: any) => handleProcessorAction(processor, action, onAction));
  });

  return processor;
}
