import { MessageProcessor } from '@a2ui/web_core/v1_0';
import {
  A2uiServerMessage,
  StoreLine,
  SurfaceSnapshot,
  expandSurfaceSnapshot,
  messageSurfaceId,
} from '@a2ui-pane/protocol';
import { createProcessor, ActionHandler } from './processor.js';

/** Recorded failure from applying a single `StoreLine` to the processor. */
export interface LineApplyError {
  seq: number;
  error: string;
}

/** Callback invoked when the processor is reset with a fresh instance. */
export type ResetListener = (newProcessor: MessageProcessor<any>) => void;

const MAX_ERRORS = 50;

/** Key under which lines that name no surface share one seq counter. */
const NO_SURFACE_KEY = '';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoreLine(line: unknown): line is StoreLine {
  return isRecord(line);
}

function sortedLines(lines: StoreLine[]): StoreLine[] {
  return lines.filter(isStoreLine).sort((a, b) => a.seq - b.seq);
}

/**
 * Returns the message with a canonical `version`.
 *
 * A message without `version` is read as `'1.0'` when it is a `createSurface`
 * that carries `components` and names no `catalogId`, and as `'v0.9'`
 * otherwise. `'v1.0'` becomes `'1.0'`, the spelling web_core 0.15 expects.
 *
 * @throws {Error} When the line carries no message object.
 */
function normalizeMessage(message: unknown): A2uiServerMessage {
  if (!isRecord(message)) {
    throw new Error('Store line has no message object');
  }
  const cs = isRecord(message.createSurface) ? message.createSurface : undefined;
  const inferred = cs && Array.isArray(cs.components) && !cs.catalogId ? '1.0' : 'v0.9';
  const raw = message.version || inferred;
  return { ...message, version: raw === 'v1.0' ? '1.0' : raw } as A2uiServerMessage;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Whether a re-sent `createSurface` keeps every surface-level setting of the
 * mounted surface, so only its components and data model can differ.
 */
function sameSurfaceSettings(prev: SurfaceSnapshot, next: SurfaceSnapshot): boolean {
  const a = prev.createSurface as JsonRecord;
  const b = next.createSurface as JsonRecord;
  return (
    prev.version === next.version &&
    a.catalogId === b.catalogId &&
    (a.sendDataModel ?? false) === (b.sendDataModel ?? false) &&
    (a.rootId ?? 'root') === (b.rootId ?? 'root') &&
    sameJson(a.theme, b.theme) &&
    sameJson(a.metadata, b.metadata)
  );
}

/** Whether `components` names every id in `existingIds`. */
function coversComponents(components: unknown, existingIds: Iterable<string>): boolean {
  const ids = new Set(
    (Array.isArray(components) ? components : []).map((c) => (isRecord(c) ? c.id : undefined)),
  );
  for (const id of existingIds) {
    if (!ids.has(id)) return false;
  }
  return true;
}

/**
 * Applies JSONL `StoreLine` updates to a live `MessageProcessor`.
 *
 * Each surface tracks its own last applied seq, so a line is skipped only when
 * its seq is at or below the one recorded for its surface. A `deleteSurface`
 * line removes the surface's entry, so a later re-create is never skipped.
 * Line failures are recorded rather than thrown, so one bad line never stops
 * the ones after it.
 *
 * A `createSurface` for a surface that is already mounted replaces it. When
 * the surface-level settings are unchanged and no component is removed, the
 * replacement is applied in place, which keeps the rendered elements (and
 * their scroll position) alive. Otherwise the surface is deleted and created
 * again.
 */
export class LineApplier {
  private processor: MessageProcessor<any>;
  private readonly surfaceSeq = new Map<string, number>();
  /** The `createSurface` each mounted surface was last built from. */
  private readonly snapshots = new Map<string, SurfaceSnapshot>();
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

  /**
   * Returns the highest seq applied to any live surface, or 0.
   *
   * Callers that number every line with one global counter on a single surface
   * see the same value as before seqs were tracked per surface.
   */
  getLastAppliedSeq(): number {
    let max = 0;
    for (const seq of this.surfaceSeq.values()) {
      if (seq > max) max = seq;
    }
    return max;
  }

  /** Returns the last applied seq of one surface, or undefined when none is recorded. */
  getSurfaceSeq(surfaceId: string): number | undefined {
    return this.surfaceSeq.get(surfaceId);
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

  /** Applies lines in seq order, skipping lines at or below their surface's recorded seq. */
  apply(lines: StoreLine[]): void {
    if (!Array.isArray(lines) || lines.length === 0) return;
    for (const line of sortedLines(lines)) {
      this.applyLine(line);
    }
  }

  /**
   * Makes the processor match a complete set of live surfaces.
   *
   * Deletes every mounted surface that `lines` does not name, forgets the seqs
   * of surfaces that are gone, and then applies `lines`.
   *
   * @param lines One line per live surface, as sent by the `snapshot` stream event.
   */
  reconcile(lines: StoreLine[]): void {
    const valid = Array.isArray(lines) ? sortedLines(lines) : [];
    const live = new Set<string>();
    for (const line of valid) {
      const sid = isRecord(line.message) ? messageSurfaceId(line.message) : undefined;
      if (sid !== undefined) live.add(sid);
    }
    for (const sid of Array.from(this.processor.getSurfaces().keys()) as string[]) {
      if (!live.has(sid)) this.removeSurface(sid);
    }
    for (const sid of Array.from(this.surfaceSeq.keys())) {
      if (!live.has(sid)) this.surfaceSeq.delete(sid);
    }
    this.apply(valid);
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
    this.surfaceSeq.clear();
    this.snapshots.clear();
    this.errors = [];

    for (const listener of this.resetListeners) {
      try {
        listener(this.processor);
      } catch (err) {
        console.error('[LineApplier] Error in reset listener:', err);
      }
    }
  }

  private applyLine(line: StoreLine): void {
    try {
      const msg = normalizeMessage(line.message);
      const sid = messageSurfaceId(msg) ?? NO_SURFACE_KEY;
      if (this.isStale(sid, line.seq, Boolean(msg.deleteSurface))) return;
      this.dispatch(msg, sid);
      if (msg.deleteSurface) {
        this.surfaceSeq.delete(sid);
      } else {
        this.surfaceSeq.set(sid, line.seq);
      }
    } catch (err: any) {
      this.recordError(line.seq, err?.message || String(err));
    }
  }

  /**
   * Whether a line is already reflected for its surface.
   *
   * A delete is stale only below the recorded seq. The sidecar numbers a
   * tombstone with the store generation, which can equal the seq of the
   * surface's last write.
   */
  private isStale(sid: string, seq: number, isDelete: boolean): boolean {
    const recorded = this.surfaceSeq.get(sid);
    if (recorded === undefined) return false;
    return isDelete ? seq < recorded : seq <= recorded;
  }

  private dispatch(msg: A2uiServerMessage, sid: string): void {
    if (msg.createSurface) {
      this.applyCreate(msg as SurfaceSnapshot, sid);
      return;
    }
    this.processor.processMessages([msg as any]);
    if (msg.deleteSurface) this.snapshots.delete(sid);
  }

  private applyCreate(snapshot: SurfaceSnapshot, sid: string): void {
    if (this.processor.getSurface(sid)) {
      this.applyCreateInPlace(snapshot, sid);
    } else {
      this.createSurface(snapshot, sid);
    }
  }

  /** Builds a surface from a snapshot, expanding pre-1.0 snapshots into three messages. */
  private createSurface(snapshot: SurfaceSnapshot, sid: string): void {
    this.processor.processMessages(expandSurfaceSnapshot(snapshot) as any[]);
    this.snapshots.set(sid, snapshot);
  }

  /**
   * Replaces a mounted surface with a new `createSurface` snapshot.
   *
   * Updates components and the root data model in place when the settings
   * match the snapshot the surface was built from and every existing
   * component id is still present. Otherwise deletes and re-creates the
   * surface, which also fires `onSurfaceCreated`.
   */
  private applyCreateInPlace(snapshot: SurfaceSnapshot, sid: string): void {
    const prev = this.snapshots.get(sid);
    const surface = this.processor.getSurface(sid) as any;
    const existingIds: Iterable<string> = surface?.componentsModel?.keys ?? [];
    const cs = snapshot.createSurface as JsonRecord;
    if (
      !prev ||
      !sameSurfaceSettings(prev, snapshot) ||
      !coversComponents(cs.components, existingIds)
    ) {
      this.removeSurface(sid);
      this.createSurface(snapshot, sid);
      return;
    }
    const version = snapshot.version;
    const messages: unknown[] = [];
    if (Array.isArray(cs.components) && cs.components.length > 0) {
      messages.push({ version, updateComponents: { surfaceId: sid, components: cs.components } });
    }
    messages.push({
      version,
      updateDataModel: { surfaceId: sid, path: '/', value: cs.dataModel ?? {} },
    });
    this.processor.processMessages(messages as any[]);
    this.snapshots.set(sid, snapshot);
  }

  private removeSurface(sid: string): void {
    const version = this.snapshots.get(sid)?.version ?? '1.0';
    this.snapshots.delete(sid);
    try {
      this.processor.processMessages([{ version, deleteSurface: { surfaceId: sid } } as any]);
    } catch (err: any) {
      this.recordError(this.surfaceSeq.get(sid) ?? 0, err?.message || String(err));
    }
  }

  private recordError(seq: number, error: string): void {
    if (this.errors.length >= MAX_ERRORS) {
      this.errors.shift();
    }
    this.errors.push({ seq, error });
  }
}
