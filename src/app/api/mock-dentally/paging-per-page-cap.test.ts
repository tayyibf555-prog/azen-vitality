import { describe, it, expect } from "vitest";
import { mockPage, mockPerPage, DENTALLY_OVER_CAP_PER_PAGE, DENTALLY_PER_PAGE_CAP } from "./_paging";
import { GET as payments } from "./v1/payments/route";
import { GET as nhsClaims } from "./v1/nhs_claims/route";
import { GET as invoices } from "./v1/invoices/route";
import { GET as patients } from "./v1/patients/route";
import { GET as notes } from "./v1/notes/route";
import { GET as treatments } from "./v1/treatments/route";
import { GET as treatmentCategories } from "./v1/treatment_categories/route";
import { GET as treatmentPlans } from "./v1/treatment_plans/route";
import { GET as treatmentPlanItems } from "./v1/treatment_plan_items/route";
import { GET as appointments } from "./v1/appointments/route";
import { dentallySiteId } from "@/lib/mock/clients";

// ===========================================================================
// THE SILENT 25 — live Dentally's per_page cap, as MEASURED rather than as tidy.
//
// Live caps per_page at 100, and a request for 200/250/500 does not come back with
// 100 rows. It comes back with TWENTY-FIVE, status 200, nothing in the envelope
// saying the request was not honoured (measured 2026-08-21, recorded on listPayments
// and listNhsClaims in src/lib/dentally/client.ts).
//
// THAT ASYMMETRY IS THE WHOLE POINT. A clamp to 100 would be harmless: a caller
// asking 500 and receiving 100 sees a full page and keeps paging. A caller asking
// 500 and receiving 25 sees a page a QUARTER the size it already expected, and every
// pageAll walker in this repo terminates on `rows.length < perPage` — so it reads 25
// rows of a 30,000 row index and reports a COMPLETE read. That is the exact shape of
// the takings and UDA understatements (38% and 85%) that were shipped to a practice
// owner while the local suite was green, because the mock honoured any per_page it
// was handed.
//
// So these tests pin the 25, not the cap. If someone "fixes" _paging.ts to clamp to
// 100 — the reasonable-looking change — the assertions below fail, because a mock
// tidier than live hides the cliff instead of modelling it.
// ===========================================================================

const SITE = dentallySiteId("site-cc");
const AUTH = { headers: { authorization: "Bearer test-token" } } as const;

function req(path: string, query: Record<string, string>): Request {
  const url = new URL(`http://localhost/api/mock-dentally${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.href, AUTH);
}

/** Every paged list route, with the query that returns a large set and the key it
 *  answers under. `min` is how many rows that set must hold for the cap to be
 *  observable at all — asserted, so a shrinking fixture cannot silently void a test. */
const ROUTES: Array<{
  name: string;
  key: string;
  handler: (r: Request) => Promise<Response>;
  path: string;
  query: Record<string, string>;
}> = [
  { name: "payments", key: "payments", handler: payments, path: "/v1/payments", query: { site_id: SITE } },
  { name: "nhs_claims", key: "nhs_claims", handler: nhsClaims, path: "/v1/nhs_claims", query: { site_id: SITE } },
  { name: "invoices", key: "invoices", handler: invoices, path: "/v1/invoices", query: {} },
];

async function rowsOf(
  entry: (typeof ROUTES)[number],
  extra: Record<string, string>,
): Promise<unknown[]> {
  const res = await entry.handler(req(entry.path, { ...entry.query, ...extra }));
  expect(res.status, `${entry.name} must answer 200`).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  const rows = json[entry.key];
  expect(Array.isArray(rows), `${entry.name} must answer under key ${entry.key}`).toBe(true);
  return rows as unknown[];
}

describe("per_page: the silent 25", () => {
  it("honours per_page up to and including 100", () => {
    expect(mockPerPage("1")).toBe(1);
    expect(mockPerPage("25")).toBe(25);
    expect(mockPerPage("99")).toBe(99);
    expect(mockPerPage(String(DENTALLY_PER_PAGE_CAP))).toBe(DENTALLY_PER_PAGE_CAP);
  });

  it("collapses ANY per_page above 100 to 25 — not to 100, which is the trap", () => {
    for (const over of ["101", "200", "250", "500", "1000", "100000"]) {
      expect(mockPerPage(over), `per_page=${over} must return the silent 25`).toBe(
        DENTALLY_OVER_CAP_PER_PAGE,
      );
      expect(mockPerPage(over), `per_page=${over} must NOT be clamped to the cap`).not.toBe(
        DENTALLY_PER_PAGE_CAP,
      );
    }
  });

  it("falls back to 100 for an absent, unreadable or non-positive per_page", () => {
    expect(mockPerPage(null)).toBe(100);
    expect(mockPerPage("")).toBe(100);
    expect(mockPerPage("banana")).toBe(100);
    expect(mockPerPage("0")).toBe(100);
    expect(mockPerPage("-5")).toBe(1);
    expect(mockPerPage(null, 50)).toBe(50);
  });

  it("reads page as 1-based, defaulting to 1", () => {
    expect(mockPage(null)).toBe(1);
    expect(mockPage("1")).toBe(1);
    expect(mockPage("7")).toBe(7);
    expect(mockPage("0")).toBe(1);
    expect(mockPage("-3")).toBe(1);
    expect(mockPage("nonsense")).toBe(1);
  });

  it.each(ROUTES)(
    "/v1/$name serves 100 for per_page=100 and only 25 for per_page=250",
    async (entry) => {
      const hundred = await rowsOf(entry, { per_page: "100" });
      expect(
        hundred.length,
        `${entry.name} fixtures must hold >100 rows or this test proves nothing`,
      ).toBe(100);

      const overCap = await rowsOf(entry, { per_page: "250" });
      expect(overCap.length, `${entry.name} must silently drop to 25`).toBe(
        DENTALLY_OVER_CAP_PER_PAGE,
      );
    },
  );

  it.each(ROUTES)(
    "/v1/$name reports total_pages against the page size live WOULD have served",
    async (entry) => {
      const res = await entry.handler(req(entry.path, { ...entry.query, per_page: "250" }));
      const json = (await res.json()) as { meta?: { total?: number; total_pages?: number } };
      const total = json.meta?.total;
      expect(typeof total, `${entry.name} must publish meta.total`).toBe("number");
      // payments publishes no total_pages (live does not); the others do.
      if (typeof json.meta?.total_pages === "number") {
        expect(
          json.meta.total_pages,
          `${entry.name} must page the set at 25, not at the 250 it was asked for`,
        ).toBe(Math.ceil((total as number) / DENTALLY_OVER_CAP_PER_PAGE));
      }
    },
  );

  it.each(ROUTES)("/v1/$name walks pages of 25 without repeating or skipping", async (entry) => {
    // The pageAll behaviour the readers depend on: page 2 of an over-cap request must
    // be the NEXT 25 rows, not the same 25 and not rows 250..275.
    const first = await rowsOf(entry, { per_page: "250", page: "1" });
    const second = await rowsOf(entry, { per_page: "250", page: "2" });
    expect(first.length).toBe(25);
    expect(second.length).toBe(25);

    const fifty = await rowsOf(entry, { per_page: "50" });
    expect(fifty.length).toBe(50);
    expect(
      [...first, ...second],
      "two over-cap pages must reconstruct the first 50 rows exactly",
    ).toEqual(fifty);
  });

  it("applies the cap on the routes whose sets are smaller than it too", async () => {
    // These fixtures hold fewer than 25 rows, so the row COUNT cannot show the cap.
    // What can be shown is that the request is not simply ignored: page 2 of a
    // 25-row page is empty, which is what live does and what a walker relies on.
    const small: Array<[string, (r: Request) => Promise<Response>, string, Record<string, string>]> = [
      ["patients", patients, "/v1/patients", { site_id: SITE }],
      ["notes", notes, "/v1/notes", { patient_id: "pat-001" }],
      ["treatments", treatments, "/v1/treatments", {}],
      ["treatment_categories", treatmentCategories, "/v1/treatment_categories", {}],
      ["treatment_plans", treatmentPlans, "/v1/treatment_plans", { site_id: SITE }],
      ["treatment_plan_items", treatmentPlanItems, "/v1/treatment_plan_items", { patient_id: "pat-001" }],
    ];
    for (const [name, handler, path, query] of small) {
      const res = await handler(req(path, { ...query, per_page: "500", page: "2" }));
      expect(res.status, `${name} must answer 200`).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      const rows = Object.values(json).find(Array.isArray) as unknown[] | undefined;
      expect(rows, `${name} must answer with an array`).toBeDefined();
      expect(
        rows!.length,
        `${name} page 2 of a 25-row page must be empty, not the whole set again`,
      ).toBe(0);
    }
  });

  it("pages the site appointment index rather than dumping it", async () => {
    const res = await appointments(req("/v1/appointments", { site_id: SITE, per_page: "500" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { appointments: unknown[] };
    expect(
      json.appointments.length,
      "the diary index must never be handed more than live's silent 25 for an over-cap ask",
    ).toBeLessThanOrEqual(DENTALLY_OVER_CAP_PER_PAGE);
  });
});
