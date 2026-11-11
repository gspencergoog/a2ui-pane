import fs from 'node:fs';
import path from 'node:path';

/** Target rendering surface declared by a template's `@genui surface=...` header. */
export type TemplateSurface = 'inline' | 'pane' | 'either';

/** Parsed metadata and file location for a registered `.a2ui` template. */
export interface TemplateEntry {
  id: string;
  path: string;
  source: 'user' | 'plugin';
  surface: TemplateSurface;
  summary: string;
  /** Data keys declared by the `// @data` header line, as written. */
  dataKeys: string[];
  /** Parsed form of `dataKeys`: top-level names, list markers, and list-row shapes. */
  declaredData: DeclaredDataKey[];
  /** Action event name declared by the `// @action` header line. */
  action?: string;
  /** Component variable names declared by the `// @customize` header line. */
  customize: string[];
}

const TEMPLATE_ID_RE = /^[a-z][a-z0-9_]*$/;
const HEADER_LINE_RE = /^\s*\/\/\s*@(\w+)\s*(.*)$/;
/** Matches a `surface(...)` or `deleteSurface(...)` statement at the start of a line. */
const SURFACE_STATEMENT_RE = /^\s*(?:surface|deleteSurface)\s*\(/m;

/**
 * Parses the `// @genui ...` comment block at the top of a template file.
 * Unknown keys are ignored; missing keys get neutral defaults.
 */
export function parseTemplateHeader(source: string): {
  id?: string;
  surface: TemplateSurface;
  summary: string;
  dataKeys: string[];
  action?: string;
  customize: string[];
} {
  const result = {
    surface: 'either' as TemplateSurface,
    summary: '',
    dataKeys: [] as string[],
    customize: [] as string[],
  } as {
    id?: string;
    surface: TemplateSurface;
    summary: string;
    dataKeys: string[];
    action?: string;
    customize: string[];
  };
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = HEADER_LINE_RE.exec(line);
    if (!match) break;
    const [, key, rest] = match;
    switch (key) {
      case 'genui':
        for (const token of rest.split(/\s+/)) {
          const [k, v] = token.split('=');
          if (k === 'id' && v) result.id = v;
          if (k === 'surface' && (v === 'inline' || v === 'pane' || v === 'either')) {
            result.surface = v;
          }
        }
        break;
      case 'summary':
        result.summary = rest.trim();
        break;
      case 'data':
        result.dataKeys = rest.trim().split(/\s+/).filter(Boolean);
        break;
      case 'action':
        result.action = rest.trim();
        break;
      case 'customize':
        result.customize = rest.trim().split(/\s+/).filter(Boolean);
        break;
      default:
        break;
    }
  }
  return result;
}

/** A top-level data key declared by a template's `// @data` line, with its list-row shape if any. */
export interface DeclaredDataKey {
  /** Key name without the leading `/` or trailing `[]` (for example `rows`). */
  name: string;
  /** True when the header wrote the key as `/name[]`. */
  isList: boolean;
  /** Field names from a `{a,b,c}` shape hint that follows a list key; empty when none or nested. */
  rowFields: string[];
}

/**
 * Parses the raw `@data` tokens (`/title`, `/rows[]`, `{label,score}`) into declared keys.
 * A `{...}` token describes the key that precedes it. Nested shapes (containing `:` or inner
 * braces) are kept as opaque and contribute no row fields.
 */
export function parseDeclaredDataKeys(tokens: string[]): DeclaredDataKey[] {
  const keys: DeclaredDataKey[] = [];
  for (const token of tokens) {
    if (token.startsWith('/')) {
      const isList = token.endsWith('[]');
      const name = token.slice(1, isList ? -2 : undefined);
      if (name) keys.push({ name, isList, rowFields: [] });
    } else if (token.startsWith('{') && token.endsWith('}') && keys.length > 0) {
      const inner = token.slice(1, -1);
      if (!/[{}:]/.test(inner)) {
        keys[keys.length - 1].rowFields = inner.split(',').filter(Boolean);
      }
    }
  }
  return keys;
}

/** Strips the `$/` or `/` prefix a caller may write on a data key and keeps the first path segment. */
function topLevelDataKey(key: string): string {
  const clean = key.startsWith('$/') ? key.slice(2) : key.startsWith('/') ? key.slice(1) : key;
  return clean.split('/')[0];
}

/**
 * Checks caller `data` against a template's declared `@data` keys.
 * Returns an error message when the data contains keys the template never reads, or when a
 * declared list key holds objects that share no field with the declared row shape; both cases
 * compile cleanly and then render an empty or stale surface, so they must fail loudly here.
 * Returns undefined when the data is consistent or the template declares no keys.
 */
export function checkTemplateData(
  templateId: string,
  declared: DeclaredDataKey[],
  data: Record<string, unknown>,
): string | undefined {
  if (declared.length === 0) return undefined;
  const byName = new Map(declared.map((k) => [k.name, k]));
  const declaredList = declared
    .map(
      (k) =>
        `${k.name}${k.isList ? '[]' : ''}${k.rowFields.length ? ` {${k.rowFields.join(',')}}` : ''}`,
    )
    .join(', ');
  const unknown: string[] = [];
  const problems: string[] = [];
  for (const [rawKey, value] of Object.entries(data)) {
    const name = topLevelDataKey(rawKey);
    const decl = byName.get(name);
    if (!decl) {
      unknown.push(name);
      continue;
    }
    if (decl.isList && decl.rowFields.length > 0 && Array.isArray(value)) {
      const first = value.find((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
      if (first) {
        const fields = Object.keys(first as Record<string, unknown>);
        if (fields.length > 0 && !fields.some((f) => decl.rowFields.includes(f))) {
          problems.push(
            `\`${name}[]\` rows have fields {${fields.join(',')}} but the template reads {${decl.rowFields.join(',')}}`,
          );
        }
      }
    }
  }
  if (unknown.length > 0) {
    problems.unshift(
      `unknown data key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `\`${k}\``).join(', ')}`,
    );
  }
  if (problems.length === 0) return undefined;
  return (
    `Template '${templateId}' does not read the data you passed: ${problems.join('; ')}. ` +
    `Declared data keys: ${declaredList}. ` +
    `Rename the keys to match (the surface would otherwise render empty), or author the surface with \`dsl\` instead.`
  );
}

/**
 * Discovers `.a2ui` templates across an ordered list of directories.
 * Earlier directories shadow later ones, so a user directory listed first
 * can override a plugin template of the same id.
 */
export class TemplateRegistry {
  private entries = new Map<string, TemplateEntry>();
  private loaded = false;

  constructor(
    private readonly dirs: Array<{ dir: string; source: 'user' | 'plugin' }>,
    private readonly log: (line: string) => void = (line) =>
      console.error(`[template-registry] ${line}`),
  ) {}

  /** Re-reads the template directories on the next lookup. */
  invalidate(): void {
    this.loaded = false;
    this.entries = new Map();
  }

  list(): TemplateEntry[] {
    this.ensureLoaded();
    return Array.from(this.entries.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  resolve(id: string): TemplateEntry | undefined {
    this.ensureLoaded();
    if (!this.entries.has(id)) {
      // A miss may be a template dropped into a user directory after the first scan.
      this.invalidate();
      this.ensureLoaded();
    }
    return this.entries.get(id);
  }

  /**
   * Builds the Express source for a template: a surface header, the template body,
   * then the caller's statements so caller `$/path = ...` assignments override template defaults.
   */
  inflate(
    id: string,
    surfaceId: string,
    options: { sendDataModel?: boolean; callerDsl?: string } = {},
  ): string {
    const entry = this.resolve(id);
    if (!entry) {
      const available = this.list()
        .map((e) => e.id)
        .join(', ');
      throw new Error(`Unknown template '${id}'. Available templates: ${available || '(none)'}`);
    }
    const body = fs.readFileSync(entry.path, 'utf-8');
    const sendDataModel = options.sendDataModel === false ? '' : ', sendDataModel=true';
    const parts = [`surface("${surfaceId}"${sendDataModel})`, body.trimEnd()];
    const caller = options.callerDsl?.trim();
    if (caller && SURFACE_STATEMENT_RE.test(caller)) {
      throw new Error(
        'Template `dsl` must not contain surface(...) or deleteSurface(...): the server emits the surface line, so pass `surfaceId` instead.',
      );
    }
    if (caller) {
      parts.push(`// caller overrides`, caller);
    }
    return parts.join('\n') + '\n';
  }

  /** Markdown index of the registered templates, suitable for `a2ui_instructions`. */
  renderIndex(): string {
    const entries = this.list();
    if (entries.length === 0) return '';
    const lines = [
      '| Template id | Surface | Summary | Data keys | Action | Customize |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ];
    for (const e of entries) {
      lines.push(
        `| \`${e.id}\` | ${e.surface} | ${e.summary || ''} | ${e.dataKeys.map((k) => `\`${k}\``).join(' ')} | ${e.action ? `\`${e.action}\`` : ''} | ${e.customize.map((c) => `\`${c}\``).join(' ')} |`,
      );
    }
    return lines.join('\n');
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    // Load lower-priority directories first so higher-priority ones overwrite.
    for (const { dir, source } of [...this.dirs].reverse()) {
      this.loadDir(dir, source);
    }
  }

  private loadDir(dir: string, source: 'user' | 'plugin'): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // missing directory is fine
    }
    for (const name of names) {
      if (!name.endsWith('.a2ui')) continue;
      const filePath = path.join(dir, name);
      let text: string;
      try {
        text = fs.readFileSync(filePath, 'utf-8');
      } catch (err: any) {
        this.log(`skipping unreadable template ${filePath}: ${err?.message || err}`);
        continue;
      }
      const header = parseTemplateHeader(text);
      const id = header.id ?? name.replace(/\.a2ui$/, '');
      if (!TEMPLATE_ID_RE.test(id)) {
        this.log(`skipping template ${filePath}: invalid id '${id}'`);
        continue;
      }
      const previous = this.entries.get(id);
      if (previous) {
        this.log(`template '${id}' from ${filePath} shadows ${previous.path}`);
      }
      this.entries.set(id, {
        id,
        path: filePath,
        source,
        surface: header.surface,
        summary: header.summary,
        dataKeys: header.dataKeys,
        declaredData: parseDeclaredDataKeys(header.dataKeys),
        action: header.action,
        customize: header.customize,
      });
    }
  }
}
