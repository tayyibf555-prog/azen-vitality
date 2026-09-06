// ===========================================================================
// THE MISSING CRON SURVIVES THE ACT IT PROMPTED (rulings W3/7, W3/31).
//
// THE DEFECT this pins. The pre-visit page mentioned the unregistered job in
// exactly one place — the onboarding banner, drawn under `!systemEnabled` — and
// that banner is the only carrier of the shared first step's last clause:
// "nothing is sent after that either until this system's scheduled job is
// registered, which has not been done yet".
//
// So the platform walked the owner into silence. He reads the step, reviews the
// question banks, switches Pre-visit questions on in System controls, and comes
// back. The banner is gone with the state that drew it. Both tabs read 0. The
// interest list tells him yeses "land here as soon as patients start filling it
// in" — a promise nothing on this deployment can keep, because
// /api/previsit/sweep is the only thing that mints a link to a patient and the
// scheduler has never heard of it. The one screen he is looking at gives him no
// reason why, and the fact now lives only on two screens he has left.
//
// first-steps.ts asserts in its own comment that this sentence "is ALSO printed
// where neither of those is: the module's own empty state". That was true of the
// OFF state only.
//
// WHAT IS PINNED, and why each half is needed:
//   1. THE SWITCHED-ON PAGE SAYS IT — the same FACT as the System controls row,
//      in this screen's own words. NOT the same sentence, and this file does not
//      pretend otherwise: System controls opens "Switched on, but it has not
//      started" (the clause runbook §4 quotes as the ROW's tell, pinned by
//      runbook.test.ts) and Home's tile is shorter again because it truncates.
//      The three are joined by their DERIVATION, claim 3 below, which is the
//      join that actually matters: one registration clears all three.
//   2. THE EMPTY STATE STOPS PROMISING. A banner above the tabs and a promise
//      inside one is still a page that says two things.
//   3. IT IS THE SCHEDULER'S FACT, NOT A CONSTANT HERE. The server component
//      reads `slugsWithNoScheduledJob()` — the module W3/31 made the single
//      home of registration truth — so the day the job is registered the
//      sentence leaves this page with the same edit that clears it from System
//      controls and Home. Proved by rendering the REAL server component, not by
//      reading its source.
//   4. A REGISTERED SYSTEM SAYS NOTHING OF THE KIND. The other direction: a
//      page that warned whatever the scheduler held would be a page nobody
//      reads.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

// The server component's I/O, and only its I/O: the pure modules it reads
// (the question bank, the mining sentences, the scheduler) stay real, because
// two of the four claims below are about what those really say.
const h = vi.hoisted(() => ({
  enabled: vi.fn(),
  scope: vi.fn(),
  user: vi.fn(),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: h.enabled }));
vi.mock("@/lib/site-view", () => ({ getViewScope: h.scope }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: h.user }));
vi.mock("@/lib/triage/repository", () => ({
  listInterest: async () => [],
  countInterestByTreatmentDetailed: async () => ({ counts: {}, capped: false }),
}));
vi.mock("@/lib/triage/mining-repository", () => ({
  listCandidates: async () => [],
  listCoverage: async () => [],
}));

import { slugsWithNoScheduledJob } from "@/lib/agent-wiring/scheduler";
import { PreVisitTriageView } from "./previsit-view";
import { PreVisitWorkspace } from "./previsit-workspace";

const BANNER = "Switched on, but nothing is being sent yet.";
const PROMISE = "land here as soon as patients start filling it in";

/** The real server component, with its reads stubbed and its switch stated. */
async function page(systemEnabled: boolean): Promise<string> {
  h.enabled.mockResolvedValue(systemEnabled);
  h.scope.mockResolvedValue({
    siteIds: ["site-ng"],
    selection: "site-ng",
    isAllSites: false,
    siteName: "N15",
    label: "N15",
  });
  h.user.mockResolvedValue({ id: "u1", role: "client_owner", clientId: "vitality" });
  return renderToStaticMarkup(await PreVisitTriageView({ clientSlug: "vitality" }));
}

/** The workspace alone, so a claim can be made about one prop at a time. */
function workspace(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(PreVisitWorkspace, {
      clientSlug: "vitality",
      isOwner: true,
      treatments: [],
      interest: [],
      interestCounts: {},
      mining: [],
      miningTitle: "People who might want to hear about implants",
      miningCoverage: "This list has not been built yet.",
      miningExclusions: "",
      miningCaveats: [],
      systemEnabled: true,
      noScheduledJob: true,
      initialTab: "interest",
      ...over,
    }),
  );
}

describe("the pre-visit page keeps the cron fact after the owner switches on", () => {
  it("warns on the switched-ON page, carrying the fact System controls carries", async () => {
    const html = await page(true);
    expect(html).toContain(BANNER);
    // ONE JOB, NAMED. The flag comes from `slugsWithNoScheduledJob()`, which
    // holds slugs; `pre-visit-triage` reaches it through the agent whose trigger
    // is /api/previsit/sweep — the questionnaire sweep — so that is the job this
    // page can vouch for. A sentence that also counted the implant scan's job
    // would be falsified by half a registration, with nothing to catch it.
    expect(html).toContain("The scheduled job that sends this questionnaire has never been registered");
    expect(html).not.toContain("two scheduled jobs");
    expect(html).toContain("Ask the agency to register");
    // And it names the one thing the switch DOES arm, so the owner is not sent
    // back to Off — which is the state in which that button is disabled (W3/21).
    expect(html).toContain("Build / refresh candidates button on the Implants tab");
  });

  it("does not promise arrivals nothing can deliver", () => {
    const html = workspace();
    expect(html).not.toContain(PROMISE);
    expect(html).toContain("no form has been sent to anybody yet");
  });

  it("keeps the promise for a deployment whose job IS registered", () => {
    const html = workspace({ noScheduledJob: false });
    expect(html).toContain(PROMISE);
    expect(html).not.toContain(BANNER);
  });

  it("stays quiet about a cron on the OFF page, where the first step carries it", async () => {
    const html = await page(false);
    expect(html).not.toContain(BANNER);
    // The state the banner belongs to still has its own, unchanged.
    expect(html).toContain("Pre-visit questions is switched off.");
    expect(html).toContain("until this system&#x27;s scheduled job is registered");
  });
});

describe("the fact is the scheduler's, so registering the job clears the page", () => {
  it("takes the flag from slugsWithNoScheduledJob(), not from a constant here", async () => {
    // Non-vacuity for the pin above: if the scheduler ever reports pre-visit as
    // registered, the warning must be gone from the page in the same edit — and
    // this test says so rather than quietly passing on a stale sentence.
    const unregistered = slugsWithNoScheduledJob().includes("pre-visit-triage");
    const html = await page(true);
    expect(html.includes(BANNER), "the page and the scheduler disagree about the pre-visit job").toBe(
      unregistered,
    );
  });

  it("says nothing on a workspace told its jobs are scheduled", () => {
    expect(workspace({ noScheduledJob: false })).not.toContain("never been registered");
  });
});
