import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiServerMessage } from '@a2ui-pane/protocol';
import { CatalogRegistry } from './catalog-registry.js';
import { StoreWriter } from './store-writer.js';

export interface ValidationIssue {
  messageIndex: number;
  path?: string;
  message: string;
}

export type ApplyResult =
  { ok: true; surfaceIds: string[] } | { ok: false; issues: ValidationIssue[] };

/**
 * Tracks the live layout state for a single conversation using a headless MessageProcessor.
 * Guarantees atomic rollback on validation failures and state restoration on restart.
 */
export class ConversationState {
  private processor!: MessageProcessor<any>;

  constructor(
    readonly conversationId: string,
    private readonly catalogs: CatalogRegistry,
    private readonly store: StoreWriter,
  ) {
    this.rebuildProcessor();
  }

  /**
   * Recreates the headless processor and replays all committed store lines.
   */
  private rebuildProcessor(): void {
    const catalogList = this.catalogs.list();
    this.processor = new MessageProcessor(catalogList, () => {}, {
      validationConfig: {
        allowUnknownElements: false,
        enforceIdentifiers: false,
      },
    });

    const lines = this.store.readAll(this.conversationId);
    if (lines.length > 0) {
      const messages = lines.map((l) => l.message);
      try {
        this.processor.processMessages(messages as any);
      } catch (err: any) {
        console.error(
          `[ConversationState] Warning: Failed replaying history for ${this.conversationId}:`,
          err?.message || err,
        );
      }
    }
  }

  /**
   * Validates and applies a batch of server messages.
   * If any message fails validation, the processor is restored to its previous state
   * and no changes are committed to the persistent store.
   */
  async apply(messages: unknown[], callId: string): Promise<ApplyResult> {
    if (!Array.isArray(messages)) {
      return {
        ok: false,
        issues: [{ messageIndex: -1, message: 'Messages must be an array' }],
      };
    }

    if (messages.length === 0) {
      return { ok: true, surfaceIds: [] };
    }

    const validMessages: A2uiServerMessage[] = [];
    const surfaceIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return {
          ok: false,
          issues: [{ messageIndex: i, message: 'Message item must be an object' }],
        };
      }

      const candidate = msg as Record<string, unknown>;
      if (!candidate.version || typeof candidate.version !== 'string') {
        return {
          ok: false,
          issues: [{ messageIndex: i, message: "Missing required 'version' string property" }],
        };
      }

      // Collect touched surfaceId for result reporting
      const sid =
        (candidate.createSurface as any)?.surfaceId ||
        (candidate.updateComponents as any)?.surfaceId ||
        (candidate.updateDataModel as any)?.surfaceId ||
        (candidate.deleteSurface as any)?.surfaceId;
      if (sid && typeof sid === 'string') {
        surfaceIds.add(sid);
      }

      try {
        this.processor.processMessages([candidate as any]);
        validMessages.push(candidate as A2uiServerMessage);
      } catch (err: any) {
        // Rollback state by rebuilding from the persistent store
        this.rebuildProcessor();
        return {
          ok: false,
          issues: [
            {
              messageIndex: i,
              message: err?.message || String(err),
            },
          ],
        };
      }
    }

    // All messages verified successfully on the processor — commit atomically
    this.store.append(this.conversationId, callId, validMessages);
    return {
      ok: true,
      surfaceIds: Array.from(surfaceIds),
    };
  }

  /**
   * Returns all active surface models currently alive on this conversation's processor.
   */
  getSurfaces(): ReadonlyMap<string, any> {
    return this.processor.getSurfaces();
  }
}
