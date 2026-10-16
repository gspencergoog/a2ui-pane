import { Catalog, MessageProcessor } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import { A2uiActionDetails } from '@a2ui-pane/protocol';

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
 * Creates a configured MessageProcessor with basicCatalog and version aliases.
 * When actions are dispatched, attaches the client data model if sendDataModel was enabled for the surface.
 */
export function createProcessor(
  onAction?: ActionHandler,
  additionalCatalogs: Catalog<any>[] = [],
): MessageProcessor<any> {
  const aliases: Catalog<any>[] = [
    basicCatalog,
    createCatalogAlias(basicCatalog, 'basic'),
    createCatalogAlias(basicCatalog, 'v0_9/basic'),
    createCatalogAlias(
      basicCatalog,
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
        dataModel = processor.getClientDataModel('v0.9') as Record<string, unknown> | undefined;
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
