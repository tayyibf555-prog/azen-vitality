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
//   2. THE LIST IS THE SCHEDULER'S. The slugs in SWEEPS_WITH_NO_CRON_JOB are
//      derived here from §2 of docs/runbooks/agent-switch-on.md — the table
//      src/lib/agent-wiring/runbook.test.ts pins row-for-row against a read of
//      `cron.job` on production — by mapping each unregistered ROUTE through the
//      agent roster's `trigger`. Registering a job later is a two-line edit that
//      cannot be done by halves, and a new sweep that ships without one goes red
//      here rather than telling a practice it is running.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AGENTS } from "@/lib/agent-wiring/roster";
import { SYSTEMS } from "@/lib/systems/catalog";
import { SYSTEM_VOCABULARY } from "@/lib/systems/vocabulary";
import { SWEEPS_WITH_NO_CRON_JOB, SystemRowLine, registrationWarning, type SystemRow } from "./systems-view";

const RUNBOOK = "docs/runbooks/agent-switch-on.md";

/** The routes §2 of the runbook says the scheduler does not hold. */
function unregisteredRoutes(): string[] {
  const md = readFileSync(join(process.cwd(), RUNBOOK), "utf8");
  const from = md.indexOf("## 2. Cron registration");
  const to = md.indexOf("## 3. The agents", from + 1);
  expect(from, "the runbook no longer has a cron registration section").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const routes: string[] = [];
  for (const line of md.slice(from, to).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !cells[1].startsWith("`app-")) continue;
    const route = cells[3].replace(/`/g, "");
    const status = cells[4].replace(/\*/g, "");
    if (status === "not registered") routes.push(route);
  }
  return routes;
}

function row(over: Partial<SystemRow> = {}): SystemRow {
  return {
    slug: "pre-visit-triage",
    label: "Pre-visit questions",
    group: "Patient lifecycle",
    halts: "The sweep, the queue and the public form all stop.",
    starts: "Patients with an appointment coming up are sent a link.",
    needsFirst: ["a cron registration for /api/previsit/sweep"],
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
    const bySlug = new Map(SYSTEMS.map((s) => [s.slug, s]));
    const derived = new Set<string>();
    for (const route of unregisteredRoutes()) {
      // The roster names a FILE ("src/app/api/closer/sweep/route.ts"); the
      // runbook's table names the ROUTE the scheduler calls. One is the other.
      const file = `src/app${route}/route.ts`;
      for (const agent of AGENTS) {
        if (agent.trigger === file && agent.slug && bySlug.has(agent.slug)) derived.add(agent.slug);
      }
    }
    expect(derived.size, "the runbook scan found no unregistered sweeps; it has gone stale").toBeGreaterThan(0);
    expect([...derived].sort(), "the panel's list drifted from the runbook's cron table").toEqual(
      [...SWEEPS_WITH_NO_CRON_JOB].sort(),
    );
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
    const html = line({ enabled: true });
    expect(html).toContain("Switched on, but it has not started");
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
    expect(html).toContain("a cron registration for /api/previsit/sweep");
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
      expect(registrationWarning({ enabled: true, slug }), slug).toContain("has not started");
    }
  });
});
