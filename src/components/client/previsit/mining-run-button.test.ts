// ===========================================================================
// THE IMPLANT SCAN HAS AN OWNER-REACHABLE CALLER (rulings W3/8, W3/21, W3/27).
//
// THE DEFECT this pins: "a feature with no caller is not shipped." The
// implant-candidate scan, its caveats, its coverage bookkeeping and its panel
// were all built and good, and for two waves NOTHING started it. Its cron is not
// registered (the runbook §2 carries the SQL for the client to run), and the
// owner-only endpoint that exists for it — POST /api/previsit/mining-run — could
// not be reached from any screen. The panel read "Nobody on this list yet"
// permanently, on a feature the practice owner asked for by name, and no screen
// said why.
//
// W3/27 settles it in the button's favour: "the owner-only 'Build / refresh
// candidates' button EXISTS on the pre-visit page."
//
// FOUR RULES, and each is a way the control could be worse than no control:
//   1. IT IS ON THE SCREEN, in the panel whose emptiness it explains, and it
//      points at the endpoint that exists (POST only — the route deliberately
//      has no GET).
//   2. OWNER-ONLY IN THE UI TOO. The page is owner + practice manager, and the
//      route answers her with a 403. A control that refuses the person looking
//      at it is worse than none, so she is not shown one.
//   3. FAIL-CLOSED UNDER THE SWITCH (W3/21). The scan reads real patient
//      history, so `pre-visit-triage` halts it exactly as it halts the sends —
//      it is NOT on the closed list of preparation surfaces W2-C/4 spares.
//   4. THE ROUTE'S OWN SENTENCES, VERBATIM, and a run that was refused does not
//      pretend the list moved on.
//
// The click itself cannot be driven here — this suite renders to static markup —
// so rule 4 is asserted against `miningRunOutcome`, the pure decision the click
// handler delegates to, and the handler is asserted to delegate to it.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The build action refreshes the route after a successful run. Nothing here
// clicks it; the router is stubbed so the panel can be rendered at all.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

import { MiningPanel, PreVisitWorkspace, miningRunOutcome } from "./previsit-workspace";

const ROW = {
  id: "mc-1",
  patientId: "dp-1",
  patientName: "Alex Berry",
  age: 44,
  lastExtractionAt: "2026-08-02T10:00:00.000Z",
  matchedText: "Extraction UR6",
};

const LABEL = "Build / refresh candidates";

function srcPath(rel: string): string {
  return join(process.cwd(), "src", rel);
}

function panel(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(MiningPanel, {
      title: "People who might want to hear about implants",
      rows: [ROW],
      coverage: "This list has not been built yet.",
      exclusions: "",
      caveats: ["This is not a clinical assessment."],
      ...over,
    }),
  );
}

/** The workspace with the implant tab OPEN, which is the only way to see it. */
function workspace(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(PreVisitWorkspace, {
      clientSlug: "vitality",
      isOwner: true,
      treatments: [],
      interest: [],
      interestCounts: {},
      mining: [ROW],
      miningTitle: "People who might want to hear about implants",
      miningCoverage: "This list has not been built yet.",
      miningExclusions: "",
      miningCaveats: [],
      systemEnabled: true,
      initialTab: "mining",
      ...over,
    }),
  );
}

describe("the implant scan has a caller the owner can reach (W3/8)", () => {
  it("puts the build action on the implant panel, above the names", () => {
    const html = panel({ clientSlug: "vitality", canBuild: true, systemEnabled: true });
    expect(html).toContain(LABEL);
    expect(html.indexOf(LABEL)).toBeLessThan(html.indexOf("Alex Berry"));
  });

  it("reaches it through the real workspace, on the implant tab", () => {
    // The tabs primitive mounts only the ACTIVE panel, so a default render of
    // this workspace never contains the implant panel at all. Opening the tab is
    // what proves the workspace WIRES the action rather than merely owning a
    // component that could render one.
    expect(workspace()).toContain(LABEL);
  });

  it("posts to the endpoint that exists, and to no other", () => {
    const src = readFileSync(srcPath("components/client/previsit/previsit-workspace.tsx"), "utf8");
    expect(src, "the build action no longer names the mining-run endpoint").toContain(
      "/api/previsit/mining-run?client=",
    );
    // POST only: the route deliberately has no GET (pinned the other way round
    // at src/app/api/previsit/mining-run/route.test.ts).
    expect(src).toContain('method: "POST"');
    const route = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(route, "the endpoint this button calls has lost its POST handler").toContain(
      "export async function POST",
    );
    expect(route, "the button's owner-only claim rests on this guard").toContain("requireOwnerRole");
  });
});

describe("the build action is the OWNER'S, not the practice manager's (W3/8)", () => {
  it("is absent for a reader who may not start a scan", () => {
    const html = panel({ clientSlug: "vitality", canBuild: false, systemEnabled: true });
    expect(html).not.toContain(LABEL);
    // The names are still there: she runs the interest lists and reads this one.
    expect(html).toContain("Alex Berry");
  });

  it("is absent from the workspace for a practice manager", () => {
    expect(workspace({ isOwner: false })).not.toContain(LABEL);
  });

  it("defaults to absent, so a caller that says nothing gets no control", () => {
    // The fail direction: a panel rendered without being told who is looking at
    // it offers nothing. `canBuild` and `clientSlug` are both required.
    expect(panel()).not.toContain(LABEL);
    expect(panel({ canBuild: true })).not.toContain(LABEL);
    expect(panel({ clientSlug: "vitality" })).not.toContain(LABEL);
  });
});

describe("the build action is fail-closed under the switch (W3/21)", () => {
  const OFF = "Pre-visit questions is switched off, so the list is not being built.";

  it("is disabled and says so while the module is off", () => {
    const html = panel({ clientSlug: "vitality", canBuild: true, systemEnabled: false });
    expect(html).toContain(LABEL);
    // The rendered boolean attribute, not the `disabled:` utility class that is
    // on the button in both states.
    expect(html).toContain('disabled=""');
    expect(html).toContain(OFF);
  });

  it("is live and silent about the switch while the module is on", () => {
    const html = panel({ clientSlug: "vitality", canBuild: true, systemEnabled: true });
    expect(html).not.toContain(OFF);
    expect(html).not.toContain('disabled=""');
  });

  it("says the same words the route says, so the screen cannot drift from it", () => {
    // The endpoint refuses this run with its own sentence. Saying it here one
    // step earlier is only honest while the two sentences are the same sentence.
    const route = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(route, "the route's switched-off sentence has changed; the screen's copy must follow").toContain(
      OFF,
    );
  });

  it("carries the switch through the workspace rather than deciding it here", () => {
    expect(workspace({ systemEnabled: false })).toContain(OFF);
    expect(workspace({ systemEnabled: true })).not.toContain(OFF);
  });
});

describe("the owner is told what the run actually did (W3/8)", () => {
  it("prints the route's own sentence, verbatim, for a run that read the book", () => {
    const out = miningRunOutcome(
      { ok: true, status: 200 },
      { ok: true, message: "Read 30 more days of the diary and added 4 people.", patientReads: 120 } as never,
    );
    expect(out.message).toBe("Read 30 more days of the diary and added 4 people.");
    expect(out.refresh).toBe(true);
  });

  it("does not pretend the list moved on when the run was SKIPPED", () => {
    // Both skips are `ok: true` — a successful refusal — which is the one shape a
    // naive `res.ok` check gets wrong. The list is exactly as it was, so the page
    // behind the button is not re-rendered.
    for (const skipped of ["system off", "another run in progress"]) {
      const out = miningRunOutcome(
        { ok: true, status: 200 },
        { ok: true, skipped, message: "This list is already being built. Give it a minute and refresh." },
      );
      expect(out.refresh, `a "${skipped}" run refreshed the page`).toBe(false);
      expect(out.message).toBe("This list is already being built. Give it a minute and refresh.");
    }
  });

  it("falls back to the status only where the route wrote no sentence", () => {
    // A 403 for the practice manager, a 404 for an unknown practice, a proxy in
    // the way. Saying the status beats saying nothing, and neither refreshes.
    const forbidden = miningRunOutcome({ ok: false, status: 403 }, {});
    expect(forbidden.message).toContain("403");
    expect(forbidden.refresh).toBe(false);
    // `error` is preferred over the fallback: the route writes one for the 500.
    const failed = miningRunOutcome(
      { ok: false, status: 500 },
      { ok: false, error: "The list could not be built just now." },
    );
    expect(failed.message).toBe("The list could not be built just now.");
    expect(failed.refresh).toBe(false);
  });

  it("is the decision the click handler delegates to, not a second copy of it", () => {
    const src = readFileSync(srcPath("components/client/previsit/previsit-workspace.tsx"), "utf8");
    expect(src, "the handler no longer calls miningRunOutcome; these rules pin nothing").toContain(
      "miningRunOutcome(res, data)",
    );
    expect(src).toContain("if (outcome.refresh) router.refresh()");
  });
});
