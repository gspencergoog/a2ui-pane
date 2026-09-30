import { basicCatalog } from '@a2ui/web_core/v0_9';
import type { Catalog } from '@a2ui/web_core/catalog';

/**
 * Registry holding available A2UI component catalogs for validation and instructions.
 * Supports canonical catalog registration and alias mappings so MessageProcessor matches
 * short IDs (e.g. "basic") while instructions output only primary catalogs.
 */
export class CatalogRegistry {
  private readonly primaryCatalogs = new Map<string, Catalog<any>>();
  private readonly allCatalogs = new Map<string, Catalog<any>>();
  private readonly defaultCatalogId: string;

  constructor() {
    this.defaultCatalogId = basicCatalog.id || 'basic';
    this.register(basicCatalog as unknown as Catalog<any>);

    // Register standard aliases mapping to basicCatalog
    this.registerAlias(basicCatalog as unknown as Catalog<any>, 'basic');
    this.registerAlias(basicCatalog as unknown as Catalog<any>, 'v0_9/basic');
    this.registerAlias(
      basicCatalog as unknown as Catalog<any>,
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
      this.primaryCatalogs.get(this.defaultCatalogId) || (basicCatalog as unknown as Catalog<any>)
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
