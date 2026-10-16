import { Catalog, MessageProcessor, basicCatalog as v1BasicCatalog } from '@a2ui/web_core/v1_0';
import { basicCatalog as v09BasicCatalog } from '@a2ui/lit/v0_9';
import { A2uiActionDetails } from '@a2ui-pane/protocol';
import { chartsCatalog } from './charts-catalog.js';

/** Callback invoked when a user interacts with an A2UI surface component. */
export type ActionHandler = (
  action: A2uiActionDetails,
  dataModel?: Record<string, unknown>,
) => void;

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

/**
 * Creates a configured MessageProcessor with v1.0 basicCatalog, chartsCatalog, and v0.9 compatibility aliases.
 * When actions are dispatched, attaches the client data model if sendDataModel was enabled for the surface.
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
    v09BasicCatalog as unknown as Catalog<any>,
    createCatalogAlias(v09BasicCatalog as unknown as Catalog<any>, 'basic'),
    createCatalogAlias(v09BasicCatalog as unknown as Catalog<any>, 'v0_9/basic'),
    createCatalogAlias(
      v09BasicCatalog as unknown as Catalog<any>,
      'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json',
    ),
  ];

  const allCatalogs = [...aliases, ...additionalCatalogs];

  const processor: MessageProcessor<any> = new MessageProcessor(
    allCatalogs,
    (action: any) => {
      if (!onAction) return;

      const surfaceId = action?.surfaceId;
      const surface = surfaceId ? processor.getSurface(surfaceId) : undefined;
      let dataModel: Record<string, unknown> | undefined;

      if (surface?.sendDataModel) {
        const targetVersion = surface.defaultCatalog?.protocolVersion === '1.0' ? 'v1.0' : 'v0.9';
        dataModel = processor.getClientDataModel(targetVersion) as
          Record<string, unknown> | undefined;
      }

      onAction(action as A2uiActionDetails, dataModel);
    },
    {
      validationConfig: {
        allowUnknownElements: false,
        allowOrphanComponents: false,
        allowDanglingReferences: false,
        allowMissingRoot: false,
      },
    },
  );

  return processor;
}
