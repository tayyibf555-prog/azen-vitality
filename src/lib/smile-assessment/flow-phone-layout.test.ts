// The phone-screen strip's geometry. What is held here is that it is the REAL
// diagram at phone size, that every screen is the SAME box (a funnel is a row of
// one device, not of eight different ones), that the step chip's number comes out
// of the picture, and that the numbers a renderer is handed can be used as they
// stand by two layers at once - an SVG of wires and HTML minis on top of it.
//
// Each assertion names the MUTATION it would catch: the exact change to
// flow-phone-layout.ts that makes it fail. A test that passes for both the code
// and its opposite is not holding anything.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";
import { FLOW_TEMPLATES, buildScratchFlow, templateForGoal } from "./flow-templates";
import { DEFAULT_LAYOUT_METRICS, layoutFlow } from "./flow-layout";
import {
  PHONE_CONTENT,
  PHONE_EDGE_LABEL,
  PHONE_METRICS,
  phoneFlowLayout,
  phoneMetrics,
} from "./flow-phone-layout";

const EVERY_GRAPH: { name: string; graph: FlowGraph }[] = [
  ...FLOW_TEMPLATES.map((t) => ({ name: t.key, graph: t.build() })),
  { name: "scratch", graph: buildScratchFlow() },
];

const M = phoneMetrics();

function graph(nodes: FlowNode[], edges: FlowEdge[], entry = nodes[0]!.id): FlowGraph {
  return { schemaVersion: FLOW_SCHEMA_VERSION, entry, nodes, edges };
}

const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

/* ---------------------------------------------------------------------------
 * It is the real layout, at another size.
 * ------------------------------------------------------------------------- */

describe("the strip comes out of the layout engine", () => {
  // MUTATION: give phoneFlowLayout its own column/row loop instead of calling
  // layoutFlow, and the ids, the positions or the routed wires stop lining up
  // with the canvas the owner edits on the next screen.
  it("places exactly the steps layoutFlow placed, where it placed them", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      const laid = layoutFlow(g, {
        content: PHONE_CONTENT,
        edgeLabel: PHONE_EDGE_LABEL,
        metrics: PHONE_METRICS,
      });

      expect(strip.nodes.map((n) => n.id), name).toEqual(laid.nodes.map((n) => n.id));
      for (let i = 0; i < laid.nodes.length; i++) {
        const a = strip.nodes[i]!;
        const b = laid.nodes[i]!;
        expect([a.x, a.y, a.w, a.h], `${name}/${a.id}`).toEqual([b.x, b.y, b.w, b.h]);
        expect([a.col, a.row], `${name}/${a.id}`).toEqual([b.col, b.row]);
        expect(a.kind, `${name}/${a.id}`).toBe(b.kind);
      }
      expect(strip.edges.map((e) => e.d), name).toEqual(laid.edges.map((e) => e.d));
      expect([strip.width, strip.height, strip.columns, strip.rows], name).toEqual([
        laid.width,
        laid.height,
        laid.columns,
        laid.rows,
      ]);
    }
  });

  // MUTATION: replace the routed `d` with a straight "M x y L x y" between two
  // screens and the H/V/C-only check fails; drop an edge and the count does.
  it("uses the routed orthogonal wires, one per edge, in edge order", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      expect(strip.edges.length, name).toBe(g.edges.length);
      expect(strip.edges.map((e) => e.index), name).toEqual(g.edges.map((_, i) => i));
      for (const e of strip.edges) {
        expect(e.d.replace(/[-\d. ]/g, ""), `${name}/${e.index}`).toMatch(/^M[HVC]+$/);
        expect([e.from, e.to], `${name}/${e.index}`).toEqual([
          g.edges[e.index]!.from,
          g.edges[e.index]!.to,
        ]);
        expect(e.forward, `${name}/${e.index}`).toBe(true);
      }
    }
  });

  // MUTATION: drop `forward` from the projection and a cyclic funnel's back edge
  // can no longer be drawn as the warning it is.
  it("reports a wire that doubles back as backwards", () => {
    const g = graph(
      [
        { id: "w", kind: "welcome" },
        { id: "a", kind: "question", questionId: "timeline" },
        { id: "c", kind: "contact" },
      ],
      [edge("w", "a"), edge("a", "c"), edge("c", "a", "high")],
    );
    const back = phoneFlowLayout(g).edges.find((e) => e.from === "c" && e.to === "a");
    expect(back?.forward).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * One device, eight times. A screen that grew with its content would read as a
 * different phone, and the wires between the rows would stagger.
 * ------------------------------------------------------------------------- */

describe("every screen is exactly the same box", () => {
  // MUTATION: raise titleChars/maxTitleLines (or headH/bodyPadY) above zero and
  // the treatment step - a long prompt and eight answers - grows taller than the
  // contact step beside it, because height is derived from the wrapped lines
  // (flow-layout.ts:586-589).
  it("gives every step the width and the height the metrics name, exactly", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      expect(strip.nodes.length, name).toBeGreaterThan(0);
      for (const n of strip.nodes) {
        expect(n.w, `${name}/${n.id} w`).toBe(M.nodeW);
        expect(n.h, `${name}/${n.id} h`).toBe(M.minH);
      }
      expect(new Set(strip.nodes.map((n) => `${n.w}x${n.h}`)).size, name).toBe(1);
    }
  });

  // MUTATION: drop the nodeW/minH overrides and the layout quietly falls back to
  // the compact canvas's 232x62 card - the strip still passes every "uniform"
  // check above, because it compares the boxes against the metrics, and every
  // mini is now a chip too small to hold a question. This is the check that says
  // what the box is FOR.
  it("is the size of a phone screen, not of a card", () => {
    expect(M.nodeW).toBeGreaterThanOrEqual(260);
    expect(M.nodeW).toBeLessThanOrEqual(420);
    expect(M.minH).toBeGreaterThanOrEqual(400);
    expect(M.minH).toBeGreaterThan(M.nodeW);
    expect(M.nodeW).toBeGreaterThan(DEFAULT_LAYOUT_METRICS.nodeW);
    expect(M.minH).toBeGreaterThan(DEFAULT_LAYOUT_METRICS.minH * 5);
  });

  // The DOUBLE GUARD, said plainly: there is no text in the layout because the
  // content callback supplies none AND the budgets leave no room for any, so no
  // single edit can put words on a box that is sized for none. Undo one half and
  // the other still holds. Undo BOTH and the height check above fails too.
  it("asks the layout for no text at all, and budgets no room for any", () => {
    expect(PHONE_CONTENT()).toEqual({ title: "" });
    expect(PHONE_EDGE_LABEL()).toBeUndefined();
    expect([M.titleChars, M.optionChars, M.maxTitleLines, M.maxOptions, M.edgeLabelChars]).toEqual([
      0, 0, 0, 0, 0,
    ]);

    for (const { name, graph: g } of EVERY_GRAPH) {
      const laid = layoutFlow(g, {
        content: PHONE_CONTENT,
        edgeLabel: PHONE_EDGE_LABEL,
        metrics: PHONE_METRICS,
      });
      for (const node of laid.nodes) {
        expect(node.titleLines, `${name}/${node.id}`).toEqual([]);
        expect(node.optionLines, `${name}/${node.id}`).toEqual([]);
        expect(node.eyebrow, `${name}/${node.id}`).toBe("");
      }
      for (const e of laid.edges) expect(e.label, `${name}/${e.index}`).toBeUndefined();
    }
  });

  // MUTATION: project a `titleLines`, `eyebrow` or `label` through and a patient's
  // words start arriving twice - once as SVG text under the mini, once inside it -
  // which is how they end up disagreeing.
  it("carries geometry only: nothing a renderer could print as text", () => {
    const strip = phoneFlowLayout(templateForGoal("invisalign").build());
    for (const n of strip.nodes) {
      expect(Object.keys(n).sort(), n.id).toEqual([
        "col",
        "h",
        "id",
        "kind",
        "row",
        "step",
        "w",
        "x",
        "y",
      ]);
    }
    for (const e of strip.edges) {
      expect(Object.keys(e).sort(), String(e.index)).toEqual(["d", "forward", "from", "index", "to"]);
    }
    expect(JSON.stringify(strip)).not.toMatch(/would you like|thank you|invisalign/i);
  });

  // MUTATION: leave gapY at the canvas's 28 and two 470-tall screens sit in a
  // 28px sliver of space, with the fan-out wires crossing the gap they share.
  it("leaves a bigger gap between rows than the compact canvas does", () => {
    expect(M.gapY).toBeGreaterThan(DEFAULT_LAYOUT_METRICS.gapY);

    // Uniform heights mean row banding centres nothing: every screen in a row
    // sits at the band top, so the gap on screen IS gapY.
    const strip = phoneFlowLayout(templateForGoal("invisalign").build());
    const rows = new Map<number, number[]>();
    for (const n of strip.nodes) rows.set(n.row, [...(rows.get(n.row) ?? []), n.y]);
    for (const [row, ys] of rows) expect(new Set(ys).size, `row ${row}`).toBe(1);

    const tops = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, ys]) => ys[0]!);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]! - tops[i - 1]!, `row ${i}`).toBe(M.minH + M.gapY);
    }
  });

  // MUTATION: raise edgeLabelChars without widening the gutter and a label runs
  // out of the gutter and over the screen it just left - the exact failure
  // flow-layout.test.ts holds for the full-size canvas.
  it("keeps any wire label inside the gutter it is centred in", () => {
    expect(M.edgeLabelChars * M.labelCharW).toBeLessThanOrEqual(M.gutterX);
  });
});

/* ---------------------------------------------------------------------------
 * The step chip's number. It is the column, so the words and the picture cannot
 * tell the owner two different things.
 * ------------------------------------------------------------------------- */

describe("the step number comes out of the column", () => {
  // MUTATION: use `col` unadjusted and every template - all of which open on a
  // welcome step - announces its first screen as "Question 0"; the welcome step
  // itself, which DRAWS that first screen, announces a different number again.
  it("numbers the first question 1, and the welcome step that draws it 1 too", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      const welcome = strip.nodes.find((n) => n.kind === "welcome")!;
      const first = strip.nodes.filter((n) => n.kind === "question").sort((a, b) => a.col - b.col)[0]!;
      expect(welcome.step, name).toBe(1);
      expect(first.step, name).toBe(1);
      expect(welcome.col, name).toBe(0);
      expect(first.col, name).toBe(1);
    }
  });

  // MUTATION: number the welcome step by its OWN column and it stops agreeing
  // with the question it is drawing the moment that column is not 0 - which is
  // any funnel mid-edit with a step still wired into the welcome. On a tidy
  // funnel the two answers coincide, so only a graph like this one can tell them
  // apart, and the builder has to draw graphs like this one.
  it("gives the welcome step the number of the question it draws", () => {
    const g = graph(
      [
        { id: "stray", kind: "question", questionId: "motivation" },
        { id: "w", kind: "welcome" },
        { id: "q1", kind: "question", questionId: "treatment_interest" },
        { id: "c", kind: "contact" },
      ],
      [edge("stray", "w"), edge("w", "q1"), edge("q1", "c")],
      "w",
    );
    const byId = new Map(phoneFlowLayout(g).nodes.map((n) => [n.id, n]));
    expect(byId.get("w")!.col).toBe(1);
    expect(byId.get("w")!.step).toBe(byId.get("q1")!.step);
    expect(byId.get("w")!.step).toBe(2);
  });

  // MUTATION: hardcode the welcome offset (rather than reading the entry) and a
  // funnel that opens straight on a question numbers its first screen 2.
  it("numbers the first question 1 when the funnel opens without a welcome step", () => {
    const g = graph(
      [
        { id: "a", kind: "question", questionId: "treatment_interest" },
        { id: "b", kind: "question", questionId: "timeline" },
        { id: "c", kind: "contact" },
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    const byId = new Map(phoneFlowLayout(g).nodes.map((n) => [n.id, n]));
    expect(byId.get("a")!.step).toBe(1);
    expect(byId.get("b")!.step).toBe(2);
  });

  // MUTATION: drop the Math.max(1, ...) and a step parked in column 0 of a
  // welcome-led funnel is announced as "Question 0".
  it("never numbers a step below 1, even when the graph is broken", () => {
    // "loose" has no incoming edge, so it ranks at column 0 beside the welcome
    // step it was never wired to (flow-layout.ts:334).
    const g = graph(
      [
        { id: "w", kind: "welcome" },
        { id: "a", kind: "question", questionId: "timeline" },
        { id: "loose", kind: "question", questionId: "motivation" },
        { id: "c", kind: "contact" },
      ],
      [edge("w", "a"), edge("a", "c")],
      "w",
    );
    const loose = phoneFlowLayout(g).nodes.find((n) => n.id === "loose")!;
    expect(loose.col).toBe(0);
    expect(loose.step).toBe(1);
  });

  // MUTATION: number by declaration order (or by counting questions on the
  // shortest path) and a rejoining branch - which every template has - numbers
  // two different screens the same.
  it("follows the column along the trunk, one screen at a time", () => {
    const strip = phoneFlowLayout(templateForGoal("invisalign").build());
    const questions = strip.nodes.filter((n) => n.kind === "question").sort((a, b) => a.col - b.col);
    expect(questions.map((n) => n.step)).toEqual(questions.map((_, i) => i + 1));
    expect(new Set(questions.map((n) => n.step)).size).toBe(questions.length);
  });
});

/* ---------------------------------------------------------------------------
 * Two layers, one coordinate space. The wires are SVG; the screens are HTML
 * positioned at the very same numbers.
 * ------------------------------------------------------------------------- */

describe("what the strip is handed is drawable by both layers as it stands", () => {
  // MUTATION: widen or centre the frame the way the thumbnail does
  // (flow-thumbnail.ts:156-162) and the SVG scales while the absolutely
  // positioned HTML does not: every wire slides off the screen it leaves.
  it("states its own box at 1:1, with no frame around it", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      expect(strip.viewBox, name).toBe(`0 0 ${strip.width} ${strip.height}`);
    }
  });

  // MUTATION: forget the padding in the width/height and the last column's screen
  // is clipped by the scroll box's own edge.
  it("is big enough to hold every screen, padding included", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      for (const n of strip.nodes) {
        expect(n.x, `${name}/${n.id} left`).toBeGreaterThanOrEqual(M.padX);
        expect(n.y, `${name}/${n.id} top`).toBeGreaterThanOrEqual(M.padY);
        expect(n.x + n.w, `${name}/${n.id} right`).toBeLessThanOrEqual(strip.width - M.padX);
        expect(n.y + n.h, `${name}/${n.id} bottom`).toBeLessThanOrEqual(strip.height - M.padY);
      }
      expect(strip.width, name).toBe(
        M.padX * 2 + strip.columns * M.nodeW + (strip.columns - 1) * M.gutterX,
      );
    }
  });

  // MUTATION: forget the rounding and a coordinate arrives as
  // 0.30000000000000004 - a different string on every float printer, and a
  // left/top the browser rounds differently from the wire beneath it.
  it("emits finite, 3dp numbers: no NaN, no infinity, no float noise", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const strip = phoneFlowLayout(g);
      const numbers = [
        ...strip.nodes.flatMap((n) => [n.x, n.y, n.w, n.h, n.col, n.row, n.step]),
        strip.width,
        strip.height,
        ...strip.edges.flatMap((e) => (e.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)),
      ];
      for (const value of numbers) {
        expect(Number.isFinite(value), `${name} ${value}`).toBe(true);
        expect(Math.round(value * 1000) / 1000, `${name} ${value}`).toBe(value);
      }
    }
  });

  // MUTATION: hardcode a width anywhere and changing the metric stops changing
  // the picture.
  it("moves with the metrics rather than a copied number", () => {
    const g = templateForGoal("hygiene").build();
    const base = phoneFlowLayout(g);
    const wider = phoneFlowLayout(g, { metrics: { nodeW: M.nodeW * 2 } });
    expect(wider.width).toBeGreaterThan(base.width);
    for (const n of wider.nodes) expect(n.w).toBe(M.nodeW * 2);
  });
});

/* ---------------------------------------------------------------------------
 * Determinism. A strip that redraws itself differently between keystrokes is a
 * strip nobody can read while typing beside it.
 * ------------------------------------------------------------------------- */

describe("the same graph produces identical numbers", () => {
  // MUTATION: seed any position from Math.random(), Date.now() or a mutable
  // module-level counter, and the second call diverges.
  it("is byte-identical across repeated calls", () => {
    for (const { name, graph: g } of EVERY_GRAPH) {
      const once = JSON.stringify(phoneFlowLayout(g));
      expect(JSON.stringify(phoneFlowLayout(g)), name).toBe(once);
      expect(JSON.stringify(phoneFlowLayout(g)), name).toBe(once);
    }
  });

  // MUTATION: sort graph.nodes in place (a tempting way to stabilise order) and
  // the second strip of the SAME object differs from the first.
  it("does not mutate the graph it was given", () => {
    const g = templateForGoal("invisalign").build();
    const before = JSON.stringify(g);
    const first = JSON.stringify(phoneFlowLayout(g));
    expect(JSON.stringify(g)).toBe(before);
    expect(JSON.stringify(phoneFlowLayout(g))).toBe(first);
  });

  // MUTATION: return a constant shape and two genuinely different funnels stop
  // being distinguishable, which is the whole point of drawing one.
  it("draws genuinely different funnels differently", () => {
    expect(JSON.stringify(phoneFlowLayout(templateForGoal("invisalign").build()))).not.toBe(
      JSON.stringify(phoneFlowLayout(buildScratchFlow())),
    );
  });
});

/* ---------------------------------------------------------------------------
 * The boundary. The same one flow-layout.ts keeps, held the only way a node test
 * can hold it: by reading the source.
 * ------------------------------------------------------------------------- */

describe("what the strip's geometry is allowed to import", () => {
  const HERE = fileURLToPath(new URL("./", import.meta.url));
  const IMPORTS = /^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm;

  // MUTATION: import React (or the question bank, or a server module) to "just
  // read one thing" and the geometry stops being testable in a node environment -
  // which is the whole reason it is a .ts and not part of the component.
  it("imports the layout engine and the graph model, and nothing else", () => {
    const source = readFileSync(`${HERE}flow-phone-layout.ts`, "utf8");
    const specifiers = [...source.matchAll(IMPORTS)].map((m) => m[1]!);
    expect(specifiers.sort()).toEqual(["./flow", "./flow-layout"]);
  });

  // MUTATION: put a colour or a font size in the metrics and a re-themed preview
  // stops re-theming, because the strip is now painting over the palette
  // (flow-canvas.tsx:17-22).
  it("names no colour: a hex code in here would out-rank the palette", () => {
    const source = readFileSync(`${HERE}flow-phone-layout.ts`, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
  });
});
