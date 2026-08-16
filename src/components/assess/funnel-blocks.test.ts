// A2 ON THE PUBLIC PAGE: the funnel's content blocks and its image-card answers,
// as the patient's browser actually receives them.
//
// THE CENTREPIECE IS THE BASELINE. `baselines/deterministic-quiz-no-blocks.html`
// was captured from the quiz BEFORE this feature existed, and the first test below
// re-renders the same funnel with the same props and asserts the markup is
// byte-for-byte that file. Every campaign live today has no blocks and no answer
// pictures, so that is the only assertion that can say "the feature is additive"
// rather than hoping it is: a stray wrapper div, a changed class order, a "grid
// gap-2" that lost its trailing space all show up here as a diff, and every one of
// them is a live page that moved for a feature it does not use.
//
// REGENERATING THE BASELINE IS A DECISION, NOT A FIX. If a later change genuinely
// redesigns the quiz, recapture the file in the same commit as the redesign and
// say so. Recapturing it to make a red test green is deleting the only thing that
// knows the public page changed.
//
// TECHNIQUE: createElement + renderToStaticMarkup, the house idiom for a .tsx in a
// node-env suite (deterministic-preview-gate.test.ts:20-24). A static render
// reaches phase "question" only, so the result screen's furniture is verified
// through FunnelBlocks directly and through the source of the call site.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";
import { FunnelBlocks } from "./funnel-blocks";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { toPublicFlow, type PublicFlow } from "@/lib/smile-assessment/campaign";
import { blockViews, type BlockView } from "@/lib/smile-assessment/flow-block-view";
import { FLOW_SCHEMA_VERSION, type FlowBlock, type FlowGraph, type FlowNode } from "@/lib/smile-assessment/flow";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "@/lib/smile-assessment/quiz";
import { assessImage } from "@/lib/assess/image-library";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "baselines", "deterministic-quiz-no-blocks.html");
const QUIZ_SOURCE = readFileSync(join(HERE, "deterministic-assessment-quiz.tsx"), "utf8");
const BLOCKS_SOURCE = readFileSync(join(HERE, "funnel-blocks.tsx"), "utf8");

/** React escapes on the way out, so assertions compare against escaped copy. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** The exact props the baseline was captured with. Changing one invalidates it. */
const BASELINE_PROPS = {
  clientSlug: "vitality",
  campaignSlug: "invisalign",
  headline: "Is Invisalign right for you?",
  intro: "Two minutes, no wrong answers.",
  practiceName: "Vitality Dental",
  previewMode: false,
} as const;

function renderQuiz(flow: PublicFlow): string {
  return renderToStaticMarkup(createElement(DeterministicAssessmentQuiz, { ...BASELINE_PROPS, flow }));
}

function publish(graph: FlowGraph): PublicFlow {
  const flow = toPublicFlow(graph);
  if (!flow) throw new Error("this graph does not publish");
  return flow;
}

/* ---------------------------------------------------------------------------
 * Fixtures.
 * ------------------------------------------------------------------------- */

const TRUST: FlowBlock = {
  kind: "trust-strip",
  practiceName: "Vitality Dental",
  chips: ["Open Saturdays", "Free parking", "Wheelchair access"],
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
    { q: "Can I ask about the cost?", a: "Yes, and you will have the figures in writing first." },
  ],
};
const IMAGE: FlowBlock = { kind: "image", image: "screens/aligners", alt: "Clear aligners on a tray" };

/** welcome -> four bank questions -> contact -> three results. Validates. */
function funnel(): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "welcome",
    nodes: [
      { id: "welcome", kind: "welcome", headline: "Is Invisalign right for you?", intro: "Two minutes." },
      { id: "q-t", kind: "question", questionId: Q_TREATMENT },
      { id: "q-tl", kind: "question", questionId: Q_TIMELINE },
      { id: "q-b", kind: "question", questionId: Q_BUDGET },
      { id: "q-l", kind: "question", questionId: Q_LOCATION },
      { id: "contact", kind: "contact" },
      { id: "out-high", kind: "outcome", band: "high" },
      { id: "out-medium", kind: "outcome", band: "medium" },
      { id: "out-low", kind: "outcome", band: "low" },
    ],
    edges: [
      { from: "welcome", to: "q-t", answer: null },
      { from: "q-t", to: "q-tl", answer: null },
      { from: "q-tl", to: "q-b", answer: null },
      { from: "q-b", to: "q-l", answer: null },
      { from: "q-l", to: "contact", answer: null },
      { from: "contact", to: "out-high", answer: "high" },
      { from: "contact", to: "out-medium", answer: "medium" },
      { from: "contact", to: "out-low", answer: "low" },
    ],
  };
}

function withNode(graph: FlowGraph, id: string, patch: (node: FlowNode) => FlowNode): FlowGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? patch(n) : n)) };
}

/**
 * The first question's answers, pictured with real manifest keys - all but the
 * LAST one, which is the only answer rule 14 lets an owner leave bare
 * (`option_images_ragged`, flow-validate.ts:309-317). So the fixture is both the
 * shippable shape and the one that exercises the icon fallback.
 */
const ANSWER_KEYS = [
  "conditions/crowded",
  "conditions/gaps",
  "conditions/open-bite",
  "conditions/overbite",
  "conditions/underbite",
  "conditions/crossbite",
  "conditions/even-bite",
];
const FIRST_QUESTION_PICTURES = questionById(Q_TREATMENT)!.options.slice(0, -1).map((o, i) => ({
  value: o.value,
  image: ANSWER_KEYS[i % ANSWER_KEYS.length]!,
}));

/* ---------------------------------------------------------------------------
 * 1. THE BASELINE: a funnel with no furniture renders the page it always did.
 * ------------------------------------------------------------------------- */

describe("a funnel with no blocks and no answer pictures is untouched by A2", () => {
  const graph = templateForGoal("invisalign").build();

  it("renders byte-for-byte the markup captured before the feature existed", () => {
    // MUTATION: render an empty wrapper for an empty block list, drop the
    // conditional on the option grid's class, or reorder one utility, and every
    // live campaign's landing page moves for a feature none of them uses.
    expect(renderQuiz(publish(graph))).toBe(readFileSync(BASELINE, "utf8"));
  });

  it("the baseline really is a no-furniture funnel, or the test above proves nothing", () => {
    for (const node of graph.nodes) {
      expect(blockViews(node), node.id).toEqual([]);
      expect("optionImages" in node && node.optionImages, node.id).toBeFalsy();
    }
  });

  // MUTATION: render the container unconditionally and the border-top rule under
  // the answers appears on every funnel on the platform.
  it("draws literally nothing for an empty block list", () => {
    expect(renderToStaticMarkup(createElement(FunnelBlocks, { blocks: [] }))).toBe("");
    expect(renderToStaticMarkup(createElement(FunnelBlocks, { blocks: [], className: "w-full" }))).toBe("");
  });
});

/* ---------------------------------------------------------------------------
 * 2. The blocks, on the screen a patient reads them on.
 * ------------------------------------------------------------------------- */

describe("the welcome step's furniture reaches the first screen", () => {
  const graph = withNode(funnel(), "welcome", (n) =>
    n.kind === "welcome" ? { ...n, blocks: [TRUST, TESTIMONIAL, FAQ, IMAGE] } : n,
  );
  const html = renderQuiz(publish(graph));

  it("is a shippable funnel, so this is a test about a real page", () => {
    expect(validateFlow(graph).failures).toEqual([]);
  });

  // MUTATION: read the blocks off the campaign instead of off the welcome NODE and
  // an owner who added a trust strip to their funnel sees nothing on their page.
  it("prints the trust strip's practice name and every chip", () => {
    if (TRUST.kind !== "trust-strip") throw new Error("fixture drifted");
    expect(html).toContain(esc(TRUST.practiceName));
    for (const chip of TRUST.chips) expect(html, `missing chip ${chip}`).toContain(esc(chip));
  });

  // MUTATION: render the quote without the attribution and an unattributed
  // testimonial is a claim from nobody - which is exactly what the GDC/ASA line in
  // the charter rules out.
  it("prints the testimonial with the words the practice holds AND who said them", () => {
    if (TESTIMONIAL.kind !== "testimonial") throw new Error("fixture drifted");
    expect(html).toContain(esc(TESTIMONIAL.quote));
    expect(html).toContain(esc(TESTIMONIAL.attribution));
    expect(html.indexOf(esc(TESTIMONIAL.quote))).toBeLessThan(html.indexOf(esc(TESTIMONIAL.attribution)));
  });

  // MUTATION: render only the questions and the accordion is a list of questions
  // nobody answers.
  it("prints both halves of every faq item", () => {
    if (FAQ.kind !== "faq") throw new Error("fixture drifted");
    for (const item of FAQ.items) {
      expect(html, `missing question ${item.q}`).toContain(esc(item.q));
      expect(html, `missing answer ${item.a}`).toContain(esc(item.a));
    }
    // Native <details>, so it needs no state and works with a keyboard for free.
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  // MUTATION: put the stored KEY in the src (CUT 4, flow.ts:304-311) and every
  // funnel picture 404s on a page a practice paid to send traffic to.
  it("resolves the picture to the shipped asset, with its intrinsic box and its alt", () => {
    if (IMAGE.kind !== "image") throw new Error("fixture drifted");
    const entry = assessImage(IMAGE.image)!;
    expect(html).toContain(`src="${entry.path}"`);
    expect(html).toContain(`alt="${esc(IMAGE.alt)}"`);
    expect(html).toContain(`width="${entry.width}"`);
    expect(html).toContain(`height="${entry.height}"`);
    expect(html).not.toContain(`src="${IMAGE.image}"`);
  });

  // MUTATION: draw the furniture above the prompt and the first thing on an ad's
  // landing page is a FAQ rather than the question the ad promised.
  it("sits under the answers, not above the question", () => {
    const q = questionById(Q_TREATMENT)!;
    expect(html.indexOf(esc(q.prompt))).toBeLessThan(html.indexOf(esc("Open Saturdays")));
    for (const o of q.options) expect(html).toContain(esc(o.label));
  });

  // MUTATION: drop the isFirst guard and the trust strip, the testimonial and the
  // FAQ are repeated under every question in the funnel.
  it("is drawn on the first screen only", () => {
    expect(QUIZ_SOURCE).toMatch(/\{isFirst \? <FunnelBlocks blocks=\{blocks\} \/> : null\}/);
  });
});

describe("the result step's furniture is wired to the band the patient got", () => {
  // A static render stops at phase "question", so the call site is read instead:
  // the blocks and the headline must come off the SAME resolved outcome node, or a
  // practice gets the hot screen's headline over the cold screen's reassurance.
  it("resolves the blocks from the same node as the headline", () => {
    expect(QUIZ_SOURCE).toMatch(/const outcome = result \? outcomeNodeFor\(flow\.graph, result\.band\) : null;/);
    expect(QUIZ_SOURCE).toMatch(/const outcomeHeadline = outcome\?\.headline \?\? null;/);
    expect(QUIZ_SOURCE).toMatch(/const outcomeBlocks = outcome \? blockViews\(outcome\) : \[\];/);
    expect(QUIZ_SOURCE).toContain("outcomeHeadline={outcomeHeadline} blocks={outcomeBlocks}");
  });

  it("draws an outcome step's own blocks", () => {
    const outcome: FlowNode = { id: "r", kind: "outcome", band: "high", blocks: [TESTIMONIAL, FAQ] };
    const html = renderToStaticMarkup(
      createElement(FunnelBlocks, { blocks: blockViews(outcome), className: "w-full text-left" }),
    );
    if (TESTIMONIAL.kind !== "testimonial") throw new Error("fixture drifted");
    expect(html).toContain(esc(TESTIMONIAL.quote));
    expect(html).toContain("w-full");
    expect(html).toContain("text-left");
  });
});

/* ---------------------------------------------------------------------------
 * 3. Image-card answers.
 * ------------------------------------------------------------------------- */

describe("a question whose answers have pictures is drawn as image cards", () => {
  const graph = withNode(funnel(), "q-t", (n) =>
    n.kind === "question" ? { ...n, optionImages: FIRST_QUESTION_PICTURES } : n,
  );
  const html = renderQuiz(publish(graph));
  const question = questionById(Q_TREATMENT)!;

  it("is a shippable funnel", () => {
    expect(validateFlow(graph).failures).toEqual([]);
  });

  // MUTATION: pair the pictures with the options by INDEX and the wrong picture
  // sits over the wrong answer on every question that pictures only some of them.
  it("puts each picture on the answer it was chosen for", () => {
    for (const picture of FIRST_QUESTION_PICTURES) {
      const entry = assessImage(picture.image)!;
      const label = question.options.find((o) => o.value === picture.value)!.label;
      const at = html.indexOf(`src="${entry.path}"`);
      expect(at, `no tile for ${picture.value}`).toBeGreaterThan(-1);
      // The label follows its own picture, before the next card starts.
      const card = html.slice(at, html.indexOf("</button>", at));
      expect(card, `${picture.value} is not labelled with its own answer`).toContain(esc(label));
    }
  });

  // MUTATION: alt={o.label} and a screen reader hears the answer twice; alt="" and
  // it hears the picture not at all.
  it("gives every tile the manifest's own alt text", () => {
    for (const picture of FIRST_QUESTION_PICTURES) {
      expect(html).toContain(`alt="${esc(assessImage(picture.image)!.alt)}"`);
    }
    // No picture anywhere on the screen is unlabelled.
    expect(html).not.toContain('alt=""');
  });

  // MUTATION: drop the icon fallback and the one answer rule 14 allows to stay
  // bare ("other") is a hole in the grid rather than a card like the rest.
  it("keeps the icon chip on the answer that has no picture", () => {
    const pictured = new Set(FIRST_QUESTION_PICTURES.map((p) => p.value));
    const bare = question.options.filter((o) => !pictured.has(o.value));
    expect(bare.length, "fixture must leave an answer unpictured").toBe(1);
    for (const o of bare) {
      const at = html.indexOf(esc(o.label));
      expect(at, `no card for ${o.value}`).toBeGreaterThan(-1);
      const card = html.slice(html.lastIndexOf("<button", at), at);
      expect(card, `${o.value} lost its icon`).toContain("<svg");
      expect(card, `${o.value} grew an image`).not.toContain("<img");
    }
  });

  // MUTATION: leave the row layout in place and a grid of tall pictures is drawn
  // one per row, so the second answer is below the fold on a phone.
  it("switches the whole step to the two-up card grid", () => {
    expect(html).toContain('class="grid grid-cols-2 gap-2"');
  });

  // MUTATION: swap the button for a div "because the picture is the target" and
  // the answers stop being reachable by keyboard.
  it("keeps the same control and the same selection semantics", () => {
    const cards = html.match(/<button type="button" aria-pressed="false"/g) ?? [];
    expect(cards.length).toBe(question.options.length);
  });

  // MUTATION: publish the picture PATH on the graph rather than the key and the
  // manifest stops being the only thing that decides what a funnel can show.
  it("still ships the key on the wire and resolves it in the browser", () => {
    expect(JSON.stringify(publish(graph))).toContain("conditions/crowded");
    expect(JSON.stringify(publish(graph))).not.toContain("/assess/conditions");
  });

  it("ships no scoring weight, pictures or not", () => {
    expect(html).not.toMatch(/weight/i);
  });
});

/* ---------------------------------------------------------------------------
 * 4. Colour and contrast.
 * ------------------------------------------------------------------------- */

describe("the furniture is painted in tokens a re-coloured campaign can reach", () => {
  const AA_INK = ["text-navy", "text-ink", "text-muted", "text-blue-deep"];

  // MUTATION: reach for a hex and that part of the screen stops following the
  // colour scheme picked in the builder (palette.ts:5-17).
  it("names no colour by hex", () => {
    const code = BLOCKS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
  });

  // MUTATION: set the FAQ answer in text-faint "because it is secondary". faint is
  // META ink - footnote weight - and this is a sentence a practice is asking a
  // patient to read before they leave a phone number.
  it("sets every word in one of the four AA-checked inks", () => {
    const code = BLOCKS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const inks = [...code.matchAll(/\btext-(?!\[)[a-z][a-z0-9-]*/g)].map((m) => m[0]);
    const LAYOUT = ["text-left", "text-center", "text-right", "text-wrap"];
    expect(inks.length, "no ink at all is a vacuous assertion").toBeGreaterThan(3);
    for (const ink of inks) {
      expect([...AA_INK, ...LAYOUT], `${ink} is not an AA-checked ink`).toContain(ink);
    }
  });

  it("draws its surfaces and hairlines out of palette tokens", () => {
    const views: BlockView[] = blockViews({ id: "w", kind: "welcome", blocks: [TRUST, TESTIMONIAL, FAQ, IMAGE] });
    const html = renderToStaticMarkup(createElement(FunnelBlocks, { blocks: views }));
    for (const cls of ["border-line", "bg-card", "bg-card-muted", "text-navy", "text-ink", "text-muted", "text-blue-deep"]) {
      expect(html, `lost ${cls}`).toContain(cls);
    }
  });
});
