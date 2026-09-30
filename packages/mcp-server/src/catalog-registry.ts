import { basicCatalog } from '@a2ui/web_core/v0_9';
import type { Catalog } from '@a2ui/web_core/catalog';

/**
 * Registry holding available A2UI component catalogs for validation and instructions.
 * Also registers alias catalog proxies so MessageProcessor can match short IDs like "basic".
 */
export class CatalogRegistry {
  private readonly catalogs = new Map<string, Catalog<any>>();
  private readonly defaultCatalogId: string;

  constructor() {
    this.defaultCatalogId = basicCatalog.id || 'basic';
    this.register(basicCatalog as unknown as Catalog<any>);

    // Create alias catalog proxies that share the same component implementations
    // but report the alias id so MessageProcessor.processMessages matches createSurface.catalogId
    this.registerAlias(basicCatalog as unknown as Catalog<any>, 'basic');
    this.registerAlias(basicCatalog as unknown as Catalog<any>, 'v0_9/basic');
    this.registerAlias(
      basicCatalog as unknown as Catalog<any>,
      'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json',
    );
  }

  /**
   * Registers a catalog alias proxy with a distinct ID.
   */
  private registerAlias(original: Catalog<any>, aliasId: string): void {
    const aliasProxy = Object.create(original);
    aliasProxy.id = aliasId;
    this.catalogs.set(aliasId, aliasProxy);
  }

  /**
   * Registers a catalog in the registry.
   */
  register(catalog: Catalog<any>): void {
    const id = catalog.id || 'custom-catalog';
    this.catalogs.set(id, catalog);
  }

  /**
   * Retrieves a catalog by ID or alias.
   */
  get(id: string): Catalog<any> | undefined {
    return this.catalogs.get(id);
  }

  /**
   * Returns the default basic catalog.
   */
  getDefaultCatalog(): Catalog<any> {
    return this.catalogs.get(this.defaultCatalogId) || (basicCatalog as unknown as Catalog<any>);
  }

  /**
   * Lists all catalogs registered (including alias proxies) so MessageProcessor can resolve any alias.
   */
  list(): Catalog<any>[] {
    return Array.from(this.catalogs.values());
  }

  /**
   * Lists primary unique catalogs (ignoring alias proxies) for human-facing prompt generation.
   */
  listPrimary(): Catalog<any>[] {
    const unique = new Map<string, Catalog<any>>();
    for (const cat of this.catalogs.values()) {
      // Pick canonical catalog instance (e.g. basicCatalog with its URL id)
      if (cat.id && cat.id.startsWith('https://')) {
        unique.set(cat.id, cat);
      }
    }
    if (unique.size === 0) {
      unique.set('basic', basicCatalog as unknown as Catalog<any>);
    }
    return Array.from(unique.values());
  }
}
