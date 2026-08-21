import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  __setDentallyBudgetForTests,
  runWithDentallyPriority,
  type BudgetConsumer,
} from "@/lib/dentally/budget";
import { computeTakingsStrip, takingsWindowKey } from "@/lib/dashboard/takings";
import { buildDashboardView, type PracticeDashboardView } from "@/lib/dashboard/view";
import { takingsCaveats, invoicedCaveats } from "@/components/client/dashboard/caveats";

// ---------------------------------------------------------------------------
// THE DASHBOARD'S MONEY PATH, AND THE EIGHT THINGS IT WAS STILL GETTING WRONG.
//
// Every case below was found by adversarial review of the reads behind the takings
// strip, the INVOICED panel and the ACCOUNTS ranking, and each one is pinned here
// because each one is invisible from the screen: a doomed page walk looks like a slow
// dashboard, a mislabelled refusal looks like a broken practice, and a mock fixture
// that silently drops out of a filter looks like a practice that billed nothing.
//
// The file is organised one describe per defect, named for the defect, so a failure
// says which honesty guarantee just went.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-21T10:00:00.000Z");
const TODAY = "2026-08-21";
const CLIENT = "vitality";

/** src/lib/mock/clients.ts — this client's three sites and their Dentally uuids. */
const SITE_UUIDS: Record<string, string> = {
  "site-cc": "3286d822-68c5-48ff-b1a2-065780dfcd15",
  "site-rv": "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf",
  "site-ng": "5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6",
};
const SITE_IDS = Object.keys(SITE_UUIDS);
const UUID_TO_SITE = new Map(Object.entries(SITE_UUIDS).map(([id, uuid]) => [uuid, id]));

const PER_PAGE = 100;
const SCAN_MAX_PAGES = 40;
/** More rows than 40 pages of 100 can ever reach: the doomed-walk trigger. */
const UNREACHABLE = SCAN_MAX_PAGES * PER_PAGE + 1;

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "money-path-hardening";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setDentallyBudgetForTests(null);
});

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

interface Recorder {
  /** Every request, by pathname, with its query. */
  calls: Array<{ path: string; q: URLSearchParams }>;
}

function newRecorder(): Recorder {
  return { calls: [] };
}

function countPath(rec: Recorder, path: string): number {
  return rec.calls.filter((c) => c.path.endsWith(path)).length;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A tiny upstream: everything answers one empty page unless `answer` returns a body.
 * Nothing here is date-ordered and nothing pretends to be — the tests that care about
 * a specific endpoint's shape supply it themselves.
 */
function harness(
  rec: Recorder,
  answer: (path: string, q: URLSearchParams) => unknown | undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    rec.calls.push({ path: url.pathname, q: url.searchParams });
    const supplied = answer(url.pathname, url.searchParams);
    if (supplied !== undefined) return json(supplied);
    const key = url.pathname.split("/").pop() ?? "";
    return json({ [key]: [], meta: { total: 0, current_page: 1 } });
  }) as typeof fetch;
}

async function readDashboard(): Promise<PracticeDashboardView> {
  const { readPracticeDashboard } = await import("./read");
  return readPracticeDashboard({ clientId: CLIENT, now: NOW });
}

function group(view: PracticeDashboardView) {
  const scope = view.scopes.find((s) => s.siteId === null);
  expect(scope, "no all-sites scope").toBeTruthy();
  return scope!;
}

// ---------------------------------------------------------------------------
// F1 — the doomed walk
// ---------------------------------------------------------------------------

describe("F1: a scan Dentally has already said is too big does not walk anyway", () => {
  // `meta.total` arrives on PAGE ONE. Both scans read it there, compared it at the
  // END, and in between paged all forty pages per site to build a result they then
  // threw away — 120 requests an assembly, against a 3,600/hour ceiling that a cron
  // emptied for a whole working day on 2026-08-20. The panel's sentence is unchanged;
  // only the bill is.

  it("stops the NHS claim scan after ONE page per site and still reports the UDA figures unavailable", async () => {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path) => {
      if (!path.endsWith("/v1/nhs_claims")) return undefined;
      return {
        nhs_claims: Array.from({ length: PER_PAGE }, (_, i) => ({
          id: `claim-${i}`,
          claim_status: "submitted",
          expected_uda: "1.0",
          awarded_uda: "1.0",
          submitted_date: "2026-08-19",
        })),
        meta: { total: UNREACHABLE, current_page: 1 },
      };
    });

    const view = await readDashboard();

    // ONE request per site, not forty.
    expect(countPath(rec, "/v1/nhs_claims")).toBe(SITE_IDS.length);
    // And the honesty half is untouched: no total over the slice it did read.
    const progress = group(view).udaProgress;
    expect(progress.completedUda.value).toBeNull();
    expect(progress.completedUda.reason).toContain("more NHS claims this contract year");
  }, 60_000);

  it("stops each invoice slice after ONE page and still reports the panels unavailable", async () => {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      return {
        invoices: Array.from({ length: PER_PAGE }, (_, i) => ({
          id: `inv-${i}`,
          patient_id: `pat-${i}`,
          amount: "100.00",
          amount_outstanding: "100.00",
          paid: false,
          created_at: `${TODAY}T09:00:00+01:00`,
        })),
        meta: { total: UNREACHABLE, current_page: 1 },
      };
    });

    const view = await readDashboard();

    // One windowed read + one per site for the outstanding slice, each a single page.
    expect(countPath(rec, "/v1/invoices")).toBe(1 + SITE_IDS.length);
    expect(group(view).periods.last30.invoiced.totalPence.value).toBeNull();
    expect(group(view).periods.last30.invoiced.totalPence.reason).toContain(
      "more invoices in this period",
    );
    expect(group(view).accounts.netBalancePence.value).toBeNull();
    expect(group(view).accounts.netBalancePence.reason).toContain("more unpaid invoices");
  }, 60_000);

  it("still walks when Dentally publishes no count at all", async () => {
    // The early stop must never fire on a null expected: no count means the walk is
    // the only way to find out, and refusing to take it would blank a panel that is
    // perfectly readable.
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      // A short page, no meta: a complete read by the short-page heuristic.
      return { invoices: [] };
    });
    await readDashboard();
    expect(countPath(rec, "/v1/invoices")).toBe(1 + SITE_IDS.length);
  }, 60_000);

  it("asks for the page size the shared pager measures short pages against", async () => {
    // THE COUPLING THE pageAll REUSE INTRODUCED, PINNED. pageAll ends a walk when a
    // page comes back with fewer than REPORTS_PER_PAGE rows — whatever per_page the
    // caller actually asked for. So a scan requesting any OTHER size would see every
    // full page as short, stop on page one, and hand back a slice marked complete:
    // a truncated read rendered as a total, which is the failure this whole file
    // exists to prevent.
    //
    // The upstream below is the shape that exposes it: no meta at all, and exactly
    // as many rows as were asked for, for ever. Read correctly it runs to the page
    // cap and reports the panel unavailable; read at the wrong page size it stops
    // after one request and states a number over a hundred rows.
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      if (q.get("paid") !== "false") return { invoices: [] };
      const perPage = Number(q.get("per_page") ?? "0");
      return {
        invoices: Array.from({ length: perPage }, (_, i) => ({
          id: `inv-${q.get("site_id")}-${q.get("page")}-${i}`,
          patient_id: `pat-${i}`,
          amount: "10.00",
          amount_outstanding: "10.00",
          paid: false,
        })),
      };
    });

    const view = await readDashboard();
    const unpaid = rec.calls.filter(
      (c) => c.path.endsWith("/v1/invoices") && c.q.get("paid") === "false",
    );
    expect(unpaid.length, "the walk stopped early — a full page was read as short").toBe(
      SCAN_MAX_PAGES * SITE_IDS.length,
    );
    for (const c of unpaid) expect(c.q.get("per_page")).toBe(String(PER_PAGE));
    expect(group(view).accounts.netBalancePence.value).toBeNull();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// F2 — the outstanding read, per site
// ---------------------------------------------------------------------------

describe("F2: the outstanding-invoice read is scoped per site, and de-duplicated", () => {
  // paid=false measured 3,853 rows live against a 4,000-row ceiling: ~147 invoices,
  // weeks of billing, from a panel that blanks entirely once it is crossed.

  it("asks each site by its own Dentally id, and asks for nothing else", async () => {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, () => undefined);
    await readDashboard();

    const unpaid = rec.calls.filter(
      (c) => c.path.endsWith("/v1/invoices") && c.q.get("paid") === "false",
    );
    expect(unpaid.length).toBe(SITE_IDS.length);
    expect(unpaid.map((c) => c.q.get("site_id")).sort()).toEqual(
      SITE_IDS.map((id) => SITE_UUIDS[id]!).sort(),
    );
    // Still not a window question: an invoice raised three years ago is still owed.
    for (const c of unpaid) expect(c.q.get("created_after")).toBeNull();

    // And the WINDOWED read is deliberately still group-wide — 90 days is nowhere
    // near the ceiling, so splitting it would buy two more requests for nothing.
    const windowed = rec.calls.filter(
      (c) => c.path.endsWith("/v1/invoices") && c.q.get("created_after") !== null,
    );
    expect(windowed.length).toBe(1);
    expect(windowed[0]!.q.get("site_id")).toBeNull();
  }, 60_000);

  it("does not treble a balance when the source ignores site_id", async () => {
    // The guard that makes the change safe against a remote system that is not doing
    // what we were told it does — our own mock is exactly such a source.
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      if (q.get("paid") !== "false") return undefined;
      // The SAME single unpaid invoice, whatever site was asked for.
      return {
        invoices: [
          { id: "inv-owed", patient_id: "pat-1", amount: "500.00", amount_outstanding: "500.00", paid: false },
        ],
        meta: { total: 1, current_page: 1 },
      };
    });

    const view = await readDashboard();
    const accounts = group(view).accounts;
    expect(accounts.totalOwedPence.value, "the same debt was counted once per site").toBe(50_000);
    expect(accounts.patientsInDebt.value).toBe(1);
  }, 60_000);

  it("reports the panel unavailable when ONE site's slice stops short", async () => {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      if (q.get("paid") !== "false") return undefined;
      const oversized = q.get("site_id") === SITE_UUIDS["site-rv"];
      return {
        invoices: oversized
          ? Array.from({ length: PER_PAGE }, (_, i) => ({
              id: `inv-rv-${i}`,
              patient_id: `pat-${i}`,
              amount: "10.00",
              amount_outstanding: "10.00",
              paid: false,
            }))
          : [],
        meta: { total: oversized ? UNREACHABLE : 0, current_page: 1 },
      };
    });

    const view = await readDashboard();
    // Not "two sites' worth of debtors": a group balance short by a practice is not a
    // group balance.
    expect(group(view).accounts.netBalancePence.value).toBeNull();
    expect(group(view).accounts.netBalancePence.reason).toContain("more unpaid invoices");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F3 — one money grammar, and a counter for what it refuses
// ---------------------------------------------------------------------------

describe("F3: invoice rows go through the platform's money grammar, and refusals are counted", () => {
  // The windowed read parsed `amount` with a private Number(v) * 100, while the
  // outstanding slice of the SAME field from the SAME endpoint went through the
  // strict parseMoneyPence twenty lines away. "27.999" was £28.00 on one path and a
  // refusal on the other.

  const goodDay = TODAY;

  function invoiceUpstream(rec: Recorder): typeof fetch {
    return harness(rec, (path, q) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      if (q.get("created_after") === null) return undefined;
      return {
        invoices: [
          {
            id: "inv-good",
            patient_id: "pat-1",
            amount: "120.50",
            amount_outstanding: "0.00",
            created_at: `${goodDay}T10:00:00+01:00`,
          },
          {
            // Three decimals. The old private parser rounded this to £28.00 and put
            // it in the total; the platform's grammar refuses to invent the penny.
            id: "inv-subpenny",
            patient_id: "pat-2",
            amount: "27.999",
            amount_outstanding: "0.00",
            created_at: `${goodDay}T10:00:00+01:00`,
          },
        ],
        meta: { total: 2, current_page: 1 },
      };
    });
  }

  it("refuses a sub-penny row rather than rounding it into the billed total", async () => {
    const rec = newRecorder();
    globalThis.fetch = invoiceUpstream(rec);
    const view = await readDashboard();
    const panel = group(view).periods.today.invoiced;
    // 120.50 alone. 12,050 + 2,800 = 14,850 would be the old answer.
    expect(panel.totalPence.value).toBe(12_050);
    expect(panel.invoiceCount.value).toBe(1);
  }, 60_000);

  it("counts the refusal and puts it on the screen, so tightening the grammar cannot hide a bill", async () => {
    const rec = newRecorder();
    globalThis.fetch = invoiceUpstream(rec);
    const view = await readDashboard();
    const panel = group(view).periods.today.invoiced;
    expect(panel.droppedInvoices).toBe(1);
    expect(panel.undatedInvoices, "an unreadable row is not an undated one").toBe(0);

    const caveats = invoicedCaveats(panel);
    const unread = caveats.find((c) => c.id === "invoiced-unread");
    expect(unread?.text).toBe("1 invoice record could not be read and is in no total on this panel.");
    expect(unread?.material).toBe(true);
  }, 60_000);

  it("says nothing when every row parsed", () => {
    expect(
      invoicedCaveats({
        totalPence: { value: 1, reason: null },
        paidPence: { value: 1, reason: null },
        unpaidPence: { value: 0, reason: null },
        invoiceCount: { value: 1, reason: null },
        undatedInvoices: 0,
        droppedInvoices: 0,
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F4 — a refused budget is not a broken practice
// ---------------------------------------------------------------------------

describe("F4: a refused assembly says the reads were paused, not that a site is unreadable", () => {
  const REFUSED_TEXT =
    "Takings unavailable: live reads were paused for a moment; this will refresh shortly.";

  it("names the platform's own refusal on every period", async () => {
    const refuseEverything: BudgetConsumer = async () => false;
    __setDentallyBudgetForTests(refuseEverything);
    const rec = newRecorder();
    globalThis.fetch = harness(rec, () => undefined);

    const view = await runWithDentallyPriority("background", () => readDashboard());

    const cells = group(view).strip.cells;
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.totalPence, "a refused read must not produce a figure").toBeNull();
      expect(cell.unavailableReason).toBe(REFUSED_TEXT);
    }
    // The screen is still recognisably hers.
    expect(view.sites.map((s) => s.id).sort()).toEqual([...SITE_IDS].sort());
  }, 60_000);

  it("checks the refusal BEFORE the exact and row paths, so neither can relabel it", () => {
    // Even handed a perfectly good aggregate, `refused` wins: the flag means no read
    // was made, so anything else present is stale or fixture data.
    const strip = computeTakingsStrip({
      payments: [],
      paymentsCoverage: null,
      now: NOW,
      siteId: "site-cc",
      siteIdsInScope: ["site-cc"],
      refused: true,
      windowTotals: new Map([
        [takingsWindowKey("site-cc", "today"), { totalPence: 999, paymentCount: 1 }],
      ]),
    });
    expect(strip.cells.every((c) => c.totalPence === null)).toBe(true);
    expect(strip.cells.every((c) => c.unavailableReason === REFUSED_TEXT)).toBe(true);
  });

  it("uses the SINGULAR sentence when the scope holds exactly one site", () => {
    const one = computeTakingsStrip({
      payments: [],
      paymentsCoverage: null,
      now: NOW,
      siteId: "site-cc",
      windowTotals: new Map(),
    });
    expect(one.cells[0]!.unavailableReason).toBe("Takings unavailable: this site could not be read.");

    const many = computeTakingsStrip({
      payments: [],
      paymentsCoverage: null,
      now: NOW,
      siteId: null,
      siteIdsInScope: SITE_IDS,
      windowTotals: new Map(),
    });
    expect(many.cells[0]!.unavailableReason).toBe(
      "Takings unavailable: one of the sites in this view could not be read.",
    );
  });
});

// ---------------------------------------------------------------------------
// F5 — the sites that did not answer, by name
// ---------------------------------------------------------------------------

describe("F5: the takings caveat names the practice that did not answer", () => {
  it("carries the failed site ids out of the read and onto the view", async () => {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (!path.endsWith("/v1/payments")) return undefined;
      if (q.get("site_id") === SITE_UUIDS["site-rv"]) {
        // An envelope with no readable aggregate: a failed read, not an empty window.
        return { payments: [], meta: { current_page: 1 } };
      }
      return { payments: [], meta: { total: 0, total_amount: "0.0", current_page: 1 } };
    });

    const view = await readDashboard();
    expect(view.takingsFailedSites).toEqual(["site-rv"]);
    // Disclosure only: the sites that DID answer still state their figures, and the
    // group total is blank for the usual reason — a missing key, not this list.
    const rv = view.scopes.find((s) => s.siteId === "site-rv")!;
    const cc = view.scopes.find((s) => s.siteId === "site-cc")!;
    expect(rv.strip.cells[0]!.totalPence).toBeNull();
    expect(cc.strip.cells[0]!.totalPence).toBe(0);
  }, 60_000);

  it("appends the names to the blank-period sentence, and nothing when none failed", () => {
    const view = buildDashboardView({
      now: NOW,
      sites: [
        { id: "site-cc", name: "N15 Vitality Dental" },
        { id: "site-rv", name: "N17 Dental" },
      ],
      practitioners: [],
      payments: [],
      paymentsCoverage: null,
      takingsWindowTotals: new Map(),
      takingsFailedSites: ["site-rv"],
      appointments: null,
      appointmentsCoverage: null,
      appointmentRows: [],
      patients: null,
      plans: null,
      invoices: null,
      balances: null,
      claims: null,
    });
    expect(view.takingsFailedSites).toEqual(["site-rv"]);

    const names = view.takingsFailedSites.map(
      (id) => view.sites.find((s) => s.id === id)?.name ?? id,
    );
    const withNames = takingsCaveats({
      strip: group(view).strip,
      unattributedPayments: 0,
      droppedPayments: 0,
      failedSiteNames: names,
    });
    expect(withNames.find((c) => c.id === "takings-blank")?.text).toContain(
      "The site that did not answer: N17 Dental.",
    );

    const without = takingsCaveats({
      strip: group(view).strip,
      unattributedPayments: 0,
      droppedPayments: 0,
    });
    expect(without.find((c) => c.id === "takings-blank")?.text).not.toContain("did not answer");
  });
});

// ---------------------------------------------------------------------------
// F6 — the mock's own invoices used to fall out of the filter
// ---------------------------------------------------------------------------

describe("F6: the generated mock invoices survive the date filter the route applies", () => {
  it("gives every generated invoice a created_at on its own day", async () => {
    const { generatedInvoices } = await import("@/app/api/mock-dentally/_dashboard-fixtures");
    const rows = generatedInvoices();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.created_at).toBe("string");
      expect(row.created_at.slice(0, 10)).toBe(row.date);
    }
  });

  it("returns rows for a windowed request, so INVOICED is not a confident £0.00 in dev", async () => {
    // THE BUG THIS PINS: the fixtures carried only `date`, the route filters on
    // `created_at` and drops rows without one, so the windowed scan got zero rows,
    // read that as a COMPLETE read of an empty window, and rendered a billing panel
    // as £0.00 — a plausible number, which is worse than a blank.
    const { GET } = await import("@/app/api/mock-dentally/v1/invoices/route");
    const today = new Date().toISOString().slice(0, 10);
    const url = new URL("http://dentally.invalid/api/mock-dentally/v1/invoices");
    url.searchParams.set("created_after", shiftDay(today, -30));
    url.searchParams.set("created_before", shiftDay(today, 1));
    url.searchParams.set("per_page", "100");
    const res = await GET(new Request(url, { headers: { Authorization: "Bearer probe" } }));
    const body = (await res.json()) as { invoices: unknown[]; meta: { total: number } };
    expect(body.meta.total).toBeGreaterThan(0);
    expect(body.invoices.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F7 — bucket on the field the server filtered on
// ---------------------------------------------------------------------------

describe("F7: an invoice is bucketed on created_at, the field the filter uses", () => {
  // Live /v1/invoices has no `date` and no `issued_at` (0 of 300 rows). The old key
  // order preferred both and was therefore correct only by falling through. The
  // invariant is that the filter and the bucket are the SAME field.

  async function windowedRows(rows: unknown[]): Promise<PracticeDashboardView> {
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (!path.endsWith("/v1/invoices")) return undefined;
      if (q.get("created_after") === null) return undefined;
      return { invoices: rows, meta: { total: rows.length, current_page: 1 } };
    });
    return readDashboard();
  }

  it("prefers created_at over dated_on when the two disagree", async () => {
    const view = await windowedRows([
      {
        id: "inv-backdated",
        patient_id: "pat-1",
        amount: "80.00",
        amount_outstanding: "0.00",
        created_at: `${TODAY}T10:00:00+01:00`,
        dated_on: shiftDay(TODAY, -40),
      },
    ]);
    // Today, because today is the day the server's own filter placed it in.
    expect(group(view).periods.today.invoiced.totalPence.value).toBe(8_000);
  }, 60_000);

  it("falls back to dated_on when there is no created_at", async () => {
    const view = await windowedRows([
      {
        id: "inv-dated-only",
        patient_id: "pat-1",
        amount: "45.00",
        amount_outstanding: "0.00",
        dated_on: TODAY,
      },
    ]);
    expect(group(view).periods.today.invoiced.totalPence.value).toBe(4_500);
  }, 60_000);

  it("treats a row carrying only the phantom `date` key as UNDATED", async () => {
    // `date` does not exist on live. A mock or a fixture that invents it must not be
    // able to place a row in a window the real filter never selected it for.
    const view = await windowedRows([
      { id: "inv-phantom", patient_id: "pat-1", amount: "60.00", amount_outstanding: "0.00", date: TODAY },
    ]);
    const panel = group(view).periods.today.invoiced;
    expect(panel.undatedInvoices).toBe(1);
    expect(panel.totalPence.value).toBeNull();
    expect(panel.totalPence.reason).toContain("no invoice carries a date");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F8 — one meta.total parser
// ---------------------------------------------------------------------------

describe("F8: meta.total is parsed in exactly one place", () => {
  const readSource = readFileSync(join(process.cwd(), "src/lib/dashboard/read.ts"), "utf8");

  it("imports the shared parser and declares none of its own", () => {
    expect(readSource).toContain('from "@/lib/reports/scan"');
    expect(readSource, "read.ts has grown its own metaTotal again").not.toMatch(
      /function\s+metaTotal\s*\(/,
    );
    // The grammar itself, hand-inlined, is the copy that hid inside paymentsWindowTotal.
    expect(readSource, "a hand-rolled row-count grammar is back in read.ts").not.toContain(
      "/^\\d+$/",
    );
  });

  it("uses it on BOTH the takings aggregate and the paging guard", async () => {
    // Dentally can send `total` as a string. One parser means one answer to that on
    // every path; three copies meant three that only happened to agree.
    const rec = newRecorder();
    globalThis.fetch = harness(rec, (path, q) => {
      if (path.endsWith("/v1/payments")) {
        return { payments: [], meta: { total: "3", total_amount: "12.34", current_page: 1 } };
      }
      if (path.endsWith("/v1/invoices") && q.get("paid") === "false") {
        return { invoices: [], meta: { total: String(UNREACHABLE), current_page: 1 } };
      }
      return undefined;
    });

    const view = await readDashboard();
    // The aggregate path read the string count.
    const today = group(view).strip.cells.find((c) => c.period === "today")!;
    expect(today.paymentCount).toBe(3 * SITE_IDS.length);
    expect(today.totalPence).toBe(1_234 * SITE_IDS.length);
    // The paging guard read the same string and refused the walk.
    expect(
      rec.calls.filter((c) => c.path.endsWith("/v1/invoices") && c.q.get("paid") === "false").length,
    ).toBe(SITE_IDS.length);
    expect(group(view).accounts.netBalancePence.value).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The site map this file asserts against is the real one.
// ---------------------------------------------------------------------------

describe("the fixture's site ids are this client's actual sites", () => {
  it("matches src/lib/mock/clients.ts", async () => {
    const { getSites, dentallySiteId } = await import("@/lib/mock/clients");
    const sites = getSites(CLIENT);
    expect(sites.map((s) => s.id).sort()).toEqual([...SITE_IDS].sort());
    for (const site of sites) {
      expect(dentallySiteId(site.id)).toBe(SITE_UUIDS[site.id]);
      expect(UUID_TO_SITE.get(SITE_UUIDS[site.id]!)).toBe(site.id);
    }
  });
});
