// THE RESOLUTION LAYER between what an owner stored and what a browser draws.
//
// Two things are load-bearing here and neither is visible in a rendered page:
// which pictures are REFUSED (an unknown key, a key fit for a different slot, a
// picture nobody wrote alt text for), and that a refusal costs the screen exactly
// one piece of furniture rather than the whole screen. Both are the difference
// between a funnel that quietly ships a broken <img> to an ad's landing page and
// one that draws what it can vouch for.

import { describe, it, expect } from "vitest";
import {
  altFor,
  blockViews,
  imageViewFor,
  optionImageViews,
  type BlockView,
} from "./flow-block-view";
import type { FlowBlock, FlowNode } from "./flow";
import { ASSESS_IMAGES, assessImage } from "@/lib/assess/image-library";

const HERO_KEY = "screens/aligners";
const ANSWER_KEY = "conditions/crowded";

const TRUST: FlowBlock = {
  kind: "trust-strip",
  practiceName: "Vitality Dental",
  chips: ["Open Saturdays", "Free parking"],
};
const TESTIMONIAL: FlowBlock = {
  kind: "testimonial",
  quote: "The team explained every step and I never felt rushed.",
  attribution: "Hannah, Enfield",
};
const FAQ: FlowBlock = {
  kind: "faq",
  items: [
    { q: "How long does it take?", a: "The team will talk you through the timings at your visit." },
    { q: "Can I ask about the cost?", a: "Yes, in writing, before anything starts." },
  ],
};
const IMAGE: FlowBlock = { kind: "image", image: HERO_KEY, alt: "Clear aligners on a tray" };

function welcome(blocks: FlowBlock[]): FlowNode {
  return { id: "w", kind: "welcome", blocks };
}

function question(optionImages: { value: string; image: string }[]): FlowNode {
  return { id: "q", kind: "question", questionId: "smile_concern", optionImages };
}

/* ---------------------------------------------------------------------------
 * 1. The alt rule.
 * ------------------------------------------------------------------------- */

describe("what a picture is announced as", () => {
  // MUTATION: prefer the manifest's alt and the owner who wrote "Our Enfield
  // reception on a Saturday morning" gets "A hygiene appointment at the practice"
  // read out instead - the generic line, on the screen they wrote a specific one for.
  it("prefers the alt the owner wrote for this screen", () => {
    expect(altFor("Our reception", "A pair of clear aligners")).toBe("Our reception");
  });

  // MUTATION: `authored ?? fallback` instead of a blank check, and a cleared alt
  // field ships alt="" - which tells a screen reader the picture is DECORATIVE and
  // to skip it, on a picture the practice deliberately put there.
  it("falls back to the manifest's own words when the authored line is blank", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(altFor(blank, "A pair of clear aligners")).toBe("A pair of clear aligners");
    }
  });

  it("trims, so a line of spaces is not alt text", () => {
    expect(altFor("  Our reception  ", "x")).toBe("Our reception");
  });

  // MUTATION: return "" instead of null and the caller's `if (!alt)` still catches
  // it - but a caller written as `alt !== null` ships the empty string. null is the
  // answer that cannot be rendered by accident.
  it("says null when nothing anywhere describes the picture", () => {
    expect(altFor("", "")).toBeNull();
    expect(altFor(null, undefined)).toBeNull();
    expect(altFor("  ", "  ")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 2. Resolving one picture.
 * ------------------------------------------------------------------------- */

describe("a picture resolves to something a renderer can vouch for", () => {
  it("resolves a real key to the shipped asset, with its intrinsic box", () => {
    const entry = assessImage(HERO_KEY)!;
    expect(imageViewFor(HERO_KEY, "hero", "Clear aligners on a tray")).toEqual({
      src: entry.path,
      alt: "Clear aligners on a tray",
      width: entry.width,
      height: entry.height,
    });
  });

  // MUTATION: emit `src={key}` and every funnel picture 404s, because a key is not
  // a path - which is the entire point of CUT 4 (flow.ts:304-311).
  it("emits the manifest's PATH, never the key", () => {
    const view = imageViewFor(ANSWER_KEY, "answer")!;
    expect(view.src).toBe("/assess/conditions/crowded.webp");
    expect(view.src).not.toBe(ANSWER_KEY);
  });

  // MUTATION: skip the manifest lookup and trust the stored string, and a row that
  // survived a manifest rename ships an <img> pointing at nothing on a page a
  // practice is paying for traffic to.
  it("refuses a key the manifest does not have", () => {
    for (const key of ["screens/not-a-real-picture", "", null, undefined, "../../etc/passwd", "https://example.com/x.jpg"]) {
      expect(imageViewFor(key, "hero"), String(key)).toBeNull();
    }
  });

  // MUTATION: drop the slot check and a 1000px hero is drawn eight times over on
  // one question's answer cards - a megabyte of nothing on a phone.
  it("refuses a key that is fit for the other slot", () => {
    expect(imageViewFor(HERO_KEY, "answer")).toBeNull();
    expect(imageViewFor(ANSWER_KEY, "hero")).toBeNull();
  });

  // MUTATION: default the alt to the empty string and a screen reader skips the
  // picture entirely. The manifest is what makes this branch unreachable today,
  // and the assertion underneath is what keeps it unreachable.
  it("refuses a picture nothing describes, and every shipped asset describes itself", () => {
    for (const image of ASSESS_IMAGES) {
      expect(image.alt.trim(), image.key).not.toBe("");
      expect(imageViewFor(image.key, image.slot), image.key).not.toBeNull();
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. Blocks.
 * ------------------------------------------------------------------------- */

describe("the furniture a screen carries", () => {
  it("carries every kind through, in the order the owner put them in", () => {
    const views = blockViews(welcome([TRUST, TESTIMONIAL, FAQ, IMAGE]));
    expect(views.map((v) => v.kind)).toEqual(["trust-strip", "testimonial", "faq", "image"]);
    expect(views[0]).toEqual({
      kind: "trust-strip",
      practiceName: "Vitality Dental",
      chips: ["Open Saturdays", "Free parking"],
    });
    expect(views[1]).toEqual({
      kind: "testimonial",
      quote: TESTIMONIAL.kind === "testimonial" ? TESTIMONIAL.quote : "",
      attribution: "Hannah, Enfield",
    });
    expect(views[2]).toEqual({ kind: "faq", items: FAQ.kind === "faq" ? FAQ.items : [] });
  });

  // MUTATION: hand back `block.chips` itself and a component that sorted its chips
  // would be editing the campaign row through a render.
  it("hands out copies, so drawing a screen cannot edit the funnel", () => {
    const node = welcome([TRUST, FAQ]);
    const views = blockViews(node);
    const strip = views[0] as Extract<BlockView, { kind: "trust-strip" }>;
    strip.chips.push("Late nights");
    const faq = views[1] as Extract<BlockView, { kind: "faq" }>;
    faq.items[0]!.q = "changed";

    const blocks = node.kind === "welcome" ? node.blocks! : [];
    const stored = blocks[0];
    expect(stored?.kind === "trust-strip" && stored.chips).toEqual(["Open Saturdays", "Free parking"]);
    const storedFaq = blocks[1];
    expect(storedFaq?.kind === "faq" && storedFaq.items[0]!.q).toBe("How long does it take?");
  });

  // MUTATION: render the block anyway with whatever src the row held. One picture
  // an owner cannot see is a support ticket; a broken <img> on an ad's landing
  // page is the practice's money.
  it("drops only the picture it cannot resolve, and keeps the rest of the screen", () => {
    const broken: FlowBlock = { kind: "image", image: "screens/deleted-last-week", alt: "Anything" };
    const views = blockViews(welcome([TRUST, broken, TESTIMONIAL]));
    expect(views.map((v) => v.kind)).toEqual(["trust-strip", "testimonial"]);
  });

  // MUTATION: resolve a block picture in the ANSWER slot and a 360px tile is
  // stretched across a hero.
  it("resolves a block's picture in the hero slot only", () => {
    const tile: FlowBlock = { kind: "image", image: ANSWER_KEY, alt: "A tile" };
    expect(blockViews(welcome([tile]))).toEqual([]);
  });

  // MUTATION: read node.blocks directly and every caller has to remember which
  // kinds can carry them - which is how a question screen grows a testimonial.
  it("is empty for every kind that cannot carry furniture", () => {
    const nodes: FlowNode[] = [
      { id: "q", kind: "question", questionId: "smile_concern" },
      { id: "c", kind: "contact" },
      { id: "w", kind: "welcome" },
      { id: "r", kind: "outcome", band: "high" },
    ];
    for (const n of nodes) expect(blockViews(n), n.kind).toEqual([]);
  });

  it("reads an outcome screen's furniture too, not only a welcome screen's", () => {
    const outcome: FlowNode = { id: "r", kind: "outcome", band: "high", blocks: [TESTIMONIAL] };
    expect(blockViews(outcome).map((v) => v.kind)).toEqual(["testimonial"]);
  });
});

/* ---------------------------------------------------------------------------
 * 4. Answer-card pictures.
 * ------------------------------------------------------------------------- */

describe("the pictures on a question's answer cards", () => {
  // MUTATION: return a LIST and the renderer pairs it with the options by index -
  // which is wrong on every question where only some answers have art.
  it("is keyed by the option value the renderer already draws by", () => {
    const views = optionImageViews(
      question([
        { value: "crowded", image: "conditions/crowded" },
        { value: "gaps", image: "conditions/gaps" },
      ]),
    );
    expect([...views.keys()]).toEqual(["crowded", "gaps"]);
    expect(views.get("gaps")!.src).toBe("/assess/conditions/gaps.webp");
  });

  // MUTATION: fall back to the option's label for alt and a screen reader hears
  // the label twice, once as the picture and once as the answer.
  it("takes its alt from the manifest, because an answer tile has no alt field", () => {
    const views = optionImageViews(question([{ value: "crowded", image: ANSWER_KEY }]));
    expect(views.get("crowded")!.alt).toBe(assessImage(ANSWER_KEY)!.alt);
  });

  it("drops an unresolvable or wrongly-slotted picture and keeps the others", () => {
    const views = optionImageViews(
      question([
        { value: "crowded", image: ANSWER_KEY },
        { value: "gaps", image: "conditions/does-not-exist" },
        { value: "overbite", image: HERO_KEY },
      ]),
    );
    expect([...views.keys()]).toEqual(["crowded"]);
  });

  // MUTATION: last-wins, and a duplicated value silently repaints an answer the
  // owner already set - the opposite of nodeMap's rule for a repeated id.
  it("keeps the first picture for a repeated answer", () => {
    const views = optionImageViews(
      question([
        { value: "crowded", image: "conditions/crowded" },
        { value: "crowded", image: "conditions/gaps" },
      ]),
    );
    expect(views.get("crowded")!.src).toBe("/assess/conditions/crowded.webp");
  });

  it("is empty for a question with no pictures, and for every other kind", () => {
    expect(optionImageViews({ id: "q", kind: "question", questionId: "smile_concern" }).size).toBe(0);
    expect(optionImageViews({ id: "w", kind: "welcome" }).size).toBe(0);
    expect(optionImageViews({ id: "c", kind: "contact" }).size).toBe(0);
    expect(optionImageViews({ id: "r", kind: "outcome", band: "low" }).size).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * 5. The boundary.
 * ------------------------------------------------------------------------- */

describe("what the resolution layer is allowed to import", () => {
  it("imports the graph and the manifest, and nothing else", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./flow-block-view.ts", import.meta.url)), "utf8");
    const specifiers = [...source.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    // MUTATION: import ./quiz "just to default an option's alt to its label" and
    // the option WEIGHTS - the practice's scoring model - enter the public bundle
    // through the one module the public quiz imports to draw its furniture.
    expect(specifiers.sort()).toEqual(["./flow", "@/lib/assess/image-library"]);
    expect(source).not.toContain("server-only");
    expect(source).not.toContain("next/headers");
  });
});
