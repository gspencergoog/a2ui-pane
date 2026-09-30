import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { StoreLine } from '@a2ui-pane/protocol';
import { createProcessor, ActionHandler } from './processor.js';

export interface LineApplyError {
  seq: number;
  error: string;
}

export type ResetListener = (newProcessor: MessageProcessor<any>) => void;

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

    for (const line of lines) {
      if (!line || typeof line !== 'object') continue;

      if (line.seq <= this.lastAppliedSeq) {
        // Drop duplicate or already-applied sequence numbers
        continue;
      }

      try {
        const msg = line.message as Record<string, unknown>;
        const versionedMsg =
          msg && typeof msg === 'object' && !msg.version ? { version: 'v0.9', ...msg } : msg;

        this.processor.processMessages([versionedMsg as any]);
        this.lastAppliedSeq = line.seq;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
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
