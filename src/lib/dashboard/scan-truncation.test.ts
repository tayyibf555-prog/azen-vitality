import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// A SCAN THAT RAN OUT OF BUDGET MUST SAY SO.
//
// Both the patient and the treatment-plan scan used to page until their 40-page
// cap and then count whatever they had reached. On this practice's book — ~51,000
// patients, ~85,000 plans, neither index date-ordered — that meant every figure in
// those two panels was a count over an arbitrary few thousand rows, rendered as
// fact. "0 new patients this month" and "40 open treatment plans" are both things
// a practice manager acts on.
//
// The scans are now narrowed with `updated_after`, which is what makes them cheap.
// Where even the narrowed scan cannot finish, the site returns null and the panel
// states the gap. That is the trade this file pins: cheaper, and where it cannot be
// both cheap and complete, honest rather than short.
// ---------------------------------------------------------------------------

const PER_PAGE = 100;
const realFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "scan-truncation";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

/**
 * An upstream where `endless` endpoints NEVER return a short page — the shape of a
 * book so large that even a 90-day slice of it outruns the page budget. Everything
 * else answers with one empty page.
 */
function endlessFetch(endless: readonly string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    const rows = endless.includes(key)
      ? Array.from({ length: PER_PAGE }, (_, i) => ({
          id: `${key}-${i}`,
          // Rows that WOULD produce a confident number if the truncation were
          // absorbed: a registration date inside the window, a plan start date.
          // Without them a partial count and an honest blank look the same and the
          // test would pass for the wrong reason.
          created_at: "2026-08-19",
          accepted_at: "2026-08-19",
          completed_at: null,
        }))
      : [];
    return new Response(JSON.stringify({ [key]: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function scope(view: { scopes: Array<{ siteId: string | null; periods: Record<string, unknown> }> }, siteId: string | null) {
  return view.scopes.find((s) => s.siteId === siteId)!;
}

describe("a patient scan that outruns its page budget", () => {
  it("reports the patient counts unavailable instead of counting a partial book", async () => {
    globalThis.fetch = endlessFetch(["patients"]);
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({
      clientId: "vitality",
      now: new Date("2026-08-20T10:00:00Z"),
    });
    const panel = (scope(view, null).periods as Record<string, { patients: { newCount: { value: number | null; reason: string | null } } }>)
      .last30.patients.newCount;
    // NOT 0. A zero here reads as "nobody registered this month", which is a fact
    // about the practice; "we could not read it" is a fact about us.
    expect(panel.value).toBeNull();
    expect(panel.reason).toContain("Unavailable");
  }, 120_000);
});

describe("a treatment-plan scan that outruns its page budget", () => {
  it("reports the plan counts unavailable instead of counting a partial index", async () => {
    globalThis.fetch = endlessFetch(["treatment_plans"]);
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({
      clientId: "vitality",
      now: new Date("2026-08-20T10:00:00Z"),
    });
    const panel = (scope(view, null).periods as Record<string, { plans: { started: { value: number | null; reason: string | null } } }>)
      .last30.plans.started;
    expect(panel.value).toBeNull();
    // The reason must be the READ one, not the field-presence one: a truncated scan
    // is "we could not read this", never "the source does not carry the field".
    expect(panel.reason).toContain("could not be read from Dentally");
  }, 120_000);
});

describe("a scan that finishes", () => {
  it("still reports its figures", async () => {
    // The guard above must not have turned every panel off: a short page is a
    // complete read and must still produce numbers.
    globalThis.fetch = endlessFetch([]);
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: new Date() });
    const panel = (scope(view, null).periods as Record<string, { plans: { started: { value: number | null; reason: string | null } } }>)
      .last30.plans.started;
    // A completed scan of an empty index reports the source's OWN limitation ("no
    // plan carries a start date"), not a read failure. The two reasons must stay
    // distinguishable, or the truncation guard would be indistinguishable from a
    // quiet practice — which is exactly the confusion it was added to end.
    expect(panel.reason).toContain("no plan carries a start date");
  }, 120_000);
});

describe("the read layer's own declaration that the plan scan is windowed", () => {
  it("reports OPEN unavailable even when the plans would happily produce a number", async () => {
    // A short page of real plans, each with a start date and a finish FIELD, so
    // computeTreatmentPlanCounts can answer all three figures. STARTED and FINISHED
    // are exact on a windowed scan; OPEN is not, and only the read layer knows the
    // scan was windowed. If it stops saying so, this is the number that quietly
    // becomes a lie again: "the practice has N open plans", counted over ninety days
    // of a book that goes back years.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      const rows =
        key === "treatment_plans"
          ? [{ id: "plan-1", accepted_at: "2026-08-18", completed_at: null }]
          : [];
      return new Response(JSON.stringify({ [key]: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: new Date("2026-08-20T10:00:00Z") });
    const panel = (scope(view, null).periods as Record<string, { plans: { started: { value: number | null }; open: { value: number | null; reason: string | null } } }>)
      .last30.plans;
    expect(panel.started.value).toBeGreaterThan(0); // the scan really did produce plans
    expect(panel.open.value).toBeNull();
    expect(panel.open.reason).toContain("cannot see plans left open before");
  }, 120_000);
});
