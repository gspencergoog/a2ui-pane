/**
 * Render-time checks for preset selections on `ChoicePicker` and `ChoiceCards`.
 *
 * Both components read their selection from a string array. A preset that is a bare
 * string, or that names a value missing from the component's `options`, renders as
 * "nothing selected" with no error anywhere, so an agent can believe it preselected a
 * recommendation when the user sees blank choices. This module finds every bound
 * selection in a batch (including per-item bindings inside `List` templates), wraps
 * scalar presets in a list, and reports presets that match no option.
 */

/** Component types whose `value` is a string-array selection over `options`. */
const CHOICE_COMPONENTS = new Set(['ChoicePicker', 'ChoiceCards']);

/** Maximum number of individual problems listed before summarizing the rest. */
const MAX_LISTED = 6;

/** A scalar preset that was wrapped in a list. */
export interface WrappedPreset {
  surfaceId: string;
  componentId: string;
  path: string;
  value: string;
}

/** A preset that names values missing from the component's options. */
export interface UnknownPreset {
  surfaceId: string;
  componentId: string;
  componentType: string;
  path: string;
  unknown: string[];
  options: string[];
}

/** A preset that is neither a list nor a string or number. */
export interface MalformedPreset {
  surfaceId: string;
  componentId: string;
  path: string;
  value: unknown;
}

/** Result of `checkChoicePresets`. */
export interface ChoicePresetReport {
  /** The input batch plus one `updateDataModel` message per wrapped preset. */
  messages: unknown[];
  wrapped: WrappedPreset[];
  unknown: UnknownPreset[];
  malformed: MalformedPreset[];
}

/** Components and data already live on a surface, used when a batch only updates it. */
export interface LiveSurface {
  components: Iterable<Record<string, unknown>>;
  data: unknown;
}

type Component = Record<string, unknown>;

interface SurfaceView {
  version: unknown;
  components: Map<string, Component>;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return [];
  return path
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAt(data: unknown, path: string): unknown {
  let current = data;
  for (const segment of parsePointer(path)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAt(data: unknown, path: string, value: unknown): unknown {
  const segments = parsePointer(path);
  if (segments.length === 0) return value;
  const root: unknown = isRecord(data) || Array.isArray(data) ? data : {};
  let current: any = root;
  segments.forEach((segment, i) => {
    if (i === segments.length - 1) {
      current[segment] = value;
      return;
    }
    if (!isRecord(current[segment]) && !Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  });
  return root;
}

/** Returns the path of a `{"@path": ...}` (Express) or `{"path": ...}` (v0.9) binding. */
function bindingPath(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const p = value['@path'] ?? value.path;
  return typeof p === 'string' ? p : undefined;
}

/** Resolves a binding path against the current `List` item scope. */
function resolvePath(path: string, scope: string): string {
  if (path.startsWith('/')) return path;
  const rel = path.replace(/^\.\/?/, '');
  if (rel === '') return scope || '/';
  return `${scope}/${rel}`;
}

/** Child component ids referenced by a component's static properties. */
function childIds(component: Component): string[] {
  const ids: string[] = [];
  for (const key of ['child', 'trigger', 'content', 'badge']) {
    if (typeof component[key] === 'string') ids.push(component[key] as string);
  }
  if (Array.isArray(component.children)) {
    for (const c of component.children) if (typeof c === 'string') ids.push(c);
  }
  if (Array.isArray(component.tabs)) {
    for (const t of component.tabs) {
      if (isRecord(t) && typeof t.child === 'string') ids.push(t.child);
    }
  }
  return ids;
}

function optionValues(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  return options
    .filter((o) => isRecord(o) && o.value !== undefined && o.value !== null)
    .map((o) => String((o as Record<string, unknown>).value));
}

function buildViews(
  messages: unknown[],
  live: (surfaceId: string) => LiveSurface | undefined,
): Map<string, SurfaceView> {
  const views = new Map<string, SurfaceView>();
  const viewFor = (sid: string, version: unknown): SurfaceView => {
    let view = views.get(sid);
    if (!view) {
      const existing = live(sid);
      view = { version, components: new Map(), data: clone(existing?.data) };
      for (const c of existing?.components ?? []) {
        if (typeof c.id === 'string') view.components.set(c.id, c);
      }
      views.set(sid, view);
    }
    return view;
  };

  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const create = raw.createSurface;
    if (isRecord(create) && typeof create.surfaceId === 'string') {
      const view: SurfaceView = { version: raw.version, components: new Map(), data: undefined };
      views.set(create.surfaceId, view);
      if (Array.isArray(create.components)) {
        for (const c of create.components) {
          if (isRecord(c) && typeof c.id === 'string') view.components.set(c.id, c);
        }
      }
      if (create.dataModel !== undefined) view.data = clone(create.dataModel);
    }
    const upd = raw.updateComponents;
    if (isRecord(upd) && typeof upd.surfaceId === 'string' && Array.isArray(upd.components)) {
      const view = viewFor(upd.surfaceId, raw.version);
      for (const c of upd.components) {
        if (isRecord(c) && typeof c.id === 'string') view.components.set(c.id, c);
      }
    }
    const data = raw.updateDataModel;
    if (isRecord(data) && typeof data.surfaceId === 'string') {
      const view = viewFor(data.surfaceId, raw.version);
      const path = typeof data.path === 'string' ? data.path : '/';
      view.data = setAt(view.data, path, clone(data.value));
    }
    const del = raw.deleteSurface;
    if (isRecord(del) && typeof del.surfaceId === 'string') views.delete(del.surfaceId);
  }
  return views;
}

/**
 * Checks every `ChoicePicker` and `ChoiceCards` selection in `messages` against its options.
 *
 * Scalar (string or number) presets are wrapped in a list by appending an
 * `updateDataModel` message for that path. Presets naming values missing from the
 * component's options are reported in `unknown`, and other non-list presets in
 * `malformed`; callers should reject the batch when either is non-empty. `live`
 * supplies components and data for surfaces this batch updates without creating.
 */
export function checkChoicePresets(
  messages: unknown[],
  live: (surfaceId: string) => LiveSurface | undefined = () => undefined,
): ChoicePresetReport {
  const views = buildViews(messages, live);
  const wrapped: WrappedPreset[] = [];
  const unknown: UnknownPreset[] = [];
  const malformed: MalformedPreset[] = [];
  const extra: unknown[] = [];

  for (const [surfaceId, view] of views) {
    const seen = new Set<string>();
    const visit = (id: string, scope: string, depth: number): void => {
      const key = `${id}@${scope}`;
      if (depth > 64 || seen.has(key)) return;
      seen.add(key);
      const component = view.components.get(id);
      if (!component) return;

      if (component.component === 'List' && isRecord(component.children)) {
        const listPath = bindingPath(component.children);
        const templateId = component.children.componentId;
        if (listPath !== undefined && typeof templateId === 'string') {
          const abs = resolvePath(listPath, scope);
          const items = getAt(view.data, abs);
          if (Array.isArray(items)) {
            const base = abs === '/' ? '' : abs;
            items.forEach((_, i) => visit(templateId, `${base}/${i}`, depth + 1));
          }
        }
      }
      for (const child of childIds(component)) visit(child, scope, depth + 1);

      if (!CHOICE_COMPONENTS.has(component.component as string)) return;
      const optionsPath = bindingPath(component.options);
      const options = optionValues(
        optionsPath !== undefined
          ? getAt(view.data, resolvePath(optionsPath, scope))
          : component.options,
      );
      const valueBinding = bindingPath(component.value);
      const path = valueBinding !== undefined ? resolvePath(valueBinding, scope) : undefined;
      let selection: unknown = path !== undefined ? getAt(view.data, path) : component.value;
      if (selection === undefined || selection === null) return;

      if (typeof selection === 'string' || typeof selection === 'number') {
        if (path === undefined) return;
        const value = String(selection);
        wrapped.push({ surfaceId, componentId: id, path, value });
        view.data = setAt(view.data, path, [value]);
        extra.push({
          ...(view.version !== undefined ? { version: view.version } : {}),
          updateDataModel: { surfaceId, path, value: [value] },
        });
        selection = [value];
      }
      if (!Array.isArray(selection)) {
        malformed.push({ surfaceId, componentId: id, path: path ?? '(literal)', value: selection });
        return;
      }
      if (options === undefined) return;
      const missing = selection.map(String).filter((v) => !options.includes(v));
      if (missing.length > 0) {
        unknown.push({
          surfaceId,
          componentId: id,
          componentType: component.component as string,
          path: path ?? '(literal)',
          unknown: missing,
          options,
        });
      }
    };
    visit('root', '', 0);
  }

  return {
    messages: extra.length > 0 ? [...messages, ...extra] : messages,
    wrapped,
    unknown,
    malformed,
  };
}

function listed<T>(items: T[], format: (item: T) => string): string {
  const lines = items.slice(0, MAX_LISTED).map((item) => `• ${format(item)}`);
  if (items.length > MAX_LISTED) lines.push(`• ...and ${items.length - MAX_LISTED} more`);
  return lines.join('\n');
}

/** Formats the rejection text for unknown and malformed presets, or `undefined` if none. */
export function formatPresetErrors(report: ChoicePresetReport): string | undefined {
  if (report.unknown.length === 0 && report.malformed.length === 0) return undefined;
  const parts: string[] = [];
  if (report.unknown.length > 0) {
    const componentIds = [...new Set(report.unknown.map((u) => u.componentId))];
    parts.push(
      `${report.unknown.length} choice preset(s) name values that are not options, so they would render as unselected:\n` +
        listed(
          report.unknown,
          (u) =>
            `${u.componentType} '${u.componentId}' on surface '${u.surfaceId}', ${u.path}: ${u.unknown
              .map((v) => JSON.stringify(v))
              .join(', ')} is not one of [${u.options.join(', ')}]`,
        ) +
        `\nUse option values in the presets, or redefine ${componentIds
          .map((c) => `'${c}'`)
          .join(', ')} with options that match (templates list it under @customize).`,
    );
  }
  if (report.malformed.length > 0) {
    parts.push(
      `${report.malformed.length} choice preset(s) are not string arrays:\n` +
        listed(
          report.malformed,
          (m) =>
            `'${m.componentId}' on surface '${m.surfaceId}', ${m.path}: ${JSON.stringify(m.value)}`,
        ) +
        '\nSelections are string arrays even for a single choice, for example ["p0"].',
    );
  }
  return `A2UI Choice Preset Check Failed.\n${parts.join('\n\n')}\n\nNothing was rendered. Fix the presets and try again.`;
}

/** Formats a note describing wrapped scalar presets, or `undefined` if none. */
export function formatWrappedNote(report: ChoicePresetReport): string | undefined {
  if (report.wrapped.length === 0) return undefined;
  return (
    `Note: wrapped ${report.wrapped.length} single-value choice preset(s) in a list, because selections are string arrays:\n` +
    listed(
      report.wrapped,
      (w) => `${w.path}: ${JSON.stringify(w.value)} -> ${JSON.stringify([w.value])}`,
    ) +
    '\nWrite them as lists next time.'
  );
}
