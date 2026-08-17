// C1 ON THE PUBLIC PAGE: the booking calendar as the funnel's fourth screen.
//
// THE ONE THAT MATTERS IS THE PREVIEW GATE. campaigns-panel.tsx embeds the live
// public page in an iframe so an owner can click their own funnel through
// (?preview=1, sandbox allow-scripts allow-same-origin allow-forms). The quiz has
// always refused to SUBMIT there. A mounted <BookingCalendar> would not care about
// that refusal: POST /api/booking/hold takes a real slot out of the practice's
// diary and POST /api/booking/create registers a patient in Dentally and books it.
// Neither route can tell it came from a preview, and neither should have to.
//
// So the gate is enforced in three places and each is checked here: the pure
// decision (booking-embed.ts, exhaustively tested in its own sibling), the branch
// that mounts the component, and the TYPE the mounting component takes - which is
// the half that cannot be forgotten, because a "preview" result carries no site
// and <BookingCalendar> cannot be built without one.
//
// TECHNIQUE. vitest collects src/**\/*.test.ts in a node env, so a .tsx is
// verified the house way (deterministic-preview-gate.test.ts:20-24): its source is
// read as text for the structural gates, and renderToStaticMarkup proves what the
// browser actually receives. A static render only ever reaches phase "question",
// which is itself the proof for the laziness assertions below.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";
import { BookingCalendar } from "@/components/book/booking-calendar";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { toPublicFlow, type PublicFlow } from "@/lib/smile-assessment/campaign";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { addBlock, starterBlock } from "@/lib/smile-assessment/flow-edit";
import { type FlowGraph } from "@/lib/smile-assessment/flow";
import { paletteVars, PALETTE_TOKENS } from "@/lib/assess/palette";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUIZ_SOURCE = readFileSync(join(HERE, "deterministic-assessment-quiz.tsx"), "utf8");
const PAGE_SOURCE = readFileSync(
  join(HERE, "..", "..", "app", "assess", "[client]", "[slug]", "page.tsx"),
  "utf8",
);

const SITE = { id: "site-ng", name: "Vitality Dental N15" };

/** A real published funnel whose result screens carry the booking invitation. */
function bookableGraph(): FlowGraph {
  let graph = templateForGoal("invisalign").build();
  const starter = starterBlock("booking");
  if (!starter) throw new Error("there is no starter booking block any more");
  for (const node of graph.nodes) {
    if (node.kind !== "outcome") continue;
    const next = addBlock(graph, node.id, starter);
    if (!next.ok) throw new Error(`a result screen refused the booking block: ${next.reason}`);
    graph = next.graph;
  }
  return graph;
}

function published(graph: FlowGraph): PublicFlow {
  const flow = toPublicFlow(graph);
  if (!flow) throw new Error("this graph does not publish");
  return flow;
}

function renderQuiz(previewMode: boolean): string {
  return renderToStaticMarkup(
    createElement(DeterministicAssessmentQuiz, {
      clientSlug: "vitality",
      campaignSlug: "invisalign",
      practiceName: "Vitality Dental",
      flow: published(bookableGraph()),
      bookingSite: SITE,
      previewMode,
    }),
  );
}

/** The source between a marker and a later one. Whatever guards it lives in here. */
function between(from: string, to: string): string {
  const start = QUIZ_SOURCE.indexOf(from);
  expect(start, `${from} is no longer in the source`).toBeGreaterThan(-1);
  const end = QUIZ_SOURCE.indexOf(to, start);
  expect(end, `${to} is not reached from ${from}`).toBeGreaterThan(start);
  return QUIZ_SOURCE.slice(start, end);
}

/* ---------------------------------------------------------------------------
 * 1. PREVIEW MODE CANNOT MOUNT A CALENDAR.
 * ------------------------------------------------------------------------- */

describe("preview mode never mounts the booking calendar", () => {
  // MUTATION: stop passing previewMode here and the gate is computed from the
  // three inputs that have nothing to do with previewing, so an owner clicking
  // through their own funnel gets a live calendar over the practice's real diary.
  it("hands previewMode to the gate, in the only call there is", () => {
    expect(QUIZ_SOURCE).toMatch(
      /const booking: BookingEmbed = bookingEmbed\(\{[\s\S]*?previewMode,[\s\S]*?\}\);/,
    );
    expect(QUIZ_SOURCE.match(/bookingEmbed\(/g)).toHaveLength(1);
  });

  // MUTATION: drop the status check from the branch and phase "booking" mounts a
  // live calendar whatever the gate said - including in preview.
  it("mounts the calendar only from a branch that has checked the gate", () => {
    expect(QUIZ_SOURCE).toMatch(/\{phase === "booking" && booking\.status === "ready" \? \(/);
    // Exactly one mount site, so gating that branch gates every mount there is.
    // (`<BookingCalendar>` in prose does not match: the element opens on a space.)
    expect(QUIZ_SOURCE.match(/<BookingCalendar[\s\n]/g)).toHaveLength(1);
    // And the mount sits inside <BookingStep>, whose prop type is the READY shape.
    expect(QUIZ_SOURCE).toMatch(/booking: BookingEmbedTarget;/);
    const step = between("function BookingStep(", "</div>\n  );");
    expect(step).toContain("<BookingCalendar");
    expect(step).toContain("siteId={booking.siteId}");
  });

  // MUTATION: drop this and a stray setPhase("booking") anywhere in the file
  // becomes a live calendar. It is the second lock on the same door.
  it("refuses inside openBooking before anything changes phase", () => {
    const guard = between("function openBooking(", 'setPhase("booking")');
    expect(guard).toMatch(/if \(booking\.status !== "ready"\) return;/);
    // openBooking is the only writer of that phase.
    expect(QUIZ_SOURCE.match(/setPhase\("booking"\)/g)).toHaveLength(1);
  });

  // MUTATION: render the live button in preview and a click books a real
  // appointment for a real patient's time out of a screen nobody was booking from.
  it("draws the offer as a disabled control while previewing, and says why", () => {
    expect(QUIZ_SOURCE).toMatch(/booking\.status === "preview" \? \(/);
    const inert = between('booking.status === "preview" ? (', "Preview mode. Booking is disabled here.");
    expect(inert).toContain("disabled");
    expect(inert).not.toContain("onClick");
  });

  it("does not mount a calendar in either mode before the patient asks for one", () => {
    // A static render reaches phase "question", which is exactly the point: the
    // calendar fetches live Dentally availability in a mount effect, so mounting
    // it on the thank-you screen would put a diary read behind EVERY completed
    // assessment. Both renders must be free of it.
    for (const previewMode of [true, false]) {
      const html = renderQuiz(previewMode);
      expect(html, `preview=${previewMode}`).not.toContain("Next available");
      expect(html, `preview=${previewMode}`).not.toContain("rounded-[1.4rem]");
    }
  });

  it("shows the owner the same funnel a patient gets, up to the gate", () => {
    // Vacuity guard for the pair above, and the promise a preview makes.
    expect(renderQuiz(true)).toBe(renderQuiz(false));
    expect(renderQuiz(true)).toContain("Question 1");
  });
});

/* ---------------------------------------------------------------------------
 * 2. THE SITE IS THE CAMPAIGN'S, EXPLICITLY.
 * ------------------------------------------------------------------------- */

describe("the diary a funnel books into", () => {
  // MUTATION: resolve the site in the browser (or let the calendar fall back the
  // way /book does) and a multi-site practice books a lead from one branch's
  // campaign into another branch's diary.
  it("is resolved on the server from the campaign, and passed down", () => {
    expect(PAGE_SOURCE).toContain("const campaignSite = getSite(campaign.siteId);");
    expect(PAGE_SOURCE).toMatch(
      /bookingSite=\{campaignSite \? \{ id: campaignSite\.id, name: campaignSite\.name \} : null\}/,
    );
    expect(QUIZ_SOURCE).toMatch(/site: bookingSite \?\? null,/);
    // Never the practice's first site, the way the /book page is allowed to.
    expect(QUIZ_SOURCE).not.toContain("sites[0]");
    expect(QUIZ_SOURCE).not.toContain("getSites");
  });

  // MUTATION: add a second isSystemEnabled call to the page and
  // assess-page-kill-switch.test.ts goes red; read the booking switch in the
  // browser instead and it stops being a switch at all.
  it("leaves the page with exactly one kill-switch read, and none in the browser", () => {
    expect(PAGE_SOURCE.match(/isSystemEnabled\(/g)).toHaveLength(1);
    expect(QUIZ_SOURCE).not.toContain("isSystemEnabled");
    expect(QUIZ_SOURCE).not.toContain("online-booking");
    // The switch arrives as the presence of bookingUrl, minted by submit/route.ts.
    expect(QUIZ_SOURCE).toMatch(/bookingUrl: result\?\.bookingUrl,/);
  });

  it("adds no public endpoint of its own", () => {
    // C1 reuses the booking module wholesale, so the only paths this funnel calls
    // are the ones it already called plus the ones /book already called. A new
    // one would need a row in client-api-module-guard-coverage.test.ts's EXEMPT.
    const paths = new Set([...QUIZ_SOURCE.matchAll(/["`](\/api\/[a-z0-9/-]+)/g)].map((m) => m[1]));
    expect([...paths].sort()).toEqual([
      "/api/smile-assessment/next",
      "/api/smile-assessment/submit",
      "/api/smile-assessment/token",
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * 3. NOTHING MOVES FOR A FUNNEL THAT HAS NO BOOKING BLOCK.
 * ------------------------------------------------------------------------- */

describe("a funnel without a booking invitation is untouched", () => {
  it("keeps the plain link it has always had", () => {
    // The "off" arm of the same ternary: the <a href> to /book, unchanged.
    expect(QUIZ_SOURCE).toMatch(/<a href=\{result\.bookingUrl\}>Book your appointment now<\/a>/);
  });

  it("renders the same first screen with and without the block", () => {
    const withBlock = renderQuiz(false);
    const without = renderToStaticMarkup(
      createElement(DeterministicAssessmentQuiz, {
        clientSlug: "vitality",
        campaignSlug: "invisalign",
        practiceName: "Vitality Dental",
        flow: published(templateForGoal("invisalign").build()),
        bookingSite: SITE,
        previewMode: false,
      }),
    );
    // The block is on the RESULT screen, so the screen an ad lands on must be
    // byte-identical - the funnel that pays for the click cannot move for a
    // feature that only shows up at the end of it.
    expect(withBlock).toBe(without);
  });

  it("publishes a bookable funnel that still validates", () => {
    // Vacuity guard for everything above: if the fixture stopped carrying the
    // block, the preview assertions would be about a funnel with no booking.
    const graph = bookableGraph();
    expect(validateFlow(graph).ok).toBe(true);
    expect(JSON.stringify(graph)).toContain('"kind":"booking"');
  });
});

/* ---------------------------------------------------------------------------
 * 4. THEMING: the embedded calendar wears the campaign's colour scheme.
 * ------------------------------------------------------------------------- */

describe("the embedded calendar re-themes with the funnel around it", () => {
  const BOLD = "deep-plum";

  /** The calendar as the funnel mounts it, under a bold preset's token wrapper. */
  const themed = renderToStaticMarkup(
    createElement(
      "div",
      { style: paletteVars(BOLD) },
      createElement(BookingCalendar, {
        clientSlug: "vitality",
        siteId: SITE.id,
        siteName: SITE.name,
      }),
    ),
  );

  it("sits under a wrapper that re-declares the whole closed token set", () => {
    // globals.css maps the raw tokens into Tailwind with @theme inline, so
    // re-declaring them on ANY ancestor re-paints every utility beneath it
    // (palette.ts). That is the entire theming mechanism, and the assess page
    // already puts this wrapper above the quiz - the calendar inherits it for
    // free BECAUSE it is mounted inside the funnel rather than navigated to.
    for (const token of PALETTE_TOKENS) {
      expect(themed, `the wrapper does not set --${token}`).toContain(`--${token}:`);
    }
  });

  /** Everything inside the wrapper: the calendar's own markup, minus the palette. */
  const markup = themed.slice(themed.indexOf(">") + 1);
  const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));

  it("paints its card out of themed tokens, not out of its own colours", () => {
    // MUTATION: give the calendar's card a literal background or border and the
    // one screen at the end of a re-coloured funnel stays Vitality blue while
    // everything above it turns plum.
    expect(markup).toContain(
      'class="overflow-hidden rounded-[1.4rem] border border-line bg-card shadow-[0_8px_40px_rgba(10,14,26,0.08)]"',
    );
    // The colour names it actually uses, pinned: every one is in the CLOSED
    // palette token set, so the wrapper above repaints all of them.
    const painted = new Set<string>();
    for (const cls of classes) {
      const m = /^(?:bg|text|border|ring|ring-offset|from|via|to)-(.+)$/.exec(cls);
      if (!m) continue;
      const token = m[1]!.replace(/\/.*$/, "");
      if ((PALETTE_TOKENS as readonly string[]).includes(token)) painted.add(token);
    }
    expect([...painted].sort()).toEqual(["card", "card-muted", "line"]);
  });

  it("names no colour by hex or by an arbitrary value anywhere it renders", () => {
    // MUTATION: reach for bg-[#f4e9f6] on a skeleton tile and that tile is the one
    // thing on the screen that does not follow the scheme. The card's SHADOW is
    // the one arbitrary value allowed through: it is a shade of the page's own
    // depth, not a brand colour, and it is the shadow the quiz card above it wears.
    const found = [...markup.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(found, `the embedded calendar hardcodes ${found.join(", ")}; use a token`).toEqual([]);
    const arbitrary = classes.filter(
      (c) => /-\[(?:#|rgb|hsl)/i.test(c) && !c.startsWith("shadow-"),
    );
    expect(arbitrary, `arbitrary colour values: ${arbitrary.join(", ")}`).toEqual([]);
  });
});
