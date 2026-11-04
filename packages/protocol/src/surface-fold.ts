import type { A2uiServerMessage } from './store.js';

/** Payload of a `createSurface` message. */
export type CreateSurfacePayload = NonNullable<A2uiServerMessage['createSurface']>;

/**
 * The complete state of one surface, expressed as a single `createSurface`
 * message. Replaying it into a fresh message processor rebuilds the surface.
 */
export type SurfaceSnapshot = A2uiServerMessage & { createSurface: CreateSurfacePayload };

/** Thrown when a message cannot be folded into a surface snapshot. */
export class FoldError extends Error {
  constructor(
    message: string,
    readonly surfaceId?: string,
  ) {
    super(message);
    this.name = 'FoldError';
  }
}

type JsonRecord = Record<string, unknown>;
type JsonContainer = JsonRecord | unknown[];

const MESSAGE_KINDS = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
] as const;
type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Mirrors `FORBIDDEN_KEYS` in `@a2ui/web_core` `state/data-model.js`. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Mirrors `MAX_ARRAY_INDEX` in `@a2ui/web_core` `state/data-model.js`. */
const MAX_ARRAY_INDEX = 10000;

/** Mirrors `RELAXED_PATH_PATTERN` in `@a2ui/web_core` `validation/integrity-checker.js`. */
const RELAXED_PATH_PATTERN =
  /^(?:(?:\/(?:[^~/]|~[01])*)*|(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*)$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumeric(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Whether a protocol version string (`'1.0'`, `'v1.0'`, `'v0.9'`) is 1.0 or later. */
function isAtLeastV1(version: unknown): boolean {
  const match = typeof version === 'string' ? /^v?(\d+)(?:\.|$)/.exec(version) : null;
  return match !== null && Number(match[1]) >= 1;
}

function messageKind(msg: A2uiServerMessage): MessageKind | undefined {
  return MESSAGE_KINDS.find((kind) => isRecord(msg[kind]));
}

/** Returns the surfaceId a server message targets, or undefined. */
export function messageSurfaceId(msg: A2uiServerMessage): string | undefined {
  const kind = isRecord(msg) ? messageKind(msg) : undefined;
  if (!kind) return undefined;
  const surfaceId = (msg[kind] as JsonRecord).surfaceId;
  return typeof surfaceId === 'string' ? surfaceId : undefined;
}

/**
 * Folds one message into a surface snapshot. Semantics mirror `@a2ui/web_core`
 * 0.15 (`message-processor.js` `applyComponentUpdate` and
 * `processUpdateDataModelOp`, `data-model.js` `set`):
 *
 * - `createSurface` replaces the snapshot with a deep clone. `components`
 *   defaults to `[]`, and a falsy `dataModel` is dropped.
 * - `updateComponents` replaces entries by id and appends new ids. An entry
 *   that omits `component` keeps the prior type. On a pre-1.0 surface it also
 *   keeps the prior `catalogId` unless it names its own; from v1.0 an entry
 *   that names no `catalogId` moves to the surface default catalog.
 * - `updateDataModel` with path `''`, `'/'`, or no path sets the root, and a
 *   null or missing root value becomes `{}`. Empty segments are dropped, so
 *   `/a//b` is `/a/b`. A null or missing `value` removes an object key, writes
 *   `null` at an array index (no splice), and is a no-op when the path is
 *   absent. Numeric segments index into arrays in place; missing containers
 *   are created as arrays when the next segment is numeric and objects
 *   otherwise.
 * - `deleteSurface` returns null.
 *
 * The input snapshot is never mutated.
 *
 * @throws {FoldError} When an update targets a missing snapshot, or when the
 *     message would be rejected by web_core (bad path, forbidden segment,
 *     write through a primitive, component without id or type).
 */
export function foldSurfaceMessage(
  snapshot: SurfaceSnapshot | null,
  msg: A2uiServerMessage,
): SurfaceSnapshot | null {
  switch (isRecord(msg) ? messageKind(msg) : undefined) {
    case 'createSurface':
      return foldCreateSurface(msg);
    case 'deleteSurface':
      return null;
    case 'updateComponents':
      return foldUpdateComponents(requireSnapshot(snapshot, msg), msg.updateComponents!);
    case 'updateDataModel':
      return foldUpdateDataModel(requireSnapshot(snapshot, msg), msg.updateDataModel!);
    default:
      throw new FoldError(
        'Message has no createSurface, updateComponents, updateDataModel, or deleteSurface payload',
      );
  }
}

/**
 * Returns the messages that rebuild a snapshot in a fresh message processor.
 *
 * From v1.0, `createSurface` carries `components` and `dataModel`, so the
 * snapshot replays as itself. The v0.9 `createSurface` schema is strict and
 * rejects those fields, so a pre-1.0 snapshot expands to a bare
 * `createSurface`, then `updateComponents`, then a root `updateDataModel`.
 */
export function expandSurfaceSnapshot(snapshot: SurfaceSnapshot): A2uiServerMessage[] {
  if (isAtLeastV1(snapshot.version)) return [snapshot];
  const { components, dataModel, ...create } = snapshot.createSurface;
  const { surfaceId } = create;
  const messages: A2uiServerMessage[] = [{ version: snapshot.version, createSurface: create }];
  if (Array.isArray(components) && components.length > 0) {
    messages.push({ version: snapshot.version, updateComponents: { surfaceId, components } });
  }
  if (dataModel) {
    messages.push({
      version: snapshot.version,
      updateDataModel: { surfaceId, path: '/', value: dataModel },
    });
  }
  return messages;
}

function requireSnapshot(
  snapshot: SurfaceSnapshot | null,
  msg: A2uiServerMessage,
): SurfaceSnapshot {
  const surfaceId = messageSurfaceId(msg);
  if (!snapshot) {
    throw new FoldError(`Surface not found for message: ${surfaceId}`, surfaceId);
  }
  if (snapshot.createSurface.surfaceId !== surfaceId) {
    throw new FoldError(
      `Message targets surface ${surfaceId}, but the snapshot is ${snapshot.createSurface.surfaceId}`,
      surfaceId,
    );
  }
  return snapshot;
}

function foldCreateSurface(msg: A2uiServerMessage): SurfaceSnapshot {
  const payload = clone(msg.createSurface!);
  if (!isNonEmptyString(payload.surfaceId)) {
    throw new FoldError('createSurface is missing a surfaceId');
  }
  if (!Array.isArray(payload.components)) {
    payload.components = [];
  }
  if (!payload.dataModel) {
    delete payload.dataModel;
  }
  return { version: msg.version, createSurface: payload };
}

function foldUpdateComponents(
  snapshot: SurfaceSnapshot,
  payload: NonNullable<A2uiServerMessage['updateComponents']>,
): SurfaceSnapshot {
  if (!Array.isArray(payload.components)) {
    throw new FoldError('updateComponents.components must be an array', payload.surfaceId);
  }
  const next = clone(snapshot);
  const components = next.createSurface.components as JsonRecord[];
  const indexById = new Map(components.map((c, i) => [c.id, i]));
  const seen = new Set<string>();
  const v1 = isAtLeastV1(snapshot.version);
  for (const comp of payload.components) {
    const id = requireComponentId(comp, payload.surfaceId);
    if (seen.has(id)) {
      throw new FoldError(`Duplicate component ID: '${id}'`, payload.surfaceId);
    }
    seen.add(id);
    const index = indexById.get(id);
    const prior = index === undefined ? undefined : components[index];
    const merged = mergeComponent(comp as JsonRecord, prior, v1, payload.surfaceId);
    if (index === undefined) {
      indexById.set(id, components.push(merged) - 1);
    } else {
      components[index] = merged;
    }
  }
  return next;
}

function requireComponentId(comp: unknown, surfaceId: string): string {
  if (!isRecord(comp) || !isNonEmptyString(comp.id)) {
    throw new FoldError("Component is missing an 'id'", surfaceId);
  }
  return comp.id;
}

function mergeComponent(
  comp: JsonRecord,
  prior: JsonRecord | undefined,
  v1: boolean,
  surfaceId: string,
): JsonRecord {
  const merged = clone(comp);
  const namesType = isNonEmptyString(comp.component);
  if (!prior) {
    if (!namesType) {
      throw new FoldError(`Cannot create component ${comp.id} without a type.`, surfaceId);
    }
    return merged;
  }
  if (!namesType) {
    merged.component = prior.component;
  }
  const keepsType = !namesType || comp.component === prior.component;
  if (!v1 && keepsType && !isNonEmptyString(comp.catalogId) && prior.catalogId !== undefined) {
    merged.catalogId = prior.catalogId;
  }
  return merged;
}

function foldUpdateDataModel(
  snapshot: SurfaceSnapshot,
  payload: NonNullable<A2uiServerMessage['updateDataModel']>,
): SurfaceSnapshot {
  const path = payload.path as unknown;
  if (path !== undefined && path !== '' && !isValidPointer(path)) {
    throw new FoldError(
      `Invalid path syntax: '${String(path)}' (path must be a valid RFC 6901 JSON Pointer starting with '/')`,
      payload.surfaceId,
    );
  }
  const next = clone(snapshot);
  const root = next.createSurface.dataModel || {};
  next.createSurface.dataModel = setPointer(root, (path as string) || '/', payload.value);
  return next;
}

function isValidPointer(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith('/') && RELAXED_PATH_PATTERN.test(path);
}

function parsePointer(path: string): string[] {
  return path
    .split('/')
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const segment = raw.replace(/~([01])/g, (_, g) => (g === '1' ? '/' : '~'));
      if (FORBIDDEN_KEYS.has(segment)) {
        throw new FoldError(`Forbidden path segment '${segment}' in path '${path}'.`);
      }
      return segment;
    });
}

/** One `get` step: the child at `segment`, or undefined when it is absent. */
function childAt(current: unknown, segment: string): unknown {
  if (current === null || typeof current !== 'object') return undefined;
  if (Array.isArray(current)) {
    const index = isNumeric(segment) ? parseInt(segment, 10) : -1;
    return index >= 0 && index < current.length ? current[index] : undefined;
  }
  return Object.prototype.hasOwnProperty.call(current, segment)
    ? (current as JsonRecord)[segment]
    : undefined;
}

/** Mirrors web_core `DataModel.get`. */
function getPointer(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    current = childAt(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Writes `value` at `path` in `root`, mutating containers in place, and
 * returns the new root. Mirrors web_core `DataModel.set` without `preserveNull`.
 */
function setPointer(root: unknown, path: string, value: unknown): unknown {
  const segments = parsePointer(path);
  if (segments.length === 0) {
    return value === null || value === undefined ? {} : clone(value);
  }
  const removes = value === null || value === undefined;
  if (removes && getPointer(root, segments) === undefined) {
    return root;
  }
  const container = rootContainer(root, path);
  const last = segments.pop()!;
  let current: JsonContainer = container;
  for (let i = 0; i < segments.length; i++) {
    const nextSegment = i < segments.length - 1 ? segments[i + 1] : last;
    current = descend(current, segments[i], nextSegment, path);
  }
  writeLeaf(current, last, removes ? undefined : clone(value), path);
  return container;
}

function rootContainer(root: unknown, path: string): JsonContainer {
  if (root === null || root === undefined) return {};
  if (typeof root !== 'object') {
    throw new FoldError(`Cannot set path '${path}': the data model root is a primitive value.`);
  }
  return root as JsonContainer;
}

function arrayIndex(segment: string, path: string): number {
  if (!isNumeric(segment)) {
    throw new FoldError(
      `Cannot use non-numeric segment '${segment}' on an array in path '${path}'.`,
    );
  }
  const index = parseInt(segment, 10);
  if (index > MAX_ARRAY_INDEX) {
    throw new FoldError(
      `Cannot set path '${path}': array index '${segment}' exceeds maximum supported index (${MAX_ARRAY_INDEX}).`,
    );
  }
  return index;
}

function newContainer(nextSegment: string, path: string): JsonContainer {
  if (!isNumeric(nextSegment)) return {};
  arrayIndex(nextSegment, path);
  return [];
}

function descend(
  current: JsonContainer,
  segment: string,
  nextSegment: string,
  path: string,
): JsonContainer {
  let value: unknown;
  let key: string | number;
  if (Array.isArray(current)) {
    key = arrayIndex(segment, path);
    value = current[key];
  } else {
    key = segment;
    value = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
  }
  if (value === null || value === undefined) {
    const created = newContainer(nextSegment, path);
    (current as JsonRecord)[key] = created;
    return created;
  }
  if (typeof value !== 'object') {
    throw new FoldError(`Cannot set path '${path}': segment '${segment}' is a primitive value.`);
  }
  return value as JsonContainer;
}

/** Writes or (when `value` is undefined) removes the leaf. */
function writeLeaf(parent: JsonContainer, last: string, value: unknown, path: string): void {
  if (Array.isArray(parent)) {
    const index = arrayIndex(last, path);
    if (value !== undefined) {
      parent[index] = value;
    } else if (index < parent.length) {
      // web_core stores `undefined` here, which serializes to `null`.
      parent[index] = null;
    }
    return;
  }
  if (value === undefined) {
    delete parent[last];
  } else {
    parent[last] = value;
  }
}
