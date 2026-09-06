import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";

// ===========================================================================
// THE FAIL-DIRECTION LAW, CHECKED ON EVERY ROUTE THAT HOLDS IT (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." `loadExcludedTargetKeys`
// REFUSES rather than returning an empty set when the override table is unreadable
// and messaging is live, because an empty set reads as "nobody is excluded" — and
// the caller would then text every patient a human had marked `inactive`, which
// has no second net at the drain the way `do_not_contact` does.
//
// ELEVEN ROUTES CARRY THAT CATCH AND THREE OF THEM WERE OBSERVED. The other eight
// were pinned by nothing at all: their own suites stub `isExclusionsUnavailable:
// () => false` alongside an empty `loadExcludedTargetKeys`, which makes the branch
// structurally unreachable, and no crawl read the files. Replacing the refusal
// with `excludedKeys = new Set<string>()` — the exact fail-OPEN regression the
// ruling forbids — left the WHOLE SUITE green on four of them.
//
// So this file is the STRUCTURAL half, and it is deliberately a text match: what
// it defends against is the refusal being deleted, aliased or "simplified" back
// into an empty default by a refactor that never runs the branch. The BEHAVIOURAL
// half — the branch actually driven, with the real predicate — lives beside each
// route (see the list below), because a crawl cannot tell whether the return is
// reached.
//
// ---------------------------------------------------------------------------
// TWO LAWFUL SHAPES, AND NOTHING ELSE.
// ---------------------------------------------------------------------------
//   SKIP THE TICK   the nine sweeps. Nobody is drafted, the tick answers
//                   `skipped: "exclusions unavailable"`, nothing is retired, and
//                   the next tick retries. A skipped tick is a delay.
//   ENROL NOBODY    the two sync routes. These do NOT abort: the read-only
//                   Dentally mirroring below them is what keeps the dashboard
//                   current and the catalog promises it keeps running whatever
//                   the messaging systems are doing. So the ENROLMENT allowance
//                   drops to zero for this tick and the mirror carries on.
//
// A NEW ROUTE IS A RED TEST UNTIL IT IS LISTED. The list is exhaustive in both
// directions: a file that loads the exclusion set and is not named here fails,
// and a name here that no longer loads it fails too. That is the property the
// eight unpinned routes were missing — not a rule nobody had written down, but a
// rule nothing read the files to check.
// ===========================================================================

/** Every route under src/app/api that asks for the exclusion set. */
const ROUTES = walkSrc({ subdir: "app/api", extensions: [".ts"] })
  .filter((p) => p.endsWith("/route.ts"))
  .filter((p) => readFileSync(srcPath(p), "utf8").includes("loadExcludedTargetKeys("))
  .sort();

/**
 * What each route must do when the exclusion set refuses, and where the branch is
 * DRIVEN. Every entry cites the behavioural test that reddens if the branch stops
 * working; the crawl below reddens if the code stops being there.
 */
const EXPECTED: Record<string, { shape: "skip-the-tick" | "enrol-nobody"; behaviouralPin: string }> = {
  "app/api/closer/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/closer/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/collection/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/collection/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/coordinator/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/coordinator/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/noshow/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/noshow/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/outreach/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/outreach/sweep/status-exclusion.test.ts",
  },
  "app/api/postop/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/postop/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/previsit/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/previsit/sweep/sweep.test.ts",
  },
  "app/api/reactivation/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/app/api/reactivation/sweep/exclusions-fail-closed.test.ts",
  },
  "app/api/recall/sweep/route.ts": {
    shape: "skip-the-tick",
    behaviouralPin: "src/lib/agent-wiring/rulings.test.ts (ruling 2)",
  },
  "app/api/sync/reactivation/route.ts": {
    shape: "enrol-nobody",
    behaviouralPin: "src/app/api/sync/reactivation/exclusions-fail-closed.test.ts",
  },
  "app/api/sync/recall/route.ts": {
    shape: "enrol-nobody",
    behaviouralPin: "src/app/api/sync/recall/exclusions-fail-closed.test.ts",
  },
};

describe("every route that loads the exclusion set is named, and named correctly", () => {
  it("the crawl found the routes the list claims, and no others", () => {
    expect(ROUTES).toEqual(Object.keys(EXPECTED).sort());
  });

  it("the crawl actually read something, so an empty walk cannot pass this file", () => {
    // A rooting mistake turns every assertion below into a vacuous one. The walk
    // comes from walk-src.ts precisely because of that hazard; this is the floor.
    expect(ROUTES.length).toBeGreaterThanOrEqual(11);
  });
});

describe("the refusal is caught and it fails CLOSED (ruling W1-B/2)", () => {
  it.each(Object.entries(EXPECTED))("%s", (route, { shape }) => {
    const src = readFileSync(srcPath(route), "utf8");

    // 1. The catch is NARROW. Swallowing every error here would report a real
    //    outage as a tidy skip.
    expect(src, `${route}: the exclusion catch no longer re-throws anything else`).toContain(
      "if (!isExclusionsUnavailable(err)) throw err;",
    );

    // 2. The catch does the ONE thing its shape allows.
    if (shape === "skip-the-tick") {
      expect(
        src.includes('skipped: "exclusions unavailable"'),
        `${route}: the tick no longer refuses when the exclusion list is unreadable`,
      ).toBe(true);
    } else {
      expect(
        src.includes("allowance.remaining = 0;"),
        `${route}: the enrolment allowance is no longer dropped to zero`,
      ).toBe(true);
    }

    // 3. AND THE MUTATION THE FINDERS ACTUALLY RAN IS NAMED. Replacing the refusal
    //    with an empty set is the fail-OPEN regression: every patient a human
    //    marked inactive then passes the `excluded:` check and is drafted.
    expect(
      /catch\s*\([\s\S]{0,600}?excludedKeys = new Set<string>\(\)/.test(src),
      `${route}: the exclusion catch resolves to an EMPTY SET, which is fail-open`,
    ).toBe(false);
  });
});
