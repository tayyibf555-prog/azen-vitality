// ===========================================================================
// A SWITCHED-ON SYSTEM WITH NO SCHEDULED JOB SAYS SO ON THE SCREEN THAT
// SWITCHED IT ON (ruling W3/7).
//
// THE DEFECT this pins: "Needs first" — the only line on any screen that
// mentions a cron registration — was rendered only while a system was OFF. Five
// sweeps have no cron job at all, so for them that prerequisite is the whole
// story, and it disappeared at exactly the moment it became unfulfilled.
//
// The path the platform itself walks the owner down: the shared first step says
// "read the two question lists, then switch the system on. Nothing is sent to a
// patient until you do." He does. From that second the control panel says
// "Running.", the module page's banner vanishes, and Home's tile prints
// "0 sent, awaiting an answer" — a bare, complete-looking nought for a sweep
// with no caller. Nothing anywhere mentions a cron again.
//
// TWO HALVES, and the second is the one that keeps this true:
//
//   1. THE ROW SAYS IT. Rendered, not grepped: SystemsView fetches its rows in
//      an effect, so a test that rendered the view would get the loading state
//      and nothing else — which is how the line could be missing from every
//      switched-on row with no assertion going red. SystemRowLine is exported
//      for exactly that reason.
//
//   2. THE LIST IS THE SCHEDULER'S. SWEEPS_WITH_NO_CRON_JOB is held equal to
//      `slugsWithNoScheduledJob()` from src/lib/agent-wiring/scheduler.ts — the
//      module that holds the 4 September read of `cron.job` and that
//      runbook.test.ts pins §2 of docs/runbooks/agent-switch-on.md against, row
//      for row. Registering a job later is a two-line edit to that module that
//      cannot be done by halves, and a new sweep that ships without one goes red
//      here rather than telling a practice it is running.
//
//      IT USED TO RE-DERIVE THE LIST BY PARSING §2 of the markdown, back when the
//      read lived in a test file the application could not import. That worked
//      and was a patch: the same fact was written out in three places (a test
//      constant, a markdown table, and the client component below) and kept
//      honest by string matching. Ruling W3/31 moved the fact into one module;
//      this file now compares the screen to it directly, and the markdown is
//      somebody else's assertion rather than this test's input.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AGENTS } from "@/lib/agent-wiring/roster";
import { slugsWithNoScheduledJob } from "@/lib/agent-wiring/scheduler";
import { SYSTEMS } from "@/lib/systems/catalog";
import { SYSTEM_VOCABULARY } from "@/lib/systems/vocabulary";
import {
  SWEEPS_WITH_NO_CRON_JOB,
  SystemRowLine,
  registrationWarning,
  systemHeadlineCounts,
  type SystemRow,
} from "./systems-view";

/**
 * The sentence the pre-visit row really carries, taken from the roster rather
 * than invented here (wave-3b handoff B130). It was a short paraphrase — "a cron
 * registration for /api/previsit/sweep" — which stayed green because the fixture
 * supplies its own `needsFirst`, and quietly showed the reader of this file a
 * sentence the product had stopped printing: the roster now names the
 * consequence as well as the task, because "a cron registration" reads like one
 * more setup item rather than the reason nothing will ever be sent.
 */
const PREVISIT_NEEDS_FIRST: readonly string[] = SYSTEM_VOCABULARY["pre-visit-triage"].needsFirst;

function row(over: Partial<SystemRow> = {}): SystemRow {
  return {
    slug: "pre-visit-triage",
    label: "Pre-visit questions",
    group: "Patient lifecycle",
    halts: "The sweep, the queue and the public form all stop.",
    starts: "Patients with an appointment coming up are sent a link.",
    needsFirst: [...PREVISIT_NEEDS_FIRST],
    // Overridden where a test is about the first step; null here so these rows
    // stay about the cron sentence and nothing else.
    firstStep: null,
    enabled: true,
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

function line(over: Partial<SystemRow> = {}): string {
  return renderToStaticMarkup(
    createElement(SystemRowLine, { row: row(over), busy: false, onToggle: () => {} }),
  );
}

describe("the panel's unregistered list is the scheduler's, not a guess", () => {
  it("names exactly the switchable systems whose sweep has no cron job", () => {
    const derived = slugsWithNoScheduledJob();
    expect(derived.length, "the scheduler reports no unregistered sweeps; this pin has gone stale")
      .toBeGreaterThan(0);
    expect([...SWEEPS_WITH_NO_CRON_JOB].sort(), "the panel's list drifted from the scheduler").toEqual(
      [...derived].sort(),
    );
  });

  it("every slug on it belongs to an agent whose trigger really is that route", () => {
    // Non-vacuity for the derivation itself, which lives in another module: it
    // maps an unregistered ROUTE onto an agent's `trigger` FILE, so a roster
    // rename would empty it silently and this screen would go quiet about a
    // system that still cannot run. Proved here rather than assumed, because
    // this is the screen the emptying would damage.
    const triggers = new Set(AGENTS.filter((a) => a.slug).map((a) => a.trigger));
    for (const slug of slugsWithNoScheduledJob()) {
      const agent = AGENTS.find((a) => a.slug === slug);
      expect(agent, `${slug} is on the unregistered list with no agent behind it`).toBeTruthy();
      expect(triggers.has(agent!.trigger)).toBe(true);
    }
  });

  it("every slug on it is a system the owner can actually switch on", () => {
    const slugs = new Set(SYSTEMS.map((s) => s.slug));
    for (const slug of SWEEPS_WITH_NO_CRON_JOB) {
      expect(slugs.has(slug), `${slug} is not a controllable system`).toBe(true);
      expect(SYSTEM_VOCABULARY[slug], `${slug} has no switch-on vocabulary`).toBeTruthy();
    }
  });
});

describe("the row answers the question its own state raises", () => {
  it("a switched-ON sweep with no job says it has not started", () => {
    // The pre-visit row, whose tail is its own (see the per-slug block below):
    // it names the job the list can actually vouch for and what the switch DOES
    // still do.
    const html = line({ enabled: true });
    expect(html).toContain("Switched on, but it has not started");
    expect(html).toContain("the scheduled job that sends this questionnaire has never been registered");
  });

  it("a switched-ON sweep whose ONLY job is unregistered is on in name only", () => {
    const html = line({ slug: "postop-checkin", label: "Post-op check-in", enabled: true });
    expect(html).toContain("its scheduled job has never been registered");
    expect(html).toContain("this system is on in name only");
  });

  it("the warning sits with 'Running.', which is the sentence it corrects", () => {
    const html = line({ enabled: true });
    expect(html).toContain("Running.");
    expect(html.indexOf("Switched on, but it has not started")).toBeGreaterThan(html.indexOf("Running."));
  });

  it("an OFF row is left to 'Needs first', which already carries the job name", () => {
    const html = line({ enabled: false });
    expect(html).toContain("Needs first:");
    expect(html).toContain(PREVISIT_NEEDS_FIRST[0]);
    expect(html).not.toContain("Switched on, but it has not started");
  });

  it("a running system that DOES have a job says nothing of the kind", () => {
    // THE OTHER DIRECTION, and it is the one that matters most: recall has been
    // firing every ten minutes for months, and a panel that warned about every
    // running row would be a panel nobody reads. Two of the roster's own cron
    // sentences say "NOT applied" for jobs that have been running for months,
    // which is why this list is derived from the scheduler and not from prose.
    const html = line({ slug: "recall", label: "Recall", enabled: true, needsFirst: [] });
    expect(html).toContain("Running.");
    expect(html).not.toContain("has not started");
  });

  it("says nothing on a running row whose prerequisites are only tuning", () => {
    const html = line({
      slug: "recall",
      label: "Recall",
      enabled: true,
      needsFirst: ["RECALL_DAILY_CONTACT_LIMIT (default 25)"],
    });
    expect(html).not.toContain("Needs first:");
    expect(html).not.toContain("has not started");
  });
});

describe("the sentence itself", () => {
  it("is null for every state that must not carry it", () => {
    expect(registrationWarning({ enabled: false, slug: "pre-visit-triage" })).toBeNull();
    expect(registrationWarning({ enabled: true, slug: "recall" })).toBeNull();
  });

  it("is present for a switched-on sweep with no job", () => {
    for (const slug of SWEEPS_WITH_NO_CRON_JOB) {
      const sentence = registrationWarning({ enabled: true, slug });
      // What every one of them owes the owner, whatever else it says: the tell
      // §4 of the runbook quotes, the reason, and who can repair it.
      expect(sentence, slug).toContain("Switched on, but it has not started");
      expect(sentence, slug).toContain("never been registered");
      expect(sentence, slug).toContain("Ask the agency to register");
    }
  });

  // =========================================================================
  // AND THE TAIL IS PER SLUG, BECAUSE ONE TAIL WAS FALSE FOR ONE OF THEM.
  //
  // The shared sentence ended "nothing runs … this system is on in name only".
  // For `pre-visit-triage` that is not true and is expensive: the owner-only
  // "Build / refresh candidates" button on the pre-visit page is disabled while
  // this system is OFF, and POST /api/previsit/mining-run refuses under the same
  // switch (rulings W3/8, W3/21, W3/27) — so switching this system on is the
  // only way to run the implant scan by hand, which is the thing the owner asked
  // for by name. An owner told the switch does nothing switches it back off,
  // into the one state where that button cannot be pressed. The runbook's
  // pre-visit section already says the opposite ("It can be built by hand in the
  // meantime"); W3/9 says the copy moves, not the code.
  //
  // The old loop asserted a shared substring across all four slugs, which is why
  // a sentence that was wrong for one of them was pinned green.
  // =========================================================================
  it("never tells the pre-visit owner his switch is doing nothing", () => {
    const sentence = registrationWarning({ enabled: true, slug: "pre-visit-triage" })!;
    expect(sentence).not.toContain("on in name only");
    expect(sentence).not.toContain("nothing runs");
  });

  it("names the one thing switching pre-visit questions on DOES start", () => {
    const sentence = registrationWarning({ enabled: true, slug: "pre-visit-triage" })!;
    expect(sentence).toContain("Build / refresh candidates");
    // ...and says it is not a send, since this is the send switch.
    expect(sentence).toContain("messages nobody");
  });

  it("still says plainly that no patient is asked anything", () => {
    // The half of the old sentence that was right. Losing it while correcting
    // the other half would be the worse defect of the two.
    const sentence = registrationWarning({ enabled: true, slug: "pre-visit-triage" })!;
    expect(sentence).toContain("no patient is asked anything");
  });

  it("claims only the job the slug list can vouch for, and asks about the other", () => {
    // `SWEEPS_WITH_NO_CRON_JOB` holds SLUGS. `pre-visit-triage` is on it through
    // the agent whose trigger is /api/previsit/sweep, so the questionnaire job is
    // the one this screen KNOWS is missing; the implant scan is a second,
    // separately registrable job whose state this list cannot report. A sentence
    // that counted them would be falsified by half a registration, silently.
    const sentence = registrationWarning({ enabled: true, slug: "pre-visit-triage" })!;
    expect(sentence).not.toContain("two scheduled jobs");
    expect(sentence).toContain("check the implant scan's own job");
  });

  it("leaves the three single-job sweeps saying exactly what they said", () => {
    for (const slug of ["treatment-closer", "balance-reminders", "postop-checkin"]) {
      const sentence = registrationWarning({ enabled: true, slug });
      expect(sentence, slug).toContain("so nothing runs and nothing is sent");
      expect(sentence, slug).toContain("this system is on in name only");
    }
  });
});

// ===========================================================================
// THE HEADLINE AGREES WITH HOME (ruling W3/31; charter §0/5, honest numbers).
//
// NAMED, CITED ENTRY — this describes a rule the screen did not previously
// hold, and nothing here loosens an existing assertion.
//
// THE DEFECT: the "Systems running" card counted every enabled row, while
// Home's Automations tile (src/lib/home/os-band.ts) subtracts the switches whose
// sweep the scheduler has never heard of. With `pre-visit-triage` switched on,
// Home said "2 of 30 running, 1 not started" and this panel said "3 of 30" — two
// owner-facing figures for the same practice at the same moment, both labelled
// running, differing by the exact system he had just toggled. The panel was also
// contradicting the row underneath it, which already said "Switched on, but it
// has not started" for that very slug.
//
// The counts are asserted through `systemHeadlineCounts` rather than through a
// render, for the reason given at the top of this file: SystemsView fetches its
// rows in an effect, so a rendered view yields the loading state and nothing
// else.
// ===========================================================================
describe("the figures above the panel", () => {
  const stalledSlug = "postop-checkin";

  it("excludes a switched-on sweep with no scheduled job from 'running'", () => {
    expect(SWEEPS_WITH_NO_CRON_JOB).toContain(stalledSlug);
    const counts = systemHeadlineCounts([
      { slug: "recall", enabled: true },
      { slug: "reactivation", enabled: true },
      { slug: stalledSlug, enabled: true },
      { slug: "equipment", enabled: false },
    ]);
    expect(counts.total).toBe(4);
    expect(counts.running).toBe(2);
    expect(counts.stalled).toBe(1);
    expect(counts.off).toBe(1);
  });

  it("counts a stalled system as neither running nor switched off", () => {
    // The owner switched it ON. Folding it into "Switched off" would read as the
    // switch not having taken, which is the opposite of what happened.
    const counts = systemHeadlineCounts([{ slug: stalledSlug, enabled: true }]);
    expect(counts.running).toBe(0);
    expect(counts.stalled).toBe(1);
    expect(counts.off).toBe(0);
    expect(counts.running + counts.stalled + counts.off).toBe(counts.total);
  });

  it("subtracts nothing from a system whose job really is registered", () => {
    // THE OTHER DIRECTION. A headline that quietly discounted working systems
    // would be the same defect pointing the other way.
    const counts = systemHeadlineCounts([
      { slug: "recall", enabled: true },
      { slug: "reactivation", enabled: true },
    ]);
    expect(counts.running).toBe(2);
    expect(counts.stalled).toBe(0);
  });

  it("subtracts nothing from an unregistered sweep that is switched OFF", () => {
    const counts = systemHeadlineCounts([{ slug: stalledSlug, enabled: false }]);
    expect(counts.running).toBe(0);
    expect(counts.stalled).toBe(0);
    expect(counts.off).toBe(1);
  });

  it("discounts exactly the scheduler's set, not a list of its own", () => {
    // The whole point of the fix: Home reads `slugsWithNoScheduledJob()` and this
    // screen reads `SWEEPS_WITH_NO_CRON_JOB`, which the first describe block
    // holds equal to it. Proved here against the scheduler directly so the
    // agreement survives someone editing only one of the two.
    for (const slug of slugsWithNoScheduledJob()) {
      expect(systemHeadlineCounts([{ slug, enabled: true }]).running, slug).toBe(0);
    }
  });
});
