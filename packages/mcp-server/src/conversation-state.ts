import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiServerMessage, isValidId } from '@a2ui-pane/protocol';
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
   * Extracts the surfaceId targeted by an A2UI message, if present.
   */
  private getSurfaceId(msg: Record<string, unknown>): string | undefined {
    return (
      (msg.createSurface as any)?.surfaceId ||
      (msg.updateComponents as any)?.surfaceId ||
      (msg.updateDataModel as any)?.surfaceId ||
      (msg.deleteSurface as any)?.surfaceId
    );
  }

  /**
   * When a batch creates new surface(s), returns deleteSurface messages for any
   * pre-existing surfaces not referenced in the incoming batch.
   */
  private collectStaleSurfaceDeletes(messages: unknown[]): A2uiServerMessage[] {
    const hasCreateSurface = messages.some((m) =>
      Boolean((m as Record<string, unknown>).createSurface),
    );
    if (!hasCreateSurface) return [];

    const batchSurfaceIds = new Set<string>();
    for (const m of messages) {
      const sid = this.getSurfaceId(m as Record<string, unknown>);
      if (sid) batchSurfaceIds.add(sid);
    }

    const deletes: A2uiServerMessage[] = [];
    for (const existingId of Array.from(this.processor.getSurfaces().keys())) {
      if (!batchSurfaceIds.has(existingId)) {
        deletes.push({
          version: 'v0.9',
          deleteSurface: { surfaceId: existingId },
        });
      }
    }
    return deletes;
  }

  /**
   * Validates and applies a batch of server messages.
   * Performs pre-validation on envelopes and surfaceIds prior to mutating the processor,
   * guaranteeing strict atomic rollback if any message fails.
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

    // Step 1: Pre-validate structural envelopes and surfaceIds for the entire batch
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

      const sid = this.getSurfaceId(candidate);
      if (sid !== undefined && !isValidId(sid)) {
        return {
          ok: false,
          issues: [
            {
              messageIndex: i,
              message: `Invalid surfaceId '${sid}'. ID must match ^[A-Za-z0-9_-]{1,128}$.`,
            },
          ],
        };
      }
    }

    // Step 2: Sequentially apply messages to processor with rollback on failure.
    // Automatically delete pre-existing surfaces not referenced when creating a new surface.
    const validMessages: A2uiServerMessage[] = [];
    const surfaceIds = new Set<string>();
    for (const delMsg of this.collectStaleSurfaceDeletes(messages)) {
      this.processor.processMessages([delMsg as any]);
      validMessages.push(delMsg);
    }

    for (let i = 0; i < messages.length; i++) {
      const candidate = messages[i] as Record<string, unknown>;
      const sid = this.getSurfaceId(candidate);
      if (sid) {
        surfaceIds.add(sid);
      }

      try {
        this.processor.processMessages([candidate as any]);
        validMessages.push(candidate as A2uiServerMessage);
      } catch (err: any) {
        // Roll back state by rebuilding from the persistent store
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

    // Step 3: All messages verified successfully on the processor — commit to persistent store
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
