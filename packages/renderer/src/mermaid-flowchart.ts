/**
 * Zero-dependency Mermaid flowchart and state-diagram parser and compound SVG layout engine.
 *
 * Supports `subgraph ... end` wave containers with 2-column wrapped grids, chained arrow
 * statements (`W1 --> W2 --> W3`), `&` multi-node expansion (`A & B --> C`), `<br/>` and
 * word-wrapped `<tspan>` labels, automatic `LR` to `TD` orientation for deep or compound
 * workflows, and a `min-width` readability floor for wide diagrams.
 */

/** A node parsed from a Mermaid flowchart or state diagram. */
export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly lines: readonly string[];
  readonly shape: 'rect' | 'round' | 'diamond' | 'start' | 'end';
  readonly order: number;
  readonly subgraphId?: string;
}

/** A directed edge between two node or subgraph identifiers. */
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly dashed: boolean;
}

/** A 1-level compound container parsed from a `subgraph ... end` block. */
export interface FlowSubgraph {
  readonly id: string;
  readonly title: string;
  readonly caption?: string;
  readonly nodeIds: readonly string[];
  readonly order: number;
}

/** Normalized graph structure produced by flowchart and state-diagram parsers. */
export interface ParsedFlowchart {
  readonly nodes: ReadonlyMap<string, FlowNode>;
  readonly edges: readonly FlowEdge[];
  readonly subgraphs: readonly FlowSubgraph[];
  readonly direction?: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
}

/** Layout tuning parameters for Mermaid flowchart and state-diagram SVG rendering. */
export interface MermaidLayoutOptions {
  /** Maximum characters per wrapped node label line (24 when omitted). */
  readonly maxLabelChars?: number;
  /** Maximum wrapped lines per node label before ellipsis truncation (3 when omitted). */
  readonly maxLabelLines?: number;
  /** Maximum columns inside a compound `subgraph` container (2 when omitted). */
  readonly maxSubgraphCols?: number;
  /** Maximum columns in a top-level vertical rank before wrapping (3 when omitted). */
  readonly maxTopCols?: number;
  /** Minimum CSS width scale floor applied when `viewBox` width exceeds 420px (0.78 when omitted). */
  readonly minReadableScale?: number;
}

interface ResolvedLayoutOptions {
  readonly maxLabelChars: number;
  readonly maxLabelLines: number;
  readonly maxSubgraphCols: number;
  readonly maxTopCols: number;
  readonly minReadableScale: number;
}

interface MutableSubgraph {
  id: string;
  title: string;
  caption?: string;
  nodeIds: string[];
  order: number;
}

interface PositionedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rank: number;
  row: number;
}

interface SubgraphMeasurement {
  readonly w: number;
  readonly h: number;
  readonly titleLines: readonly string[];
  readonly localCoords: ReadonlyMap<
    string,
    { dx: number; dy: number; w: number; h: number; rank: number }
  >;
  readonly intraEdges: readonly FlowEdge[];
}

interface ArrowMatch {
  readonly start: number;
  readonly end: number;
  readonly label?: string;
  readonly dashed: boolean;
}

const DEFAULT_OPTIONS: ResolvedLayoutOptions = {
  maxLabelChars: 24,
  maxLabelLines: 3,
  maxSubgraphCols: 2,
  maxTopCols: 3,
  minReadableScale: 0.78,
};

function resolveOptions(options?: MermaidLayoutOptions): ResolvedLayoutOptions {
  return {
    maxLabelChars: Math.max(8, options?.maxLabelChars ?? DEFAULT_OPTIONS.maxLabelChars),
    maxLabelLines: Math.max(1, options?.maxLabelLines ?? DEFAULT_OPTIONS.maxLabelLines),
    maxSubgraphCols: Math.max(1, options?.maxSubgraphCols ?? DEFAULT_OPTIONS.maxSubgraphCols),
    maxTopCols: Math.max(1, options?.maxTopCols ?? DEFAULT_OPTIONS.maxTopCols),
    minReadableScale: Math.min(
      1,
      Math.max(0.4, options?.minReadableScale ?? DEFAULT_OPTIONS.minReadableScale),
    ),
  };
}

/** Escapes special XML characters before interpolating text into SVG markup. */
export function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function splitLongWord(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) {
    return [word];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < word.length) {
    chunks.push(word.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return chunks;
}

function wrapSegment(segment: string, maxChars: number): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => splitLongWord(w, maxChars));
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const current = lines[lines.length - 1];
    if (current.length + 1 + word.length <= maxChars) {
      lines[lines.length - 1] = `${current} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/**
 * Wraps a Mermaid node label on explicit `<br/>` / newline breaks and word boundaries.
 *
 * Truncates the final allowed line with an ellipsis when the wrapped text exceeds `maxLines`.
 */
export function wrapNodeLabel(
  label: string,
  maxChars: number = DEFAULT_OPTIONS.maxLabelChars,
  maxLines: number = DEFAULT_OPTIONS.maxLabelLines,
): string[] {
  const safeMaxChars = Math.max(8, maxChars);
  const safeMaxLines = Math.max(1, maxLines);
  const normalized = label.replace(/<br\s*\/?>/gi, '\n').trim();
  if (!normalized) {
    return [''];
  }
  const wrapped = normalized.split(/\r?\n/).flatMap((part) => wrapSegment(part, safeMaxChars));
  if (wrapped.length === 0) {
    return [''];
  }
  if (wrapped.length <= safeMaxLines) {
    return wrapped;
  }
  const truncated = wrapped.slice(0, safeMaxLines);
  const last = truncated[safeMaxLines - 1];
  truncated[safeMaxLines - 1] =
    last.length >= safeMaxChars ? `${last.slice(0, safeMaxChars - 1).trimEnd()}…` : `${last}…`;
  return truncated;
}

function splitSubgraphTitle(rawTitle: string): { title: string; caption?: string } {
  const trimmed = rawTitle.trim();
  const parenMatch = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(trimmed);
  if (parenMatch) {
    return { title: parenMatch[1].trim(), caption: parenMatch[2].trim() };
  }
  const bracketMatch = /^(.+?)\s*\[(Parallel|Sequential[^\]]*)\]\s*$/i.exec(trimmed);
  if (bracketMatch) {
    return { title: bracketMatch[1].trim(), caption: bracketMatch[2].trim() };
  }
  return { title: trimmed };
}

function parseSubgraphHeader(
  line: string,
  index: number,
  order: number,
): MutableSubgraph | undefined {
  const body = /^subgraph\s+(.+)$/i.exec(line)?.[1]?.trim();
  if (!body) {
    return undefined;
  }
  const bracketed = /^([A-Za-z0-9_.-]+)\s*\[\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\s*\]$/.exec(body);
  if (bracketed) {
    const raw = bracketed[2] ?? bracketed[3] ?? bracketed[4] ?? bracketed[1];
    const { title, caption } = splitSubgraphTitle(raw);
    return { id: bracketed[1], title: title || bracketed[1], caption, nodeIds: [], order };
  }
  const quotedOnly = /^(?:"([^"]+)"|'([^']+)')$/.exec(body);
  if (quotedOnly) {
    const raw = quotedOnly[1] ?? quotedOnly[2] ?? `Group ${index + 1}`;
    const { title, caption } = splitSubgraphTitle(raw);
    return { id: `__sg_${index}`, title, caption, nodeIds: [], order };
  }
  if (/^[A-Za-z0-9_.-]+$/.test(body)) {
    return { id: body, title: body, nodeIds: [], order };
  }
  const { title, caption } = splitSubgraphTitle(body);
  return { id: `__sg_${index}`, title, caption, nodeIds: [], order };
}

function stripOuterQuotes(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

const NODE_SHAPE_DELIMITERS: ReadonlyArray<
  readonly [open: string, close: string, shape: FlowNode['shape']]
> = [
  ['([', '])', 'round'],
  ['[[', ']]', 'rect'],
  ['[(', ')]', 'round'],
  ['((', '))', 'round'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
];

function extractNodeShapeAndLabel(
  suffix: string,
): { shape: FlowNode['shape']; label: string } | undefined {
  const trimmed = suffix.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const [open, close, shape] of NODE_SHAPE_DELIMITERS) {
    if (
      trimmed.startsWith(open) &&
      trimmed.endsWith(close) &&
      trimmed.length >= open.length + close.length
    ) {
      return { shape, label: stripOuterQuotes(trimmed.slice(open.length, -close.length)) };
    }
  }
  return undefined;
}

function registerNode(
  raw: string,
  nodes: Map<string, FlowNode>,
  subgraphsById: ReadonlyMap<string, MutableSubgraph>,
  activeSubgraph: MutableSubgraph | undefined,
  opts: ResolvedLayoutOptions,
  nextOrder: () => number,
): string {
  const trimmed = raw.trim();
  const idMatch = /^([A-Za-z0-9_.-]+)(.*)$/s.exec(trimmed);
  if (!idMatch) {
    const fallbackId = trimmed.replace(/\s+/g, '_') || 'node';
    if (!nodes.has(fallbackId)) {
      nodes.set(fallbackId, {
        id: fallbackId,
        label: trimmed,
        lines: wrapNodeLabel(trimmed, opts.maxLabelChars, opts.maxLabelLines),
        shape: 'rect',
        order: nextOrder(),
        subgraphId: activeSubgraph?.id,
      });
      activeSubgraph?.nodeIds.push(fallbackId);
    }
    return fallbackId;
  }

  const id = idMatch[1];
  const parsedSuffix = extractNodeShapeAndLabel(idMatch[2]);
  if (!parsedSuffix && subgraphsById.has(id)) {
    return id;
  }

  const existing = nodes.get(id);
  const order = existing?.order ?? nextOrder();
  const subgraphId = existing?.subgraphId ?? activeSubgraph?.id;
  if (parsedSuffix) {
    nodes.set(id, {
      id,
      label: parsedSuffix.label,
      lines: wrapNodeLabel(parsedSuffix.label, opts.maxLabelChars, opts.maxLabelLines),
      shape: parsedSuffix.shape,
      order,
      subgraphId,
    });
  } else if (!existing) {
    nodes.set(id, {
      id,
      label: id,
      lines: wrapNodeLabel(id, opts.maxLabelChars, opts.maxLabelLines),
      shape: 'rect',
      order,
      subgraphId,
    });
  }

  if (activeSubgraph && id !== activeSubgraph.id && !activeSubgraph.nodeIds.includes(id)) {
    activeSubgraph.nodeIds.push(id);
  }
  return id;
}

const INLINE_ARROW_RE =
  /^(?:--\s*([^>-][^>]*?)\s*--+>|-\.\s*([^.>-][^>]*?)\s*\.->|==\s*([^=>]+?)\s*==+>)(?:\s*\|([^|]*)\|)?/;
const PLAIN_ARROW_RE = /^(-\.+->|==+>|--+>)(?:\s*\|([^|]*)\|)?/;

function matchArrowAt(line: string, idx: number): ArrowMatch | undefined {
  const slice = line.slice(idx);
  const inlineMatch = INLINE_ARROW_RE.exec(slice);
  if (inlineMatch) {
    const inlineLabel = (inlineMatch[1] ?? inlineMatch[2] ?? inlineMatch[3] ?? '').trim();
    const pipeLabel = inlineMatch[4]?.trim();
    return {
      start: idx,
      end: idx + inlineMatch[0].length,
      label: pipeLabel || inlineLabel || undefined,
      dashed: inlineMatch[0].includes('.'),
    };
  }
  const plainMatch = PLAIN_ARROW_RE.exec(slice);
  if (plainMatch) {
    return {
      start: idx,
      end: idx + plainMatch[0].length,
      label: plainMatch[2]?.trim() || undefined,
      dashed: plainMatch[1].includes('.'),
    };
  }
  return undefined;
}

function nextQuoteState(
  text: string,
  idx: number,
  quote: '"' | "'" | undefined,
): { quote: '"' | "'" | undefined; consumed: boolean } {
  const ch = text[idx];
  if (quote) {
    return {
      quote: ch === quote && text[idx - 1] !== '\\' ? undefined : quote,
      consumed: true,
    };
  }
  if (ch === '"' || ch === "'") {
    return { quote: ch, consumed: true };
  }
  return { quote: undefined, consumed: false };
}

function nextBracketDepth(ch: string, depth: number): { depth: number; consumed: boolean } {
  if (ch === '[' || ch === '(' || ch === '{') {
    return { depth: depth + 1, consumed: true };
  }
  if (ch === ']' || ch === ')' || ch === '}') {
    return { depth: Math.max(0, depth - 1), consumed: true };
  }
  return { depth, consumed: false };
}

function scanOutsideDelimiters(text: string, onIndex: (idx: number) => number | undefined): void {
  let quote: '"' | "'" | undefined;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const qStep = nextQuoteState(text, i, quote);
    quote = qStep.quote;
    if (qStep.consumed) {
      i++;
      continue;
    }
    const bStep = nextBracketDepth(text[i], depth);
    depth = bStep.depth;
    if (!bStep.consumed && depth === 0) {
      const jump = onIndex(i);
      if (jump !== undefined) {
        i = jump;
        continue;
      }
    }
    i++;
  }
}

function findTopLevelArrows(line: string): ArrowMatch[] {
  const matches: ArrowMatch[] = [];
  scanOutsideDelimiters(line, (idx) => {
    const ch = line[idx];
    if (ch !== '-' && ch !== '=') {
      return undefined;
    }
    const m = matchArrowAt(line, idx);
    if (!m) {
      return undefined;
    }
    matches.push(m);
    return m.end;
  });
  return matches;
}

function splitAmpersandTokens(segment: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scanOutsideDelimiters(segment, (idx) => {
    if (segment[idx] === '&') {
      const token = segment.slice(start, idx).trim();
      if (token) {
        parts.push(token);
      }
      start = idx + 1;
    }
    return undefined;
  });
  const tail = segment.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

function finalizeSubgraphs(
  rawSubgraphs: readonly MutableSubgraph[],
  nodes: Map<string, FlowNode>,
  opts: ResolvedLayoutOptions,
): FlowSubgraph[] {
  const finalized: FlowSubgraph[] = [];
  for (const sg of rawSubgraphs) {
    if (sg.nodeIds.length === 0) {
      if (!nodes.has(sg.id)) {
        nodes.set(sg.id, {
          id: sg.id,
          label: sg.title,
          lines: wrapNodeLabel(sg.title, opts.maxLabelChars, opts.maxLabelLines),
          shape: 'rect',
          order: sg.order,
        });
      }
      continue;
    }
    finalized.push({
      id: sg.id,
      title: sg.title,
      caption: sg.caption,
      nodeIds: [...sg.nodeIds],
      order: sg.order,
    });
  }
  return finalized;
}

function isIgnoredFlowDirective(line: string): boolean {
  return /^(?:style|classDef|class|click|linkStyle|direction)\b/i.test(line);
}

interface FlowchartParseState {
  readonly opts: ResolvedLayoutOptions;
  readonly nodes: Map<string, FlowNode>;
  readonly edges: FlowEdge[];
  readonly rawSubgraphs: MutableSubgraph[];
  readonly subgraphsById: Map<string, MutableSubgraph>;
  readonly stack: MutableSubgraph[];
  readonly nextOrder: () => number;
}

function openSubgraphFrame(line: string, state: FlowchartParseState): void {
  if (state.stack.length > 0) {
    state.stack.push(state.stack[0]);
    return;
  }
  const sg = parseSubgraphHeader(line, state.rawSubgraphs.length, state.nextOrder());
  if (!sg) {
    return;
  }
  const placeholder = state.nodes.get(sg.id);
  if (placeholder && placeholder.label === sg.id) {
    state.nodes.delete(sg.id);
  }
  state.rawSubgraphs.push(sg);
  state.subgraphsById.set(sg.id, sg);
  state.stack.push(sg);
}

function appendCartesianEdges(
  fromIds: readonly string[],
  toIds: readonly string[],
  arrow: ArrowMatch,
  edges: FlowEdge[],
): void {
  for (const fromId of fromIds) {
    for (const toId of toIds) {
      edges.push({ from: fromId, to: toId, label: arrow.label, dashed: arrow.dashed });
    }
  }
}

function parseFlowchartStatement(line: string, state: FlowchartParseState): void {
  const activeSg = state.stack[0];
  const arrows = findTopLevelArrows(line);
  if (arrows.length === 0) {
    for (const token of splitAmpersandTokens(line)) {
      registerNode(token, state.nodes, state.subgraphsById, activeSg, state.opts, state.nextOrder);
    }
    return;
  }
  const segments: string[][] = [];
  let cursor = 0;
  for (const arrow of arrows) {
    segments.push(splitAmpersandTokens(line.slice(cursor, arrow.start)));
    cursor = arrow.end;
  }
  segments.push(splitAmpersandTokens(line.slice(cursor)));

  const segmentIds = segments.map((tokens) =>
    tokens.map((tok) =>
      registerNode(tok, state.nodes, state.subgraphsById, activeSg, state.opts, state.nextOrder),
    ),
  );
  for (let i = 0; i < arrows.length; i++) {
    appendCartesianEdges(segmentIds[i], segmentIds[i + 1], arrows[i], state.edges);
  }
}

/**
 * Parses Mermaid `flowchart` / `graph` body lines into nodes, edges, and 1-level `FlowSubgraph` containers.
 */
export function parseFlowchartLines(
  lines: readonly string[],
  options?: MermaidLayoutOptions,
): ParsedFlowchart {
  let orderCounter = 0;
  const state: FlowchartParseState = {
    opts: resolveOptions(options),
    nodes: new Map<string, FlowNode>(),
    edges: [],
    rawSubgraphs: [],
    subgraphsById: new Map<string, MutableSubgraph>(),
    stack: [],
    nextOrder: () => orderCounter++,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, '');
    if (!line || line.startsWith('%%') || isIgnoredFlowDirective(line)) {
      continue;
    }
    if (/^end\b/i.test(line)) {
      state.stack.pop();
    } else if (/^subgraph\b/i.test(line)) {
      openSubgraphFrame(line, state);
    } else {
      parseFlowchartStatement(line, state);
    }
  }

  const subgraphs = finalizeSubgraphs(state.rawSubgraphs, state.nodes, state.opts);
  return { nodes: state.nodes, edges: state.edges, subgraphs };
}

const STATE_ALIAS_RE = /^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_.-]+)$/i;
const STATE_TRANSITION_RE =
  /^(\[\*\]|[A-Za-z0-9_.-]+)\s*(-->|--\.->|-\.->)\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/;
const STATE_DESC_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/;
const STATE_DIR_RE = /^direction\s+(TD|TB|LR|RL|BT)\b/i;

function ensureStateNode(
  token: string,
  isSource: boolean,
  nodes: Map<string, FlowNode>,
  opts: ResolvedLayoutOptions,
): string {
  if (token === '[*]') {
    const id = isSource ? '__start__' : '__end__';
    const shape = isSource ? 'start' : 'end';
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: '', lines: [''], shape, order: nodes.size });
    }
    return id;
  }
  if (!nodes.has(token)) {
    nodes.set(token, {
      id: token,
      label: token,
      lines: wrapNodeLabel(token, opts.maxLabelChars, opts.maxLabelLines),
      shape: 'round',
      order: nodes.size,
    });
  }
  return token;
}

function parseSingleStateLine(
  line: string,
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
  opts: ResolvedLayoutOptions,
): ParsedFlowchart['direction'] | undefined {
  const dirMatch = STATE_DIR_RE.exec(line);
  if (dirMatch) {
    return dirMatch[1].toUpperCase() as ParsedFlowchart['direction'];
  }
  const aliasMatch = STATE_ALIAS_RE.exec(line);
  if (aliasMatch) {
    const label = aliasMatch[1].trim();
    const id = aliasMatch[2].trim();
    nodes.set(id, {
      id,
      label,
      lines: wrapNodeLabel(label, opts.maxLabelChars, opts.maxLabelLines),
      shape: 'round',
      order: nodes.get(id)?.order ?? nodes.size,
    });
    return undefined;
  }
  const transMatch = STATE_TRANSITION_RE.exec(line);
  if (transMatch) {
    edges.push({
      from: ensureStateNode(transMatch[1].trim(), true, nodes, opts),
      to: ensureStateNode(transMatch[3].trim(), false, nodes, opts),
      label: transMatch[4]?.trim(),
      dashed: transMatch[2].includes('.'),
    });
    return undefined;
  }
  const descMatch = STATE_DESC_RE.exec(line);
  if (descMatch) {
    const id = descMatch[1].trim();
    const existing = nodes.get(id);
    const label =
      existing && existing.label !== id ? existing.label : `${id}: ${descMatch[2].trim()}`;
    nodes.set(id, {
      id,
      label,
      lines: wrapNodeLabel(label, opts.maxLabelChars, opts.maxLabelLines),
      shape: 'round',
      order: existing?.order ?? nodes.size,
    });
  }
  return undefined;
}

/**
 * Parses Mermaid `stateDiagram` / `stateDiagram-v2` body lines into a `ParsedFlowchart`.
 */
export function parseStateDiagramLines(
  lines: readonly string[],
  options?: MermaidLayoutOptions,
): ParsedFlowchart {
  const opts = resolveOptions(options);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let direction: ParsedFlowchart['direction'] = 'TD';

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, '');
    if (!line || line.startsWith('%%') || /^(?:note\b|end\s+note\b|\}|\{)/i.test(line)) {
      continue;
    }
    const parsedDir = parseSingleStateLine(line, nodes, edges, opts);
    if (parsedDir) {
      direction = parsedDir;
    }
  }

  return { nodes, edges, subgraphs: [], direction };
}

function computeNodeDimensions(node: FlowNode): { w: number; h: number } {
  if (node.shape === 'start' || node.shape === 'end') {
    return { w: 22, h: 22 };
  }
  const maxChars = Math.max(1, ...node.lines.map((l) => l.length));
  const extraW = node.shape === 'diamond' ? 36 : 20;
  const extraH = node.shape === 'diamond' ? 26 : 18;
  return {
    w: clamp(104, Math.ceil(maxChars * 6.4) + extraW, 166),
    h: extraH + node.lines.length * 16,
  };
}

function computeTopologicalRanks(
  itemOrders: ReadonlyMap<string, number>,
  edges: readonly { from: string; to: string }[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of itemOrders.keys()) {
    ranks.set(id, 0);
  }
  for (let iter = 0; iter < itemOrders.size; iter++) {
    let changed = false;
    for (const edge of edges) {
      const fromOrder = itemOrders.get(edge.from);
      const toOrder = itemOrders.get(edge.to);
      if (fromOrder === undefined || toOrder === undefined || fromOrder >= toOrder) {
        continue;
      }
      const nextRank = (ranks.get(edge.from) ?? 0) + 1;
      if ((ranks.get(edge.to) ?? 0) < nextRank) {
        ranks.set(edge.to, nextRank);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return ranks;
}

function chunkItems<T>(items: readonly T[], maxCols: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += maxCols) {
    rows.push(items.slice(i, i + maxCols));
  }
  return rows;
}

function groupIdsByRank(
  ids: readonly string[],
  ranks: ReadonlyMap<string, number>,
): { byRank: Map<number, string[]>; maxRank: number } {
  let maxRank = 0;
  const byRank = new Map<number, string[]>();
  for (const id of ids) {
    const r = ranks.get(id) ?? 0;
    maxRank = Math.max(maxRank, r);
    const list = byRank.get(r) ?? [];
    list.push(id);
    byRank.set(r, list);
  }
  return { byRank, maxRank };
}

interface SubgraphRow {
  readonly ids: string[];
  readonly rank: number;
  readonly rowW: number;
  readonly rowH: number;
}

function buildSubgraphRows(
  byRank: ReadonlyMap<number, string[]>,
  maxLocalRank: number,
  nodeDims: ReadonlyMap<string, { w: number; h: number }>,
  maxSubgraphCols: number,
  colGap: number,
): { subRows: SubgraphRow[]; maxGridW: number } {
  const subRows: SubgraphRow[] = [];
  let maxGridW = 0;
  for (let r = 0; r <= maxLocalRank; r++) {
    for (const chunk of chunkItems(byRank.get(r) ?? [], maxSubgraphCols)) {
      const rowW =
        chunk.reduce((sum, id) => sum + (nodeDims.get(id)?.w ?? 120), 0) +
        Math.max(0, chunk.length - 1) * colGap;
      const rowH = Math.max(34, ...chunk.map((id) => nodeDims.get(id)?.h ?? 34));
      maxGridW = Math.max(maxGridW, rowW);
      subRows.push({ ids: chunk, rank: r, rowW, rowH });
    }
  }
  return { subRows, maxGridW };
}

function measureSubgraph(
  sg: FlowSubgraph,
  nodes: ReadonlyMap<string, FlowNode>,
  nodeDims: ReadonlyMap<string, { w: number; h: number }>,
  intraEdges: readonly FlowEdge[],
  opts: ResolvedLayoutOptions,
): SubgraphMeasurement {
  const padX = 13;
  const padBottom = 12;
  const colGap = 12;
  const subRowGap = 10;
  const localRankGap = 24;

  const titleLines = wrapNodeLabel(sg.title, 38, 2);
  const headerH = 14 + titleLines.length * 15 + (sg.caption ? 15 : 0);
  const titleWidth = Math.max(
    ...titleLines.map((l) => Math.ceil(l.length * 7.2)),
    sg.caption ? Math.ceil(sg.caption.length * 6.4) : 0,
  );

  const localOrders = new Map<string, number>();
  for (const id of sg.nodeIds) {
    const node = nodes.get(id);
    if (node) {
      localOrders.set(id, node.order);
    }
  }
  const localRanks = computeTopologicalRanks(localOrders, intraEdges);
  const { byRank, maxRank: maxLocalRank } = groupIdsByRank(sg.nodeIds, localRanks);
  const { subRows, maxGridW } = buildSubgraphRows(
    byRank,
    maxLocalRank,
    nodeDims,
    opts.maxSubgraphCols,
    colGap,
  );

  const containerW = clamp(180, Math.max(maxGridW + padX * 2, titleWidth + padX * 2 + 8), 448);
  const localCoords = new Map<
    string,
    { dx: number; dy: number; w: number; h: number; rank: number }
  >();
  let cursorY = headerH;
  for (let idx = 0; idx < subRows.length; idx++) {
    const sr = subRows[idx];
    if (idx > 0) {
      cursorY += sr.rank > subRows[idx - 1].rank ? localRankGap : subRowGap;
    }
    const cyOffset = cursorY + sr.rowH / 2;
    let cursorX = -sr.rowW / 2;
    for (const id of sr.ids) {
      const d = nodeDims.get(id)!;
      localCoords.set(id, { dx: cursorX + d.w / 2, dy: cyOffset, w: d.w, h: d.h, rank: sr.rank });
      cursorX += d.w + colGap;
    }
    cursorY += sr.rowH;
  }

  const containerH = cursorY + padBottom;
  const centeredCoords = new Map<
    string,
    { dx: number; dy: number; w: number; h: number; rank: number }
  >();
  for (const [id, c] of localCoords.entries()) {
    centeredCoords.set(id, { ...c, dy: c.dy - containerH / 2 });
  }
  return { w: containerW, h: containerH, titleLines, localCoords: centeredCoords, intraEdges };
}

function layoutHorizontalMacro(
  macroIds: readonly string[],
  macroRanks: ReadonlyMap<string, number>,
  macroDims: ReadonlyMap<string, { w: number; h: number }>,
  macroEdges: readonly FlowEdge[],
  hasBackEdge: boolean,
): { coords: Map<string, PositionedBox>; maxX: number; maxY: number } {
  const padX = 16;
  const padY = 16;
  const rowGapY = 20;
  let maxRank = 0;
  const byRank = new Map<number, string[]>();
  for (const id of macroIds) {
    const r = macroRanks.get(id) ?? 0;
    maxRank = Math.max(maxRank, r);
    const group = byRank.get(r) ?? [];
    group.push(id);
    byRank.set(r, group);
  }

  const colWidths = new Array<number>(maxRank + 1).fill(108);
  const colHeights = new Array<number>(maxRank + 1).fill(34);
  for (let r = 0; r <= maxRank; r++) {
    const group = byRank.get(r) ?? [];
    for (const id of group) {
      colWidths[r] = Math.max(colWidths[r], macroDims.get(id)!.w);
    }
    colHeights[r] =
      group.reduce((sum, id) => sum + macroDims.get(id)!.h, 0) +
      Math.max(0, group.length - 1) * rowGapY;
  }

  const colGap = new Array<number>(maxRank + 1).fill(46);
  for (const e of macroEdges) {
    const rf = macroRanks.get(e.from) ?? 0;
    const rt = macroRanks.get(e.to) ?? 0;
    if (rt > rf && e.label) {
      colGap[rf] = Math.max(colGap[rf], Math.ceil(e.label.length * 6.4) + 28);
    }
  }

  const colCenterX: number[] = [];
  let cursorX = padX;
  for (let r = 0; r <= maxRank; r++) {
    colCenterX[r] = cursorX + colWidths[r] / 2;
    cursorX += colWidths[r] + colGap[r];
  }
  const maxColH = Math.max(34, ...colHeights);
  const topSlack = hasBackEdge ? 24 : 0;
  const maxX = cursorX - (colGap[maxRank] ?? 46) + padX;
  const maxY = padY * 2 + maxColH + topSlack;

  const coords = new Map<string, PositionedBox>();
  for (let r = 0; r <= maxRank; r++) {
    const group = byRank.get(r) ?? [];
    let cursorY = padY + topSlack + (maxColH - colHeights[r]) / 2;
    group.forEach((id, idx) => {
      const d = macroDims.get(id)!;
      coords.set(id, {
        cx: colCenterX[r],
        cy: cursorY + d.h / 2,
        w: d.w,
        h: d.h,
        rank: r,
        row: idx,
      });
      cursorY += d.h + rowGapY;
    });
  }
  return { coords, maxX, maxY };
}

interface VerticalBand {
  readonly ids: string[];
  readonly rank: number;
  readonly rowW: number;
  readonly rowH: number;
  readonly isLastSubRow: boolean;
}

function computeIncomingLabelMetrics(
  macroEdges: readonly FlowEdge[],
  macroRanks: ReadonlyMap<string, number>,
): { incomingLabelW: Map<string, number>; labeledByRank: Map<number, number> } {
  const incomingLabelW = new Map<string, number>();
  const labeledByRank = new Map<number, number>();
  for (const e of macroEdges) {
    const rf = macroRanks.get(e.from) ?? 0;
    const rt = macroRanks.get(e.to) ?? 0;
    if (rf < rt && e.label) {
      incomingLabelW.set(
        e.to,
        Math.max(incomingLabelW.get(e.to) ?? 0, Math.ceil(e.label.length * 6.2) + 22),
      );
      labeledByRank.set(rf, (labeledByRank.get(rf) ?? 0) + 1);
    }
  }
  return { incomingLabelW, labeledByRank };
}

function verticalSlotWidth(
  id: string,
  bandLen: number,
  macroDims: ReadonlyMap<string, { w: number; h: number }>,
  incomingLabelW: ReadonlyMap<string, number>,
): number {
  const baseW = macroDims.get(id)!.w;
  return bandLen <= 1 ? baseW : Math.max(baseW, incomingLabelW.get(id) ?? 0);
}

function chunkRankForVerticalBands(
  ids: readonly string[],
  sgById: ReadonlyMap<string, FlowSubgraph>,
  maxTopCols: number,
): string[][] {
  const effectiveCols = ids.length >= 4 && maxTopCols === 3 ? 2 : maxTopCols;
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const id of ids) {
    if (sgById.has(id)) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
      chunks.push([id]);
      continue;
    }
    current.push(id);
    if (current.length >= effectiveCols) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function buildVerticalBands(
  orderedRanks: readonly number[],
  byRank: ReadonlyMap<number, string[]>,
  macroDims: ReadonlyMap<string, { w: number; h: number }>,
  incomingLabelW: ReadonlyMap<string, number>,
  sgById: ReadonlyMap<string, FlowSubgraph>,
  maxTopCols: number,
  colGapX: number,
): { bands: VerticalBand[]; maxRowWidth: number } {
  const bands: VerticalBand[] = [];
  let maxRowWidth = 200;
  for (const r of orderedRanks) {
    const chunks = chunkRankForVerticalBands(byRank.get(r) ?? [], sgById, maxTopCols);
    chunks.forEach((chunk, chunkIdx) => {
      const rowW =
        chunk.reduce(
          (s, id) => s + verticalSlotWidth(id, chunk.length, macroDims, incomingLabelW),
          0,
        ) +
        Math.max(0, chunk.length - 1) * colGapX;
      const rowH = Math.max(34, ...chunk.map((id) => macroDims.get(id)!.h));
      maxRowWidth = Math.max(maxRowWidth, rowW);
      bands.push({ ids: chunk, rank: r, rowW, rowH, isLastSubRow: chunkIdx === chunks.length - 1 });
    });
  }
  return { bands, maxRowWidth };
}

function nextVerticalGap(band: VerticalBand, labeledByRank: ReadonlyMap<number, number>): number {
  if (!band.isLastSubRow) {
    return 14;
  }
  return (labeledByRank.get(band.rank) ?? 0) >= 2 ? 56 : 34;
}

function layoutVerticalMacro(
  macroIds: readonly string[],
  macroRanks: ReadonlyMap<string, number>,
  macroDims: ReadonlyMap<string, { w: number; h: number }>,
  macroEdges: readonly FlowEdge[],
  sgById: ReadonlyMap<string, FlowSubgraph>,
  hasBackEdge: boolean,
  reverseRanks: boolean,
  maxTopCols: number,
): { coords: Map<string, PositionedBox>; maxX: number; maxY: number } {
  const leftMargin = hasBackEdge ? 80 : 16;
  const rightMargin = 16;
  const padY = 16;
  const colGapX = 14;

  const { byRank, maxRank } = groupIdsByRank(macroIds, macroRanks);
  const { incomingLabelW, labeledByRank } = computeIncomingLabelMetrics(macroEdges, macroRanks);

  const orderedRanks: number[] = [];
  for (let r = 0; r <= maxRank; r++) {
    orderedRanks.push(reverseRanks ? maxRank - r : r);
  }
  const { bands, maxRowWidth } = buildVerticalBands(
    orderedRanks,
    byRank,
    macroDims,
    incomingLabelW,
    sgById,
    maxTopCols,
    colGapX,
  );

  const coords = new Map<string, PositionedBox>();
  let cursorY = padY;
  for (let bandIdx = 0; bandIdx < bands.length; bandIdx++) {
    const band = bands[bandIdx];
    const cy = cursorY + band.rowH / 2;
    let startX = leftMargin + (maxRowWidth - band.rowW) / 2;
    for (let idx = 0; idx < band.ids.length; idx++) {
      const id = band.ids[idx];
      const d = macroDims.get(id)!;
      const slotW = verticalSlotWidth(id, band.ids.length, macroDims, incomingLabelW);
      coords.set(id, { cx: startX + slotW / 2, cy, w: d.w, h: d.h, rank: band.rank, row: idx });
      startX += slotW + colGapX;
    }
    cursorY += band.rowH;
    if (bandIdx < bands.length - 1) {
      cursorY += nextVerticalGap(band, labeledByRank);
    }
  }

  return {
    coords,
    maxX: leftMargin + maxRowWidth + rightMargin,
    maxY: cursorY + padY,
  };
}

function renderNodeTextSvg(cx: number, cy: number, lines: readonly string[]): string {
  if (lines.length <= 1) {
    return `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="500" fill="var(--a2ui-text-color-text, #1f1f1f)">${escapeSvgText(lines[0] ?? '')}</text>`;
  }
  const lineH = 15;
  const firstY = cy - ((lines.length - 1) * lineH) / 2 + 4;
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" y="${firstY + i * lineH}">${escapeSvgText(line)}</tspan>`)
    .join('');
  return `<text text-anchor="middle" font-size="12" font-weight="500" fill="var(--a2ui-text-color-text, #1f1f1f)">${tspans}</text>`;
}

function renderSingleNodeSvg(node: FlowNode, box: PositionedBox): string {
  if (node.shape === 'start') {
    return `<g class="a2ui-mermaid-node"><circle cx="${box.cx}" cy="${box.cy}" r="8" fill="var(--a2ui-color-primary, #0b57d0)" /></g>`;
  }
  if (node.shape === 'end') {
    return `<g class="a2ui-mermaid-node"><circle cx="${box.cx}" cy="${box.cy}" r="9" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5" /><circle cx="${box.cx}" cy="${box.cy}" r="5" fill="var(--a2ui-color-primary, #0b57d0)" /></g>`;
  }
  const x = box.cx - box.w / 2;
  const y = box.cy - box.h / 2;
  const rx = node.shape === 'round' ? 14 : 6;
  const shapeEl =
    node.shape === 'diamond'
      ? `<polygon points="${box.cx},${y} ${x + box.w},${box.cy} ${box.cx},${y + box.h} ${x},${box.cy}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5" />`
      : `<rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="${rx}" fill="var(--a2ui-color-secondary, #f1f3f4)" stroke="var(--a2ui-color-border, #dadce0)" stroke-width="1.5" />`;
  return `<g class="a2ui-mermaid-node">${shapeEl}${renderNodeTextSvg(box.cx, box.cy, node.lines)}</g>`;
}

function renderSubgraphFrameSvg(
  sg: FlowSubgraph,
  box: PositionedBox,
  measurement: SubgraphMeasurement,
): string {
  const x = box.cx - box.w / 2;
  const y = box.cy - box.h / 2;
  const titleSpans = measurement.titleLines
    .map(
      (line, idx) => `<tspan x="${box.cx}" y="${y + 18 + idx * 15}">${escapeSvgText(line)}</tspan>`,
    )
    .join('');
  const captionY = y + 18 + measurement.titleLines.length * 15;
  const captionEl = sg.caption
    ? `<text x="${box.cx}" y="${captionY}" text-anchor="middle" font-size="10.5" font-weight="500" fill="var(--a2ui-text-caption-color, #70757a)">${escapeSvgText(sg.caption)}</text>`
    : '';
  return `<g class="a2ui-mermaid-subgraph" data-subgraph-id="${escapeSvgText(sg.id)}"><rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="10" fill="color-mix(in srgb, var(--a2ui-color-primary, #0b57d0) 6%, var(--a2ui-color-surface, #ffffff))" stroke="var(--a2ui-color-border, #dadce0)" stroke-width="1.25" /><text text-anchor="middle" font-size="12" font-weight="600" fill="var(--a2ui-text-color-text, #1f1f1f)">${titleSpans}</text>${captionEl}</g>`;
}

const LABEL_HALO_ATTRS =
  'paint-order="stroke fill" stroke="var(--a2ui-color-surface, #ffffff)" stroke-width="4" stroke-linejoin="round"';

function buildForwardOutBySource(
  edges: readonly FlowEdge[],
  coords: ReadonlyMap<string, PositionedBox>,
  isHorizontal: boolean,
): Map<string, FlowEdge[]> {
  const forwardOutBySource = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const f = coords.get(e.from);
    const t = coords.get(e.to);
    if (!f || !t || f.rank >= t.rank || e.from === e.to) {
      continue;
    }
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
  return forwardOutBySource;
}

function renderDirectForwardEdge(
  e: FlowEdge,
  from: PositionedBox,
  to: PositionedBox,
  isHorizontal: boolean,
  dash: string,
  edgeLines: string[],
  edgeLabels: string[],
): void {
  const x1 = isHorizontal ? from.cx + from.w / 2 : from.cx;
  const y1 = isHorizontal ? from.cy : from.cy + from.h / 2;
  const x2 = isHorizontal ? to.cx - to.w / 2 - 4 : to.cx;
  const y2 = isHorizontal ? to.cy : to.cy - to.h / 2 - 4;
  edgeLines.push(
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
  );
  if (!e.label) {
    return;
  }
  const midX = (x1 + x2) / 2;
  const midY = isHorizontal ? (y1 + y2) / 2 - 6 : (y1 + y2) / 2 + 3;
  const textOffset = !isHorizontal && Math.abs(x1 - x2) < 8 ? 8 : 0;
  const anchor = textOffset > 0 ? 'start' : 'middle';
  edgeLabels.push(
    `<text x="${midX + textOffset}" y="${midY}" text-anchor="${anchor}" font-size="10.5" ${LABEL_HALO_ATTRS} fill="var(--a2ui-text-caption-color, #70757a)">${escapeSvgText(e.label)}</text>`,
  );
}

function renderEdgesSvg(
  edges: readonly FlowEdge[],
  coords: ReadonlyMap<string, PositionedBox>,
  isHorizontal: boolean,
): { edgeSvg: string; edgeLabelSvg: string } {
  const forwardOutBySource = buildForwardOutBySource(edges, coords, isHorizontal);
  const edgeLines: string[] = [];
  const edgeLabels: string[] = [];

  for (const e of edges) {
    const from = coords.get(e.from);
    const to = coords.get(e.to);
    if (!from || !to) {
      continue;
    }
    const isBackEdge = from.rank >= to.rank && e.from !== e.to;
    const dash = e.dashed || isBackEdge ? ' stroke-dasharray="4 3"' : '';
    if (isBackEdge) {
      renderBackEdge(e, from, to, isHorizontal, dash, LABEL_HALO_ATTRS, edgeLines, edgeLabels);
      continue;
    }
    const siblings = forwardOutBySource.get(e.from) ?? [e];
    if (!isHorizontal && siblings.length > 1) {
      renderFanOutEdge(e, from, to, siblings, dash, LABEL_HALO_ATTRS, edgeLines, edgeLabels);
    } else {
      renderDirectForwardEdge(e, from, to, isHorizontal, dash, edgeLines, edgeLabels);
    }
  }

  return { edgeSvg: edgeLines.join(''), edgeLabelSvg: edgeLabels.join('') };
}

function renderBackEdge(
  e: FlowEdge,
  from: PositionedBox,
  to: PositionedBox,
  isHorizontal: boolean,
  dash: string,
  labelHaloAttrs: string,
  edgeLines: string[],
  edgeLabels: string[],
): void {
  if (isHorizontal) {
    const x1 = from.cx;
    const y1 = from.cy - from.h / 2;
    const x2 = to.cx;
    const y2 = to.cy - to.h / 2 - 4;
    const ctrlY = Math.min(y1, y2) - 24;
    const midX = (x1 + x2) / 2;
    edgeLines.push(
      `<path d="M ${x1} ${y1} Q ${midX} ${ctrlY} ${x2} ${y2}" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
    );
    if (e.label) {
      edgeLabels.push(
        `<text x="${midX}" y="${ctrlY + 4}" text-anchor="middle" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeSvgText(e.label)}</text>`,
      );
    }
    return;
  }
  const x1 = from.cx - from.w / 2;
  const y1 = from.cy;
  const x2 = to.cx - to.w / 2 - 4;
  const y2 = to.cy;
  const arcX = Math.min(x1, x2) - 44;
  edgeLines.push(
    `<path d="M ${x1} ${y1} C ${arcX} ${y1}, ${arcX} ${y2}, ${x2} ${y2}" fill="none" stroke="var(--a2ui-color-primary, #0b57d0)" stroke-width="1.5"${dash} marker-end="url(#a2ui-arrow)" />`,
  );
  if (e.label) {
    edgeLabels.push(
      `<text x="${arcX - 4}" y="${(y1 + y2) / 2 + 3}" text-anchor="end" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeSvgText(e.label)}</text>`,
    );
  }
}

function renderFanOutEdge(
  e: FlowEdge,
  from: PositionedBox,
  to: PositionedBox,
  siblings: readonly FlowEdge[],
  dash: string,
  labelHaloAttrs: string,
  edgeLines: string[],
  edgeLabels: string[],
): void {
  const outCount = siblings.length;
  const outIdx = Math.max(0, siblings.indexOf(e));
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
    const yFraction = outCount >= 3 ? (outIdx % 2 === 0 ? 0.46 : 0.76) : 0.58;
    edgeLabels.push(
      `<text x="${x1 + 0.76 * (x2 - x1)}" y="${y1 + yFraction * (y2 - y1) + 3}" text-anchor="middle" font-size="10.5" ${labelHaloAttrs} fill="var(--a2ui-text-caption-color, #70757a)">${escapeSvgText(e.label)}</text>`,
    );
  }
}

function resolveMacroOwner(
  id: string,
  nodes: ReadonlyMap<string, FlowNode>,
  sgById: ReadonlyMap<string, FlowSubgraph>,
): string | undefined {
  if (sgById.has(id)) {
    return id;
  }
  const node = nodes.get(id);
  if (!node) {
    return undefined;
  }
  return node.subgraphId && sgById.has(node.subgraphId) ? node.subgraphId : id;
}

function partitionFlowEdges(
  edges: readonly FlowEdge[],
  nodes: ReadonlyMap<string, FlowNode>,
  sgById: ReadonlyMap<string, FlowSubgraph>,
): {
  intraEdgesBySg: Map<string, FlowEdge[]>;
  macroEdges: FlowEdge[];
  visibleOuterEdges: FlowEdge[];
} {
  const intraEdgesBySg = new Map<string, FlowEdge[]>();
  const macroEdges: FlowEdge[] = [];
  const visibleOuterEdges: FlowEdge[] = [];
  for (const edge of edges) {
    const ownerFrom = resolveMacroOwner(edge.from, nodes, sgById);
    const ownerTo = resolveMacroOwner(edge.to, nodes, sgById);
    if (!ownerFrom || !ownerTo) {
      continue;
    }
    if (ownerFrom === ownerTo && sgById.has(ownerFrom)) {
      const list = intraEdgesBySg.get(ownerFrom) ?? [];
      list.push(edge);
      intraEdgesBySg.set(ownerFrom, list);
    } else {
      macroEdges.push({ ...edge, from: ownerFrom, to: ownerTo });
      visibleOuterEdges.push(edge);
    }
  }
  return { intraEdgesBySg, macroEdges, visibleOuterEdges };
}

function buildMacroItems(
  parsed: ParsedFlowchart,
  sgById: ReadonlyMap<string, FlowSubgraph>,
  sgMeasurements: ReadonlyMap<string, SubgraphMeasurement>,
  nodeDims: ReadonlyMap<string, { w: number; h: number }>,
): Array<{ id: string; order: number; w: number; h: number }> {
  const macroItems: Array<{ id: string; order: number; w: number; h: number }> = [];
  for (const sg of parsed.subgraphs) {
    const m = sgMeasurements.get(sg.id)!;
    macroItems.push({ id: sg.id, order: sg.order, w: m.w, h: m.h });
  }
  for (const node of parsed.nodes.values()) {
    if (!node.subgraphId || !sgById.has(node.subgraphId)) {
      const d = nodeDims.get(node.id)!;
      macroItems.push({ id: node.id, order: node.order, w: d.w, h: d.h });
    }
  }
  macroItems.sort((a, b) => a.order - b.order);
  return macroItems;
}

function projectSubgraphChildren(
  subgraphs: readonly FlowSubgraph[],
  sgMeasurements: ReadonlyMap<string, SubgraphMeasurement>,
  allCoords: Map<string, PositionedBox>,
): void {
  for (const sg of subgraphs) {
    const sgBox = allCoords.get(sg.id);
    const m = sgMeasurements.get(sg.id);
    if (!sgBox || !m) {
      continue;
    }
    for (const [nodeId, local] of m.localCoords.entries()) {
      allCoords.set(nodeId, {
        cx: sgBox.cx + local.dx,
        cy: sgBox.cy + local.dy,
        w: local.w,
        h: local.h,
        rank: sgBox.rank * 100 + local.rank,
        row: 0,
      });
    }
  }
}

function resolveEffectiveDirection(
  rawDir: string,
  subgraphCount: number,
  maxMacroRank: number,
  macroCount: number,
): { effectiveDir: string; isHorizontal: boolean } {
  const normalizedDir = rawDir.toUpperCase();
  const hasParallelRank = macroCount > maxMacroRank + 1;
  const autoFlip =
    (normalizedDir === 'LR' || normalizedDir === 'RL') &&
    (subgraphCount > 0 ||
      maxMacroRank >= 3 ||
      (maxMacroRank >= 2 && hasParallelRank) ||
      macroCount >= 4);
  const effectiveDir = autoFlip ? 'TD' : normalizedDir;
  return { effectiveDir, isHorizontal: effectiveDir === 'LR' || effectiveDir === 'RL' };
}

function chooseMacroLayout(
  isHorizontal: boolean,
  effectiveDir: string,
  macroIds: readonly string[],
  macroRanks: ReadonlyMap<string, number>,
  macroDims: ReadonlyMap<string, { w: number; h: number }>,
  macroEdges: readonly FlowEdge[],
  sgById: ReadonlyMap<string, FlowSubgraph>,
  hasBackEdge: boolean,
  maxTopCols: number,
): { coords: Map<string, PositionedBox>; maxX: number; maxY: number; isHorizontal: boolean } {
  if (isHorizontal) {
    const horiz = layoutHorizontalMacro(macroIds, macroRanks, macroDims, macroEdges, hasBackEdge);
    if (horiz.maxX <= 560) {
      return { ...horiz, isHorizontal: true };
    }
  }
  const vert = layoutVerticalMacro(
    macroIds,
    macroRanks,
    macroDims,
    macroEdges,
    sgById,
    hasBackEdge,
    effectiveDir === 'BT',
    maxTopCols,
  );
  return { ...vert, isHorizontal: false };
}

/**
 * Renders a `ParsedFlowchart` into an inline `<div class="a2ui-mermaid"><svg>...</svg></div>` fragment.
 *
 * Returns `<pre class="a2ui-mermaid-fallback">` when the parsed graph contains zero nodes.
 */
export function renderFlowchartGraphSvg(
  parsed: ParsedFlowchart,
  direction: string,
  rawLines: readonly string[],
  options?: MermaidLayoutOptions,
): string {
  if (parsed.nodes.size === 0) {
    return `<pre class="a2ui-mermaid-fallback"><code>${escapeSvgText(rawLines.join('\n'))}</code></pre>`;
  }

  const opts = resolveOptions(options);
  const nodeDims = new Map(
    Array.from(parsed.nodes.entries(), ([id, node]) => [id, computeNodeDimensions(node)]),
  );
  const sgById = new Map(parsed.subgraphs.map((sg) => [sg.id, sg]));
  const { intraEdgesBySg, macroEdges, visibleOuterEdges } = partitionFlowEdges(
    parsed.edges,
    parsed.nodes,
    sgById,
  );
  const sgMeasurements = new Map(
    parsed.subgraphs.map((sg) => [
      sg.id,
      measureSubgraph(sg, parsed.nodes, nodeDims, intraEdgesBySg.get(sg.id) ?? [], opts),
    ]),
  );

  const macroItems = buildMacroItems(parsed, sgById, sgMeasurements, nodeDims);
  const macroOrders = new Map(macroItems.map((item) => [item.id, item.order]));
  const macroDims = new Map(macroItems.map((item) => [item.id, { w: item.w, h: item.h }]));
  const macroRanks = computeTopologicalRanks(macroOrders, macroEdges);
  const maxMacroRank = Math.max(0, ...macroRanks.values());
  const { effectiveDir, isHorizontal: initialHorizontal } = resolveEffectiveDirection(
    parsed.direction ?? direction,
    parsed.subgraphs.length,
    maxMacroRank,
    macroItems.length,
  );
  const hasBackEdge = macroEdges.some(
    (e) => (macroRanks.get(e.from) ?? 0) >= (macroRanks.get(e.to) ?? 0) && e.from !== e.to,
  );

  const macroIds = macroItems.map((item) => item.id);
  const {
    coords: allCoords,
    maxX,
    maxY,
    isHorizontal,
  } = chooseMacroLayout(
    initialHorizontal,
    effectiveDir,
    macroIds,
    macroRanks,
    macroDims,
    macroEdges,
    sgById,
    hasBackEdge,
    opts.maxTopCols,
  );
  projectSubgraphChildren(parsed.subgraphs, sgMeasurements, allCoords);

  const sgSvg = parsed.subgraphs
    .map((sg) => renderSubgraphFrameSvg(sg, allCoords.get(sg.id)!, sgMeasurements.get(sg.id)!))
    .join('');
  const allRenderableEdges = [...visibleOuterEdges, ...Array.from(intraEdgesBySg.values()).flat()];
  const { edgeSvg, edgeLabelSvg } = renderEdgesSvg(allRenderableEdges, allCoords, isHorizontal);
  const nodeSvg = Array.from(parsed.nodes.values())
    .map((node) => renderSingleNodeSvg(node, allCoords.get(node.id)!))
    .join('');

  const floorStyle = maxX > 420 ? `min-width:${Math.round(maxX * opts.minReadableScale)}px;` : '';
  const maxHStyle = isHorizontal ? 'max-height:200px;' : '';
  const naturalAttr = maxX > 420 ? ` data-natural-width="${maxX}"` : '';

  return `<div class="a2ui-mermaid"${naturalAttr}><svg class="a2ui-mermaid-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX} ${maxY}" width="100%" style="max-width:${maxX}px;${floorStyle}${maxHStyle}height:auto;display:block;margin:0 auto"><defs><marker id="a2ui-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--a2ui-color-primary, #0b57d0)" /></marker></defs>${sgSvg}${edgeSvg}${nodeSvg}${edgeLabelSvg}</svg></div>`;
}
