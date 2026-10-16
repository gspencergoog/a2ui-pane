import { renderMarkdown } from '@a2ui/markdown-it';

/** Configuration options for the rich Markdown, MathML, and Mermaid renderer. */
export interface RichMarkdownOptions {
  tagClassMap?: Record<string, string[]>;
  mermaidRenderer?: (code: string) => Promise<string> | string;
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
  const cmd = src.slice(afterSlash, end);

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
  if (cmd === 'mathcal') {
    const arg = readBracedGroup(src, end);
    const converted = Array.from(arg.content.trim())
      .map((ch) => MATHCAL_MAP[ch] ?? ch)
      .join('');
    return {
      html: `<mi>${escapeHtml(converted)}</mi>`,
      nextIndex: arg.nextIndex,
    };
  }
  if (cmd === 'mathbb') {
    const arg = readBracedGroup(src, end);
    const converted = Array.from(arg.content.trim())
      .map((ch) => MATHBB_MAP[ch] ?? ch)
      .join('');
    return {
      html: `<mi>${escapeHtml(converted)}</mi>`,
      nextIndex: arg.nextIndex,
    };
  }
  if (cmd === 'mathtt' || cmd === 'mathsf' || cmd === 'mathit') {
    const arg = readBracedGroup(src, end);
    const variant = cmd === 'mathtt' ? 'monospace' : cmd === 'mathsf' ? 'sans-serif' : 'italic';
    return {
      html: `<mstyle mathvariant="${variant}"><mrow>${parseLatexTokens(arg.content)}</mrow></mstyle>`,
      nextIndex: arg.nextIndex,
    };
  }
  if (UPRIGHT_FUNCTIONS.has(cmd)) {
    return {
      html: `<mi mathvariant="normal">${escapeHtml(cmd)}</mi>`,
      nextIndex: end,
    };
  }
  if (cmd === 'begin') {
    const env = readBracedGroup(src, end);
    const endMarker = `\\end{${env.content}}`;
    const closeIdx = src.indexOf(endMarker, env.nextIndex);
    if (closeIdx !== -1) {
      const body = src.slice(env.nextIndex, closeIdx);
      return {
        html: renderMatrixEnvironment(env.content, body),
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

function parseLatexTokens(src: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < src.length) {
    const atom = parseAtom(src, i);
    if (!atom.html && atom.nextIndex >= src.length) {
      break;
    }
    i = atom.nextIndex;
    let baseHtml = atom.html;
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

    if (subHtml !== undefined && supHtml !== undefined) {
      baseHtml = `<msubsup>${baseHtml}${subHtml}${supHtml}</msubsup>`;
    } else if (subHtml !== undefined) {
      baseHtml = `<msub>${baseHtml}${subHtml}</msub>`;
    } else if (supHtml !== undefined) {
      baseHtml = `<msup>${baseHtml}${supHtml}</msup>`;
    }
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

interface FlowNode {
  id: string;
  label: string;
  shape: 'rect' | 'round' | 'diamond' | 'start' | 'end';
  order: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
}

function parseNodeToken(
  raw: string,
  nodes: Map<string, FlowNode>,
  defaultShape: FlowNode['shape'] = 'rect',
): string {
  const trimmed = raw.trim();
  const match =
    /^([A-Za-z0-9_.-]+)\s*(?:\[\s*"?([^"\]]*)"?\s*\]|\(\s*"?([^")]*)"?\s*\)|\{\s*"?([^"}]*)?"?\s*\})?$/.exec(
      trimmed,
    );
  if (!match) {
    const fallbackId = trimmed.replace(/\s+/g, '_') || 'node';
    if (!nodes.has(fallbackId)) {
      nodes.set(fallbackId, {
        id: fallbackId,
        label: trimmed,
        shape: defaultShape,
        order: nodes.size,
      });
    }
    return fallbackId;
  }
  const id = match[1];
  const rectLabel = match[2];
  const roundLabel = match[3];
  const diamondLabel = match[4];
  const existingOrder = nodes.get(id)?.order ?? nodes.size;
  if (rectLabel !== undefined) {
    nodes.set(id, { id, label: rectLabel.trim(), shape: 'rect', order: existingOrder });
  } else if (roundLabel !== undefined) {
    nodes.set(id, { id, label: roundLabel.trim(), shape: 'round', order: existingOrder });
  } else if (diamondLabel !== undefined) {
    nodes.set(id, { id, label: diamondLabel.trim(), shape: 'diamond', order: existingOrder });
  } else if (!nodes.has(id)) {
    nodes.set(id, { id, label: id, shape: defaultShape, order: existingOrder });
  }
  return id;
}

function parseFlowchartLines(lines: string[]): {
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
} {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const edgePattern =
    /^(.+?)\s*(?:--\s*([^>-][^>]*?)\s*-->|(-\.->|==>|--+>\s*))(?:\|([^|]*)\|\s*)?(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, '');
    if (!line || line.startsWith('%%') || /^(?:subgraph|end|style|classDef|class)\b/i.test(line)) {
      continue;
    }
    const edgeMatch = edgePattern.exec(line);
    if (edgeMatch) {
      const fromId = parseNodeToken(edgeMatch[1], nodes);
      const inlineLabel = edgeMatch[2]?.trim();
      const arrowToken = edgeMatch[3] ?? '-->';
      const pipeLabel = edgeMatch[4]?.trim();
      const toId = parseNodeToken(edgeMatch[5], nodes);
      edges.push({
        from: fromId,
        to: toId,
        label: pipeLabel || inlineLabel,
        dashed: arrowToken.includes('.'),
      });
    } else {
      parseNodeToken(line, nodes);
    }
  }
  return { nodes, edges };
}

function parseStateDiagramLines(lines: string[]): {
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  direction: string;
} {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let direction = 'TD';

  const stateAliasPattern = /^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_.-]+)$/i;
  const transitionPattern =
    /^(\[\*\]|[A-Za-z0-9_.-]+)\s*(-->|--\.->)\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/;
  const stateDescPattern = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/;

  const ensureStateNode = (token: string, isSource: boolean): string => {
    if (token === '[*]') {
      const id = isSource ? '__start__' : '__end__';
      const shape = isSource ? 'start' : 'end';
      if (!nodes.has(id)) {
        nodes.set(id, { id, label: '', shape, order: nodes.size });
      }
      return id;
    }
    if (!nodes.has(token)) {
      nodes.set(token, { id: token, label: token, shape: 'round', order: nodes.size });
    }
    return token;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, '');
    if (!line || line.startsWith('%%') || /^(?:note\b|end\s+note\b|\}|\{)/i.test(line)) {
      continue;
    }
    const dirMatch = /^direction\s+(TD|TB|LR|RL|BT)\b/i.exec(line);
    if (dirMatch) {
      direction = dirMatch[1].toUpperCase();
      continue;
    }
    const aliasMatch = stateAliasPattern.exec(line);
    if (aliasMatch) {
      const label = aliasMatch[1].trim();
      const id = aliasMatch[2].trim();
      const existingOrder = nodes.get(id)?.order ?? nodes.size;
      nodes.set(id, { id, label, shape: 'round', order: existingOrder });
      continue;
    }
    const transMatch = transitionPattern.exec(line);
    if (transMatch) {
      const fromId = ensureStateNode(transMatch[1].trim(), true);
      const arrow = transMatch[2];
      const toId = ensureStateNode(transMatch[3].trim(), false);
      const label = transMatch[4]?.trim();
      edges.push({
        from: fromId,
        to: toId,
        label,
        dashed: arrow.includes('.'),
      });
      continue;
    }
    const descMatch = stateDescPattern.exec(line);
    if (descMatch) {
      const id = descMatch[1].trim();
      const desc = descMatch[2].trim();
      const existing = nodes.get(id);
      nodes.set(id, {
        id,
        label: existing && existing.label !== id ? existing.label : `${id}: ${desc}`,
        shape: 'round',
        order: existing?.order ?? nodes.size,
      });
    }
  }

  return { nodes, edges, direction };
}

function computeNodeRanks(
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
): Map<string, { rank: number; row: number; groupSize: number }> {
  const ranks = new Map<string, number>();
  for (const id of nodes.keys()) {
    ranks.set(id, 0);
  }
  for (let iter = 0; iter < nodes.size; iter++) {
    for (const edge of edges) {
      const fromNode = nodes.get(edge.from);
      const toNode = nodes.get(edge.to);
      if (!fromNode || !toNode) continue;
      // Ignore back-edges (cycles) when computing hierarchical rank
      if (fromNode.order >= toNode.order) continue;
      const fromRank = ranks.get(edge.from) ?? 0;
      const toRank = ranks.get(edge.to) ?? 0;
      if (toRank <= fromRank && edge.from !== edge.to) {
        ranks.set(edge.to, fromRank + 1);
      }
    }
  }
  const byRank = new Map<number, string[]>();
  for (const [id, rank] of ranks.entries()) {
    const group = byRank.get(rank) ?? [];
    group.push(id);
    byRank.set(rank, group);
  }
  const positions = new Map<string, { rank: number; row: number; groupSize: number }>();
  for (const [rank, group] of byRank.entries()) {
    group.forEach((id, idx) => positions.set(id, { rank, row: idx, groupSize: group.length }));
  }
  return positions;
}

function computeNodeDimensions(n: FlowNode): { w: number; h: number } {
  if (n.shape === 'start' || n.shape === 'end') {
    return { w: 22, h: 22 };
  }
  const textWidth = Math.ceil(n.label.length * 7.4) + 28;
  return {
    w: Math.max(116, textWidth),
    h: 34,
  };
}

function renderGraphSvg(
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
  direction: string,
  rawLinesForFallback: string[],
): string {
  if (nodes.size === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(rawLinesForFallback.join('\n'))}</code></pre>`;
  }
  const isHorizontal = direction === 'LR' || direction === 'RL';
  const positions = computeNodeRanks(nodes, edges);
  const dims = new Map<string, { w: number; h: number }>();
  for (const [id, n] of nodes.entries()) {
    dims.set(id, computeNodeDimensions(n));
  }

  let maxRank = 0;
  let maxGroupSize = 1;
  for (const pos of positions.values()) {
    maxRank = Math.max(maxRank, pos.rank);
    maxGroupSize = Math.max(maxGroupSize, pos.groupSize);
  }

  // Check if there are any back-edges so we reserve left margin in vertical layout
  const hasBackEdge = edges.some((e) => {
    const f = positions.get(e.from);
    const t = positions.get(e.to);
    return f && t && f.rank >= t.rank;
  });

  const coords = new Map<
    string,
    { cx: number; cy: number; w: number; h: number; rank: number; row: number }
  >();
  let maxX = 0;
  let maxY = 0;

  if (isHorizontal) {
    const padX = 16;
    const padY = 16;
    const gapY = 54;
    const colWidths: number[] = new Array(maxRank + 1).fill(116);
    for (const [id, pos] of positions.entries()) {
      const d = dims.get(id)!;
      colWidths[pos.rank] = Math.max(colWidths[pos.rank], d.w);
    }

    const colGap: number[] = new Array(maxRank + 1).fill(46);
    for (const e of edges) {
      const f = positions.get(e.from);
      const t = positions.get(e.to);
      if (f && t && t.rank > f.rank && e.label) {
        colGap[f.rank] = Math.max(colGap[f.rank], Math.ceil(e.label.length * 6.4) + 28);
      }
    }

    const colCenterX: number[] = [];
    let cursorX = padX;
    for (let r = 0; r <= maxRank; r++) {
      colCenterX[r] = cursorX + colWidths[r] / 2;
      cursorX += colWidths[r] + colGap[r];
    }
    maxX = cursorX - (colGap[maxRank] ?? 46) + padX;
    const totalRowsHeight = (maxGroupSize - 1) * gapY + 34;
    maxY = padY * 2 + totalRowsHeight + (hasBackEdge ? 28 : 0);

    for (const [id, pos] of positions.entries()) {
      const d = dims.get(id)!;
      const rowOffset = (maxGroupSize - pos.groupSize) / 2;
      const cy = padY + (hasBackEdge ? 20 : 0) + (pos.row + rowOffset) * gapY + 17;
      coords.set(id, {
        cx: colCenterX[pos.rank],
        cy,
        w: d.w,
        h: d.h,
        rank: pos.rank,
        row: pos.row,
      });
    }
  } else {
    const leftMargin = hasBackEdge ? 96 : 16;
    const rightMargin = 24;
    const padY = 16;
    const colGapX = 28;

    // Group nodes by rank to compute row widths and incoming edge label widths
    const byRank = new Map<number, string[]>();
    for (const [id, pos] of positions.entries()) {
      const list = byRank.get(pos.rank) ?? [];
      list.push(id);
      byRank.set(pos.rank, list);
    }

    const incomingLabelWidth = new Map<string, number>();
    const labeledEdgesByRank = new Map<number, number>();
    for (const e of edges) {
      const f = positions.get(e.from);
      const t = positions.get(e.to);
      if (f && t && f.rank < t.rank && e.label) {
        const labelW = Math.ceil(e.label.length * 6.2) + 22;
        incomingLabelWidth.set(e.to, Math.max(incomingLabelWidth.get(e.to) ?? 0, labelW));
        labeledEdgesByRank.set(f.rank, (labeledEdgesByRank.get(f.rank) ?? 0) + 1);
      }
    }

    const getSlotWidth = (id: string, rankSize: number): number => {
      const baseW = dims.get(id)!.w;
      if (rankSize <= 1) return baseW;
      return Math.max(baseW, incomingLabelWidth.get(id) ?? 0);
    };

    let maxRowWidth = 220;
    for (const list of byRank.values()) {
      const rowW =
        list.reduce((sum, id) => sum + getSlotWidth(id, list.length), 0) +
        Math.max(0, list.length - 1) * colGapX;
      maxRowWidth = Math.max(maxRowWidth, rowW);
    }

    const rankCenterY: number[] = [];
    let cursorY = padY + 17;
    for (let r = 0; r <= maxRank; r++) {
      rankCenterY[r] = cursorY;
      const gapY = (labeledEdgesByRank.get(r) ?? 0) >= 2 ? 88 : 66;
      cursorY += gapY;
    }

    maxX = leftMargin + maxRowWidth + rightMargin;
    maxY = (rankCenterY[maxRank] ?? padY + 17) + 17 + padY;

    for (const [rank, list] of byRank.entries()) {
      const rowW =
        list.reduce((sum, id) => sum + getSlotWidth(id, list.length), 0) +
        Math.max(0, list.length - 1) * colGapX;
      let startX = leftMargin + (maxRowWidth - rowW) / 2;
      const cy = rankCenterY[rank];
      list.forEach((id, idx) => {
        const d = dims.get(id)!;
        const slotW = getSlotWidth(id, list.length);
        const cx = startX + slotW / 2;
        startX += slotW + colGapX;
        coords.set(id, { cx, cy, w: d.w, h: d.h, rank, row: idx });
      });
    }
  }

  // Group forward edges by source node to spread fan-out ports and stagger labels
  const forwardOutBySource = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const f = coords.get(e.from);
    const t = coords.get(e.to);
    if (!f || !t || f.rank >= t.rank || e.from === e.to) continue;
    const list = forwardOutBySource.get(e.from) ?? [];
    list.push(e);
    forwardOutBySource.set(e.from, list);
  }
  for (const list of forwardOutBySource.values()) {
    list.sort((a, b) => {
      const ca = coords.get(a.to)!;
      const cb = coords.get(b.to)!;
      return isHorizontal ? ca.cy - cb.cy : ca.cx - cb.cx;
    });
  }

  const labelHaloAttrs =
    'paint-order="stroke fill" stroke="var(--a2ui-color-surface, #ffffff)" stroke-width="4" stroke-linejoin="round"';
  const edgeLines: string[] = [];
  const edgeLabels: string[] = [];

  for (const e of edges) {
    const from = coords.get(e.from);
    const to = coords.get(e.to);
    if (!from || !to) continue;
    const isBackEdge = from.rank >= to.rank && e.from !== e.to;
    const dash = e.dashed || isBackEdge ? ' stroke-dasharray="4 3"' : '';

    if (isBackEdge) {
      if (isHorizontal) {
        const x1 = from.cx;
        const y1 = from.cy - from.h / 2;
        const x2 = to.cx;
        const y2 = to.cy - to.h / 2 - 4;
        const ctrlY = Math.min(y1, y2) - 26;
        const midX = (x1 + x2) / 2;
        edgeLines.push(
          `<path d="M ${x1} ${y1} Q ${midX} ${ctrlY} ${x2} ${y2}" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
        );
        if (e.label) {
          edgeLabels.push(
            `<text x="${midX}" y="${ctrlY + 4}" text-anchor="middle" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeHtml(e.label)}</text>`,
          );
        }
      } else {
        const x1 = from.cx - from.w / 2;
        const y1 = from.cy;
        const x2 = to.cx - to.w / 2 - 4;
        const y2 = to.cy;
        const arcX = Math.min(x1, x2) - 44;
        const midY = (y1 + y2) / 2;
        edgeLines.push(
          `<path d="M ${x1} ${y1} C ${arcX} ${y1}, ${arcX} ${y2}, ${x2} ${y2}" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
        );
        if (e.label) {
          edgeLabels.push(
            `<text x="${arcX - 4}" y="${midY + 3}" text-anchor="end" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeHtml(e.label)}</text>`,
          );
        }
      }
      continue;
    }

    const siblings = forwardOutBySource.get(e.from) ?? [e];
    const outCount = siblings.length;
    const outIdx = Math.max(0, siblings.indexOf(e));

    if (!isHorizontal && outCount > 1) {
      const spread = Math.min(44, from.w * 0.36);
      const x1 = from.cx + ((outIdx - (outCount - 1) / 2) / Math.max(1, outCount - 1)) * spread;
      const y1 = from.cy + from.h / 2;
      const x2 = to.cx;
      const y2 = to.cy - to.h / 2 - 4;
      if (Math.abs(x1 - x2) > 6) {
        const ctrlY = y1 + (y2 - y1) * 0.45;
        edgeLines.push(
          `<path d="M ${x1} ${y1} C ${x1} ${ctrlY}, ${x2} ${ctrlY}, ${x2} ${y2}" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
        );
      } else {
        edgeLines.push(
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
        );
      }
      if (e.label) {
        const xFraction = 0.76;
        const yFraction = outCount >= 3 ? (outIdx % 2 === 0 ? 0.46 : 0.76) : 0.58;
        const labelX = x1 + xFraction * (x2 - x1);
        const labelY = y1 + yFraction * (y2 - y1) + 3;
        edgeLabels.push(
          `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeHtml(e.label)}</text>`,
        );
      }
      continue;
    }

    const x1 = isHorizontal ? from.cx + from.w / 2 : from.cx;
    const y1 = isHorizontal ? from.cy : from.cy + from.h / 2;
    const x2 = isHorizontal ? to.cx - to.w / 2 - 4 : to.cx;
    const y2 = isHorizontal ? to.cy : to.cy - to.h / 2 - 4;
    const midX = (x1 + x2) / 2;
    const midY = isHorizontal ? (y1 + y2) / 2 - 6 : (y1 + y2) / 2 + 3;
    const textOffset = !isHorizontal && Math.abs(x1 - x2) < 8 ? 8 : 0;
    const anchor = textOffset > 0 ? 'start' : 'middle';
    edgeLines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
    );
    if (e.label) {
      edgeLabels.push(
        `<text x="${midX + textOffset}" y="${midY}" text-anchor="${anchor}" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeHtml(e.label)}</text>`,
      );
    }
  }
  const edgeSvg = edgeLines.join('');
  const edgeLabelSvg = edgeLabels.join('');

  const nodeSvg = Array.from(nodes.values())
    .map((n) => {
      const c = coords.get(n.id)!;
      if (n.shape === 'start') {
        return `<g class="a2ui-mermaid-node"><circle cx="${c.cx}" cy="${c.cy}" r="8" fill="var(--a2ui-color-primary, #0b57d0)" /></g>`;
      }
      if (n.shape === 'end') {
        return `<g class="a2ui-mermaid-node"><circle cx="${c.cx}" cy="${c.cy}" r="9" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5" /><circle cx="${c.cx}" cy="${c.cy}" r="5" fill="var(--a2ui-color-primary, #0b57d0)" /></g>`;
      }
      const x = c.cx - c.w / 2;
      const y = c.cy - c.h / 2;
      const rx = n.shape === 'round' ? 14 : 6;
      const shapeEl =
        n.shape === 'diamond'
          ? `<polygon points="${c.cx},${y} ${x + c.w},${c.cy} ${c.cx},${y + c.h} ${x},${c.cy}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5" />`
          : `<rect x="${x}" y="${y}" width="${c.w}" height="${c.h}" rx="${rx}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-border, #dadce0)" stroke-width="1.5" />`;
      return `<g class="a2ui-mermaid-node">${shapeEl}<text x="${c.cx}" y="${c.cy + 4}" text-anchor="middle" font-size="12" font-weight="500" fill="var(--a2ui-text-color-text, #1f1f1f)">${escapeHtml(n.label)}</text></g>`;
    })
    .join('');

  const maxH = isHorizontal ? 200 : 300;
  return `<div class="a2ui-mermaid"><svg class="a2ui-mermaid-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX} ${maxY}" width="100%" style="max-width:${maxX}px;max-height:${maxH}px;height:auto;display:block;margin:0 auto"><defs><marker id="a2ui-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--a2ui-color-primary, #0b57d0)" /></marker></defs>${edgeSvg}${nodeSvg}${edgeLabelSvg}</svg></div>`;
}

function renderFlowchartSvg(lines: string[], direction: string): string {
  const { nodes, edges } = parseFlowchartLines(lines);
  return renderGraphSvg(nodes, edges, direction, lines);
}

function renderStateDiagramSvg(lines: string[]): string {
  const { nodes, edges, direction } = parseStateDiagramLines(lines);
  return renderGraphSvg(nodes, edges, direction, lines);
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
export function renderMermaidSvg(code: string): string {
  const rawLines = code
    .trim()
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('%%'));
  const header = rawLines[0]?.trim() ?? '';
  const flowMatch = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\b/i.exec(header);
  if (flowMatch) {
    const dir = (flowMatch[1] ?? 'TD').toUpperCase();
    return renderFlowchartSvg(rawLines.slice(1), dir);
  }
  if (/^stateDiagram(?:-v2)?\b/i.test(header)) {
    return renderStateDiagramSvg(rawLines.slice(1));
  }
  if (/^sequenceDiagram\b/i.test(header)) {
    return renderSequenceSvg(rawLines.slice(1));
  }
  return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(code.trim())}</code></pre>`;
}

/**
 * Renders Markdown enriched with LaTeX MathML (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`)
 * and Mermaid SVG diagrams (` ```mermaid `), preserving DOMPurify XSS sanitization.
 */
export async function renderRichMarkdown(
  value: string,
  options?: RichMarkdownOptions,
): Promise<string> {
  if (!value) {
    return '';
  }

  const protectedCode: string[] = [];
  const fragments: Array<{ token: string; html: string; isBlock: boolean }> = [];

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

  // 2. Resolve any Mermaid blocks (via custom renderer, globalThis.mermaid, or built-in SVG)
  const customMermaid =
    options?.mermaidRenderer ??
    (typeof (globalThis as any).mermaid?.render === 'function'
      ? async (code: string) => {
          const res = await (globalThis as any).mermaid.render(
            `a2ui-mmd-${Math.random().toString(36).slice(2, 8)}`,
            code,
          );
          return typeof res === 'string' ? res : res.svg;
        }
      : undefined);

  for (const frag of fragments) {
    if (customMermaid) {
      try {
        const rawSvg = await customMermaid(frag.html);
        frag.html = `<div class="a2ui-mermaid">${sanitizeSvgFragment(String(rawSvg))}</div>`;
      } catch {
        frag.html = renderMermaidSvg(frag.html);
      }
    } else {
      frag.html = renderMermaidSvg(frag.html);
    }
  }

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

  const withBlockMath = withInlineCodeProtected
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

  // 5. Render standard Markdown + DOMPurify via @a2ui/markdown-it
  let rendered = await renderMarkdown(restoredForMarkdown, {
    tagClassMap: options?.tagClassMap,
  });

  // 6. Substitute sanitized MathML and Mermaid SVG fragments
  for (const frag of fragments) {
    if (frag.isBlock) {
      const wrappedRegex = new RegExp(`<p[^>]*>\\s*${frag.token}\\s*<\\/p>`, 'g');
      if (wrappedRegex.test(rendered)) {
        rendered = rendered.replace(wrappedRegex, frag.html);
        continue;
      }
    }
    rendered = rendered.replaceAll(frag.token, frag.html);
  }

  return rendered;
}
