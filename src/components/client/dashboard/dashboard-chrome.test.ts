import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE DASHBOARD'S CHROME: its type, and what it says when it has nothing to say.
 *
 * This is the half of the premium pass that is not about width. Three properties,
 * and each of them was a real defect on the screen the owner rejected:
 *
 *   1. NOTHING ON THE DASHBOARD SHOUTS. Fifteen 10px uppercase micro-labels sat
 *      across six call sites - every one of them the same hand-copied class string
 *      `text-[10px] font-semibold uppercase tracking-[0.07em] text-muted` - while
 *      PRODUCT.md asks for sentence-case headings. Caps at 10px is a Dentally-era
 *      convention we did not have to inherit and the house .text-title token
 *      (13px/600, no transform) is what SectionCard's heading has always used.
 *
 *   2. THE HONESTY SURVIVES THE QUIETING. This is the trap in the whole change.
 *      "Make it calmer" and "say less" are one careless edit apart, and PRODUCT.md
 *      bans the second outright: removing chrome is not the same as removing
 *      information. So every caveat the view produces must still be reachable, in
 *      full, in the markup - collapsed behind one disclosure, never dropped - and
 *      there must still be exactly one freshness line saying when the figures are
 *      from. This file computes the expected caveats from the same builders the
 *      component calls and demands every sentence back out of the HTML.
 *
 *   3. AN EMPTY WORKLIST IS GOOD NEWS AND MUST LOOK LIKE IT. "Next actions" with
 *      nothing in it rendered a navy-filled chip reading "All 0" - the SELECTED
 *      state of a filter with no alternatives - over a 190px dashed box. Both
 *      read as a fault. The words were always fine ("All clear"); the furniture
 *      round them was not, so the words are unchanged here and pinned as such.
 *
 * TECHNIQUE. vitest runs environment:"node" and collects only src/-star-star/*.test.ts,
 * so this is renderToStaticMarkup for everything a first paint can show, plus the
 * source read as text for the two things it cannot: a state that only exists after
 * an effect has run, and a colour literal. The split is the one
 * create-experience-shell.test.ts uses, including its comment stripper - prose about
 * a colour is not a colour, and prose about "All 0" is not "All 0".
 *
 * Paths resolve from import.meta.url so this never walks .claude/worktrees, which
 * are full repo copies and would match duplicate files.
 */

// PracticeDashboard and TaskQueueBoard both call usePathname to decide which shell
// they are being read in (/c versus /owner). It is the only hook in either subtree
// that needs a Next runtime; everything else is useState and useMemo.
vi.mock("next/navigation", () => ({ usePathname: () => "/c/vitality" }));

import { PracticeDashboard } from "./practice-dashboard";
import { EmptyState } from "@/components/primitives";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import {
  accountsCaveats,
  appointmentsCaveats,
  invoicedCaveats,
  takingsCaveats,
  udaCaveats,
  type Caveat,
} from "./caveats";
import { buildDashboardView, type BuildViewInput } from "@/lib/dashboard/view";

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(DASHBOARD_DIR, "..", "..", "..");
const TASK_QUEUE_DIR = resolve(SRC, "components", "client", "task-queue");
const EMPTY_STATE = resolve(SRC, "components", "primitives", "empty-state.tsx");

const read = (path: string) => readFileSync(path, "utf8");

/** Source with comments removed: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The five characters React escapes on its way into static markup. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/* ---------------------------------------------------------------------------
 * A dashboard with something to say in every panel.
 *
 * Deliberately built to PRODUCE CAVEATS rather than to look tidy: no rollup rows
 * (so the longer periods are genuinely blank), an appointment state Dentally
 * never sends, undated invoices, unreadable payment and balance rows, and no
 * configured UDA target. A view with nothing to qualify would let the honesty
 * assertions below pass while saying nothing at all.
 * ------------------------------------------------------------------------- */

const NOW = new Date("2026-07-30T09:42:00Z");
const TODAY = "2026-07-30";

const SITES = [{ id: "site-cc", name: "N15 Vitality Dental" }];
const PRACTITIONERS = [{ id: "prac-1", name: "Dana Hale" }];

function input(): BuildViewInput {
  return {
    now: NOW,
    sites: SITES,
    practitioners: PRACTITIONERS,

    payments: [
      {
        id: "pay-1",
        amountPence: 42_350,
        day: TODAY,
        siteId: "site-cc",
        practitionerId: "prac-1",
        patientId: "pat-1",
        deleted: false,
      },
    ],
    paymentsCoverage: { from: TODAY, to: TODAY },
    // Rows the normaliser could not read at all -> a material takings caveat.
    droppedPayments: 2,
    // No rollups, so last 7 / 30 / 90 cannot be sourced -> the "periods blank" caveat.
    rollups: null,

    appointments: [
      {
        id: "appt-1",
        day: TODAY,
        siteId: "site-cc",
        practitionerId: "prac-1",
        patientId: "pat-1",
        state: "Completed",
      },
      // A state we do not recognise -> the appointments caveat.
      {
        id: "appt-2",
        day: TODAY,
        siteId: "site-cc",
        practitionerId: "prac-1",
        patientId: "pat-2",
        state: "Teleported",
      },
    ],
    appointmentsCoverage: { from: TODAY, to: TODAY },
    appointmentRows: [
      {
        id: "appt-1",
        startIso: "2026-07-30T09:00:00Z",
        durationMin: 30,
        patientId: "pat-1",
        patientName: "Aisha Rahman",
        siteId: "site-cc",
        practitionerId: "prac-1",
        practitionerName: "Dana Hale",
        reason: "Examination",
        note: "Asked to be seen before school run",
        // Still to come, so it survives the list's default "remaining" filter and
        // the row itself is actually rendered - patient link, reason, note and all.
        state: "Booked",
      },
    ],

    patients: [],
    plans: [],

    invoices: [],
    // Bills carrying no date -> the invoiced caveat.
    undatedInvoices: 2,

    balances: [],
    droppedBalances: 3,

    claims: [],
    // No udaTargets at all, so contract progress is unavailable -> the UDA caveat.
  };
}

const view = buildDashboardView(input());
/** The scope and period PracticeDashboard opens on: all sites, today. */
const scope = view.scopes[0];
const panels = scope.periods.today;

/** Exactly the list the component assembles, from exactly the same builders. */
const expectedCaveats: Caveat[] = [
  ...takingsCaveats({
    strip: scope.strip,
    unattributedPayments: scope.unattributedPayments,
    droppedPayments: view.droppedPayments,
  }),
  ...appointmentsCaveats(panels.appointments),
  ...accountsCaveats(scope.accounts),
  ...invoicedCaveats(panels.invoiced),
  ...udaCaveats(panels.uda, scope.udaProgress),
];

const html = renderToStaticMarkup(
  createElement(PracticeDashboard, {
    view,
    clientSlug: "vitality",
    initialSiteId: null,
  }),
);

/* ---------------------------------------------------------------------------
 * 0. Anti-vacuity. Every assertion below is "the markup does NOT contain X" or
 *    "contains X exactly once", and both pass beautifully against an empty
 *    string. So first: this really is the dashboard, and it really does have
 *    something to qualify.
 * ------------------------------------------------------------------------- */

describe("the fixture renders the real dashboard, with real caveats", () => {
  it("renders all four band panels, the strip and the list", () => {
    for (const landmark of [
      'aria-label="Takings"',
      'aria-label="Appointments"',
      'aria-label="Accounts"',
      'aria-label="Invoiced"',
      'aria-label="Patients, treatment plans and UDAs"',
      'aria-label="Appointments list"',
    ]) {
      expect(html, `the dashboard did not render ${landmark}`).toContain(landmark);
    }
  });

  it("renders an actual appointment row, so the shared primitives are in the tree too", () => {
    // The row pulls in PatientLink and StatusPill. Without one rendered, "no
    // uppercase anywhere in the tree" would only be a claim about this folder.
    expect(html, "the fixture row was filtered out; the list rendered empty").toContain(
      "Aisha Rahman",
    );
    expect(html, "no status pill rendered, so the primitive is untested here").toContain(
      "Examination",
    );
  });

  it("produces caveats worth guarding, several of them material", () => {
    expect(
      expectedCaveats.length,
      "the fixture qualifies nothing, so the honesty assertions below prove nothing",
    ).toBeGreaterThanOrEqual(4);
    expect(
      expectedCaveats.filter((c) => c.material).length,
      "no MATERIAL caveat in the fixture - the amber path is untested",
    ).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------------
 * 1. Type: nothing on this screen is set in capitals.
 * ------------------------------------------------------------------------- */

describe("the dashboard is set in sentence case", () => {
  it("renders no uppercase transform anywhere in the tree", () => {
    // The whole subtree, not a file list: a label re-introduced in any panel,
    // or arriving inside a shared primitive the dashboard renders, fails here.
    expect(
      html.includes("uppercase"),
      "something in the dashboard is set in capitals again; headings use .text-title, labels are sentence case",
    ).toBe(false);
  });

  it("gives every heading on the screen the same token", () => {
    // Three sibling <h2>/<h3>s used to wear three treatments within one scroll:
    // 12px sentence case, 10px caps, and 10px caps. One rank, one look - and it
    // is the token SectionCard's heading already uses, so it is the product's.
    for (const heading of [
      '<h2 class="text-title text-navy">Takings</h2>',
      '<h2 class="text-title text-navy">Appointments</h2>',
      '<h3 class="text-title text-navy">Invoiced</h3>',
      '<h3 class="text-title text-navy">Patients and plans</h3>',
    ]) {
      expect(html, `heading no longer rendered as ${heading}`).toContain(heading);
    }
  });

  it("keeps the old hand-copied label string out of the source for good", () => {
    // The class string itself, in every panel file. This is the thing that got
    // copied fifteen times, and a paste is how it comes back.
    const banned = "font-semibold uppercase tracking-[0.07em]";
    for (const name of readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith(".tsx"))) {
      expect(
        codeOnly(read(join(DASHBOARD_DIR, name))).includes(banned),
        `${name} carries the retired micro-label string again`,
      ).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. Honesty: one freshness line, one disclosure, and every sentence still there.
 * ------------------------------------------------------------------------- */

describe("the quieting did not cost the screen any of its honesty", () => {
  it("says when the figures are from, exactly once", () => {
    // Once. The screen used to carry this twice - a per-panel source note and a
    // footnote - and twice is how a reader learns to stop reading it.
    expect(occurrences(html, "Stats updated")).toBe(1);
    expect(html, "the freshness line lost its scope or its window").toContain(scope.label);
  });

  it("keeps every caveat reachable in full, sentence for sentence", () => {
    // THE HONESTY GUARD. Not "a caveat is shown" - EVERY caveat, with its whole
    // sentence, present in the markup. Collapsed behind a disclosure is fine;
    // that is a reader's choice. Dropped is not, and dropping one is exactly what
    // a "make it calmer" edit does when nobody is looking.
    for (const caveat of expectedCaveats) {
      expect(html, `caveat "${caveat.id}" lost its label`).toContain(esc(caveat.label));
      expect(html, `caveat "${caveat.id}" lost its sentence`).toContain(esc(caveat.text));
    }
  });

  it("collapses them behind ONE control, not a row of chips", () => {
    // The row under the band used to print every caveat as its own pill, three of
    // them amber, so the screen announced five problems before a figure had been
    // read. One line, one disclosure. The slice is the footnote region itself, so
    // the marks beside the figures above are not what satisfies this.
    const from = html.indexOf("Stats updated");
    const to = html.indexOf('aria-label="Appointments list"');
    expect(from, "no freshness line to locate the footnote by").toBeGreaterThan(-1);
    expect(to, "no appointment list to bound the footnote by").toBeGreaterThan(from);
    const footnote = html.slice(from, to);

    expect(
      occurrences(footnote, "<button"),
      "the caveat footnote has grown more than one control - it is a chip row again",
    ).toBe(1);
    expect(
      footnote.includes("bg-tint-amber"),
      "amber is back in the footnote; it is reserved for a warning, not for how a figure is sourced",
    ).toBe(false);
  });

  it("keeps the sentences in the DOM when collapsed, rather than unmounting them", () => {
    // hidden, not absent. Find-in-page still finds them, and a screen reader
    // opening the disclosure does not wait on a render.
    expect(html, "the caveat text is no longer a hidden region").toContain(
      'id="dashboard-caveat-text" hidden=""',
    );
  });
});

/* ---------------------------------------------------------------------------
 * 3. The empty worklist.
 * ------------------------------------------------------------------------- */

/** The chip row's opening guard, as it must appear in the board's source. */
const CHIP_GATE = /total === 0 \? null : \(/;

/** The parenthesised block starting at `openIndex`, by paren balance. */
function balancedFrom(code: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex, i + 1);
    }
  }
  throw new Error("the chip row's conditional never closes");
}

describe("an empty worklist reads as good news", () => {
  const board = codeOnly(read(join(TASK_QUEUE_DIR, "task-queue-board.tsx")));

  it("renders no filter chips at all before anything has loaded", () => {
    // First paint: no tasks, so nothing to filter. This is a real render, and it
    // is also the state a practice with a clear queue sits in all day.
    const queue = renderToStaticMarkup(
      createElement(TaskQueueBoard, {
        clientSlug: "vitality",
        maxRows: 8,
        title: "Next actions",
        plain: true,
      }),
    );
    expect(queue, "the board did not render its own header").toContain("Next actions");
    expect(
      queue.includes("All 0"),
      'the worklist prints a navy-filled "All 0" chip when it has nothing in it',
    ).toBe(false);
    expect(
      queue.includes("All <span"),
      "the All chip is rendered with an empty queue",
    ).toBe(false);
  });

  it("gates the WHOLE chip row on the count, not just the label", () => {
    // A render can only show the first paint; the empty state that matters is the
    // one after the fetch resolves, and no effect runs in a static render. So the
    // structure is read instead: the "All" chip and the per-kind chips must both
    // live inside the `total === 0` guard. Suppressing only the number would still
    // leave a selected-looking chip reading "All" over the words "All clear".
    const m = CHIP_GATE.exec(board);
    expect(
      m,
      'task-queue-board.tsx no longer suppresses the chip row when the queue is empty ("All 0" is back)',
    ).not.toBeNull();
    const gate = m as RegExpExecArray;
    const block = balancedFrom(board, gate.index + gate[0].length - 1);
    expect(block, "the All chip is outside the empty guard").toContain("All <span");
    expect(block, "the per-kind chips are outside the empty guard").toContain(
      "TASK_KIND_LABEL[kind]",
    );
  });

  it("asks for the compact empty state when it is embedded under the dashboard", () => {
    expect(
      board.includes("compact={embedded}"),
      "the embedded worklist no longer asks EmptyState for the compact box",
    ).toBe(true);
    expect(
      board.includes("const embedded = maxRows !== undefined"),
      "the board lost its notion of being embedded, so compact is decided by something else now",
    ).toBe(true);
  });

  it("shrinks the box and keeps every word of the copy", () => {
    // The copy is the part that was already right. This asserts it survives the
    // furniture change verbatim, in both sizes.
    const props = {
      title: "All clear",
      description: "Nothing needs your attention right now.",
    };
    const compact = renderToStaticMarkup(createElement(EmptyState, { ...props, compact: true }));
    const full = renderToStaticMarkup(createElement(EmptyState, props));

    for (const markup of [compact, full]) {
      expect(markup).toContain("All clear");
      expect(markup).toContain("Nothing needs your attention right now.");
      // Still legible as "nothing here" rather than as content that ran short.
      expect(markup).toContain("border-dashed");
    }
    expect(compact, "the compact empty state is still the full-height box").not.toContain("py-12");
    expect(full, "the page-level empty state shrank; only the embedded one should have").toContain(
      "py-12",
    );
  });

  it("keeps a colour on the compact heading, which tailwind-merge will happily eat", () => {
    // A REAL DEFECT CAUGHT WHILE WRITING THIS, and the reason the assertion is
    // here rather than in a comment. `cn("font-semibold text-navy", "text-title")`
    // returns "font-semibold text-title": tailwind-merge only knows Tailwind's own
    // utilities, .text-title is a house class in globals.css, so it is filed as a
    // text-COLOUR and beats the colour beside it. The heading then inherits navy
    // from the body and looks correct on this page and wrong on any surface that
    // sets its own ink. Both classes, or this fails.
    const markup = renderToStaticMarkup(
      createElement(EmptyState, { title: "All clear", compact: true }),
    );
    const heading = markup.slice(markup.indexOf("<h3"), markup.indexOf("</h3>"));
    expect(heading, "the compact heading lost .text-title").toContain("text-title");
    expect(
      heading,
      "the compact heading lost its colour - tailwind-merge ate text-navy; do not build this className with cn()",
    ).toContain("text-navy");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The "Next actions" block names its colours.
 *
 * A companion to dashboard-tokens.test.ts, which bans hex under
 * src/components/client/dashboard/. The worklist under the dashboard is part of
 * the same screen and was outside that scan: two `hover:bg-[#f7f9fc]` on the
 * board and one `bg-[#f0f4f9]` on the empty state it renders. All three are
 * tokens now (--row-hover, --tile), at their exact previous values.
 *
 * SCOPE IS DELIBERATELY NOT src/components/primitives. Four other primitives
 * still hardcode colours - status-pill.tsx, tabs.tsx, charts.tsx, data-table.tsx -
 * and widening the ban to catch them is a sweep of its own, not a line in this
 * change. empty-state.tsx is named because it is the one primitive the empty
 * worklist reaches into, and it was edited here.
 * ------------------------------------------------------------------------- */

describe("the worklist under the dashboard names its colours", () => {
  const FILES = [
    ...readdirSync(TASK_QUEUE_DIR)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => join(TASK_QUEUE_DIR, name)),
    EMPTY_STATE,
  ];

  it("scans the files it thinks it is scanning", () => {
    expect(FILES.length, "the task-queue directory is empty or moved").toBeGreaterThanOrEqual(2);
    expect(FILES.some((f) => f.endsWith("task-queue-board.tsx"))).toBe(true);
    expect(FILES.some((f) => f.endsWith("empty-state.tsx"))).toBe(true);
  });

  it.each(FILES)("%s names no colour by hex", (path) => {
    const found = [...codeOnly(read(path)).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(
      found,
      `hardcodes ${found.join(", ")}; give the colour a name in globals.css and use it`,
    ).toEqual([]);
  });

  it("keeps the two washes it was given in the token file", () => {
    const css = read(resolve(SRC, "app", "globals.css"));
    expect(css, "--tile is gone, so bg-tile paints nothing").toMatch(/--tile:\s*#f0f4f9;/);
    expect(css, "--row-hover is gone, so the row hover paints nothing").toMatch(
      /--row-hover:\s*#f7f9fc;/,
    );
  });
});
