import fs from 'node:fs';
import path from 'node:path';

export type TemplateSurface = 'inline' | 'pane' | 'either';

export interface TemplateEntry {
  id: string;
  path: string;
  source: 'user' | 'plugin';
  surface: TemplateSurface;
  summary: string;
  /** Data keys declared by the `// @data` header line, as written. */
  dataKeys: string[];
  /** Action event name declared by the `// @action` header line. */
  action?: string;
  /** Component variable names declared by the `// @customize` header line. */
  customize: string[];
}

const TEMPLATE_ID_RE = /^[a-z][a-z0-9_]*$/;
const HEADER_LINE_RE = /^\s*\/\/\s*@(\w+)\s*(.*)$/;

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
        action: header.action,
        customize: header.customize,
      });
    }
  }
}
