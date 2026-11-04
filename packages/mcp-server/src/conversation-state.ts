import { MessageProcessor } from '@a2ui/web_core/v1_0';
import {
  A2uiServerMessage,
  expandSurfaceSnapshot,
  FoldError,
  type StoreLine,
  type SurfaceSnapshot,
} from '@a2ui-pane/protocol';
import { isStorableSurfaceId, StoreLockError } from '@a2ui-pane/protocol/store-fs';
import { CatalogRegistry } from './catalog-registry.js';
import { StoreWriter } from './store-writer.js';

/** Diagnostic issue reported when an A2UI message fails validation. */
export interface ValidationIssue {
  messageIndex: number;
  path?: string;
  message: string;
}

/** Outcome of validating and applying a batch of A2UI messages. */
export type ApplyResult =
  { ok: true; surfaceIds: string[] } | { ok: false; issues: ValidationIssue[] };

type Failure = Extract<ApplyResult, { ok: false }>;

function failure(messageIndex: number, message: string): Failure {
  return { ok: false, issues: [{ messageIndex, message }] };
}

/** Rewrites the legacy `'v1.0'` wire version to the `'1.0'` that web_core 0.15 expects. */
function normalizeVersion<T extends Record<string, unknown>>(msg: T): T {
  return msg.version === 'v1.0' ? { ...msg, version: '1.0' } : msg;
}

/** Extracts the surfaceId targeted by an A2UI message, if present. */
function getSurfaceId(msg: Record<string, unknown>): string | undefined {
  return (
    (msg.createSurface as any)?.surfaceId ||
    (msg.updateComponents as any)?.surfaceId ||
    (msg.updateDataModel as any)?.surfaceId ||
    (msg.deleteSurface as any)?.surfaceId
  );
}

/**
 * Checks the envelope and surfaceId of one message before anything touches the
 * processor. Returns an issue message, or undefined when the message passes.
 */
function envelopeIssue(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return 'Message item must be an object';
  }
  const candidate = msg as Record<string, unknown>;
  if (!candidate.version || typeof candidate.version !== 'string') {
    return "Missing required 'version' string property";
  }
  const sid = getSurfaceId(candidate);
  if (sid !== undefined && !isStorableSurfaceId(sid)) {
    return (
      `Invalid surfaceId '${sid}'. ID must match ^[A-Za-z0-9_-]{1,128}$ ` +
      `and must not start with '_' (reserved for store files).`
    );
  }
  return undefined;
}

/** Reports why a commit failed in terms the calling agent can act on. */
function commitFailureMessage(err: FoldError | StoreLockError): string {
  if (err instanceof StoreLockError) {
    return `The A2UI store for this conversation is busy (${err.message}); retry the render.`;
  }
  const sid = err.surfaceId ?? 'unknown';
  return (
    `Surface ${sid} was removed by the user while this update was in flight; ` +
    're-create it with replace: true if still needed'
  );
}

/**
 * Tracks the live layout state for a single conversation using a headless MessageProcessor.
 * Guarantees atomic rollback on validation failures and state restoration on restart.
 *
 * The store is shared with other writers (other MCP processes, the sidecar's
 * delete route, `/monitor`), so the processor is rebuilt from disk whenever the
 * store's generation differs from the one this instance last saw.
 */
export class ConversationState {
  private processor!: MessageProcessor<any>;
  private lastGeneration = -1;

  constructor(
    readonly conversationId: string,
    private readonly catalogs: CatalogRegistry,
    private readonly store: StoreWriter,
  ) {
    this.rebuildProcessor();
  }

  /**
   * Recreates the headless processor and replays every surface snapshot.
   * The generation is read before the snapshot, so a write that lands in
   * between makes the next `syncWithStore` rebuild again instead of being lost.
   */
  private rebuildProcessor(): void {
    this.processor = new MessageProcessor(this.catalogs.list(), () => {}, {
      validationConfig: {
        allowUnknownElements: false,
        enforceIdentifiers: false,
      },
    });
    this.lastGeneration = this.store.generation(this.conversationId);
    for (const line of this.store.readAll(this.conversationId)) {
      this.replaySnapshot(line);
    }
  }

  /** Replays one snapshot line; a snapshot that fails validation is skipped entirely. */
  private replaySnapshot(line: StoreLine): void {
    const snapshot = line.message as SurfaceSnapshot;
    try {
      const messages = expandSurfaceSnapshot(snapshot).map((m) => normalizeVersion(m as any));
      this.processor.processMessages(messages as any);
    } catch (err: any) {
      console.error(
        `[ConversationState] Warning: Failed replaying history for ${this.conversationId}:`,
        err?.message || err,
      );
      this.dropSurface(snapshot.createSurface?.surfaceId, snapshot.version);
    }
  }

  /** Removes a partially replayed surface so the processor never holds half a snapshot. */
  private dropSurface(surfaceId: string | undefined, version: string): void {
    if (!surfaceId || !this.processor.getSurfaces().has(surfaceId)) return;
    try {
      this.processor.processMessages([
        normalizeVersion({ version, deleteSurface: { surfaceId } }) as any,
      ]);
    } catch {
      // The surface stays; a later rebuild retries.
    }
  }

  /** Rebuilds the processor when another writer changed the store since the last sync. */
  private syncWithStore(): void {
    if (this.store.generation(this.conversationId) !== this.lastGeneration) {
      this.rebuildProcessor();
    }
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
      const sid = getSurfaceId(m as Record<string, unknown>);
      if (sid) batchSurfaceIds.add(sid);
    }

    const deletes: A2uiServerMessage[] = [];
    for (const [existingId, existingSurface] of this.processor.getSurfaces().entries()) {
      if (!batchSurfaceIds.has(existingId)) {
        const ver =
          ((existingSurface as any)?.protocolVersion ??
            existingSurface?.defaultCatalog?.protocolVersion) === '1.0'
            ? '1.0'
            : 'v0.9';
        deletes.push({
          version: ver as any,
          deleteSurface: { surfaceId: existingId },
        });
      }
    }
    return deletes;
  }

  /**
   * Applies the batch to the in-memory processor. Returns the messages to
   * commit, or a failure after rolling the processor back from the store.
   */
  private applyToProcessor(
    messages: unknown[],
    clearStaleSurfaces: boolean,
  ): { valid: A2uiServerMessage[]; surfaceIds: Set<string> } | Failure {
    const valid: A2uiServerMessage[] = [];
    const surfaceIds = new Set<string>();
    if (clearStaleSurfaces) {
      for (const delMsg of this.collectStaleSurfaceDeletes(messages)) {
        this.processor.processMessages([delMsg as any]);
        valid.push(delMsg);
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const candidate = normalizeVersion(messages[i] as Record<string, unknown>);
      const sid = getSurfaceId(candidate);
      if (sid) surfaceIds.add(sid);
      try {
        this.processor.processMessages([candidate as any]);
        valid.push(candidate as A2uiServerMessage);
      } catch (err: any) {
        // Roll back state by rebuilding from the persistent store
        this.rebuildProcessor();
        return failure(i, err?.message || String(err));
      }
    }
    return { valid, surfaceIds };
  }

  /**
   * Commits validated messages. A delete from another writer can land between
   * validation and commit, so fold and lock failures become issues and the
   * processor is rebuilt to match disk.
   */
  private commit(callId: string, messages: A2uiServerMessage[]): Failure | undefined {
    let lines: StoreLine[];
    try {
      lines = this.store.append(this.conversationId, callId, messages);
    } catch (err) {
      if (!(err instanceof FoldError) && !(err instanceof StoreLockError)) throw err;
      this.rebuildProcessor();
      return failure(0, commitFailureMessage(err));
    }
    this.recordCommit(lines);
    return undefined;
  }

  /**
   * Advances `lastGeneration` past this process's own commit. When the
   * commit's first seq does not directly follow the last seen generation,
   * another writer committed in between, so the processor is rebuilt.
   */
  private recordCommit(lines: StoreLine[]): void {
    if (lines.length === 0) return;
    const first = lines[0].seq;
    const last = lines[lines.length - 1].seq;
    if (first - 1 === this.lastGeneration) {
      this.lastGeneration = last;
    } else {
      this.rebuildProcessor();
    }
  }

  /**
   * Validates and applies a batch of server messages.
   * Performs pre-validation on envelopes and surfaceIds prior to mutating the processor,
   * guaranteeing strict atomic rollback if any message fails.
   */
  async apply(
    messages: unknown[],
    callId: string,
    options?: { clearStaleSurfaces?: boolean },
  ): Promise<ApplyResult> {
    if (!Array.isArray(messages)) {
      return failure(-1, 'Messages must be an array');
    }
    if (messages.length === 0) {
      return { ok: true, surfaceIds: [] };
    }

    // Step 1: Pre-validate structural envelopes and surfaceIds for the entire batch
    for (let i = 0; i < messages.length; i++) {
      const issue = envelopeIssue(messages[i]);
      if (issue) return failure(i, issue);
    }

    // Step 2: Pick up foreign writes, then apply to the processor with rollback on failure.
    this.syncWithStore();
    const applied = this.applyToProcessor(messages, options?.clearStaleSurfaces !== false);
    if ('ok' in applied) return applied;

    // Step 3: All messages verified successfully on the processor — commit to persistent store
    const commitFailure = this.commit(callId, applied.valid);
    if (commitFailure) return commitFailure;
    return { ok: true, surfaceIds: Array.from(applied.surfaceIds) };
  }

  /**
   * Returns all active surface models currently alive on this conversation's processor.
   */
  getSurfaces(): ReadonlyMap<string, any> {
    this.syncWithStore();
    return this.processor.getSurfaces();
  }

  /**
   * Reports whether a surface with the given id is currently alive.
   */
  hasSurface(surfaceId: string): boolean {
    this.syncWithStore();
    return this.processor.getSurfaces().has(surfaceId);
  }
}
