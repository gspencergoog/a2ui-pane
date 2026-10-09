import { renderMarkdown } from '@a2ui/markdown-it';

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
  shape: 'rect' | 'round' | 'diamond';
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
}

function parseNodeToken(raw: string, nodes: Map<string, FlowNode>): string {
  const trimmed = raw.trim();
  const match =
    /^([A-Za-z0-9_.-]+)\s*(?:\[\s*"?([^"\]]*)"?\s*\]|\(\s*"?([^")]*)"?\s*\)|\{\s*"?([^"}]*)?"?\s*\})?$/.exec(
      trimmed,
    );
  if (!match) {
    const fallbackId = trimmed.replace(/\s+/g, '_') || 'node';
    if (!nodes.has(fallbackId)) {
      nodes.set(fallbackId, { id: fallbackId, label: trimmed, shape: 'rect' });
    }
    return fallbackId;
  }
  const id = match[1];
  const rectLabel = match[2];
  const roundLabel = match[3];
  const diamondLabel = match[4];
  if (rectLabel !== undefined) {
    nodes.set(id, { id, label: rectLabel.trim(), shape: 'rect' });
  } else if (roundLabel !== undefined) {
    nodes.set(id, { id, label: roundLabel.trim(), shape: 'round' });
  } else if (diamondLabel !== undefined) {
    nodes.set(id, { id, label: diamondLabel.trim(), shape: 'diamond' });
  } else if (!nodes.has(id)) {
    nodes.set(id, { id, label: id, shape: 'rect' });
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

function computeNodeRanks(
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
): Map<string, { rank: number; row: number }> {
  const ranks = new Map<string, number>();
  for (const id of nodes.keys()) {
    ranks.set(id, 0);
  }
  for (let iter = 0; iter < nodes.size; iter++) {
    for (const edge of edges) {
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
  const positions = new Map<string, { rank: number; row: number }>();
  for (const [rank, group] of byRank.entries()) {
    group.forEach((id, idx) => positions.set(id, { rank, row: idx }));
  }
  return positions;
}

function renderFlowchartSvg(lines: string[], direction: string): string {
  const { nodes, edges } = parseFlowchartLines(lines);
  if (nodes.size === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
  }
  const isHorizontal = direction === 'LR' || direction === 'RL';
  const positions = computeNodeRanks(nodes, edges);
  const nodeW = 132;
  const nodeH = 34;
  const gapX = isHorizontal ? 176 : 156;
  const gapY = isHorizontal ? 54 : 62;
  const pad = 12;

  let maxX = 0;
  let maxY = 0;
  const coords = new Map<string, { cx: number; cy: number }>();
  for (const [id, pos] of positions.entries()) {
    const col = isHorizontal ? pos.rank : pos.row;
    const row = isHorizontal ? pos.row : pos.rank;
    const cx = pad + col * gapX + nodeW / 2;
    const cy = pad + row * gapY + nodeH / 2;
    coords.set(id, { cx, cy });
    maxX = Math.max(maxX, cx + nodeW / 2 + pad);
    maxY = Math.max(maxY, cy + nodeH / 2 + pad);
  }

  const edgeSvg = edges
    .map((e) => {
      const from = coords.get(e.from);
      const to = coords.get(e.to);
      if (!from || !to) return '';
      const x1 = isHorizontal ? from.cx + nodeW / 2 : from.cx;
      const y1 = isHorizontal ? from.cy : from.cy + nodeH / 2;
      const x2 = isHorizontal ? to.cx - nodeW / 2 - 4 : to.cx;
      const y2 = isHorizontal ? to.cy : to.cy - nodeH / 2 - 4;
      const dash = e.dashed ? ' stroke-dasharray="4 3"' : '';
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2 - 6;
      const labelEl = e.label
        ? `<text x="${midX}" y="${midY}" text-anchor="middle" font-size="11" fill="var(--a2ui-text-caption-color, #70757a)">${escapeHtml(e.label)}</text>`
        : '';
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />${labelEl}`;
    })
    .join('');

  const nodeSvg = Array.from(nodes.values())
    .map((n) => {
      const c = coords.get(n.id)!;
      const x = c.cx - nodeW / 2;
      const y = c.cy - nodeH / 2;
      const rx = n.shape === 'round' ? 18 : 6;
      const shapeEl =
        n.shape === 'diamond'
          ? `<polygon points="${c.cx},${y} ${x + nodeW},${c.cy} ${c.cx},${y + nodeH} ${x},${c.cy}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5" />`
          : `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="${rx}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-border, #dadce0)" stroke-width="1.5" />`;
      return `<g class="a2ui-mermaid-node">${shapeEl}<text x="${c.cx}" y="${c.cy + 4}" text-anchor="middle" font-size="12" font-weight="500" fill="var(--a2ui-text-color-text, #1f1f1f)">${escapeHtml(n.label)}</text></g>`;
    })
    .join('');

  return `<div class="a2ui-mermaid"><svg class="a2ui-mermaid-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX} ${maxY}" width="100%" style="max-width:${maxX}px;max-height:180px;height:auto;display:block;margin:0 auto"><defs><marker id="a2ui-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--a2ui-color-primary, #0b57d0)" /></marker></defs>${edgeSvg}${nodeSvg}</svg></div>`;
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
 * Renders a Mermaid diagram definition (`flowchart`/`graph` or `sequenceDiagram`) to an inline SVG.
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
