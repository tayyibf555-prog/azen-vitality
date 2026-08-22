import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";

import { srcPath } from "@/lib/test-support/walk-src";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// F5 — THREE COPIES OF ONE PER-SITE SCAN.
//
// scanAppointments, scanPatients and scanPlans were the same thirty-five lines three
// times over: Promise.all across the sites, a try, a pageAll at PER_PAGE and
// SCAN_MAX_PAGES, a two-branch truncation log, a normaliser, and a catch that
// rethrows a budget refusal and reports the site unread. Only the nouns and the
// normaliser differed.
//
// This file is the pin that they now share ONE block, and — the part that matters —
// that sharing it changed none of the four behaviours each copy was carrying: a
// truncated site withholds its own panel and nobody else's, a failed site does the
// same, a budget refusal still PROPAGATES rather than degrading to an empty scan,
// and the two ways of being truncated are still logged apart.
//
// F4 — AND THE FOURTH COPY JOINED THEM. scanClaims was the same walk a fourth time
// and was excluded for one reason: the UDA panel's sentence differs by CAUSE ("there
// are more claims this contract year than one read can cover" is not "NHS claims
// could not be read from Dentally"), and the helper answered `null` for both. The
// helper now returns a discriminated per-site result carrying the cause, which
// deleted the dead `null` arms in the other three callers as well. The group-level
// distinction scanClaims makes off that cause is pinned below, because it is the
// whole reason it stayed out.
// ---------------------------------------------------------------------------

const SITES = 3;
const SCAN_MAX_PAGES = 40;
const PER_PAGE = 100;
const NOW = new Date("2026-08-22T10:00:00Z");
const IN_WINDOW = "2026-08-21";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

let errors: string[] = [];
beforeEach(() => {
  process.env.DENTALLY_API_KEY = "scan-windowed-per-site";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
});

function row(key: string, page: number, i: number): Record<string, unknown> {
  return {
    id: `${key}-${page}-${i}`,
    created_at: IN_WINDOW,
    accepted_at: IN_WINDOW,
    completed_at: null,
    start_time: `${IN_WINDOW}T09:00:00+01:00`,
    state: "completed",
  };
}

/** Rows every non-target resource answers with, so the panels that read CLEANLY have
 *  a figure to state. An empty set is not good enough here: an empty plan index
 *  legitimately reports "no plan carries a start date", which is indistinguishable
 *  from the withholding this test is trying to prove did NOT spread. */
const CLEAN_ROWS = 2;

/**
 * An upstream where ONE named resource is short of its published count and every
 * other resource answers a clean, complete page.
 */
function shortOf(target: string, opts: { rows: number; total: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const mine = key === target;
    const windowed = ["appointments", "patients", "treatment_plans"].includes(key);
    const n = page > 1 ? 0 : mine ? opts.rows : windowed ? CLEAN_ROWS : 0;
    const body: Record<string, unknown> = {
      [key]: Array.from({ length: n }, (_, i) => row(key, page, i)),
    };
    if (mine) body["meta"] = { total: opts.total, current_page: page };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

type View = import("./view").PracticeDashboardView;
async function assemble(): Promise<View> {
  const { readPracticeDashboard } = await import("./read");
  return readPracticeDashboard({ clientId: "vitality", now: NOW });
}
function group(view: View) {
  return view.scopes.find((s) => s.siteId === null)!;
}

describe("F5: the three windowed scans run one shared per-site block", () => {
  it("declares it ONCE, and none of the three keeps a private Promise.all walk", () => {
    const source = readFileSync(srcPath("lib/dashboard/read.ts"), "utf8");

    expect((source.match(/async function scanWindowedPerSite\(/g) ?? []).length).toBe(1);

    for (const fn of ["scanAppointments", "scanPatients", "scanPlans", "scanClaims"]) {
      const start = source.indexOf(`async function ${fn}(`);
      expect(start, `${fn} is gone`).toBeGreaterThan(-1);
      // Up to the next top-level declaration.
      const rest = source.slice(start + 1);
      const end = rest.search(/\n(?:async function|function|interface|\/\/ ---)/);
      const body = rest.slice(0, end === -1 ? undefined : end);
      expect(body, `${fn} still walks its own sites`).toContain("scanWindowedPerSite(");
      expect(body, `${fn} has grown a fourth copy of the per-site loop`).not.toContain(
        "siteIds.map(async (siteId)",
      );
      expect(body, `${fn} pages outside the shared block`).not.toContain("await pageAll(");
    }
  });

  it.each([
    ["patients", "patient scan", "patients"],
    ["treatment_plans", "treatment plan scan", "plans"],
    ["appointments", "appointment scan", "appointments"],
  ])(
    "%s: a short walk withholds its OWN figures and logs the count it fell short of",
    async (resource, scanNoun, rowNoun) => {
      globalThis.fetch = shortOf(resource, { rows: 40, total: 500 });

      const view = await assemble();
      const panels = group(view).periods.last30;

      // The truncated resource is withheld...
      if (resource === "patients") expect(panels.patients.newCount.value).toBeNull();
      if (resource === "treatment_plans") expect(panels.plans.started.value).toBeNull();
      if (resource === "appointments") expect(panels.appointments.total.value).toBeNull();

      // ...and the other two, which read cleanly, still state their figures. A shared
      // block that reported the whole assembly unavailable would be a regression no
      // per-panel assertion above would have caught.
      const clean = CLEAN_ROWS * SITES;
      if (resource !== "patients") expect(panels.patients.newCount.value).toBe(clean);
      if (resource !== "treatment_plans") expect(panels.plans.started.value).toBe(clean);
      if (resource !== "appointments") expect(panels.appointments.total.value).toBe(clean);

      // THE COUNT BRANCH of the log, with this scan's own nouns, once per site.
      const said = errors.filter(
        (m) => m.includes(`${scanNoun} read 40 of 500 ${rowNoun}`) && !m.includes("page cap"),
      );
      expect(said).toHaveLength(SITES);
    },
    120_000,
  );

  it("logs the NO-COUNT branch differently, because it is a different fact about the source", async () => {
    // Full pages for ever and no meta: the walk runs out of budget rather than
    // falling short of a stated count, and someone reading the log has to be able to
    // tell those apart — one is "raise the cap", the other is "the server is lying".
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      const page = Number(url.searchParams.get("page") ?? "1");
      const n = key === "patients" ? PER_PAGE : 0;
      return new Response(
        JSON.stringify({ [key]: Array.from({ length: n }, (_, i) => row(key, page, i)) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const view = await assemble();

    expect(group(view).periods.last30.patients.newCount.value).toBeNull();
    const said = errors.filter(
      (m) =>
        m.includes(`patient scan hit the page cap`) &&
        m.includes(`at ${SCAN_MAX_PAGES} pages with no meta.total to verify against`),
    );
    expect(said).toHaveLength(SITES);
    expect(errors.some((m) => m.includes("patient scan read"))).toBe(false);
  }, 120_000);

  it("CONTROL: a site that ERRORS is reported as a failed scan, not as a truncation", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      if (key === "patients") {
        return new Response(JSON.stringify({ error: "upstream is down" }), { status: 500 });
      }
      return new Response(JSON.stringify({ [key]: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const view = await assemble();

    expect(group(view).periods.last30.patients.newCount.value).toBeNull();
    expect(errors.filter((m) => m.includes("patient scan failed for site"))).toHaveLength(SITES);
    expect(errors.some((m) => m.includes("patient scan read"))).toBe(false);
    expect(errors.some((m) => m.includes("patient scan hit the page cap"))).toBe(false);
  }, 120_000);
});

describe("F4: the shared block carries scanClaims' truncated-vs-failed distinction", () => {
  // The ONE thing that kept this scan out of the helper. The panel says something
  // different for each cause, and "there is too much data" must never be printed over
  // an outage: it reads like a smaller problem than it is.

  it("a TRUNCATED claim site gets the too-much-data sentence", async () => {
    globalThis.fetch = shortOf("nhs_claims", { rows: 40, total: 500 });

    const progress = group(await assemble()).udaProgress;

    expect(progress.completedUda.value).toBeNull();
    expect(progress.completedUda.reason).toContain(
      "more NHS claims this contract year than one read can cover",
    );
  }, 120_000);

  it("a FAILED claim site gets the could-not-be-read sentence instead", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      if (key === "nhs_claims") {
        return new Response(JSON.stringify({ error: "upstream is down" }), { status: 500 });
      }
      return new Response(JSON.stringify({ [key]: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const progress = group(await assemble()).udaProgress;

    expect(progress.completedUda.value).toBeNull();
    expect(
      progress.completedUda.reason,
      "an outage was dressed up as there being too much data to read",
    ).toContain("could not be read from Dentally");
    expect(errors.filter((m) => m.includes("NHS claim scan failed for site"))).toHaveLength(SITES);
  }, 120_000);

  it("ONE failed site among truncated ones is still reported as the outage it is", async () => {
    // The group-level rule, unchanged by the move: truncation is the whole group's
    // story only if nothing else went wrong.
    let seen = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      const page = Number(url.searchParams.get("page") ?? "1");
      if (key !== "nhs_claims") {
        return new Response(JSON.stringify({ [key]: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      seen += 1;
      // The first site to ask errors; the rest come back short of a stated count.
      if (seen === 1) return new Response(JSON.stringify({ error: "down" }), { status: 500 });
      return new Response(
        JSON.stringify({
          nhs_claims: page > 1 ? [] : Array.from({ length: 40 }, (_, i) => row(key, page, i)),
          meta: { total: 500, current_page: page },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const progress = group(await assemble()).udaProgress;

    expect(progress.completedUda.reason).toContain("could not be read from Dentally");
  }, 120_000);
});
