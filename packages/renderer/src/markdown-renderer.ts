import { renderMarkdown } from '@a2ui/markdown-it';
import {
  computeNiceTicks,
  describeSectorPath,
  formatTickNumber,
  polarToCartesian,
  resolveSeriesColor,
} from './chart-math.js';
import {
  type MermaidLayoutOptions,
  parseFlowchartLines,
  parseStateDiagramLines,
  renderFlowchartGraphSvg,
} from './mermaid-flowchart.js';

/** Configuration options for the rich Markdown, MathML, and Mermaid renderer. */
export interface RichMarkdownOptions {
  tagClassMap?: Record<string, string[]>;
  mermaidRenderer?: (code: string) => Promise<string> | string;
  readonly mermaidLayout?: MermaidLayoutOptions;
}

const GREEK_AND_SYMBOLS: Readonly<Record<string, string>> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  infty: '∞',
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '⋅',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  forall: '∀',
  exists: '∃',
  nabla: '∇',
  partial: '∂',
  sum: '∑',
  prod: '∏',
  int: '∫',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
};

const MATHCAL_MAP: Readonly<Record<string, string>> = {
  A: '𝒜',
  B: 'ℬ',
  C: '𝒞',
  D: '𝒟',
  E: 'ℰ',
  F: 'ℱ',
  G: '𝒢',
  H: 'ℋ',
  I: 'ℐ',
  J: '𝒥',
  K: '𝒦',
  L: 'ℒ',
  M: 'ℳ',
  N: '𝒩',
  O: '𝒪',
  P: '𝒫',
  Q: '𝒬',
  R: 'ℛ',
  S: '𝒮',
  T: '𝒯',
  U: '𝒰',
  V: '𝒱',
  W: '𝒲',
  X: '𝒳',
  Y: '𝒴',
  Z: '𝒵',
};

const MATHBB_MAP: Readonly<Record<string, string>> = {
  A: '𝔸',
  B: '𝔹',
  C: 'ℂ',
  D: '𝔻',
  E: '𝔼',
  F: '𝔽',
  G: '𝔾',
  H: 'ℍ',
  I: '𝕀',
  J: '𝕁',
  K: '𝕂',
  L: '𝕃',
  M: '𝕄',
  N: 'ℕ',
  O: '𝕆',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  S: '𝕊',
  T: '𝕋',
  U: '𝕌',
  V: '𝕍',
  W: '𝕎',
  X: '𝕏',
  Y: '𝕐',
  Z: 'ℤ',
};

const UPRIGHT_FUNCTIONS = new Set([
  'min',
  'max',
  'sup',
  'inf',
  'lim',
  'log',
  'ln',
  'exp',
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'det',
  'dim',
  'ker',
  'deg',
  'gcd',
  'Pr',
  'arg',
  'mod',
]);

const OPERATORS = new Set([
  '+',
  '-',
  '=',
  '<',
  '>',
  '/',
  '*',
  ',',
  ';',
  ':',
  '!',
  '?',
  '|',
  '(',
  ')',
  '[',
  ']',
]);

/**
 * Escapes special HTML characters to prevent injection inside MathML and SVG fragments.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips script blocks, event handlers, and javascript: URIs from external SVG fragments.
 */
function sanitizeSvgFragment(fragment: string): string {
  return fragment
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(?:href|xlink:href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
}

function readBracedGroup(src: string, startIndex: number): { content: string; nextIndex: number } {
  let i = startIndex;
  while (i < src.length && /\s/.test(src[i])) {
    i++;
  }
  if (src[i] !== '{') {
    const ch = src[i] ?? '';
    return { content: ch, nextIndex: ch ? i + 1 : i };
  }
  let depth = 0;
  const contentStart = i + 1;
  while (i < src.length) {
    if (src[i] === '{' && src[i - 1] !== '\\') {
      depth++;
    } else if (src[i] === '}' && src[i - 1] !== '\\') {
      depth--;
      if (depth === 0) {
        return { content: src.slice(contentStart, i), nextIndex: i + 1 };
      }
    }
    i++;
  }
  return { content: src.slice(contentStart), nextIndex: src.length };
}

function renderMatrixEnvironment(envName: string, body: string): string {
  const rows = body
    .trim()
    .split(/\\\\/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const rowsHtml = rows
    .map((row) => {
      const cells = row.split('&').map((c) => `<mtd>${parseLatexTokens(c.trim())}</mtd>`);
      return `<mtr>${cells.join('')}</mtr>`;
    })
    .join('');
  const table = `<mtable>${rowsHtml}</mtable>`;
  if (envName === 'pmatrix') {
    return `<mrow><mo>(</mo>${table}<mo>)</mo></mrow>`;
  }
  if (envName === 'bmatrix') {
    return `<mrow><mo>[</mo>${table}<mo>]</mo></mrow>`;
  }
  return table;
}

const FONT_VARIANT_MAP: Readonly<Record<string, string>> = {
  mathtt: 'monospace',
  mathsf: 'sans-serif',
  mathit: 'italic',
};

function convertMappedChars(text: string, table: Readonly<Record<string, string>>): string {
  return Array.from(text.trim())
    .map((ch) => table[ch] ?? ch)
    .join('');
}

function parseStyledLatexCommand(
  cmd: string,
  src: string,
  end: number,
): { html: string; nextIndex: number } | undefined {
  if (cmd === 'text' || cmd === 'mathrm' || cmd === 'operatorname') {
    const arg = readBracedGroup(src, end);
    return { html: `<mtext>${escapeHtml(arg.content)}</mtext>`, nextIndex: arg.nextIndex };
  }
  if (cmd === 'mathbf' || cmd === 'boldsymbol') {
    const arg = readBracedGroup(src, end);
    return {
      html: `<mstyle mathvariant="bold"><mrow>${parseLatexTokens(arg.content)}</mrow></mstyle>`,
      nextIndex: arg.nextIndex,
    };
  }
  if (cmd === 'mathcal' || cmd === 'mathbb') {
    const arg = readBracedGroup(src, end);
    const table = cmd === 'mathcal' ? MATHCAL_MAP : MATHBB_MAP;
    return {
      html: `<mi>${escapeHtml(convertMappedChars(arg.content, table))}</mi>`,
      nextIndex: arg.nextIndex,
    };
  }
  const variant = FONT_VARIANT_MAP[cmd];
  if (variant) {
    const arg = readBracedGroup(src, end);
    return {
      html: `<mstyle mathvariant="${variant}"><mrow>${parseLatexTokens(arg.content)}</mrow></mstyle>`,
      nextIndex: arg.nextIndex,
    };
  }
  return undefined;
}

function parseNamedLatexCommand(
  cmd: string,
  src: string,
  end: number,
): { html: string; nextIndex: number } {
  if (cmd === 'left' || cmd === 'right') {
    return { html: '', nextIndex: end };
  }
  if (cmd === 'frac') {
    const num = readBracedGroup(src, end);
    const den = readBracedGroup(src, num.nextIndex);
    return {
      html: `<mfrac><mrow>${parseLatexTokens(num.content)}</mrow><mrow>${parseLatexTokens(den.content)}</mrow></mfrac>`,
      nextIndex: den.nextIndex,
    };
  }
  if (cmd === 'sqrt') {
    const arg = readBracedGroup(src, end);
    return {
      html: `<msqrt><mrow>${parseLatexTokens(arg.content)}</mrow></msqrt>`,
      nextIndex: arg.nextIndex,
    };
  }
  const styled = parseStyledLatexCommand(cmd, src, end);
  if (styled) {
    return styled;
  }
  if (UPRIGHT_FUNCTIONS.has(cmd)) {
    return { html: `<mi mathvariant="normal">${escapeHtml(cmd)}</mi>`, nextIndex: end };
  }
  if (cmd === 'begin') {
    const env = readBracedGroup(src, end);
    const endMarker = `\\end{${env.content}}`;
    const closeIdx = src.indexOf(endMarker, env.nextIndex);
    if (closeIdx !== -1) {
      return {
        html: renderMatrixEnvironment(env.content, src.slice(env.nextIndex, closeIdx)),
        nextIndex: closeIdx + endMarker.length,
      };
    }
  }
  const mapped = GREEK_AND_SYMBOLS[cmd];
  if (mapped) {
    const tag = /^[α-ωΑ-Ω∂∇∞∅]$/.test(mapped) ? 'mi' : 'mo';
    return { html: `<${tag}>${escapeHtml(mapped)}</${tag}>`, nextIndex: end };
  }
  return { html: `<mi>${escapeHtml(cmd)}</mi>`, nextIndex: end };
}

function parseCommand(src: string, cmdStart: number): { html: string; nextIndex: number } {
  const afterSlash = cmdStart + 1;
  if (afterSlash >= src.length) {
    return { html: '', nextIndex: afterSlash };
  }
  const firstChar = src[afterSlash];
  if (!/[a-zA-Z]/.test(firstChar)) {
    if (firstChar === '{' || firstChar === '}') {
      return { html: `<mo>${escapeHtml(firstChar)}</mo>`, nextIndex: afterSlash + 1 };
    }
    return { html: '<mspace width="0.2em"></mspace>', nextIndex: afterSlash + 1 };
  }

  let end = afterSlash;
  while (end < src.length && /[a-zA-Z]/.test(src[end])) {
    end++;
  }
  return parseNamedLatexCommand(src.slice(afterSlash, end), src, end);
}

function parseAtom(src: string, index: number): { html: string; nextIndex: number } {
  let i = index;
  while (i < src.length && /\s/.test(src[i])) {
    i++;
  }
  if (i >= src.length) {
    return { html: '', nextIndex: i };
  }
  const ch = src[i];
  if (ch === '{') {
    const group = readBracedGroup(src, i);
    return { html: `<mrow>${parseLatexTokens(group.content)}</mrow>`, nextIndex: group.nextIndex };
  }
  if (ch === '\\') {
    return parseCommand(src, i);
  }
  if (/[0-9]/.test(ch)) {
    let end = i;
    while (end < src.length && /[0-9.]/.test(src[end])) {
      end++;
    }
    return { html: `<mn>${escapeHtml(src.slice(i, end))}</mn>`, nextIndex: end };
  }
  if (/[a-zA-Z]/.test(ch)) {
    return { html: `<mi>${escapeHtml(ch)}</mi>`, nextIndex: i + 1 };
  }
  if (OPERATORS.has(ch)) {
    return { html: `<mo>${escapeHtml(ch)}</mo>`, nextIndex: i + 1 };
  }
  return { html: `<mtext>${escapeHtml(ch)}</mtext>`, nextIndex: i + 1 };
}

function consumeScripts(
  src: string,
  startIndex: number,
): { subHtml?: string; supHtml?: string; nextIndex: number } {
  let i = startIndex;
  let subHtml: string | undefined;
  let supHtml: string | undefined;
  for (let pass = 0; pass < 2; pass++) {
    while (i < src.length && /\s/.test(src[i])) {
      i++;
    }
    if (src[i] === '_' && subHtml === undefined) {
      const subAtom = parseAtom(src, i + 1);
      subHtml = subAtom.html || '<mrow></mrow>';
      i = subAtom.nextIndex;
    } else if (src[i] === '^' && supHtml === undefined) {
      const supAtom = parseAtom(src, i + 1);
      supHtml = supAtom.html || '<mrow></mrow>';
      i = supAtom.nextIndex;
    }
  }
  return { subHtml, supHtml, nextIndex: i };
}

function wrapScriptedAtom(baseHtml: string, subHtml?: string, supHtml?: string): string {
  if (subHtml !== undefined && supHtml !== undefined) {
    return `<msubsup>${baseHtml}${subHtml}${supHtml}</msubsup>`;
  }
  if (subHtml !== undefined) {
    return `<msub>${baseHtml}${subHtml}</msub>`;
  }
  if (supHtml !== undefined) {
    return `<msup>${baseHtml}${supHtml}</msup>`;
  }
  return baseHtml;
}

function parseLatexTokens(src: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < src.length) {
    const atom = parseAtom(src, i);
    if (!atom.html && atom.nextIndex >= src.length) {
      break;
    }
    const scripts = consumeScripts(src, atom.nextIndex);
    i = scripts.nextIndex;
    const baseHtml = wrapScriptedAtom(atom.html, scripts.subHtml, scripts.supHtml);
    if (baseHtml) {
      parts.push(baseHtml);
    }
  }
  return parts.join('');
}

/**
 * Converts a LaTeX math expression into standards-compliant MathML without external fonts.
 */
export function renderLatexToMathMl(tex: string, displayMode = false): string {
  const displayAttr = displayMode ? ' display="block"' : ' display="inline"';
  const inner = parseLatexTokens(tex.trim());
  const mathEl = `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}><mrow>${inner}</mrow></math>`;
  return displayMode ? `<div class="a2ui-math-block">${mathEl}</div>` : mathEl;
}

function renderSequenceSvg(lines: string[]): string {
  const participants = new Map<string, string>();
  const messages: Array<{ from: string; to: string; text: string; dashed: boolean }> = [];
  const pRegex = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i;
  const mRegex = /^([A-Za-z0-9_.-]+)\s*(--?>?>?|-x)\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)$/;

  for (const raw of lines) {
    const line = raw.trim();
    const pm = pRegex.exec(line);
    if (pm) {
      participants.set(pm[1], (pm[2] ?? pm[1]).trim());
      continue;
    }
    const mm = mRegex.exec(line);
    if (mm) {
      if (!participants.has(mm[1])) participants.set(mm[1], mm[1]);
      if (!participants.has(mm[3])) participants.set(mm[3], mm[3]);
      messages.push({
        from: mm[1],
        to: mm[3],
        text: mm[4].trim(),
        dashed: mm[2].startsWith('--'),
      });
    }
  }
  if (participants.size === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
  }

  const ids = Array.from(participants.keys());
  const colW = 150;
  const pad = 20;
  const boxW = 110;
  const boxH = 32;
  const width = pad * 2 + ids.length * colW;
  const height = pad * 2 + boxH + Math.max(1, messages.length) * 44 + 16;

  const lifelines = ids
    .map((id, idx) => {
      const cx = pad + idx * colW + colW / 2;
      const label = participants.get(id)!;
      return `<g class="a2ui-mermaid-actor"><line x1="${cx}" y1="${pad + boxH}" x2="${cx}" y2="${height - pad}" stroke="var(--a2ui-color-border, #dadce0)" stroke-dasharray="4 3" /><rect x="${cx - boxW / 2}" y="${pad}" width="${boxW}" height="${boxH}" rx="6" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-border, #dadce0)" /><text x="${cx}" y="${pad + 20}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--a2ui-text-color-text, #1f1f1f)">${escapeHtml(label)}</text></g>`;
    })
    .join('');

  const msgSvg = messages
    .map((m, idx) => {
      const fromIdx = ids.indexOf(m.from);
      const toIdx = ids.indexOf(m.to);
      const x1 = pad + fromIdx * colW + colW / 2;
      const x2 = pad + toIdx * colW + colW / 2;
      const y = pad + boxH + 30 + idx * 44;
      const dash = m.dashed ? ' stroke-dasharray="4 3"' : '';
      const midX = (x1 + x2) / 2;
      return `<g class="a2ui-mermaid-msg"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" /><text x="${midX}" y="${y - 6}" text-anchor="middle" font-size="11" fill="var(--a2ui-text-color-text, #1f1f1f)">${escapeHtml(m.text)}</text></g>`;
    })
    .join('');

  return `<div class="a2ui-mermaid"><svg class="a2ui-mermaid-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;max-height:200px;height:auto;display:block;margin:0 auto"><defs><marker id="a2ui-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--a2ui-color-primary, #0b57d0)" /></marker></defs>${lifelines}${msgSvg}</svg></div>`;
}

/**
 * Renders a Mermaid diagram definition (`flowchart`/`graph`, `stateDiagram`/`stateDiagram-v2`,
 * or `sequenceDiagram`) to an inline SVG.
 */

interface PieSpec {
  readonly title: string;
  readonly showData: boolean;
  readonly slices: ReadonlyArray<{ label: string; value: number }>;
}

function parsePieSpec(header: string, lines: readonly string[]): PieSpec {
  const showData = /\bshowData\b/i.test(header);
  const inlineTitle = /^pie(?:\s+showData)?\s+title\s+(.+)$/i.exec(header);
  let title = inlineTitle ? inlineTitle[1].trim().replace(/^"(.*)"$/, '$1') : '';
  const slices: Array<{ label: string; value: number }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    const titleMatch = /^title\s+(.+)$/i.exec(line);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^"(.*)"$/, '$1');
      continue;
    }
    const sliceMatch = /^"([^"]+)"\s*:\s*([+-]?\d+(?:\.\d+)?)$/.exec(line);
    const value = sliceMatch ? Number(sliceMatch[2]) : NaN;
    if (sliceMatch && Number.isFinite(value) && value >= 0) {
      slices.push({ label: sliceMatch[1], value });
    }
  }
  return { title, showData, slices };
}

function renderPieSvg(header: string, lines: string[]): string {
  const { title, showData, slices } = parsePieSpec(header, lines);
  if (slices.length === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml([header, ...lines].join('\n'))}</code></pre>`;
  }
  const total = slices.reduce((acc, s) => acc + s.value, 0) || 1;
  const width = 440;
  const titleOffset = title ? 26 : 6;
  const cx = 130;
  const cy = titleOffset + 100;
  const radius = 82;
  const height = titleOffset + 200;

  let angle = 0;
  const paths: string[] = [];
  const legendItems: string[] = [];
  slices.forEach((s, idx) => {
    const span = (s.value / total) * 360;
    const start = angle;
    const end = angle + span;
    angle = end;
    const color = resolveSeriesColor(idx);
    const d = describeSectorPath(cx, cy, radius, 0, start, end);
    const pct = Math.round((s.value / total) * 100);
    const labelPos = polarToCartesian(cx, cy, radius * 0.65, start + span / 2);
    paths.push(
      `<path d="${d}" fill="${color}" stroke="var(--a2ui-color-surface, #ffffff)" stroke-width="1.5" />`,
    );
    if (pct >= 8) {
      paths.push(
        `<text x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="600">${pct}%</text>`,
      );
    }
    const displaySuffix = showData ? ` (${formatTickNumber(s.value)})` : ` (${pct}%)`;
    const ly = titleOffset + 28 + idx * 22;
    legendItems.push(
      `<rect x="242" y="${ly - 9}" width="11" height="11" rx="2" fill="${color}" />` +
        `<text x="259" y="${ly}" fill="var(--a2ui-text-color-text, #1f1f1f)" font-size="12">${escapeHtml(s.label + displaySuffix)}</text>`,
    );
  });

  const titleEl = title
    ? `<text x="${width / 2}" y="18" text-anchor="middle" fill="var(--a2ui-text-color-text, #1f1f1f)" font-size="13" font-weight="600">${escapeHtml(title)}</text>`
    : '';

  return `<div class="a2ui-mermaid"><svg class="a2ui-mermaid-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(title || 'Pie chart')}">${titleEl}${paths.join('')}${legendItems.join('')}</svg></div>`;
}

function parseBracketList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((item) =>
    item
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1'),
  );
}

interface XyChartSpec {
  title: string;
  xCategories: string[];
  yAxisTitle: string;
  explicitMin?: number;
  explicitMax?: number;
  series: Array<{ kind: 'bar' | 'line'; values: number[] }>;
}

function parseSingleXyChartLine(line: string, spec: XyChartSpec): void {
  const titleMatch = /^title\s+(.+)$/i.exec(line);
  if (titleMatch) {
    spec.title = titleMatch[1].trim().replace(/^"(.*)"$/, '$1');
    return;
  }
  const xAxisMatch = /^x-axis\s+(?:"[^"]*"\s+)?(\[.*\])$/i.exec(line);
  if (xAxisMatch) {
    spec.xCategories = parseBracketList(xAxisMatch[1]);
    return;
  }
  const yAxisMatch =
    /^y-axis\s+(?:"([^"]*)"\s*)?(?:([+-]?\d+(?:\.\d+)?)\s*-->\s*([+-]?\d+(?:\.\d+)?))?$/i.exec(
      line,
    );
  if (yAxisMatch) {
    if (yAxisMatch[1]) spec.yAxisTitle = yAxisMatch[1];
    if (yAxisMatch[2] !== undefined && yAxisMatch[3] !== undefined) {
      spec.explicitMin = Number(yAxisMatch[2]);
      spec.explicitMax = Number(yAxisMatch[3]);
    }
    return;
  }
  const seriesMatch = /^(bar|line)\s+(?:"[^"]*"\s+)?(\[.*\])$/i.exec(line);
  if (seriesMatch) {
    const kind = seriesMatch[1].toLowerCase() as 'bar' | 'line';
    const vals = parseBracketList(seriesMatch[2])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    if (vals.length > 0) {
      spec.series.push({ kind, values: vals });
    }
  }
}

function parseXyChartSpec(lines: readonly string[]): XyChartSpec {
  const spec: XyChartSpec = { title: '', xCategories: [], yAxisTitle: '', series: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (line) {
      parseSingleXyChartLine(line, spec);
    }
  }
  return spec;
}

function renderXySeriesParts(
  series: ReadonlyArray<{ kind: 'bar' | 'line'; values: number[] }>,
  padLeft: number,
  slotW: number,
  barWidth: number,
  zeroY: number,
  yFor: (v: number) => number,
): string[] {
  const parts: string[] = [];
  let barIdx = 0;
  series.forEach((s, sIdx) => {
    const color = resolveSeriesColor(sIdx);
    if (s.kind === 'bar') {
      const bOffset = barIdx++;
      s.values.forEach((v, idx) => {
        const x = padLeft + idx * slotW + slotW * 0.175 + bOffset * barWidth;
        const yTop = v >= 0 ? yFor(v) : zeroY;
        const yBot = v >= 0 ? zeroY : yFor(v);
        const h = Math.max(2, Math.abs(yBot - yTop));
        parts.push(
          `<rect x="${Number(x.toFixed(2))}" y="${Number(Math.min(yTop, yBot).toFixed(2))}" width="${Number(barWidth.toFixed(2))}" height="${Number(h.toFixed(2))}" rx="2" fill="${color}" />`,
        );
      });
      return;
    }
    const pts = s.values.map((v, idx) => ({
      x: Number((padLeft + (idx + 0.5) * slotW).toFixed(2)),
      y: Number(yFor(v).toFixed(2)),
    }));
    parts.push(
      `<polyline fill="none" stroke="${color}" stroke-width="2.2" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" />`,
      ...pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${color}" />`),
    );
  });
  return parts;
}

function renderXyChartSvg(lines: string[]): string {
  const { title, xCategories, yAxisTitle, explicitMin, explicitMax, series } =
    parseXyChartSpec(lines);
  if (series.length === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(['xychart-beta', ...lines].join('\n'))}</code></pre>`;
  }

  const allVals = series.flatMap((s) => s.values);
  const minVal = explicitMin ?? Math.min(0, ...allVals);
  const maxVal = explicitMax ?? Math.max(0, ...allVals);
  const scale = computeNiceTicks(minVal, maxVal, 5, explicitMin === undefined);
  const span = scale.max - scale.min || 1;

  const width = 480;
  const height = 230;
  const padLeft = yAxisTitle ? 54 : 42;
  const padRight = 18;
  const padTop = title ? 30 : 14;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const yFor = (v: number) => padTop + plotH - ((v - scale.min) / span) * plotH;
  const zeroY = yFor(Math.max(0, scale.min));

  const maxPoints = Math.max(xCategories.length, ...series.map((s) => s.values.length), 1);
  const slotW = plotW / maxPoints;
  const barSeries = series.filter((s) => s.kind === 'bar');
  const barWidth = Math.max(6, (slotW * 0.65) / Math.max(1, barSeries.length));

  const parts: string[] = [];
  if (title) {
    parts.push(
      `<text x="${width / 2}" y="18" text-anchor="middle" fill="var(--a2ui-text-color-text, #1f1f1f)" font-size="13" font-weight="600">${escapeHtml(title)}</text>`,
    );
  }
  for (const tick of scale.ticks) {
    const y = Number(yFor(tick).toFixed(2));
    parts.push(
      `<line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="var(--a2ui-chart-grid-color, rgba(128,134,139,0.22))" stroke-dasharray="3 3" />`,
      `<text x="${padLeft - 6}" y="${y + 4}" text-anchor="end" fill="var(--a2ui-text-caption-color, #70757a)" font-size="11">${formatTickNumber(tick)}</text>`,
    );
  }
  parts.push(
    `<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="var(--a2ui-chart-axis-color, rgba(128,134,139,0.55))" />`,
    `<line x1="${padLeft}" y1="${Number(zeroY.toFixed(2))}" x2="${padLeft + plotW}" y2="${Number(zeroY.toFixed(2))}" stroke="var(--a2ui-chart-axis-color, rgba(128,134,139,0.55))" />`,
    ...renderXySeriesParts(series, padLeft, slotW, barWidth, zeroY, yFor),
  );

  for (let i = 0; i < maxPoints; i++) {
    const lbl = xCategories[i] ?? String(i + 1);
    const cx = Number((padLeft + (i + 0.5) * slotW).toFixed(2));
    parts.push(
      `<text x="${cx}" y="${padTop + plotH + 16}" text-anchor="middle" fill="var(--a2ui-text-caption-color, #70757a)" font-size="11">${escapeHtml(lbl)}</text>`,
    );
  }

  return `<div class="a2ui-mermaid"><svg class="a2ui-mermaid-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(title || 'XY chart')}">${parts.join('')}</svg></div>`;
}

export function renderMermaidSvg(code: string, options?: MermaidLayoutOptions): string {
  const lines = code
    .trim()
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('%%'));
  const header = lines[0]?.trim() ?? '';
  const flowMatch = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\b/i.exec(header);
  if (flowMatch) {
    return renderFlowchartGraphSvg(
      parseFlowchartLines(lines.slice(1), options),
      (flowMatch[1] ?? 'TD').toUpperCase(),
      lines,
      options,
    );
  }
  if (/^stateDiagram(?:-v2)?\b/i.test(header)) {
    const parsed = parseStateDiagramLines(lines.slice(1), options);
    return renderFlowchartGraphSvg(parsed, parsed.direction ?? 'TD', lines, options);
  }
  if (/^sequenceDiagram\b/i.test(header)) {
    return renderSequenceSvg(lines.slice(1));
  }
  if (/^pie\b/i.test(header)) {
    return renderPieSvg(header, lines.slice(1));
  }
  if (/^xychart(?:-beta)?\b/i.test(header)) {
    return renderXyChartSvg(lines.slice(1));
  }
  return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(code.trim())}</code></pre>`;
}

/** Schemes that markdown-it and DOMPurify already keep as navigable `href` values. */
const PASSTHROUGH_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/** Schemes that never become links: the whole `[label](scheme:...)` collapses to its label. */
const BLOCKED_LINK_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data']);

/** Placeholder scheme that survives markdown-it and DOMPurify so the original can be restored. */
const LINK_PLACEHOLDER_SCHEME = 'a2uilink';

/**
 * Matches an inline Markdown link whose destination carries a scheme, such as
 * `[label](file:///tmp/a.md)` or `[label](conversation://abc "title")`. The destination may
 * contain one level of balanced parentheses (`javascript:alert(1)`, `file:///a_(b).md`), as
 * markdown-it allows. The negative lookbehind skips images (`![alt](...)`).
 */
const SCHEME_LINK_RE =
  /(?<!!)\[([^\]\r\n]*)\]\(([a-z][a-z0-9+.-]*):((?:[^()\s]|\([^()\s]*\))*)((?:\s+"[^"]*")?)\)/gi;

/**
 * Rewrites Markdown links with schemes other than `http`, `https`, and `mailto` to
 * `[label](a2uilink:n)` placeholders so markdown-it's `validateLink` and DOMPurify's URI
 * filter do not drop them. `javascript:`, `vbscript:`, and `data:` links are replaced by their
 * label text alone, so a dangerous link degrades to plain text instead of leaking its syntax.
 * Returns the rewritten text and the original destinations.
 */
export function protectNonHttpLinks(markdown: string): { text: string; links: string[] } {
  const links: string[] = [];
  const text = markdown.replace(
    SCHEME_LINK_RE,
    (full: string, label: string, scheme: string, rest: string, title: string) => {
      const lower = scheme.toLowerCase();
      if (PASSTHROUGH_LINK_SCHEMES.has(lower)) {
        return full;
      }
      if (BLOCKED_LINK_SCHEMES.has(lower)) {
        return label;
      }
      links.push(`${scheme}:${rest}`);
      return `[${label}](${LINK_PLACEHOLDER_SCHEME}:${links.length - 1}${title})`;
    },
  );
  return { text, links };
}

/**
 * Replaces `href="a2uilink:n"` placeholders in sanitized HTML with
 * `data-a2ui-href="<original>"` (no `href`, so the browser never navigates to an unknown
 * scheme) and adds `rel="noopener noreferrer"` to the `http(s)` anchors that kept their `href`.
 */
export function restoreNonHttpLinks(html: string, links: readonly string[]): string {
  const placeholderRe = new RegExp(`href="${LINK_PLACEHOLDER_SCHEME}:(\\d+)"`, 'g');
  return html
    .replace(placeholderRe, (_, idx: string) => {
      const original = links[Number(idx)];
      return original === undefined ? '' : `data-a2ui-href="${escapeHtml(original)}"`;
    })
    .replace(/<a\b([^>]*\bhref="https?:[^"]*"[^>]*)>/gi, '<a$1 rel="noopener noreferrer">');
}

interface MarkdownFragment {
  token: string;
  html: string;
  isBlock: boolean;
}

function resolveCustomMermaidRenderer(
  options?: RichMarkdownOptions,
): ((code: string) => Promise<string> | string) | undefined {
  if (options?.mermaidRenderer) {
    return options.mermaidRenderer;
  }
  const globalMermaid = (globalThis as any).mermaid;
  if (typeof globalMermaid?.render !== 'function') {
    return undefined;
  }
  return async (code: string) => {
    const res = await globalMermaid.render(
      `a2ui-mmd-${Math.random().toString(36).slice(2, 8)}`,
      code,
    );
    return typeof res === 'string' ? res : res.svg;
  };
}

async function resolveMermaidFragments(
  fragments: MarkdownFragment[],
  options?: RichMarkdownOptions,
): Promise<void> {
  const customMermaid = resolveCustomMermaidRenderer(options);
  for (const frag of fragments) {
    if (!customMermaid) {
      frag.html = renderMermaidSvg(frag.html, options?.mermaidLayout);
      continue;
    }
    try {
      const rawSvg = await customMermaid(frag.html);
      frag.html = `<div class="a2ui-mermaid">${sanitizeSvgFragment(String(rawSvg))}</div>`;
    } catch {
      frag.html = renderMermaidSvg(frag.html, options?.mermaidLayout);
    }
  }
}

function substituteFragments(rendered: string, fragments: readonly MarkdownFragment[]): string {
  let out = rendered;
  for (const frag of fragments) {
    if (frag.isBlock) {
      const wrappedRegex = new RegExp(`<p[^>]*>\\s*${frag.token}\\s*<\\/p>`, 'g');
      if (wrappedRegex.test(out)) {
        out = out.replace(wrappedRegex, frag.html);
        continue;
      }
    }
    out = out.replaceAll(frag.token, frag.html);
  }
  return out;
}

/**
 * Renders Markdown enriched with LaTeX MathML (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`)
 * and Mermaid SVG diagrams (` ```mermaid `), preserving DOMPurify XSS sanitization.
 * Links with schemes other than `http(s)` and `mailto` render as anchors carrying
 * `data-a2ui-href` instead of `href`; see `protectNonHttpLinks`.
 */
export async function renderRichMarkdown(
  value: string,
  options?: RichMarkdownOptions,
): Promise<string> {
  if (!value) {
    return '';
  }

  const protectedCode: string[] = [];
  const fragments: MarkdownFragment[] = [];

  // 1. Extract ```mermaid blocks first and protect other fenced code blocks / inline code spans
  const withFencesProcessed = value.replace(
    /```([^\r\n`]*)\r?\n([\s\S]*?)```/g,
    (fullMatch, lang: string, body: string) => {
      if (lang.trim().toLowerCase() === 'mermaid') {
        const token = `A2UIFRAGMENT${fragments.length}END`;
        fragments.push({ token, html: body, isBlock: true });
        return `\n\n${token}\n\n`;
      }
      const codeToken = `@@A2UICODE_${protectedCode.length}@@`;
      protectedCode.push(fullMatch);
      return codeToken;
    },
  );

  const withInlineCodeProtected = withFencesProcessed.replace(/`[^`\r\n]+`/g, (inlineMatch) => {
    const codeToken = `@@A2UICODE_${protectedCode.length}@@`;
    protectedCode.push(inlineMatch);
    return codeToken;
  });

  // 1b. Protect non-http link destinations while code is still masked, so links inside
  //     fenced blocks and code spans stay untouched.
  const { text: withLinksProtected, links: protectedLinks } =
    protectNonHttpLinks(withInlineCodeProtected);

  // 2. Resolve any Mermaid blocks (via custom renderer, globalThis.mermaid, or built-in SVG)
  await resolveMermaidFragments(fragments, options);

  // 3. Extract block math ($$...$$ and \[...\]) and inline math (\(...\) and $...$)
  const addMathFragment = (tex: string, displayMode: boolean): string => {
    const token = `A2UIFRAGMENT${fragments.length}END`;
    fragments.push({
      token,
      html: renderLatexToMathMl(tex, displayMode),
      isBlock: displayMode,
    });
    return displayMode ? `\n\n${token}\n\n` : token;
  };

  const withBlockMath = withLinksProtected
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => addMathFragment(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => addMathFragment(tex, true));

  const withAllMath = withBlockMath
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => addMathFragment(tex, false))
    .replace(/(^|[^\\$])\$(?!\s)([^$\r\n]+?)(?<!\s)\$/g, (_, prefix: string, tex: string) => {
      return `${prefix}${addMathFragment(tex, false)}`;
    });

  // 4. Restore protected code spans/blocks before passing to @a2ui/markdown-it
  const restoredForMarkdown = withAllMath.replace(
    /@@A2UICODE_(\d+)@@/g,
    (_, idx: string) => protectedCode[Number(idx)] ?? '',
  );

  // 5. Render standard Markdown + DOMPurify via @a2ui/markdown-it, then restore the
  //    protected link destinations as data-a2ui-href and harden http(s) anchors
  const rendered = restoreNonHttpLinks(
    await renderMarkdown(restoredForMarkdown, {
      tagClassMap: options?.tagClassMap,
    }),
    protectedLinks,
  );

  // 6. Substitute sanitized MathML and Mermaid SVG fragments
  return substituteFragments(rendered, fragments);
}
