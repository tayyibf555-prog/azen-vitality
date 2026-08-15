import { describe, it, expect } from "vitest";
import { FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";
import { FLOW_TEMPLATES, buildScratchFlow } from "./flow-templates";
import { describeEdge, describeNode } from "./flow-edit";
import {
  DEFAULT_LAYOUT_METRICS,
  edgesOutOf,
  layoutFlow,
  orderRows,
  orthogonalPath,
  outlineOrder,
  rankNodes,
  round3,
  roundedTopPath,
  truncate,
  wrapText,
  type FlowLayout,
} from "./flow-layout";

// ---------------------------------------------------------------------------
// Fixtures + a path parser, because the only way to hold "the wire is
// axis-aligned" without a renderer is to read the `d` string back.
// ---------------------------------------------------------------------------

function graph(nodes: FlowNode[], edges: FlowEdge[], entry = nodes[0]!.id): FlowGraph {
  return { schemaVersion: FLOW_SCHEMA_VERSION, entry, nodes, edges };
}

const q = (id: string, questionId = id): FlowNode => ({ id, kind: "question", questionId });
const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

/** welcome -> a -> b -> contact -> one result. No branches at all. */
function linearGraph(): FlowGraph {
  return graph(
    [
      { id: "w", kind: "welcome" },
      q("a"),
      q("b"),
      { id: "c", kind: "contact" },
      { id: "r", kind: "outcome", band: "high" },
    ],
    [edge("w", "a"), edge("a", "b"), edge("b", "c"), edge("c", "r", "high")],
  );
}

/** A branch that REJOINS: exactly the shape every template has. */
function rejoinGraph(): FlowGraph {
  return graph(
    [q("t"), q("branch"), q("trunk"), { id: "c", kind: "contact" }],
    [edge("t", "branch", "implants"), edge("t", "trunk"), edge("branch", "trunk"), edge("trunk", "c")],
  );
}

interface Cmd {
  op: string;
  args: number[];
}

function parsePath(d: string): Cmd[] {
  const tokens = d.trim().split(/\s+/).filter(Boolean);
  const out: Cmd[] = [];
  let i = 0;
  while (i < tokens.length) {
    const op = tokens[i++]!;
    const arity =
      op === "M" ? 2 : op === "C" ? 6 : op === "H" || op === "V" ? 1 : op === "Z" ? 0 : -1;
    expect(arity, `unknown path command "${op}" in ${d}`).toBeGreaterThanOrEqual(0);
    const args: number[] = [];
    for (let k = 0; k < arity; k++) args.push(Number(tokens[i++]));
    out.push({ op, args });
  }
  return out;
}

function allNumbers(layout: FlowLayout): number[] {
  const out: number[] = [layout.width, layout.height];
  for (const n of layout.nodes) {
    out.push(n.x, n.y, n.w, n.h, n.textX, n.eyebrowY, n.dividerY);
    for (const l of [...n.titleLines, ...n.optionLines]) out.push(l.y);
  }
  for (const e of layout.edges) {
    out.push(e.labelPoint.x, e.labelPoint.y);
    for (const c of parsePath(e.d)) out.push(...c.args);
  }
  return out;
}

/**
 * WHAT THE APP ACTUALLY DRAWS. The builder lays a funnel out with the real card
 * text and the real answer labels, and those are far longer than the raw stored
 * values - "Straightening my teeth (Invisalign)" against "invisalign". Laying the
 * templates out with the DEFAULTS instead was hiding both label defects this file
 * now pins: a label wider than the gutter, and a label centred on the wrong point.
 */
const real = (g: FlowGraph): FlowLayout =>
  layoutFlow(g, { content: describeNode, edgeLabel: describeEdge });

const REAL_GRAPHS: { name: string; graph: FlowGraph }[] = [
  ...FLOW_TEMPLATES.map((t) => ({ name: t.key, graph: t.build() })),
  { name: "scratch", graph: buildScratchFlow() },
];

// ---------------------------------------------------------------------------

describe("text fitting", () => {
  it("truncates with an ellipsis only when something was actually lost", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a longer line than fits", 10)).toBe("a longer…");
    expect(truncate("x", 1)).toBe("x");
  });

  it("wraps greedily and never exceeds the character budget", () => {
    const lines = wrapText("How soon would you like to get started?", 14, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(14);
    expect(lines.join(" ")).toContain("How soon");
  });

  it("folds the overflow into the last line rather than dropping words silently", () => {
    const lines = wrapText("one two three four five six seven eight", 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("…");
  });

  it("hard-cuts a single word that cannot fit, so nothing runs off the card", () => {
    const lines = wrapText("supercalifragilistic", 8, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(8);
  });
});

describe("rounding", () => {
  it("keeps three decimal places and never emits a non-finite number", () => {
    expect(round3(1 / 3)).toBe(0.333);
    expect(round3(Number.NaN)).toBe(0);
    expect(round3(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("layering", () => {
  it("gives a column index equal to BFS depth on a graph with one path to each node", () => {
    const ranks = rankNodes(linearGraph());
    expect(ranks.get("w")).toBe(0);
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(2);
    expect(ranks.get("c")).toBe(3);
    expect(ranks.get("r")).toBe(4);
  });

  // THE HALF THE PHRASE "BFS DEPTH" DOES NOT COVER, pinned deliberately. Shortest-path
  // depth would put "branch" and "trunk" both in column 1, and the branch -> trunk
  // wire would then run backwards inside its own column. Every template has this
  // shape (flow-templates.ts:138-150), so this is the normal case, not a corner.
  it("puts a rejoining branch AFTER the branch, not level with the trunk it rejoins", () => {
    const ranks = rankNodes(rejoinGraph());
    expect(ranks.get("t")).toBe(0);
    expect(ranks.get("branch")).toBe(1);
    expect(ranks.get("trunk")).toBe(2);
    expect(ranks.get("c")).toBe(3);
  });

  it("still ranks every node of a graph that contains a loop, instead of hanging", () => {
    const g = graph([q("a"), q("b"), q("c")], [edge("a", "b"), edge("b", "c"), edge("c", "b")]);
    const ranks = rankNodes(g);
    expect(ranks.size).toBe(3);
    for (const r of ranks.values()) expect(Number.isFinite(r)).toBe(true);
  });

  it("does not let two edges between the same pair stall the sweep", () => {
    const g = graph([q("a"), q("b")], [edge("a", "b", "one"), edge("a", "b", "two")]);
    expect(rankNodes(g).get("b")).toBe(1);
  });

  it("orders a column by the barycentre of the rows its parents took", () => {
    // Three sources in column 0 (declared low, high, mid); their children in
    // column 1 must come out in the parents' row order, not declaration order.
    const g = graph(
      [q("p0"), q("p1"), q("p2"), q("c2"), q("c0"), q("c1")],
      [edge("p0", "c0"), edge("p1", "c1"), edge("p2", "c2")],
    );
    const ranks = rankNodes(g);
    const rows = orderRows(g, ranks);
    expect(rows.get("p0")).toBe(0);
    expect(rows.get("p1")).toBe(1);
    expect(rows.get("p2")).toBe(2);
    expect(rows.get("c0")).toBe(0);
    expect(rows.get("c1")).toBe(1);
    expect(rows.get("c2")).toBe(2);
  });
});

describe("orthogonalPath", () => {
  it("emits a plain straight run when there is no turn to make", () => {
    expect(orthogonalPath([{ x: 0, y: 5 }, { x: 40, y: 5 }], 9)).toBe("M 0 5 H 40");
  });

  it("collapses a collinear waypoint rather than drawing a corner of nothing", () => {
    expect(
      orthogonalPath([{ x: 0, y: 5 }, { x: 20, y: 5 }, { x: 40, y: 5 }], 9),
    ).toBe("M 0 5 H 40");
  });

  it("writes every corner as a quadratic fillet, both controls on the corner itself", () => {
    const d = orthogonalPath(
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 90, y: 40 }],
      10,
    );
    const cmds = parsePath(d);
    const curves = cmds.filter((c) => c.op === "C");
    expect(curves).toHaveLength(2);
    for (const c of curves) {
      expect([c.args[0], c.args[1]]).toEqual([c.args[2], c.args[3]]);
    }
    expect(cmds.map((c) => c.op)).toEqual(["M", "H", "C", "V", "C", "H"]);
  });

  it("shrinks the radius to fit a short segment instead of overshooting it", () => {
    const d = orthogonalPath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 40 }], 10);
    const cmds = parsePath(d);
    // The corner is 4 units from the start, so the fillet may only be 2.
    expect(cmds[1]).toEqual({ op: "H", args: [2] });
  });
});

describe("layoutFlow", () => {
  it("gives every node its own (col, row) cell", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      const layout = real(g);
      const cells = new Set(layout.nodes.map((n) => `${n.col}:${n.row}`));
      expect(cells.size, `${name} shares a cell`).toBe(layout.nodes.length);
    }
  });

  it("only ever moves an edge forward in column order", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      const layout = real(g);
      const col = new Map(layout.nodes.map((n) => [n.id, n.col]));
      for (const e of layout.edges) {
        expect(e.forward, `${name}: ${e.from} -> ${e.to} doubles back`).toBe(true);
        expect(col.get(e.from)!, `${name}: ${e.from} -> ${e.to}`).toBeLessThan(col.get(e.to)!);
      }
    }
  });

  it("keeps every wire axis-aligned between its fillets", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const e of real(g).edges) {
        const cmds = parsePath(e.d);
        expect(cmds[0]!.op, `${name}: ${e.from}->${e.to}`).toBe("M");
        for (const c of cmds) {
          expect(["M", "H", "V", "C"], `${name}: ${e.d}`).toContain(c.op);
          // A curve that is not a pure corner would mean an off-axis run hiding
          // inside a "fillet".
          if (c.op === "C") expect([c.args[0], c.args[1]]).toEqual([c.args[2], c.args[3]]);
        }
        // Between fillets, runs must alternate: two H in a row would be a
        // diagonal expressed as two moves.
        const runs = cmds.filter((c) => c.op === "H" || c.op === "V").map((c) => c.op);
        for (let i = 1; i < runs.length; i++) {
          expect(runs[i], `${name}: ${e.d} repeats an axis`).not.toBe(runs[i - 1]);
        }
      }
    }
  });

  it("is deterministic: the same graph lays out to identical numbers", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      const a = real(g);
      const b = real(g);
      expect(JSON.stringify(b), `${name} is not stable`).toBe(JSON.stringify(a));
      // And a fresh build of the same template, which is a different object graph.
      const c = real(JSON.parse(JSON.stringify(g)) as FlowGraph);
      expect(JSON.stringify(c), `${name} depends on object identity`).toBe(JSON.stringify(a));
    }
  });

  it("draws a linear funnel with no crossings at all: every wire is one straight run", () => {
    const layout = layoutFlow(linearGraph());
    expect(layout.rows).toBe(1);
    for (const e of layout.edges) {
      expect(parsePath(e.d).map((c) => c.op), e.d).toEqual(["M", "H"]);
    }
  });

  it("makes the total width the sum of the columns plus the gutters between them", () => {
    const m = DEFAULT_LAYOUT_METRICS;
    for (const { name, graph: g } of REAL_GRAPHS) {
      const layout = real(g);
      expect(layout.width, name).toBe(
        m.padX * 2 + layout.columns * m.nodeW + (layout.columns - 1) * m.gutterX,
      );
      // And the viewBox is the layout's own, never a guess made in the component.
      expect(layout.viewBox).toBe(`0 0 ${layout.width} ${layout.height}`);
      const right = Math.max(...layout.nodes.map((n) => n.x + n.w));
      expect(right + m.padX, `${name} overflows its viewBox`).toBeLessThanOrEqual(layout.width);
      const bottom = Math.max(...layout.nodes.map((n) => n.y + n.h));
      expect(bottom + m.padY, `${name} overflows its viewBox`).toBeLessThanOrEqual(layout.height);
    }
  });

  it("emits only finite numbers, all rounded to three decimal places", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const v of allNumbers(real(g))) {
        expect(Number.isFinite(v), `${name} emitted ${v}`).toBe(true);
        expect(Math.round(v * 1000) / 1000, `${name} emitted ${v}`).toBe(v);
      }
    }
  });

  it("spreads several answers out of one card onto their own anchors", () => {
    const g = graph(
      [q("t"), q("x"), q("y"), q("z")],
      [edge("t", "x", "a"), edge("t", "y", "b"), edge("t", "z", "c")],
    );
    const layout = layoutFlow(g);
    const ys = edgesOutOf(layout, "t").map((e) => e.labelPoint.y);
    expect(new Set(ys).size, "three answers left on the same anchor").toBe(3);
  });

  it("sizes a card from the content it was given, so the text cannot outgrow it", () => {
    const g = graph([q("a"), q("b")], [edge("a", "b")]);
    const layout = layoutFlow(g, {
      content: (n) =>
        n.id === "a"
          ? { title: "one", options: ["x", "y", "z", "w"] }
          : { title: "one", options: [] },
    });
    const a = layout.nodes.find((n) => n.id === "a")!;
    const b = layout.nodes.find((n) => n.id === "b")!;
    expect(a.optionLines).toHaveLength(4);
    expect(a.h).toBeGreaterThan(b.h);
    expect(a.h).toBe(
      DEFAULT_LAYOUT_METRICS.headH +
        a.titleLines.length * DEFAULT_LAYOUT_METRICS.titleLineH +
        4 * DEFAULT_LAYOUT_METRICS.optionLineH +
        DEFAULT_LAYOUT_METRICS.bodyPadY,
    );
  });

  it("collapses a long option list rather than drawing a card taller than the page", () => {
    const many = Array.from({ length: 14 }, (_, i) => `option ${i}`);
    const layout = layoutFlow(graph([q("a")], []), { content: () => ({ title: "t", options: many }) });
    const a = layout.nodes[0]!;
    expect(a.optionLines).toHaveLength(DEFAULT_LAYOUT_METRICS.maxOptions);
    // Seven listed, so the tail must account for the other seven exactly.
    expect(a.optionLines[a.optionLines.length - 1]!.text).toBe("+7 more");
    expect(a.optionLines[0]!.text).toBe("option 0");
  });

  it("labels a wire by its answer and leaves the welcome wire unlabelled", () => {
    const layout = layoutFlow(linearGraph());
    const fromWelcome = layout.edges.find((e) => e.from === "w")!;
    expect(fromWelcome.label).toBeUndefined();
    const toResult = layout.edges.find((e) => e.to === "r")!;
    expect(toResult.label).toBe("high");
  });

  it("draws a looping graph instead of throwing, with the back wire flagged", () => {
    const g = graph([q("a"), q("b")], [edge("a", "b"), edge("b", "a")]);
    const layout = layoutFlow(g);
    expect(layout.nodes).toHaveLength(2);
    const back = layout.edges.find((e) => e.from === "b")!;
    expect(back.forward).toBe(false);
    expect(back.d.length).toBeGreaterThan(0);
  });

  it("ignores an edge whose endpoints are not nodes, which is rule 1's business", () => {
    const g = graph([q("a")], [edge("a", "ghost")]);
    expect(layoutFlow(g).edges).toHaveLength(0);
  });

  it("survives an empty-ish graph without producing a broken viewBox", () => {
    const layout = layoutFlow(graph([q("only")], []));
    expect(layout.columns).toBe(1);
    expect(layout.viewBox).toMatch(/^0 0 \d/);
  });
});

describe("the mobile projection", () => {
  it("is the same layout data in reading order, not a second view of the graph", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      const layout = real(g);
      const outline = outlineOrder(layout);
      expect(outline.length, name).toBe(layout.nodes.length);
      for (let i = 1; i < outline.length; i++) {
        const prev = outline[i - 1]!;
        const cur = outline[i]!;
        expect(
          prev.col < cur.col || (prev.col === cur.col && prev.row < cur.row),
          `${name}: ${prev.id} then ${cur.id} is not reading order`,
        ).toBe(true);
      }
      // Same ids, same cards - a projection, so nothing can be in one and not the other.
      expect(outline.map((n) => n.id).sort()).toEqual(layout.nodes.map((n) => n.id).sort());
    }
  });
});

describe("card text positions", () => {
  it("keeps every baseline inside the card it belongs to", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const n of real(g).nodes) {
        const lines = [n.eyebrowY, ...n.titleLines.map((l) => l.y), ...n.optionLines.map((l) => l.y)];
        for (const y of lines) {
          expect(y, `${name}/${n.id} baseline above the card`).toBeGreaterThan(n.y);
          expect(y, `${name}/${n.id} baseline below the card`).toBeLessThanOrEqual(n.y + n.h);
        }
        expect(n.textX).toBeGreaterThan(n.x);
        expect(n.textX).toBeLessThan(n.x + n.w);
        expect(n.dividerY).toBeGreaterThan(n.y);
        expect(n.dividerY).toBeLessThan(n.y + n.h);
      }
    }
  });

  it("stacks the options BELOW the title, never over it", () => {
    const layout = layoutFlow(graph([q("a")], []), {
      content: () => ({ title: "a prompt long enough to wrap onto a second line here", options: ["one", "two"] }),
    });
    const n = layout.nodes[0]!;
    expect(n.titleLines.length).toBeGreaterThan(1);
    const lastTitle = n.titleLines[n.titleLines.length - 1]!.y;
    for (const o of n.optionLines) expect(o.y).toBeGreaterThan(lastTitle);
  });
});

/* ---------------------------------------------------------------------------
 * The card's chrome. Everything the canvas draws AROUND the text - the header
 * strip, the kind bar, the rule above each option row - is derived here, because
 * a position derived in JSX is a position no test can reach (flow-canvas.tsx:5-13).
 * ------------------------------------------------------------------------- */

describe("roundedTopPath", () => {
  it("rounds the top corners only, and closes flat along the bottom", () => {
    const cmds = parsePath(roundedTopPath(10, 20, 100, 30, 8));
    expect(cmds.map((c) => c.op)).toEqual(["M", "V", "C", "H", "C", "V", "Z"]);
    // Starts and ends on the bottom edge: the strip meets the divider square, so
    // a tinted header cannot read as a smaller card floating inside the card.
    expect(cmds[0]!.args).toEqual([10, 50]);
    expect(cmds[5]!.args).toEqual([50]);
    // The same fillet idiom as a wire: both control points sit ON the corner.
    for (const c of cmds.filter((c) => c.op === "C")) {
      expect([c.args[0], c.args[1]]).toEqual([c.args[2], c.args[3]]);
    }
  });

  it("shrinks the corner to fit rather than curving past its own bottom edge", () => {
    // Radius 10 asked for, but the strip is only 4 tall: the corner may be 4.
    const cmds = parsePath(roundedTopPath(0, 0, 100, 4, 10));
    expect(cmds[1]).toEqual({ op: "V", args: [4] });
    expect(cmds[2]!.args).toEqual([0, 0, 0, 0, 4, 0]);
  });

  it("draws nothing at all for a strip with no height, which is the thumbnail case", () => {
    expect(roundedTopPath(0, 0, 30, 0, 10)).toBe("");
    expect(roundedTopPath(0, 0, 0, 14, 10)).toBe("");
  });
});

describe("the card's chrome", () => {
  it("gives every card a header strip and a right edge to draw a rule to", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const n of real(g).nodes) {
        expect(n.right, `${name}/${n.id}`).toBe(round3(n.x + n.w));
        expect(n.headerD.length, `${name}/${n.id} has no header strip`).toBeGreaterThan(0);
        expect(n.rx).toBe(DEFAULT_LAYOUT_METRICS.cardRx);
      }
    }
  });

  // MUTATION: inset the bar by less than the corner radius (it used to be 4
  // against a radius of 10) and it pokes out past the card's own rounded outline.
  it("keeps the kind bar inside the card, clear of both rounded corners", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const n of real(g).nodes) {
        expect(n.accent.x, `${name}/${n.id}`).toBe(n.x);
        expect(n.accent.w).toBeLessThan(n.w);
        expect(
          n.accent.y - n.y,
          `${name}/${n.id}: the bar starts inside the top corner`,
        ).toBeGreaterThanOrEqual(n.rx);
        expect(
          n.y + n.h - (n.accent.y + n.accent.h),
          `${name}/${n.id}: the bar runs into the bottom corner`,
        ).toBeGreaterThanOrEqual(n.rx);
        expect(n.accent.h).toBeGreaterThan(0);
      }
    }
  });

  it("clamps the kind bar to nothing on a card too short to hold one", () => {
    // A thumbnail card is 14 units tall, all text budgets zeroed, against a
    // 10-unit inset at each end (flow-thumbnail.ts:70-92).
    const layout = layoutFlow(graph([q("a")], []), {
      metrics: {
        minH: 14,
        headH: 0,
        titleLineH: 0,
        optionLineH: 0,
        bodyPadY: 0,
        titleChars: 0,
        maxTitleLines: 0,
      },
    });
    const only = layout.nodes[0]!;
    expect(only.h).toBe(14);
    expect(only.accent.h).toBe(0);
    // ...and a zero-tall header strip is no strip at all, rather than a sliver.
    expect(only.headerD).toBe("");
  });

  // MUTATION: key the rules off anything but the option top and one drifts off
  // the row it belongs to the moment a title wraps to a second line.
  it("puts exactly one rule above each option row, and none anywhere else", () => {
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const n of real(g).nodes) {
        expect(n.optionRuleY, `${name}/${n.id}`).toHaveLength(n.optionLines.length);
        n.optionRuleY.forEach((y, i) => {
          expect(y, `${name}/${n.id} rule ${i} is above the header divider`).toBeGreaterThanOrEqual(
            n.dividerY,
          );
          expect(y, `${name}/${n.id} rule ${i} sits below its own row`).toBeLessThan(
            n.optionLines[i]!.y,
          );
          expect(y, `${name}/${n.id} rule ${i} falls outside the card`).toBeLessThan(n.y + n.h);
          if (i > 0) {
            expect(y, `${name}/${n.id} rule ${i} sits on the row above`).toBeGreaterThan(
              n.optionLines[i - 1]!.y,
            );
          }
        });
      }
    }
  });

  // MUTATION: widen optionChars past what the card can hold and the answer rows
  // run out through the card's right edge. The budget is the guard, so the budget
  // is what is held - the drawn rows are checked too, in case one escapes it.
  it("keeps an option row inside the card's own width", () => {
    const m = DEFAULT_LAYOUT_METRICS;
    expect(m.optionChars * m.labelCharW + m.textPad * 2).toBeLessThanOrEqual(m.nodeW);
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const n of real(g).nodes) {
        for (const line of n.optionLines) {
          expect(
            line.text.length * m.labelCharW + m.textPad * 2,
            `${name}/${n.id}: "${line.text}" runs off the card`,
          ).toBeLessThanOrEqual(m.nodeW);
        }
      }
    }
  });
});

describe("wire labels", () => {
  it("never lets a label run wider than the gutter it is centred in", () => {
    const m = DEFAULT_LAYOUT_METRICS;
    for (const { name, graph: g } of REAL_GRAPHS) {
      for (const e of real(g).edges) {
        if (!e.label) continue;
        expect(e.label.length, `${name}: "${e.label}" would draw over a card`).toBeLessThanOrEqual(
          m.edgeLabelChars,
        );
      }
    }
  });

  it("truncates the long answer labels rather than dropping them", () => {
    // "Straightening my teeth (Invisalign)" is 35 characters; unbudgeted it drew
    // straight across the question it was leaving.
    const layout = layoutFlow(graph([q("a"), q("b")], [edge("a", "b", "x")]), {
      edgeLabel: () => "Straightening my teeth (Invisalign)",
    });
    const label = layout.edges[0]!.label!;
    expect(label.length).toBeLessThanOrEqual(DEFAULT_LAYOUT_METRICS.edgeLabelChars);
    expect(label.startsWith("Straightening")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("wire labels stay in the gutter", () => {
  it("centres a forward label between the two cards, with room for its own width", () => {
    const m = DEFAULT_LAYOUT_METRICS;
    for (const { name, graph: g } of REAL_GRAPHS) {
      const layout = real(g);
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      for (const e of layout.edges) {
        if (!e.label || !e.forward) continue;
        const from = byId.get(e.from)!;
        const to = byId.get(e.to)!;
        const half = (e.label.length * m.labelCharW) / 2;
        expect(
          e.labelPoint.x - half,
          `${name}: "${e.label}" runs back over ${e.from}`,
        ).toBeGreaterThanOrEqual(from.x + from.w);
        expect(
          e.labelPoint.x + half,
          `${name}: "${e.label}" runs over ${e.to}`,
        ).toBeLessThanOrEqual(to.x);
      }
    }
  });
});
