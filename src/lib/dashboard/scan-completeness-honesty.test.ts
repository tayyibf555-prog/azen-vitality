import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// A SCAN THAT STOPPED SHORT MUST SAY SO — AND SAY WHICH KIND OF SHORT.
//
// The takings bug had two siblings on the same screen, both hidden the same way.
//
//   NHS CLAIMS  paged newest-first and stopped at the first row older than 1 April.
//               The index is ordered by id and spans years, so that happens on page
//               one: the UDA block totalled about a hundred of this practice's
//               ~7,700 contract-year claims and printed it as the contract year.
//
//   INVOICES    walked 40 unfiltered pages — 4,000 of 34,201 rows, of which 30,348
//               are already settled — and then broke out of the loop WITH NO
//               TRUNCATION FLAG AT ALL. Both the INVOICED total and the debtors
//               ranking rendered over an arbitrary eighth of the index with nothing
//               on screen to say so.
//
// Both are now narrowed by a filter that is proven to work and both are checked for
// completeness against `meta.total`, which states exactly how many rows match. This
// file pins the honesty half of that: where the read cannot be complete, the panel
// is blank AND the reason distinguishes "there is more data here than one read can
// carry" from "Dentally could not be reached". They are different problems and they
// send someone looking in different places.
// ---------------------------------------------------------------------------

const PER_PAGE = 100;
const SCAN_MAX_PAGES = 40;
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const NOW = new Date("2026-08-21T10:00:00.000Z");

interface Seen {
  invoiceQueries: URLSearchParams[];
}

/**
 * An upstream where the named resources report FAR more rows in `meta.total` than a
 * page budget can fetch, and never short-page. The shape of a real index whose
 * filtered slice is simply bigger than one assembly can carry.
 */
function oversizedFetch(oversized: readonly string[], seen: Seen, opts: { dead?: readonly string[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    if (key === "invoices") seen.invoiceQueries.push(url.searchParams);
    if (opts.dead?.includes(key)) return new Response("upstream is sick", { status: 503 });

    const big = oversized.includes(key);
    const rows = big
      ? Array.from({ length: PER_PAGE }, (_, i) => ({
          // Rows that WOULD make a confident number if the truncation were absorbed.
          id: `${key}-${url.searchParams.get("page")}-${i}`,
          expected_uda: "1.0",
          awarded_uda: "1.0",
          claim_status: "submitted",
          submitted_date: "2026-08-19",
          amount: "100.0",
          amount_outstanding: "100.0",
          patient_id: `pat-${i}`,
          paid: false,
          created_at: "2026-08-19T09:00:00.000+01:00",
          dated_on: "2026-08-19",
        }))
      : [];
    return new Response(
      JSON.stringify({
        [key]: rows,
        meta: {
          // Deliberately more than SCAN_MAX_PAGES * PER_PAGE can ever reach.
          total: big ? SCAN_MAX_PAGES * PER_PAGE + 1 : 0,
          current_page: Number(url.searchParams.get("page") ?? "1"),
          total_amount: "0.0",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function newSeen(): Seen {
  return { invoiceQueries: [] };
}

type View = import("@/lib/dashboard/view").PracticeDashboardView;

function group(view: View) {
  const scope = view.scopes.find((s) => s.siteId === null);
  expect(scope).toBeTruthy();
  return scope!;
}

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "scan-completeness-honesty";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

describe("NHS claims: too many to read is not the same as unreadable", () => {
  it("blanks the UDA figures and says the contract year is bigger than one read", async () => {
    globalThis.fetch = oversizedFetch(["nhs_claims"], newSeen());
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    const progress = group(view).udaProgress;
    // The number is withheld. The old code would have totalled 4,000 rows here.
    expect(progress.completedUda.value).toBeNull();
    expect(progress.completedUda.reason).toContain("more NHS claims this contract year");
    expect(progress.completedUda.reason).not.toContain("could not be read");

    const windowPanel = group(view).periods.last30.uda;
    expect(windowPanel.completedUda.value).toBeNull();
    expect(windowPanel.completedUda.reason).toContain("more NHS claims this contract year");
  }, 120_000);

  it("still says 'could not be read' when the endpoint is genuinely down", async () => {
    // The two must never be conflated: one sends you to look at data volume, the
    // other at a broken connection.
    globalThis.fetch = oversizedFetch([], newSeen(), { dead: ["nhs_claims"] });
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    const progress = group(view).udaProgress;
    expect(progress.completedUda.value).toBeNull();
    expect(progress.completedUda.reason).toContain("could not be read");
  }, 120_000);
});

describe("invoices: the silent truncation is gone", () => {
  it("blanks the INVOICED total and the debtors ranking, each with its own reason", async () => {
    globalThis.fetch = oversizedFetch(["invoices"], newSeen());
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    const invoiced = group(view).periods.last30.invoiced;
    expect(invoiced.totalPence.value, "a total over an eighth of the index is not a total").toBeNull();
    expect(invoiced.totalPence.reason).toContain("more invoices in this period");

    const accounts = group(view).accounts;
    expect(accounts.netBalancePence.value).toBeNull();
    expect(accounts.netBalancePence.reason).toContain("more unpaid invoices");
  }, 120_000);

  it("narrows both reads with the filters live actually honours", async () => {
    const seen = newSeen();
    globalThis.fetch = oversizedFetch([], seen);
    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: NOW });

    expect(seen.invoiceQueries.length).toBeGreaterThan(0);
    const windowed = seen.invoiceQueries.filter((q) => q.get("created_after") !== null);
    const debtors = seen.invoiceQueries.filter((q) => q.get("paid") === "false");
    // The INVOICED panel's read is date-narrowed...
    expect(windowed.length).toBeGreaterThan(0);
    for (const q of windowed) {
      expect(q.get("created_before")).toBeTruthy();
      expect(q.get("created_after")! < q.get("created_before")!).toBe(true);
      // start_date/end_date are IGNORED on this endpoint; sending them would be
      // cargo-culting the payments parameters onto a resource that drops them.
      expect(q.get("start_date")).toBeNull();
    }
    // ...and the debtors read asks only for what is unpaid, which on live is 3,853
    // rows out of 34,201 rather than a walk through 30,348 settled ones.
    expect(debtors.length).toBeGreaterThan(0);
    for (const q of debtors) expect(q.get("created_after")).toBeNull();
  }, 120_000);
});
