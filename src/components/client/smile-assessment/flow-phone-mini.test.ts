// THE PHONE-SCREEN STRIP, held at the seams a pure test cannot reach: what a mini
// actually renders, that it renders it out of nothing but a resolved screen, and
// that it stays a PICTURE - no quiz mounted inside it, nothing to press, no colour
// it could not be re-themed out of.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts,
// but .tsx components are freely imported and rendered: createElement plus
// renderToStaticMarkup is the house idiom (create-experience-shell.test.ts:20-21,
// deterministic-preview-gate.test.ts:26-33). The three things a static render
// cannot show - what the file imports, what hooks it calls, and how the panel
// wraps it - are read out of the source as text.
//
// WHAT THE RULES THEMSELVES ARE TESTED BY. Every string on a mini is resolved by
// flow-phone-screen.ts and every coordinate by flow-phone-layout.ts, each with its
// own suite beside it. What is left over here, and what a redesign breaks
// silently, is the WIRING: a screen field that stops being rendered, a mini that
// grows a button, a strip whose two layers stop reading the same numbers.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FLOW_BANDS, FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "@/lib/smile-assessment/flow";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { phoneFlowLayout, phoneMetrics } from "@/lib/smile-assessment/flow-phone-layout";
import { screenFor, type PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import { questionById } from "@/lib/smile-assessment/quiz";
import { iconFor } from "@/components/assess/option-icons";
import { resultCopy } from "@/lib/smile-assessment/result-copy";
import { PhoneMini } from "./flow-phone-mini";
import { FlowPhoneCanvas } from "./flow-phone-canvas";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINI_PATH = join(HERE, "flow-phone-mini.tsx");
const CANVAS_PATH = join(HERE, "flow-phone-canvas.tsx");
const PANEL_PATH = resolve(process.cwd(), "src/components/client/smile-assessment/campaigns-panel.tsx");

const miniSource = readFileSync(MINI_PATH, "utf8");
const canvasSource = readFileSync(CANVAS_PATH, "utf8");
const panelSource = readFileSync(PANEL_PATH, "utf8");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/**
 * Copy as it arrives in the MARKUP. React escapes &, <, >, " and ' on its way out,
 * so "You'll get a recommendation" is not in the HTML - "You&#x27;ll ..." is.
 * Asserting on the raw string would quietly pass for every sentence without an
 * apostrophe and fail for every sentence with one.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function render(screen: PhoneScreen, practiceName?: string): string {
  return renderToStaticMarkup(createElement(PhoneMini, { screen, practiceName }));
}

/* ---------------------------------------------------------------------------
 * Fixtures. A hand-built funnel, so each kind can be asked for on its own.
 * ------------------------------------------------------------------------- */

const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

function graph(nodes: FlowNode[], edges: FlowEdge[], entry = nodes[0]!.id): FlowGraph {
  return { schemaVersion: FLOW_SCHEMA_VERSION, entry, nodes, edges };
}

/** welcome -> treatment -> timeline -> contact -> three results. */
function funnel(): FlowGraph {
  return graph(
    [
      { id: "w", kind: "welcome", headline: "Is Invisalign right for you?", intro: "Two minutes." },
      { id: "q1", kind: "question", questionId: "treatment_interest" },
      { id: "q2", kind: "question", questionId: "timeline", transition: "Good to know." },
      { id: "c", kind: "contact" },
      { id: "hot", kind: "outcome", band: "high", headline: "You are a great fit" },
      { id: "warm", kind: "outcome", band: "medium" },
      { id: "cold", kind: "outcome", band: "low" },
    ],
    [
      edge("w", "q1"),
      edge("q1", "q2"),
      edge("q2", "c"),
      edge("c", "hot", "high"),
      edge("c", "warm", "medium"),
      edge("c", "cold", "low"),
    ],
  );
}

/** The panel's own construction, mirrored: layout first, one screen per node. */
function preview(g: FlowGraph, campaign: { headline?: string; intro?: string } = {}) {
  const layout = phoneFlowLayout(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const screens = new Map<string, PhoneScreen>();
  for (const n of layout.nodes) {
    const node = byId.get(n.id);
    if (node) screens.set(n.id, screenFor(node, g, campaign, n.step));
  }
  return { layout, screens };
}

function screenOf(g: FlowGraph, id: string, campaign?: { headline?: string; intro?: string }): PhoneScreen {
  const found = preview(g, campaign).screens.get(id);
  if (!found) throw new Error(`no screen for ${id}`);
  return found;
}

/* ---------------------------------------------------------------------------
 * 1. Every screen kind draws the screen it is.
 * ------------------------------------------------------------------------- */

describe("a question mini draws the question a patient is asked", () => {
  const screen = screenOf(funnel(), "q2");
  const html = render(screen);

  // MUTATION: render the node's kind instead of its question and every mini in
  // the strip reads "Question" - true of every template on the shelf, and
  // therefore useless for choosing between them.
  it("prints the prompt and every answer, in the bank's own words", () => {
    if (screen.kind !== "question") throw new Error("fixture drifted");
    const q = questionById("timeline")!;
    expect(html).toContain(esc(q.prompt));
    for (const o of q.options) {
      expect(html, `missing answer ${o.value}`).toContain(esc(o.label));
    }
    expect(screen.options.length).toBe(q.options.length);
  });

  // MUTATION: drop the chip and a seven-screen strip has no step numbers on it at
  // all - the one thing that says which screen comes when.
  it("carries the step chip and the step's own lead-in", () => {
    // Second question of the funnel, so it is numbered from the layout's column
    // rather than from the node's position in the array.
    expect(html).toContain("Question 2");
    expect(html).toContain("Good to know.");
  });

  // MUTATION: number the chip in here and it drifts from the runtime's nudge,
  // which starts at the third question (deterministic-assessment-quiz.tsx:545).
  it("carries the nudge the runtime adds from the third question on", () => {
    const g = funnel();
    g.nodes.splice(3, 0, { id: "q3", kind: "question", questionId: "budget_readiness" });
    g.edges = g.edges.map((e) => (e.from === "q2" ? { ...e, to: "q3" } : e));
    g.edges.push(edge("q3", "c"));
    expect(render(screenOf(g, "q3"))).toContain("Question 3 · nearly there");
  });

  // MUTATION: hardcode the back link and screen one grows a Back that goes
  // nowhere; drop it and every later screen loses the way out the runtime gives.
  it("shows Back only where the runtime shows it", () => {
    expect(html).toContain("Back");
    expect(render(screenOf(funnel(), "q1"))).not.toContain(">Back<");
  });

  // MUTATION: drop the width and the progress bar is either empty on every
  // screen or full on all of them.
  it("fills the progress bar to the number the screen carries", () => {
    expect(html).toContain(`width:${screen.progress}%`);
  });

  // MUTATION: pick the icon by LABEL and every row falls back to the default
  // circle, because the icon map is keyed by option value (option-icons.ts).
  //
  // The first version of this test counted distinct lucide classes across the
  // WHOLE mini and asserted > 2 - which the Back arrow and the chevrons satisfy
  // on their own, so the exact mutation named above passed it. The verifier
  // caught that. Now the comparison is the one that means something: the
  // distinct icon set rendered INSIDE the option rows must equal the set the
  // value-keyed map produces for these options. Keyed by label, every option
  // icon collapses to the Circle fallback and the sets stop matching.
  it("draws a different icon per answer, chosen by the option's value", () => {
    if (screen.kind !== "question") throw new Error("fixture must be a question screen");
    const expected = new Set(
      screen.options.map((o) => renderToStaticMarkup(createElement(iconFor(o.value), {}))
        .match(/class="lucide[^"]*"/)?.[0] ?? ""),
    );
    expect(expected.size).toBeGreaterThan(1);
    // Slice to the options grid: everything after the prompt legend.
    const grid = html.slice(html.indexOf(screen.prompt));
    const rendered = new Set([...grid.matchAll(/class="lucide[^"]*"/g)].map((m) => m[0]));
    for (const icon of expected) expect(rendered).toContain(icon);
  });
});

describe("the first screen carries the hero block above the prompt", () => {
  const screen = screenOf(funnel(), "w");
  const html = render(screen);

  // MUTATION: draw a standalone welcome screen with a Start button. There is no
  // such screen and no such button in the runtime - the hero copy is an OVERRIDE
  // rendered above the first question's prompt (deterministic-assessment-quiz
  // .tsx:207-212,549-555) - so a mockup of one would be a picture of a screen the
  // funnel does not have, which is exactly what the old mockup was killed for.
  it("is the first QUESTION's screen, with the headline and intro on top of it", () => {
    if (screen.kind !== "welcome-question") throw new Error("fixture drifted");
    const q = questionById("treatment_interest")!;
    expect(html).toContain(esc("Is Invisalign right for you?"));
    expect(html).toContain("Two minutes.");
    expect(html).toContain(esc(q.prompt));
    for (const o of q.options) expect(html).toContain(esc(o.label));
    // Above, not below: the order on screen is the order in the markup.
    expect(html.indexOf(esc("Is Invisalign right for you?"))).toBeLessThan(
      html.indexOf(esc(q.prompt)),
    );
    // No start control, because there is nothing to start.
    expect(html.toLowerCase()).not.toContain("start");
    expect(html).not.toContain(">Back<");
  });

  // MUTATION: ignore the campaign copy and the headline being typed on this very
  // form never appears where a patient reads it.
  it("shows the campaign's own headline when the step has none", () => {
    const g = funnel();
    g.nodes[0] = { id: "w", kind: "welcome" };
    const html2 = render(screenOf(g, "w", { headline: "Straighter teeth by spring", intro: "" }));
    expect(html2).toContain("Straighter teeth by spring");
  });
});

describe("the contact mini draws the form the funnel actually asks", () => {
  const screen = screenOf(funnel(), "c");
  const html = render(screen);

  // MUTATION: hand-type this screen's copy here and the preview keeps promising
  // wording the runtime stopped using.
  it("prints the runtime's eyebrow, heading, helper and consent line", () => {
    if (screen.kind !== "contact") throw new Error("fixture drifted");
    for (const line of [screen.eyebrow, screen.heading, screen.helper, screen.consent]) {
      expect(html, `missing ${line}`).toContain(esc(line));
    }
  });

  it("shows the fields and the reply channels the funnel offers", () => {
    if (screen.kind !== "contact") throw new Error("fixture drifted");
    expect(html).toContain(esc(screen.nameField.label));
    expect(html).toContain(esc(screen.addressField.label));
    expect(html).toContain(esc(screen.channelLegend));
    for (const c of screen.channels) expect(html).toContain(esc(c.label));
    expect(html).toContain(esc(screen.submitLabel));
    // MUTATION: add WhatsApp back and the preview offers a channel the practice
    // cannot yet send on.
    expect(html).not.toContain("WhatsApp");
  });

  // MUTATION: render real inputs and a picture of a form becomes four tab stops
  // and a submit button inside a wizard that has no campaign yet.
  it("draws the controls rather than rendering them", () => {
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});

describe("a result mini draws the thank-you screen for its band", () => {
  // MUTATION: use one band's copy for all three and the three result steps a
  // funnel is required to have become three identical screens.
  it.each(FLOW_BANDS)("%s reads as its own band", (band) => {
    const g = graph(
      [
        { id: "q", kind: "question", questionId: "treatment_interest" },
        { id: "c", kind: "contact" },
        { id: "r", kind: "outcome", band },
      ],
      [edge("q", "c"), edge("c", "r", band)],
    );
    const html = render(screenOf(g, "r"));
    // The convention, said out loud in flow-phone-screen.ts: a hot result IS
    // fast-tracked, and no booking link is assumed.
    expect(html).toContain(esc(resultCopy(band, band === "high", false)));
    expect(html).toContain("Thank you");
  });

  it("prefers the step's own headline", () => {
    const html = render(screenOf(funnel(), "hot"));
    expect(html).toContain("You are a great fit");
    expect(html).not.toContain(">Thank you<");
  });

  // MUTATION: "fix" the green tick to match the scheme. --success is semantic and
  // deliberately outside PALETTE_TOKENS (palette.ts:36-39): green means "done" on
  // every palette.
  it("keeps the tick green on every scheme", () => {
    expect(render(screenOf(funnel(), "warm"))).toContain("text-success");
  });
});

describe("a step that cannot be drawn says so on the step", () => {
  // MUTATION: render nothing for an unresolvable step and the owner gets a blank
  // phone in the middle of the strip with no clue which one is broken.
  it("prints the reason rather than an empty phone", () => {
    const g = graph(
      [
        { id: "q", kind: "question", questionId: "not_a_real_question" },
        { id: "c", kind: "contact" },
        { id: "r", kind: "outcome", band: "high" },
      ],
      [edge("q", "c"), edge("c", "r", "high")],
    );
    const screen = screenOf(g, "q");
    if (screen.kind !== "error") throw new Error("fixture drifted");
    const html = render(screen);
    expect(html).toContain(esc(screen.title));
    expect(html).toContain(esc(screen.detail));
  });
});

/* ---------------------------------------------------------------------------
 * 2. The chrome every screen shares.
 * ------------------------------------------------------------------------- */

describe("every mini wears the funnel's own chrome", () => {
  const html = render(screenOf(funnel(), "q2"), "Vitality Dental");

  it("carries the branded lockup, with the runtime's fallback name", () => {
    expect(html).toContain("Vitality Dental");
    expect(html).toContain("Smile Assessment");
    expect(html).toContain('src="/copilot-logo.png"');
    // No practice name supplied: the runtime's own fallback (:399), not a blank.
    expect(render(screenOf(funnel(), "q2"))).toContain(">Smile Assessment<");
  });

  // MUTATION: paint the glow with the bare rgba and an unthemed strip and a
  // themed one stop matching. The exact literal is pinned a second time in
  // palette.test.ts, alongside both quiz components.
  it("paints the promoted glow through the token, with the shipped fallback", () => {
    expect(html).toContain("var(--assess-glow,rgba(91,196,247,0.20))");
  });

  // MUTATION: reach for a hex, or for a token outside PALETTE_TOKENS, and that
  // part of the screen stops following the colour scheme picked below it.
  it("paints itself out of themed tokens", () => {
    for (const cls of ["bg-cream", "bg-card", "text-navy", "text-ink", "text-muted", "bg-blue-dark", "text-blue-deep", "bg-card-muted", "border-line"]) {
      expect(html, `lost ${cls}`).toContain(cls);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. It is a picture, and it stays one.
 * ------------------------------------------------------------------------- */

describe("the mini is presentational, structurally", () => {
  const IMPORTS = /^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm;
  const specifiers = (source: string) => [...source.matchAll(IMPORTS)].map((m) => m[1]!);

  // MUTATION: mount the real quiz component instead of mirroring its classes.
  // Ten live funnels on one screen: ten trackers firing, ten screens that answer
  // their own questions on click, and a POST waiting behind each contact step.
  it.each([
    ["flow-phone-mini.tsx", miniSource],
    ["flow-phone-canvas.tsx", canvasSource],
  ])("%s mounts no quiz component and nothing server-only", (_name, source) => {
    for (const spec of specifiers(source)) {
      expect(spec, `imports ${spec}`).not.toMatch(/assessment-quiz/);
      expect(spec, `imports ${spec}`).not.toContain("server-only");
      expect(spec, `imports ${spec}`).not.toContain("funnel-tracker");
      // describeNode writes for the OWNER: it leaks builder-only lines onto a
      // drawing of a patient's screen and drops the option values the icons need.
      expect(spec, `imports ${spec}`).not.toContain("flow-edit");
    }
  });

  // MUTATION: give a mini state or an effect and a preview strip starts doing
  // work - on a component rendered ten times over, inside a form. The mini is the
  // half of the pair that stayed a picture outright: A1 made the STRIP selectable
  // and left the screen inside it untouched, which is what keeps one funnel
  // rendering shared by the read-only wizard preview and the editor.
  it("the mini holds no state, runs no effect, fetches nothing, and has nothing to click", () => {
    const code = codeOnly(miniSource);
    for (const banned of ["useState", "useEffect", "useMemo", "fetch(", "onClick", "onChange"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
  });

  // THE STRIP HAS EXACTLY TWO INTERACTIONS, and both are the same shape: a click
  // that hands a NODE ID back to the builder. Selecting a screen (A1's
  // click-to-edit) and adding one after it (A1's parity pass, once the abstract
  // canvas came down and the strip became the only canvas). It still decides
  // nothing - no state, no effect, no fetch, and no handler that does anything but
  // call the callback it was given.
  //
  // PIN CHANGED, deliberately: this used to require EXACTLY ONE onClick. It now
  // requires exactly two, named, so a third arriving unannounced still goes red.
  //
  // MUTATION: let the strip hold the selection itself ("it is only one useState")
  // and the ring on the phone and the rail beside it become two answers to "what
  // am I editing". MUTATION: decide in here whether a + can do anything - whether
  // a question may be added on that route is the validator's answer
  // (planScreenInsertion), and a control that greys itself out on a rule written
  // in JSX is a rule no test can hold.
  it("the canvas forwards its two clicks and holds nothing", () => {
    const code = codeOnly(canvasSource);
    for (const banned of ["useState", "useEffect", "useMemo", "fetch(", "onChange"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
    expect(code).toContain("onClick={() => onSelect(nodeId)}");
    expect(code).toContain("onClick={() => onAddAfter(nodeId)}");
    expect(code.split("onClick").length - 1, "an unnamed third handler").toBe(2);
    // The + never disables itself: the refusal is the builder's, in words.
    expect(code).not.toContain("disabled");
  });

  // MUTATION: make the option rows buttons "so they look right". Ten screens of
  // eight answers is eighty tab stops on a picture.
  //
  // Rendered WITHOUT `onSelect`, which is the read-only strip the wizard's stage 2
  // mounts. MUTATION: make the buttons unconditional and that preview - of a
  // funnel with no campaign to be saved against - grows a tab stop per screen.
  it("renders nothing focusable when it is not editable", () => {
    const { layout, screens } = preview(funnel());
    const html = renderToStaticMarkup(
      createElement(FlowPhoneCanvas, { layout, screens, idPrefix: "t" }),
    );
    for (const tag of ["<button", "<input", "<a ", "<select", "<textarea", "tabindex"]) {
      expect(html, `found ${tag}`).not.toContain(tag);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 4. The strip: two layers, one set of numbers.
 * ------------------------------------------------------------------------- */

describe("the strip positions the minis off the layout it was handed", () => {
  const { layout, screens } = preview(templateForGoal("invisalign").build());
  const html = renderToStaticMarkup(
    createElement(FlowPhoneCanvas, { layout, screens, idPrefix: "strip" }),
  );

  // MUTATION: lay the minis out with a flex row and the wires - which are drawn
  // at the layout's coordinates - point at empty space.
  it("places every node at the exact coordinates the layout gave it", () => {
    for (const n of layout.nodes) {
      expect(
        html,
        `${n.id} is not where the layout put it`,
      ).toContain(`left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`);
    }
  });

  // MUTATION: scale or transform either layer and the two stop agreeing about
  // where a screen is. The SVG is the same pixel box as the HTML above it, at 1:1.
  it("sizes the wire underlay to the very same box, with no transform", () => {
    expect(html).toContain(`width="${layout.width}"`);
    expect(html).toContain(`height="${layout.height}"`);
    expect(html).toContain(`viewBox="${layout.viewBox}"`);
    expect(html).not.toContain("transform");
    expect(html).not.toContain("foreignObject");
  });

  // MUTATION: draw the wires as straight lines between centres and a branch that
  // the builder's canvas routes around a card cuts straight through one here.
  it("draws each edge's real routed path, and nothing else in SVG", () => {
    for (const e of layout.edges) expect(html).toContain(`d="${e.d}"`);
    // Scoped to the underlay, because the option-row icons are SVGs of their own
    // further down the markup - a whole-document scan would be reading those.
    const underlay = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
    // No cards in SVG: a mini is HTML, and its corners and words are CSS and DOM.
    expect(underlay).not.toContain("<rect");
    expect(underlay).not.toContain("<text");
    expect(underlay).not.toContain("<foreignObject");
  });

  // MUTATION: drop a kind from the switch and that step renders as a hole in the
  // middle of the funnel.
  it("draws one mini per step, and every step of the graph", () => {
    expect(screens.size).toBe(layout.nodes.length);
    // Twice over: once in the strip, once in the small-screen list.
    const lockups = html.split('src="/copilot-logo.png"').length - 1;
    expect(lockups).toBe(layout.nodes.length * 2);
  });

  // MUTATION: let the strip scroll the page instead of itself and reading a
  // nine-step funnel drags the form off screen sideways.
  it("keeps its scrolling to itself and reads as one picture", () => {
    expect(html).toContain("overflow-auto");
    expect(html).toContain('role="img"');
    expect(html).toContain(`the ${layout.nodes.length} screens a patient sees`);
  });

  // MUTATION: ship the 3400px strip to a phone. A diagram you have to drag
  // sideways is a diagram nobody reads - the canvas made the same call
  // (flow-canvas.tsx:148-161).
  it("falls back to the same minis stacked, below sm", () => {
    expect(html).toContain("sm:hidden");
    expect(html).toContain("hidden overflow-auto p-1 sm:block");
    expect(html).toContain("<ol");
  });
});

/* ---------------------------------------------------------------------------
 * 5. The panel wraps the strip in the scheme.
 * ------------------------------------------------------------------------- */

describe("the chosen colour scheme reaches the strip", () => {
  // MUTATION: drop the wrapper and the picker below the preview stops changing
  // the preview - which is the one thing a colour picker is for. MUTATION: put
  // the vars on an element INSIDE the strip and the phone frames float on the
  // old palette while their screens change colour.
  // The one line of the minis' chrome that could quietly stop being what the
  // patient sees: the branded header's practice name. Production passes the
  // real name on the public page; the preview must carry the same name through
  // the panel, or every mini falls back to the generic "Smile Assessment"
  // lockup - fidelity in everything except the practice's own name. MUTATION:
  // drop the prop from the FlowPhoneCanvas call and this goes red while every
  // rendering test stays green (the fallback renders fine - that is the trap).
  it("passes the practice name through to the minis", () => {
    const code = codeOnly(panelSource);
    const stripAt = code.indexOf("<FlowPhoneCanvas");
    const stripTag = code.slice(stripAt, code.indexOf("/>", stripAt));
    expect(stripTag).toContain("practiceName={practiceName}");
  });

  // Since 0081 the wrapper resolves through `themeVarsFor`, not `paletteVars`
  // directly: the picker above the strip now also offers the practice's OWN
  // schemes, and those have no catalogue key for paletteVars to look up. The
  // enclosure — and the reason for it — is unchanged; only what resolves the
  // value moved, so that the one control whose effect is visible from this card
  // stays visible for exactly the schemes the owner built themselves.
  it("encloses the minis in a themeVarsFor wrapper", () => {
    const code = codeOnly(panelSource);
    const wrapperAt = code.indexOf("themeVarsFor(form.theme");
    expect(wrapperAt, "no theme-vars wrapper in the panel").toBeGreaterThan(-1);
    const stripAt = code.indexOf("<FlowPhoneCanvas");
    expect(stripAt, "the strip is not inside the wrapper").toBeGreaterThan(wrapperAt);
    // ...and it closes AFTER the strip: the enclosure, not just the order.
    const closeAt = code.indexOf("</div>", wrapperAt);
    expect(closeAt).toBeGreaterThan(stripAt);
  });

  // MUTATION: thread the theme in as a prop and it has to be plumbed through
  // every mini by hand - which is how half of them get missed.
  it("re-themes without the components knowing anything about it", () => {
    expect(codeOnly(miniSource)).not.toContain("theme");
    expect(codeOnly(canvasSource)).not.toContain("theme");
    expect(codeOnly(miniSource)).not.toContain("palette");
  });
});

/* ---------------------------------------------------------------------------
 * 5b. A2: content blocks and answer pictures, at 300px.
 *
 * A mini is 300x470 and EVERY mini is exactly that (flow-phone-layout.ts). So the
 * question a block has to answer here is not "does it look like the page" - it
 * cannot - but "is it TRUE about the page, in the room there is". A chip row is
 * the chips; a quote line is the quote and who said it; a count line is how many
 * questions the accordion answers; a stand-in plate is a picture that is there.
 * ------------------------------------------------------------------------- */

describe("a funnel with no furniture draws the mini it drew before A2", () => {
  const BASELINE = JSON.parse(
    readFileSync(join(HERE, "baselines", "phone-minis-no-blocks.json"), "utf8"),
  ) as Record<string, string>;

  const g = templateForGoal("invisalign").build();
  const { screens } = preview(g, {
    headline: "Is Invisalign right for you?",
    intro: "Two minutes, no wrong answers.",
  });

  // MUTATION: render the block strip's wrapper (or its border-top) for an empty
  // list, or add a class to the options grid unconditionally, and every campaign
  // preview on the platform moves for a feature none of them uses.
  it("renders byte-for-byte the markup captured before the feature existed", () => {
    expect(Object.keys(BASELINE).length).toBe(screens.size);
    for (const [id, screen] of screens) {
      expect(render(screen, "Vitality Dental"), id).toBe(BASELINE[id]);
    }
  });

  it("the baseline really is a no-furniture funnel, or the test above proves nothing", () => {
    for (const [id, screen] of screens) {
      if (screen.kind === "welcome-question" || screen.kind === "outcome") {
        expect(screen.blocks, id).toEqual([]);
      }
      if (screen.kind === "question" || screen.kind === "welcome-question") {
        for (const o of screen.options) expect(o.image, `${id}/${o.value}`).toBeUndefined();
      }
    }
  });
});

describe("the furniture on a screen is drawn as what fits", () => {
  const TRUST = {
    kind: "trust-strip" as const,
    practiceName: "Vitality Dental",
    chips: ["Open Saturdays", "Free parking", "Wheelchair access"],
  };
  const TESTIMONIAL = {
    kind: "testimonial" as const,
    quote: "The team explained every step and I never felt rushed.",
    attribution: "Hannah, Enfield",
  };
  const FAQ = {
    kind: "faq" as const,
    items: [
      { q: "How long does it take?", a: "The team will talk you through it." },
      { q: "Can I ask about cost?", a: "Yes, in writing, first." },
      { q: "Do you see nervous patients?", a: "Every day." },
    ],
  };
  const IMAGE = { kind: "image" as const, image: "screens/aligners", alt: "A pair of clear aligners" };

  function decorated(): FlowGraph {
    const g = funnel();
    g.nodes[0] = { id: "w", kind: "welcome", headline: "Is Invisalign right for you?", intro: "Two minutes.", blocks: [TRUST, TESTIMONIAL, FAQ, IMAGE] };
    g.nodes[4] = { id: "hot", kind: "outcome", band: "high", headline: "You are a great fit", blocks: [TESTIMONIAL, FAQ] };
    return g;
  }

  const hero = render(screenOf(decorated(), "w"));
  const outcome = render(screenOf(decorated(), "hot"));

  // MUTATION: summarise the chips as "3 reassurances" and the one thing an owner
  // opened the preview to check - that the strip says "Open Saturdays" - is gone.
  it("draws the trust strip as the practice name and its chips, verbatim", () => {
    expect(hero).toContain(esc(TRUST.practiceName));
    for (const chip of TRUST.chips) expect(hero, `missing chip ${chip}`).toContain(esc(chip));
  });

  // MUTATION: print the quote without the attribution and the drawing shows a
  // testimonial the page does not have - one from nobody.
  it("draws the testimonial as one line: the quote and who said it", () => {
    expect(hero).toContain(esc(`“${TESTIMONIAL.quote}” — ${TESTIMONIAL.attribution}`));
    // Clamped, not cut: the model carries the practice's own words in full.
    expect(hero).toContain("line-clamp-2");
  });

  // MUTATION: draw the FAQ's questions and answers in full and the 470px screen
  // is a wall of clipped text with the answers below the cut.
  it("draws the faq as a count of what it answers", () => {
    expect(hero).toContain("3 questions answered");
    expect(hero).not.toContain(esc(FAQ.items[0]!.a));
  });

  // MUTATION: draw the real hero and a strip of ten minis fetches a megabyte of
  // 1000px JPEGs to show them at 20 pixels wide.
  it("draws a screen picture as a stand-in captioned with what it shows", () => {
    expect(hero).toContain(esc(IMAGE.alt));
    expect(hero).not.toContain("/landing/invisalign/aligners.jpg");
  });

  it("draws a result step's own furniture too", () => {
    expect(outcome).toContain(esc(`“${TESTIMONIAL.quote}” — ${TESTIMONIAL.attribution}`));
    expect(outcome).toContain("3 questions answered");
  });

  // MUTATION: let the block strip sit in the flow and a screen with eight answers
  // pushes it out of a box that cannot grow - the furniture an owner just added is
  // then invisible in the preview of the screen they added it to.
  it("keeps the strip on screen and lets the answers give up the room instead", () => {
    expect(hero).toContain("shrink-0 space-y-1 border-t border-line pt-1.5 mt-auto");
    expect(hero).toContain("grid min-h-0 gap-1 overflow-hidden");
  });

  // MUTATION: grow the box for a screen with furniture and the strip stops being a
  // row of identical handsets - the wires, drawn at the layout's coordinates, then
  // point at the wrong edges (flow-phone-layout.ts, uniform cards).
  it("changes not one coordinate: every box is still PHONE_METRICS.minH", () => {
    const plain = phoneFlowLayout(funnel());
    const rich = phoneFlowLayout(decorated());
    expect(rich.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h])).toEqual(
      plain.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h]),
    );
    for (const n of rich.nodes) expect(n.h, n.id).toBe(phoneMetrics().minH);
  });

  // MUTATION: reach for a token outside the AA-checked inks (text-faint is the
  // tempting one: it is meta ink for footnotes) and the furniture is the one part
  // of the screen a patient cannot read.
  it("sets the furniture's words in the AA-checked inks only", () => {
    // The four the quiz already sets COPY in. text-blue-dark is deliberately not
    // among them: it is the action colour and the icon-chip glyph, and palette.ts
    // calls blue-DEEP "the AA-contrast small-text blue on a light card".
    const AA_INK = ["text-navy", "text-ink", "text-muted", "text-blue-deep"];
    const NOT_A_COLOUR = ["text-left", "text-wrap"];
    // Scoped to the block strip, which is the last thing on the screen (mt-auto),
    // so this is reading the furniture's own words rather than the chrome around
    // it - a whole-mini scan would be satisfied by the option rows' own inks.
    const at = hero.indexOf("shrink-0 space-y-1 border-t border-line pt-1.5");
    expect(at, "the block strip is not in this render").toBeGreaterThan(-1);
    const strip = hero.slice(at);
    const inks = new Set([...strip.matchAll(/\btext-(?!\[)[a-z][a-z0-9-]*/g)].map((m) => m[0]));
    expect(inks.size, "no ink at all is a vacuous assertion").toBeGreaterThan(2);
    for (const ink of inks) {
      expect([...AA_INK, ...NOT_A_COLOUR], `${ink} is not an AA-checked ink`).toContain(ink);
    }
  });
});

describe("a booking invitation is drawn as the button and what opens behind it", () => {
  const BOOKING = {
    kind: "booking" as const,
    headline: "Book your appointment now",
    blurb: "Pick a time that suits you and we will hold it for you.",
  };

  function bookable(): FlowGraph {
    const g = funnel();
    g.nodes[4] = { id: "hot", kind: "outcome", band: "high", headline: "You are a great fit", blocks: [BOOKING] };
    return g;
  }

  const outcome = render(screenOf(bookable(), "hot"));

  // MUTATION: summarise it ("a booking button") and the two things the owner
  // opened the preview to read back - the words on the button and the line under
  // it - are the two things the preview does not show.
  it("prints both authored lines verbatim", () => {
    expect(outcome).toContain(esc(BOOKING.headline));
    expect(outcome).toContain(esc(BOOKING.blurb));
  });

  // MUTATION: print plausible times ("9:00 9:30 10:00") and the preview invents
  // appointments out of a diary it has not read, on the screen an owner is using
  // to decide what to publish.
  it("stands in for the calendar without inventing a single time", () => {
    expect(outcome).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    // The plate row, drawn the same way the contact form's inputs are.
    expect(outcome).toContain("h-2.5 flex-1 rounded-sm border border-line bg-card-muted");
  });

  // MUTATION: draw it as a <button> and the strip stops being a picture: ten
  // minis on one canvas become ten tab stops that open ten real calendars.
  it("stays a picture: nothing here is a control", () => {
    expect(outcome).not.toContain("<button");
    expect(outcome).not.toContain("<a ");
    // It IS the primary button on the real screen, so it wears the primary
    // button's own fill rather than a block's flat card.
    expect(outcome).toContain("bg-blue-royal");
  });

  it("draws nothing at all on a result screen with no booking block", () => {
    // Vacuity guard, and the promise every funnel drawn before C1 relies on.
    const plain = render(screenOf(funnel(), "hot"));
    expect(plain).not.toContain(esc(BOOKING.headline));
    expect(plain).not.toContain("border-t border-line pt-1.5");
  });
});

describe("an answer with a picture is drawn with it", () => {
  const bank = questionById("timeline")!;
  const KEYS = ["conditions/crowded", "conditions/gaps", "conditions/overbite", "conditions/underbite"];

  function pictured(bare: number): FlowGraph {
    const g = funnel();
    g.nodes[2] = {
      id: "q2",
      kind: "question",
      questionId: "timeline",
      transition: "Good to know.",
      optionImages: bank.options
        .slice(0, bank.options.length - bare)
        .map((o, i) => ({ value: o.value, image: KEYS[i % KEYS.length]! })),
    };
    return g;
  }

  const html = render(screenOf(pictured(0), "q2"));

  // MUTATION: keep the icon chip and the pictures an owner chose never appear -
  // which is the whole feature.
  it("puts the shipped tile where the icon chip was", () => {
    expect(html).toContain('src="/assess/conditions/crowded.webp"');
    expect(html).toContain('width="360"');
    expect(html).toContain('height="270"');
  });

  // MUTATION: alt="" and the small-screen LIST rendering - which is not role="img"
  // - announces nothing at all for the answer's picture.
  it("gives every tile the manifest's own alt text", () => {
    expect(html).toContain('alt="Crowded teeth 3D model"');
    // Scoped to the answers: the lockup's logo IS decorative and carries alt=""
    // on purpose, so a whole-document scan would be reading that instead.
    const grid = html.slice(html.indexOf('class="grid'));
    expect(grid).not.toContain('alt=""');
    expect((grid.match(/<img /g) ?? []).length).toBe(bank.options.length);
  });

  // MUTATION: drop the icon fallback and the one answer rule 14 lets an owner
  // leave bare is a hole in the row.
  it("keeps the icon on an answer with no picture", () => {
    const mixed = render(screenOf(pictured(1), "q2"));
    const last = bank.options[bank.options.length - 1]!;
    const at = mixed.indexOf(esc(last.label));
    expect(at).toBeGreaterThan(-1);
    const row = mixed.slice(mixed.lastIndexOf("<div class=\"flex items-center gap-1.5", at), at);
    expect(row).toContain("<svg");
    expect(row).not.toContain("<img");
  });

  // MUTATION: mount an <img> per answer at its intrinsic 360px and a strip of ten
  // minis lays out ten full-size tiles it then scales to 20 pixels.
  it("draws the tile at the chip's size, with the box reserved", () => {
    expect(html).toContain("h-5 w-5 shrink-0 overflow-hidden rounded-md bg-card-muted");
    expect(html).toContain('loading="lazy"');
  });

  it("ships no scoring weight, pictures or not", () => {
    expect(html).not.toMatch(/weight/i);
  });
});

/* ---------------------------------------------------------------------------
 * 6. No colour literals, and the ban grows with the directory.
 * ------------------------------------------------------------------------- */

describe("the funnel's own components name their colours", () => {
  /**
   * WHY A RULE AND NOT A FILE LIST. A ban on named files is a ban on the files
   * somebody already found (dashboard-tokens.test.ts:22-25). Every component that
   * draws a funnel is named flow-*.tsx, so the next one is covered before it is
   * written. The panel beside them is banned separately, twice over
   * (create-experience-shell.test.ts, campaign-theme.test.ts).
   */
  const COMPONENTS = readdirSync(HERE)
    .filter((name) => name.startsWith("flow-") && name.endsWith(".tsx"))
    .sort();

  it("scans the files it thinks it is scanning - otherwise this is vacuous", () => {
    for (const required of [
      "flow-builder.tsx",
      "flow-canvas.tsx",
      "flow-phone-canvas.tsx",
      "flow-phone-mini.tsx",
    ]) {
      expect(COMPONENTS, `${required} is no longer being scanned`).toContain(required);
    }
  });

  it.each(COMPONENTS)("%s names no colour by hex", (name) => {
    const code = codeOnly(readFileSync(join(HERE, name), "utf8"));
    const found = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(
      found,
      `${name} hardcodes ${found.join(", ")}; name the colour in globals.css and use var(--name)`,
    ).toEqual([]);
  });
});
