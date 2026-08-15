// The gallery card's miniature. What is held here is that it is the REAL diagram
// at another size, that it is deterministic, and that the diagram is always
// entirely inside the frame the card draws.
//
// Each assertion names the MUTATION it would catch: the exact change to
// flow-thumbnail.ts that makes it fail. A test that passes for both the code and
// its opposite is not holding anything.

import { describe, it, expect } from "vitest";
import { FLOW_TEMPLATES, buildScratchFlow, templateForGoal } from "./flow-templates";
import { layoutFlow } from "./flow-layout";
import {
  THUMBNAIL_ASPECT,
  THUMBNAIL_CONTENT,
  THUMBNAIL_EDGE_LABEL,
  THUMBNAIL_FRAME_W,
  THUMBNAIL_METRICS,
  THUMBNAIL_RX,
  flowThumbnail,
} from "./flow-thumbnail";
import { FLOW_SCHEMA_VERSION, type FlowGraph } from "./flow";

const EVERY_GRAPH: { name: string; graph: FlowGraph }[] = [
  ...FLOW_TEMPLATES.map((t) => ({ name: t.key, graph: t.build() })),
  { name: "scratch", graph: buildScratchFlow() },
];

/* ---------------------------------------------------------------------------
 * It is the real diagram, not a second drawing of one.
 * ------------------------------------------------------------------------- */

describe("the miniature comes out of the layout engine", () => {
  // MUTATION: give flowThumbnail its own spacing loop instead of calling
  // layoutFlow, and the ids or the positions stop lining up.
  it("draws exactly the steps layoutFlow placed, where it placed them", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const thumb = flowThumbnail(graph);
      const laid = layoutFlow(graph, {
        content: THUMBNAIL_CONTENT,
        edgeLabel: THUMBNAIL_EDGE_LABEL,
        metrics: THUMBNAIL_METRICS,
      });

      expect(thumb.nodes.map((n) => n.id), name).toEqual(laid.nodes.map((n) => n.id));
      for (let i = 0; i < laid.nodes.length; i++) {
        const a = thumb.nodes[i]!;
        const b = laid.nodes[i]!;
        expect([a.x, a.y, a.w, a.h], `${name}/${a.id}`).toEqual([b.x, b.y, b.w, b.h]);
        expect(a.kind, `${name}/${a.id}`).toBe(b.kind);
      }
      expect(thumb.edges.map((e) => e.d), name).toEqual(laid.edges.map((e) => e.d));
    }
  });

  // MUTATION: replace the routed `d` with a straight "M x y L x y" between card
  // centres and the H/V-only command check fails.
  it("uses the routed orthogonal wires, one per edge, in edge order", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const thumb = flowThumbnail(graph);
      expect(thumb.edges.length, name).toBe(graph.edges.length);
      expect(
        thumb.edges.map((e) => e.index),
        name,
      ).toEqual(graph.edges.map((_, i) => i));
      for (const e of thumb.edges) {
        // Only the commands the router emits (flow-layout.ts:411-444).
        expect(e.d.replace(/[-\d. ]/g, ""), `${name}/${e.index}`).toMatch(/^M[HVC]+$/);
        expect(e.d.length, `${name}/${e.index}`).toBeGreaterThan(8);
      }
    }
  });

  // DOUBLE-GUARDED ON PURPOSE, and said plainly: the picture stays text-free
  // because THUMBNAIL_CONTENT asks for no text AND the metrics budget no room for
  // any, so no SINGLE edit puts words on a card. Undo BOTH (a content callback
  // that returns node.id, plus titleChars/maxTitleLines above zero) and the first
  // half of this fails; add a `title` or `eyebrow` field to the projection and the
  // key check in the second half fails.
  it("carries no text at all: there is nothing in the projection to draw", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const laid = layoutFlow(graph, {
        content: THUMBNAIL_CONTENT,
        edgeLabel: THUMBNAIL_EDGE_LABEL,
        metrics: THUMBNAIL_METRICS,
      });
      for (const node of laid.nodes) {
        expect(node.titleLines, `${name}/${node.id}`).toEqual([]);
        expect(node.optionLines, `${name}/${node.id}`).toEqual([]);
        expect(node.eyebrow, `${name}/${node.id}`).toBe("");
      }
      for (const edge of laid.edges) {
        expect(edge.label, `${name}/${edge.index}`).toBeUndefined();
      }

      const thumb = flowThumbnail(graph);
      for (const node of thumb.nodes) {
        expect(Object.keys(node).sort(), `${name}/${node.id}`).toEqual([
          "h",
          "id",
          "kind",
          "rx",
          "w",
          "x",
          "y",
        ]);
      }
      for (const edge of thumb.edges) {
        expect(Object.keys(edge).sort(), `${name}/${edge.index}`).toEqual([
          "d",
          "forward",
          "index",
        ]);
      }
      // Nothing a patient would read has leaked into a picture on an owner screen.
      expect(JSON.stringify(thumb), name).not.toMatch(/would you like|thank you/i);
    }
  });

  // MUTATION: drop `forward` from the projection and a cyclic funnel's back-edge
  // can no longer be drawn in the warning colour.
  it("reports every template's wires as forward, because every template is legal", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      for (const e of flowThumbnail(graph).edges) {
        expect(e.forward, `${name}/${e.index}`).toBe(true);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * Determinism. A card that redraws itself differently reads as a different
 * template, which is the one thing a gallery must never do.
 * ------------------------------------------------------------------------- */

describe("the same graph produces identical numbers", () => {
  // MUTATION: seed any position from Math.random(), Date.now() or a mutable
  // module-level counter, and the second call diverges.
  it("is byte-identical across repeated calls on freshly built graphs", () => {
    for (const template of FLOW_TEMPLATES) {
      const once = JSON.stringify(flowThumbnail(template.build()));
      expect(JSON.stringify(flowThumbnail(template.build())), template.key).toBe(once);
      expect(JSON.stringify(flowThumbnail(template.build())), template.key).toBe(once);
    }
  });

  // MUTATION: sort graph.nodes in place (a tempting way to stabilise order) and
  // the second thumbnail of the SAME object differs from the first.
  it("does not mutate the graph it was given", () => {
    const graph = templateForGoal("invisalign").build();
    const before = JSON.stringify(graph);
    const first = JSON.stringify(flowThumbnail(graph));
    expect(JSON.stringify(graph)).toBe(before);
    expect(JSON.stringify(flowThumbnail(graph))).toBe(first);
  });

  // MUTATION: return a constant shape (a placeholder picture) and two genuinely
  // different funnels stop being distinguishable - which is the whole point.
  it("draws genuinely different funnels differently", () => {
    const branching = JSON.stringify(flowThumbnail(templateForGoal("invisalign").build()));
    const straight = JSON.stringify(flowThumbnail(templateForGoal("hygiene").build()));
    expect(branching).not.toBe(straight);
  });
});

/* ---------------------------------------------------------------------------
 * The frame. Everything must be inside it, and it must match the box the card
 * reserves - otherwise the funnel is cropped, or floats in a letterbox.
 * ------------------------------------------------------------------------- */

describe("the frame holds the whole diagram at the card's aspect", () => {
  // MUTATION: return layout.viewBox unchanged and the frame stops matching the
  // aspect the card's box is shaped to, so every thumbnail letterboxes.
  it("is exactly THUMBNAIL_ASPECT wide for its height, every time", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const { frame } = flowThumbnail(graph);
      // 3dp, because the frame itself is rounded to 3dp before the ratio is taken.
      expect(frame.width / frame.height, name).toBeCloseTo(THUMBNAIL_ASPECT, 3);
    }
  });

  // MUTATION: centre by translating the nodes instead of widening the frame, or
  // get a sign wrong in the offset, and steps fall outside the visible area.
  it("contains every step, with nothing clipped at any edge", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const { nodes, frame } = flowThumbnail(graph);
      expect(nodes.length, name).toBeGreaterThan(0);
      for (const n of nodes) {
        expect(n.x, `${name}/${n.id} left`).toBeGreaterThanOrEqual(frame.x);
        expect(n.y, `${name}/${n.id} top`).toBeGreaterThanOrEqual(frame.y);
        expect(n.x + n.w, `${name}/${n.id} right`).toBeLessThanOrEqual(frame.x + frame.width);
        expect(n.y + n.h, `${name}/${n.id} bottom`).toBeLessThanOrEqual(frame.y + frame.height);
      }
    }
  });

  // MUTATION: fit the frame to each diagram instead of holding it at
  // THUMBNAIL_FRAME_W, and a shorter funnel is blown up to the width of a longer
  // one - erasing exactly the difference the picture exists to show.
  it("keeps one scale across the shelf, so a shorter funnel draws shorter", () => {
    const widths = new Set(EVERY_GRAPH.map(({ graph }) => flowThumbnail(graph).frame.width));
    expect(widths).toEqual(new Set([THUMBNAIL_FRAME_W]));

    const short = flowThumbnail(buildScratchFlow());
    const long = flowThumbnail(templateForGoal("general").build());
    expect(short.content.width).toBeLessThan(long.content.width);
  });

  // MUTATION: drop the `layout.height * aspect` term from the width, and a tall
  // graph overflows the frame vertically while still "fitting" horizontally.
  it("widens the frame rather than clipping when a funnel is bigger than the box", () => {
    // A deliberately tall graph: one welcome fanning out to many outcomes, so the
    // row count - and with it the height - is far past any template's.
    const nodes: FlowGraph["nodes"] = [{ id: "welcome", kind: "welcome" }];
    const edges: FlowGraph["edges"] = [];
    for (let i = 0; i < 40; i++) {
      nodes.push({ id: `out-${i}`, kind: "outcome", band: "low" });
      edges.push({ from: "welcome", to: `out-${i}`, answer: `a${i}` });
    }
    const tall: FlowGraph = { schemaVersion: FLOW_SCHEMA_VERSION, entry: "welcome", nodes, edges };

    const thumb = flowThumbnail(tall);
    expect(thumb.content.height).toBeGreaterThan(THUMBNAIL_FRAME_W / THUMBNAIL_ASPECT);
    expect(thumb.frame.width).toBeGreaterThan(THUMBNAIL_FRAME_W);
    expect(thumb.frame.width / thumb.frame.height).toBeCloseTo(THUMBNAIL_ASPECT, 3);
    for (const n of thumb.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(thumb.frame.y);
      expect(n.y + n.h).toBeLessThanOrEqual(thumb.frame.y + thumb.frame.height);
    }
  });

  // MUTATION: build the viewBox from anything other than the frame, and the
  // attribute the SVG actually uses stops agreeing with the numbers tested above.
  it("states the frame it computed, in viewBox order", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const { viewBox, frame } = flowThumbnail(graph);
      expect(viewBox, name).toBe(`${frame.x} ${frame.y} ${frame.width} ${frame.height}`);
      const parts = viewBox.split(" ").map(Number);
      expect(parts.length, name).toBe(4);
      for (const p of parts) expect(Number.isFinite(p), `${name} ${viewBox}`).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Small rounded rects, and numbers a renderer can use as they stand.
 * ------------------------------------------------------------------------- */

describe("what the card is handed is drawable as-is", () => {
  // MUTATION: leave rx off the projection and the card has to pick a radius
  // itself - arithmetic in a .tsx, which is the thing this split exists to stop.
  it("carries a corner radius that fits the step it belongs to", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      for (const n of flowThumbnail(graph).nodes) {
        expect(n.rx, `${name}/${n.id}`).toBe(THUMBNAIL_RX);
        expect(n.rx * 2, `${name}/${n.id}`).toBeLessThanOrEqual(n.h);
        expect(n.rx * 2, `${name}/${n.id}`).toBeLessThanOrEqual(n.w);
      }
    }
  });

  // MUTATION: forget the rounding and a coordinate arrives as
  // 0.30000000000000004, a different string on every float printer.
  it("emits finite, 3dp numbers: no NaN, no infinity, no float noise", () => {
    for (const { name, graph } of EVERY_GRAPH) {
      const thumb = flowThumbnail(graph);
      const numbers = [
        ...thumb.nodes.flatMap((n) => [n.x, n.y, n.w, n.h, n.rx]),
        thumb.frame.x,
        thumb.frame.y,
        thumb.frame.width,
        thumb.frame.height,
        ...thumb.edges.flatMap((e) => (e.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)),
      ];
      for (const value of numbers) {
        expect(Number.isFinite(value), `${name} ${value}`).toBe(true);
        expect(Math.round(value * 1000) / 1000, `${name} ${value}`).toBe(value);
      }
    }
  });

  // MUTATION: let a zero or negative override through and the card renders an
  // empty box with nothing to say why.
  it("refuses a nonsense aspect or frame width rather than drawing nothing", () => {
    const graph = templateForGoal("hygiene").build();
    const base = flowThumbnail(graph);
    expect(flowThumbnail(graph, { aspect: 0 }).viewBox).toBe(base.viewBox);
    expect(flowThumbnail(graph, { aspect: -3 }).viewBox).toBe(base.viewBox);
    expect(flowThumbnail(graph, { frameWidth: 0 }).viewBox).toBe(base.viewBox);
    expect(flowThumbnail(graph, { frameWidth: -80 }).viewBox).toBe(base.viewBox);
  });

  // MUTATION: hardcode the aspect anywhere (module or card) and changing the
  // constant stops changing the picture.
  it("moves with the constants rather than a copied number", () => {
    const graph = templateForGoal("hygiene").build();
    const wider = flowThumbnail(graph, { aspect: THUMBNAIL_ASPECT * 2 });
    expect(wider.frame.width / wider.frame.height).toBeCloseTo(THUMBNAIL_ASPECT * 2, 3);
    expect(wider.frame.height).toBeLessThan(flowThumbnail(graph).frame.height);
  });
});
