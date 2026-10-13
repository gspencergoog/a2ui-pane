import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemplateRegistry, parseTemplateHeader } from '../src/template-registry.js';

const SAMPLE = `// @genui id=triage_matrix surface=pane
// @summary Classify items into buckets.
// @data /title /items[] {title,bucket}
// @action submit_triage_matrix
// @customize bucket_picker submit_btn

$/title = "Default title"
root = Card(Text($/title))
`;

describe('parseTemplateHeader', () => {
  it('reads id, surface, summary, data keys, action, and customize', () => {
    const header = parseTemplateHeader(SAMPLE);
    expect(header).toEqual({
      id: 'triage_matrix',
      surface: 'pane',
      summary: 'Classify items into buckets.',
      dataKeys: ['/title', '/items[]', '{title,bucket}'],
      action: 'submit_triage_matrix',
      customize: ['bucket_picker', 'submit_btn'],
    });
  });

  it('stops at the first non-header line and tolerates missing keys', () => {
    const header = parseTemplateHeader('root = Text("x")\n// @summary ignored');
    expect(header.id).toBeUndefined();
    expect(header.surface).toBe('either');
    expect(header.summary).toBe('');
    expect(header.dataKeys).toEqual([]);
    expect(header.customize).toEqual([]);
  });

  it('ignores an invalid surface value', () => {
    expect(parseTemplateHeader('// @genui id=x surface=huge').surface).toBe('either');
  });
});

describe('TemplateRegistry', () => {
  let root: string;
  let userDir: string;
  let pluginDir: string;
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'template-registry-'));
    userDir = join(root, 'user');
    pluginDir = join(root, 'plugin');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'triage_matrix.a2ui'), SAMPLE);
    writeFileSync(join(pluginDir, 'plain.a2ui'), 'root = Text("plain")\n');
    writeFileSync(join(pluginDir, 'Bad-Id.a2ui'), 'root = Text("bad")\n');
    writeFileSync(join(pluginDir, 'notes.txt'), 'ignored');
    logs = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = () =>
    new TemplateRegistry(
      [
        { dir: userDir, source: 'user' },
        { dir: pluginDir, source: 'plugin' },
      ],
      (l) => logs.push(l),
    );

  it('lists valid templates sorted by id, deriving ids from filenames when no header', () => {
    const registry = make();
    expect(registry.list().map((e) => e.id)).toEqual(['plain', 'triage_matrix']);
    expect(logs.some((l) => l.includes("invalid id 'Bad-Id'"))).toBe(true);
    expect(registry.resolve('plain')?.source).toBe('plugin');
  });

  it('tolerates a missing user directory', () => {
    expect(make().resolve('triage_matrix')).toBeDefined();
  });

  it('lets a user template shadow a plugin template and logs it', () => {
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'triage_matrix.a2ui'),
      '// @genui id=triage_matrix\nroot = Text("mine")\n',
    );
    const registry = make();
    const entry = registry.resolve('triage_matrix');
    expect(entry?.source).toBe('user');
    expect(logs.some((l) => l.includes('shadows'))).toBe(true);
  });

  it('inflates with a surface header, the body, and caller overrides last', () => {
    const source = make().inflate('triage_matrix', 'grill-1', { callerDsl: '$/title = "Mine"' });
    const lines = source.trim().split('\n');
    expect(lines[0]).toBe('surface("grill-1", sendDataModel=true)');
    expect(source).toContain('$/title = "Default title"');
    expect(lines[lines.length - 1]).toBe('$/title = "Mine"');
    expect(source.indexOf('Default title')).toBeLessThan(source.indexOf('"Mine"'));
  });

  it('omits sendDataModel when asked and rejects unknown ids with the available list', () => {
    const registry = make();
    expect(registry.inflate('plain', 's', { sendDataModel: false })).toMatch(/^surface\("s"\)\n/);
    expect(() => registry.inflate('nope', 's')).toThrow(
      /Unknown template 'nope'.*plain, triage_matrix/,
    );
  });

  it('renders a markdown index and reloads after invalidate', () => {
    const registry = make();
    const index = registry.renderIndex();
    expect(index).toContain('| `triage_matrix` | pane | Classify items into buckets. |');
    expect(index).toContain('`submit_triage_matrix`');
    expect(index).toContain('`bucket_picker` `submit_btn`');
    writeFileSync(join(pluginDir, 'extra.a2ui'), 'root = Text("extra")\n');
    expect(registry.resolve('extra')).toBeUndefined();
    registry.invalidate();
    expect(registry.resolve('extra')).toBeDefined();
  });

  it('returns an empty index with no templates', () => {
    expect(
      new TemplateRegistry([{ dir: join(root, 'none'), source: 'plugin' }]).renderIndex(),
    ).toBe('');
  });
});
