import { MessageProcessor } from '@a2ui/web_core/v1_0';
import { StoreLine } from '@a2ui-pane/protocol';
import { createProcessor, ActionHandler } from './processor.js';

/** Recorded failure from applying a single `StoreLine` to the processor. */
export interface LineApplyError {
  seq: number;
  error: string;
}

/** Callback invoked when the processor is reset with a fresh instance. */
export type ResetListener = (newProcessor: MessageProcessor<any>) => void;

const MAX_ERRORS = 50;

/**
 * Sequentially applies JSONL StoreLine updates to a live MessageProcessor.
 * Isolates line failures to prevent cascading crashes, enforces sequence monotonicity,
 * and manages processor resets during stream reconnections.
 */
export class LineApplier {
  private processor: MessageProcessor<any>;
  private lastAppliedSeq = 0;
  private errors: LineApplyError[] = [];
  private readonly processorFactory: () => MessageProcessor<any>;
  private readonly resetListeners = new Set<ResetListener>();

  constructor(
    processorOrFactory?: MessageProcessor<any> | (() => MessageProcessor<any>),
    onAction?: ActionHandler,
  ) {
    if (typeof processorOrFactory === 'function') {
      this.processorFactory = processorOrFactory;
      this.processor = this.processorFactory();
    } else if (processorOrFactory) {
      this.processor = processorOrFactory;
      this.processorFactory = () => createProcessor(onAction);
    } else {
      this.processorFactory = () => createProcessor(onAction);
      this.processor = this.processorFactory();
    }
  }

  getProcessor(): MessageProcessor<any> {
    return this.processor;
  }

  getLastAppliedSeq(): number {
    return this.lastAppliedSeq;
  }

  getErrors(): readonly LineApplyError[] {
    return this.errors;
  }

  clearErrors(): void {
    this.errors = [];
  }

  onReset(listener: ResetListener): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  apply(lines: StoreLine[]): void {
    if (!Array.isArray(lines) || lines.length === 0) return;

    const sortedLines = lines
      .filter((line): line is StoreLine => Boolean(line && typeof line === 'object'))
      .sort((a, b) => a.seq - b.seq);

    for (const line of sortedLines) {
      if (line.seq <= this.lastAppliedSeq) {
        // Drop duplicate or already-applied sequence numbers
        continue;
      }

      try {
        const msg = line.message as Record<string, unknown>;
        const cs =
          msg && typeof msg === 'object'
            ? (msg.createSurface as Record<string, unknown> | undefined)
            : undefined;
        const inferredVer = cs && Array.isArray(cs.components) && !cs.catalogId ? 'v1.0' : 'v0.9';
        const versionedMsg =
          msg && typeof msg === 'object' && !msg.version ? { version: inferredVer, ...msg } : msg;

        this.processor.processMessages([versionedMsg as any]);
        this.lastAppliedSeq = line.seq;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        if (this.errors.length >= MAX_ERRORS) {
          this.errors.shift();
        }
        this.errors.push({
          seq: line.seq,
          error: errorMsg,
        });
      }
    }
  }

  reset(): void {
    if (typeof (this.processor as any).dispose === 'function') {
      try {
        (this.processor as any).dispose();
      } catch {
        // Safe disposal
      }
    }
    this.processor = this.processorFactory();
    this.lastAppliedSeq = 0;
    this.errors = [];

    for (const listener of this.resetListeners) {
      try {
        listener(this.processor);
      } catch (err) {
        console.error('[LineApplier] Error in reset listener:', err);
      }
    }
  }
}
