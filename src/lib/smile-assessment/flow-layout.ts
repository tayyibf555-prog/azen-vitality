// THE CANVAS GEOMETRY. Turns an authored funnel graph into numbers and path
// strings: card positions, wrapped text lines, orthogonal edge routes with corner
// fillets, and the viewBox that holds them all.
//
// WHY THIS IS A .ts AND NOT PART OF THE COMPONENT. Same reason tooth-shape.ts is
// (src/components/client/patients/record/chart/tooth.tsx:49-57): vitest collects
// only src/**\/*.test.ts in a node environment, no .tsx at all. A layout rule
// living in JSX is a rule no test can reach, and a rule no test can reach drifts.
// So this module emits numbers and strings of numbers, and flow-canvas.tsx draws
// exactly what it is handed and computes nothing.
//
// NO REACT, NO BARREL, NO SERVER IMPORTS - the boundary.test.ts rules for
// src/lib/charting, applied here for the same reasons.
//
// NO TRANSFORMS. Every coordinate is absolute in one flat space, mirroring
// tooth-shape.ts:483: a `transform` is a second coordinate system, and the moment
// there are two of them a hit target and the thing it is meant to be hitting can
// disagree. Colours are not this module's business at all - flow-canvas.tsx puts
// them on via CSS custom properties.
//
// CONTENT COMES IN, HEIGHT COMES OUT. The caller supplies the card's text (via
// `content`), this module wraps it and derives the card height from the number of
// lines it produced. That ordering is deliberate: if the component wrapped the
// text itself, a three-line prompt would overflow a card sized for two and
// nothing would notice.

import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind } from "./flow";

// ---------------------------------------------------------------------------
// Metrics. Every one is an integer in viewBox units, so a card height is exact
// and only the fractional anchor positions ever need rounding.
// ---------------------------------------------------------------------------

export interface LayoutMetrics {
  /** Card width. Every card is the same width; only the height varies. */
  nodeW: number;
  /** Outer padding around the whole diagram. */
  padX: number;
  padY: number;
  /** Horizontal space BETWEEN columns. Edge routes and their labels live here. */
  gutterX: number;
  /** Vertical space between row bands. */
  gapY: number;
  /** Card header strip (the eyebrow: "Step 2", "Result", ...). */
  headH: number;
  /** One wrapped title line. */
  titleLineH: number;
  /** One listed option. */
  optionLineH: number;
  /** Padding under the last line of the card body. */
  bodyPadY: number;
  /** Floor on card height, so a bare contact card is not a sliver. */
  minH: number;
  /** Corner fillet radius on an orthogonal turn. */
  corner: number;
  /** How far an edge label sits above its wire. */
  labelLift: number;
  /** Stub length for a backwards edge before it drops into the return channel. */
  stub: number;
  /** Character budget per wrapped title line. */
  titleChars: number;
  /** Character budget for one listed option. */
  optionChars: number;
  /** Most title lines before the title is ellipsised. */
  maxTitleLines: number;
  /** Most options listed before the rest collapse into a "+n more" line. */
  maxOptions: number;
  /** Left inset of every line of text in a card. */
  textPad: number;
  /**
   * Character budget for a WIRE LABEL. A wire label is centred over the gutter,
   * so it may run gutterX/2 either way before it is sitting on a card - and the
   * answer labels are long ("Straightening my teeth (Invisalign)"). Without this
   * the label draws straight over the question it is leaving, which is exactly
   * what the first render of this canvas did.
   */
  edgeLabelChars: number;
  /**
   * Assumed width of one label character. Not a measurement - a node test cannot
   * measure a font - but it is what makes "the label fits in the gutter" a
   * property a test can hold, so the budget above can never quietly stop fitting.
   */
  labelCharW: number;
  /** Where a line's BASELINE sits inside the band that line occupies. */
  baseline: number;
}

export const DEFAULT_LAYOUT_METRICS: LayoutMetrics = {
  nodeW: 232,
  padX: 20,
  padY: 20,
  gutterX: 132,
  gapY: 28,
  headH: 30,
  titleLineH: 15,
  optionLineH: 15,
  bodyPadY: 12,
  minH: 62,
  corner: 9,
  labelLift: 7,
  stub: 18,
  titleChars: 32,
  optionChars: 30,
  maxTitleLines: 3,
  maxOptions: 8,
  textPad: 12,
  edgeLabelChars: 22,
  labelCharW: 5,
  baseline: 11,
};

/** What a card says. Supplied by the caller, because the question bank (and the
 *  human wording of a band) is not this module's business. */
export interface FlowNodeContent {
  /** Small label in the header strip. */
  eyebrow?: string;
  /** The card's main line - a question prompt, "Contact details", a band name. */
  title: string;
  /** Answer options listed inside the card. */
  options?: string[];
}

export interface LayoutOptions {
  content?: (node: FlowNode) => FlowNodeContent;
  /** The wire label. Returning undefined draws an unlabelled wire. */
  edgeLabel?: (edge: FlowEdge, from: FlowNode) => string | undefined;
  metrics?: Partial<LayoutMetrics>;
}

/** One line of card text and the baseline to draw it on. */
export interface LaidOutLine {
  text: string;
  y: number;
}

export interface LaidOutNode {
  id: string;
  kind: FlowNodeKind;
  /** Column index = longest path in edges from the entry (see rankNodes). */
  col: number;
  /** Position within the column, top to bottom. */
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Left inset every line of text in this card is drawn at. */
  textX: number;
  eyebrow: string;
  eyebrowY: number;
  /** Where the hairline under the header strip sits. */
  dividerY: number;
  /** The title, wrapped, each line with its own baseline. */
  titleLines: LaidOutLine[];
  /** The options, truncated, each line with its own baseline. */
  optionLines: LaidOutLine[];
}

export interface LaidOutEdge {
  from: string;
  to: string;
  /** Index into graph.edges. The stable handle the builder edits an edge by. */
  index: number;
  answer: string | null;
  /** The wire: only M, H, V and C commands, all 3dp. */
  d: string;
  label?: string;
  labelPoint: { x: number; y: number };
  /** False when the wire has to double back (only possible on an invalid graph). */
  forward: boolean;
}

export interface FlowLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** "0 0 w h". The viewBox comes OUT of the layout (gum-line.tsx:302 idiom). */
  viewBox: string;
}

// ---------------------------------------------------------------------------
// Numbers.
// ---------------------------------------------------------------------------

/** 3dp, the charting house rounding (tooth-shape.ts:457). */
export function round3(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Text. Wrapping is geometry here, not presentation: the card's height is a
// function of how many lines came out, so the wrap has to happen before the
// height is known. Character-budget wrapping rather than real text measurement,
// because a node test cannot measure a font - and a card that is a line too tall
// is a much smaller problem than a rule no test can see.
// ---------------------------------------------------------------------------

const ELLIPSIS = "…";

/** Cut to `max` characters, ending in an ellipsis when anything was lost. */
export function truncate(text: string, max: number): string {
  const s = text.trim();
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return ELLIPSIS;
  return `${s.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * Greedy word wrap to `maxChars` per line and at most `maxLines` lines; the last
 * line is ellipsised if anything is left over. A single word longer than the
 * budget is hard-cut rather than allowed to run off the card.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || maxChars <= 0 || maxLines <= 0) return [];

  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    if (word.length > maxChars) word = truncate(word, maxChars);
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) {
      // No room for this word: fold what is left into the last line as an ellipsis.
      lines[maxLines - 1] = truncate(`${lines[maxLines - 1]!} ${word}`, maxChars);
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// Layering.
//
// THE COLUMN IS THE LONGEST PATH FROM THE ENTRY, NOT THE SHORTEST. The brief
// calls this "BFS depth", and on a linear funnel or a tree the two are the same
// number, which is the case the phrase describes. They diverge the moment a
// branch REJOINS the trunk - which every one of the seven templates does:
// flow-templates.ts:138-150 routes treatment -> [goal question] -> trunk AND
// treatment -> trunk. Shortest-path depth puts the goal question and the first
// trunk question in the SAME column, so the wire between them would run
// backwards into its own column and the diagram would read as a lie.
// Longest-path layering is the same breadth-first sweep (Kahn order, relaxing
// forward) and is what actually guarantees the invariant the canvas is for:
// every wire moves left to right. Pinned by two tests, one for each half.
// ---------------------------------------------------------------------------

export function rankNodes(graph: FlowGraph): Map<string, number> {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const edges = graph.edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const outs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    outs.set(id, []);
    indeg.set(id, 0);
  }
  // Parallel edges between the same pair must not inflate the in-degree, or Kahn
  // never drains the node and a perfectly good graph gets treated as cyclic.
  const pairs = new Set<string>();
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    outs.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) rank.set(id, 0);

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    const r = rank.get(id) ?? 0;
    for (const to of outs.get(id)!) {
      rank.set(to, Math.max(rank.get(to) ?? 0, r + 1));
      const left = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, left);
      if (left === 0) queue.push(to);
    }
  }

  // Whatever Kahn could not drain sits on a cycle. A cycle fails validation (rule
  // 4) so it can never be published - but the builder still has to DRAW it, and
  // the drawing is how the owner sees what to delete. Park each such node one
  // column past the deepest thing that reaches it, and let the back-edge router
  // take care of the wires that then point the wrong way.
  const stranded = ids.filter((id) => !rank.has(id));
  if (stranded.length > 0) {
    let deepest = 0;
    for (const r of rank.values()) deepest = Math.max(deepest, r);
    for (const id of stranded) {
      let r = deepest + 1;
      for (const e of edges) {
        if (e.to !== id) continue;
        const pr = rank.get(e.from);
        if (pr !== undefined) r = Math.max(r, pr + 1);
      }
      rank.set(id, r);
    }
  }

  return rank;
}

/**
 * Row within each column: ordered by the BARYCENTRE of the rows its parents
 * already took, one deterministic left-to-right pass, ties broken by the order
 * the nodes were declared in. One pass rather than the usual sweep-until-stable:
 * a funnel is a shallow, mostly-forward graph, the extra passes buy almost no
 * crossings back, and "same graph in, same picture out" is worth more here than
 * a marginally tidier picture. That determinism is a tested property, because a
 * canvas that reshuffles itself on every keystroke is unusable.
 */
export function orderRows(graph: FlowGraph, ranks: Map<string, number>): Map<string, number> {
  const declIndex = new Map<string, number>();
  graph.nodes.forEach((n, i) => {
    if (!declIndex.has(n.id)) declIndex.set(n.id, i);
  });

  const byCol = new Map<number, string[]>();
  const placed = new Set<string>();
  for (const n of graph.nodes) {
    if (placed.has(n.id)) continue; // duplicate id: first wins, as nodeMap does
    placed.add(n.id);
    const col = ranks.get(n.id) ?? 0;
    const list = byCol.get(col);
    if (list) list.push(n.id);
    else byCol.set(col, [n.id]);
  }

  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    const list = parents.get(e.to);
    if (list) list.push(e.from);
    else parents.set(e.to, [e.from]);
  }

  const rows = new Map<string, number>();
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  for (const col of cols) {
    const ids = byCol.get(col)!;
    const scored = ids.map((id) => {
      const ups = (parents.get(id) ?? []).filter((p) => (ranks.get(p) ?? 0) < col && rows.has(p));
      const bary =
        ups.length > 0 ? ups.reduce((sum, p) => sum + (rows.get(p) ?? 0), 0) / ups.length : 0;
      return { id, placed: ups.length > 0 ? 0 : 1, bary, decl: declIndex.get(id) ?? 0 };
    });
    scored.sort((a, b) => a.placed - b.placed || a.bary - b.bary || a.decl - b.decl);
    scored.forEach((s, i) => rows.set(s.id, i));
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Orthogonal routing.
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

/** Drop repeats and merge collinear runs, so every remaining turn is a real 90 degrees. */
function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
    else i++;
  }
  return out;
}

/**
 * An axis-aligned polyline as an SVG path, with a rounded corner at every turn.
 *
 * ONLY M, H, V AND C ARE EMITTED, and every C is a quadratic corner written as a
 * cubic: both control points sit exactly ON the corner, so the curve is a pure
 * fillet between two axis-aligned runs and nothing between the fillets is ever
 * off-axis. flow-layout.test.ts parses the string back and asserts precisely
 * that, which is the only way to hold the property without a renderer.
 *
 * The radius shrinks to fit a short segment rather than overshooting it, and
 * collapses to a plain corner when there is no room at all.
 */
export function orthogonalPath(points: Pt[], radius: number): string {
  const pts = tidy(points);
  if (pts.length === 0) return "";
  const first = pts[0]!;
  if (pts.length === 1) return `M ${round3(first.x)} ${round3(first.y)}`;

  const segLen = (a: Pt, b: Pt): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const towards = (from: Pt, to: Pt, dist: number): Pt => {
    const len = segLen(from, to);
    if (len === 0) return { x: to.x, y: to.y };
    const t = Math.min(1, dist / len);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  };

  let d = `M ${round3(first.x)} ${round3(first.y)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1];

    const r = next
      ? Math.max(0, Math.min(radius, segLen(prev, cur) / 2, segLen(cur, next) / 2))
      : 0;

    const stop = r > 0 ? towards(cur, prev, r) : cur;
    d += prev.y === cur.y ? ` H ${round3(stop.x)}` : ` V ${round3(stop.y)}`;

    if (next && r > 0) {
      const resume = towards(cur, next, r);
      d += ` C ${round3(cur.x)} ${round3(cur.y)} ${round3(cur.x)} ${round3(cur.y)} ${round3(resume.x)} ${round3(resume.y)}`;
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// The layout.
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT = (node: FlowNode): FlowNodeContent => ({ title: node.id });

const DEFAULT_EDGE_LABEL = (edge: FlowEdge, from: FlowNode): string | undefined => {
  if (from.kind === "welcome") return undefined;
  return edge.answer ?? "Anything else";
};

export function layoutFlow(graph: FlowGraph, opts: LayoutOptions = {}): FlowLayout {
  const m: LayoutMetrics = { ...DEFAULT_LAYOUT_METRICS, ...(opts.metrics ?? {}) };
  const content = opts.content ?? DEFAULT_CONTENT;
  const edgeLabel = opts.edgeLabel ?? DEFAULT_EDGE_LABEL;

  const ranks = rankNodes(graph);
  const rows = orderRows(graph, ranks);

  // First-wins on a duplicate id, matching nodeMap in flow.ts. A duplicate is a
  // rule-1 validation failure; the canvas just has to not draw it twice.
  const unique: FlowNode[] = [];
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    unique.push(n);
  }

  // ---- sizes ---------------------------------------------------------------
  interface Sized {
    node: FlowNode;
    col: number;
    row: number;
    h: number;
    eyebrow: string;
    titleLines: string[];
    optionLines: string[];
  }

  const sized: Sized[] = unique.map((node) => {
    const c = content(node);
    const titleLines = wrapText(c.title ?? "", m.titleChars, m.maxTitleLines);
    const all = c.options ?? [];
    const optionLines =
      all.length > m.maxOptions
        ? [
            ...all.slice(0, m.maxOptions - 1).map((o) => truncate(o, m.optionChars)),
            `+${all.length - (m.maxOptions - 1)} more`,
          ]
        : all.map((o) => truncate(o, m.optionChars));
    const h = Math.max(
      m.minH,
      m.headH + titleLines.length * m.titleLineH + optionLines.length * m.optionLineH + m.bodyPadY,
    );
    return {
      node,
      col: ranks.get(node.id) ?? 0,
      row: rows.get(node.id) ?? 0,
      h,
      eyebrow: c.eyebrow ?? "",
      titleLines,
      optionLines,
    };
  });

  const columns = sized.reduce((max, s) => Math.max(max, s.col + 1), 0);
  const rowCount = sized.reduce((max, s) => Math.max(max, s.row + 1), 0);

  // ---- row bands -----------------------------------------------------------
  // Every node in row r is vertically CENTRED in a band as tall as the tallest
  // card in that row. That is what makes a straight funnel draw as straight
  // wires: same row, same band, same centre line, no dog-legs to read past.
  const bandH: number[] = new Array(rowCount).fill(0);
  for (const s of sized) bandH[s.row] = Math.max(bandH[s.row] ?? 0, s.h);
  const bandTop: number[] = new Array(rowCount).fill(0);
  let acc = m.padY;
  for (let r = 0; r < rowCount; r++) {
    bandTop[r] = acc;
    acc += (bandH[r] ?? 0) + m.gapY;
  }

  const colX = (col: number): number => m.padX + col * (m.nodeW + m.gutterX);

  const nodes: LaidOutNode[] = sized
    .map((s) => {
      const x = colX(s.col);
      const y = (bandTop[s.row] ?? m.padY) + ((bandH[s.row] ?? s.h) - s.h) / 2;
      // Baselines come out of here rather than out of the component, so the card
      // can never be sized for two lines and then drawn with three.
      const titleTop = y + m.headH;
      const optionTop = titleTop + s.titleLines.length * m.titleLineH;
      return {
        id: s.node.id,
        kind: s.node.kind,
        col: s.col,
        row: s.row,
        x: round3(x),
        y: round3(y),
        w: round3(m.nodeW),
        h: round3(s.h),
        textX: round3(x + m.textPad),
        eyebrow: s.eyebrow,
        eyebrowY: round3(y + m.headH - (m.headH - m.baseline) / 2),
        dividerY: round3(titleTop),
        titleLines: s.titleLines.map((text, i) => ({
          text,
          y: round3(titleTop + i * m.titleLineH + m.baseline),
        })),
        optionLines: s.optionLines.map((text, i) => ({
          text,
          y: round3(optionTop + i * m.optionLineH + m.baseline),
        })),
      };
    })
    .sort((a, b) => a.col - b.col || a.row - b.row);

  const placed = new Map<string, LaidOutNode>();
  for (const n of nodes) placed.set(n.id, n);
  const byId = new Map<string, FlowNode>();
  for (const n of unique) byId.set(n.id, n);

  const width = columns > 0 ? m.padX * 2 + columns * m.nodeW + (columns - 1) * m.gutterX : m.padX * 2;
  const height =
    rowCount > 0
      ? m.padY * 2 + bandH.reduce((sum, h) => sum + h, 0) + (rowCount - 1) * m.gapY
      : m.padY * 2;

  // ---- wires ---------------------------------------------------------------
  // Anchors are spread down the card edge, one slot per wire, so seven answers
  // out of the treatment question leave as seven distinguishable wires with
  // seven label positions instead of a single overdrawn bundle. With exactly one
  // wire the slot is the card's centre line, which is the straight-funnel case.
  const outIdx = new Map<string, number[]>();
  const inIdx = new Map<string, number[]>();
  graph.edges.forEach((e, i) => {
    if (!placed.has(e.from) || !placed.has(e.to)) return;
    const o = outIdx.get(e.from);
    if (o) o.push(i);
    else outIdx.set(e.from, [i]);
    const t = inIdx.get(e.to);
    if (t) t.push(i);
    else inIdx.set(e.to, [i]);
  });

  const slot = (node: LaidOutNode, index: number, total: number): number =>
    total <= 1 ? node.y + node.h / 2 : node.y + (node.h * (index + 1)) / (total + 1);

  const channelGap = m.gapY / 2;

  const edges: LaidOutEdge[] = [];
  graph.edges.forEach((e, index) => {
    const from = placed.get(e.from);
    const to = placed.get(e.to);
    const fromNode = byId.get(e.from);
    if (!from || !to || !fromNode) return; // a dangling edge is a rule-1 failure, not a wire

    const outs = outIdx.get(e.from) ?? [];
    const ins = inIdx.get(e.to) ?? [];
    const sx = from.x + from.w;
    const sy = slot(from, outs.indexOf(index), outs.length);
    const tx = to.x;
    const ty = slot(to, ins.indexOf(index), ins.length);

    const forward = tx > sx;
    let points: Pt[];
    if (forward) {
      const mx = (sx + tx) / 2;
      points = [
        { x: sx, y: sy },
        { x: mx, y: sy },
        { x: mx, y: ty },
        { x: tx, y: ty },
      ];
    } else {
      // Backwards, which only happens on a cyclic graph (validation rule 4) or a
      // self-referential edge. Drop into a return channel UNDER both cards
      // rather than drawing a straight line back through them, so the owner can
      // actually see the loop they need to delete.
      const channelY = Math.max(from.y + from.h, to.y + to.h) + channelGap;
      points = [
        { x: sx, y: sy },
        { x: sx + m.stub, y: sy },
        { x: sx + m.stub, y: channelY },
        { x: tx - m.stub, y: channelY },
        { x: tx - m.stub, y: ty },
        { x: tx, y: ty },
      ];
    }

    const label = edgeLabel(e, fromNode);
    const fitted = label ? truncate(label, m.edgeLabelChars) : undefined;
    // CENTRED IN THE GUTTER, not on the first segment. The first segment runs
    // from the card edge only as far as the mid-line, so its midpoint is a
    // QUARTER of the way across - and a centred label there hangs back over the
    // card it just left, where the card (drawn after the wires) paints over it.
    // The first render of this canvas lost the front half of every long answer
    // exactly that way.
    const a = points[0]!;
    const b = points[1]!;
    const labelX = forward ? (sx + tx) / 2 : (a.x + b.x) / 2;
    edges.push({
      from: e.from,
      to: e.to,
      index,
      answer: e.answer,
      d: orthogonalPath(points, m.corner),
      ...(fitted ? { label: fitted } : {}),
      labelPoint: { x: round3(labelX), y: round3((a.y + b.y) / 2 - m.labelLift) },
      forward,
    });
  });

  return {
    nodes,
    edges,
    columns,
    rows: rowCount,
    width: round3(width),
    height: round3(height),
    viewBox: `0 0 ${round3(width)} ${round3(height)}`,
  };
}

/**
 * THE MOBILE PROJECTION. Under about 640px a canvas you have to drag sideways is
 * a canvas nobody reads (arch-metrics.ts:49-57 says so in as many words about the
 * tooth chart, and a funnel on a phone is the same problem). So the small screen
 * gets an ORDERED LIST of the very same layout - not a second, hand-maintained
 * view of the graph that can disagree with the picture.
 *
 * layoutFlow already returns nodes sorted by (column, row), which is reading
 * order, so this is a projection and not a re-computation. It exists as a named,
 * tested function so that the "same data" claim is something a test can hold.
 */
export function outlineOrder(layout: FlowLayout): LaidOutNode[] {
  return layout.nodes;
}

/** Wires leaving a node, in the order the canvas drew them. */
export function edgesOutOf(layout: FlowLayout, nodeId: string): LaidOutEdge[] {
  return layout.edges.filter((e) => e.from === nodeId);
}
