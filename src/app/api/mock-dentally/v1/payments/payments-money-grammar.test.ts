import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { sumAmountsPence, penceToDentallyAmount } from "@/app/api/mock-dentally/_money";
import { allPayments } from "@/app/api/mock-dentally/_finance-fixtures";
import { parseMoneyPence, parseAggregateAmountPence } from "@/lib/dashboard/money";
import { dentallySiteId } from "@/lib/mock/clients";

// ===========================================================================
// ONE MONEY GRAMMAR, SHARED — the mock's aggregate and the app's row sum must be
// the same arithmetic, not two implementations that happen to agree.
//
// `meta.total_amount` is the whole reason the takings panel can total a window in a
// single request instead of paging 30,000 rows. If the mock reaches that figure by a
// grammar of its own, then the agreement the panel is checked against locally is a
// coincidence, and the day the two drift the mock reports the APP as broken.
//
// It was not even a coincidence that held. The route's inline copy omitted
// parseMoneyPence's overflow guard, so an amount whose pence value is not a safe
// integer was COUNTED into total_amount and REFUSED by the reader — the mock scoring
// a row the app drops, which is the exact inversion of what a test double is for.
//
// These tests pin three things:
//   1. the mock's envelope equals the app's own row-by-row sum, on the real fixtures;
//   2. the mock's per-value verdict IS parseMoneyPence's, including on the values the
//      old inline regex got wrong — so re-introducing the copy fails here;
//   3. no fixture amount carries a sub-penny tail, because the day one does, the
//      >2dp rejection stops being harmless and this aggregate must render the exact
//      decimal sum live renders.
// ===========================================================================

/** What a caller queries with (Dentally knows its own UUIDs, not "site-cc"). */
const SITE_UUID = dentallySiteId("site-cc");
/** What the fixture rows actually carry, which resolveMockSiteId maps the UUID to. */
const SITE_INTERNAL = "site-cc";

async function metaFor(query: Record<string, string>): Promise<{
  total: number;
  total_amount: string;
}> {
  const url = new URL("http://localhost/api/mock-dentally/v1/payments");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await GET(new Request(url.href, { headers: { authorization: "Bearer test-token" } }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { meta: { total: number; total_amount: string } };
  return json.meta;
}

describe("mock /v1/payments money grammar", () => {
  it("agrees to the penny with the app's own row-by-row sum, unfiltered", async () => {
    const meta = await metaFor({});
    const expected = allPayments().reduce((acc, p) => acc + (parseMoneyPence(p.amount) ?? 0), 0);

    // Read the envelope the way the app reads it, through the AGGREGATE parser.
    expect(parseAggregateAmountPence(meta.total_amount)).toBe(expected);
    expect(meta.total).toBe(allPayments().length);
  });

  it("agrees to the penny on a site-scoped, date-windowed read", async () => {
    const rows = allPayments().filter((p) => p.site_id === SITE_INTERNAL);
    const days = [...new Set(rows.map((p) => p.dated_on))].sort();
    expect(days.length, "the fixture window must span several days").toBeGreaterThan(3);
    const from = days[1];
    const to = days[days.length - 2];

    const meta = await metaFor({ site_id: SITE_UUID, start_date: from, end_date: to });
    const windowed = rows.filter((p) => p.dated_on >= from && p.dated_on <= to);
    const expected = windowed.reduce((acc, p) => acc + (parseMoneyPence(p.amount) ?? 0), 0);

    expect(windowed.length, "the window must not be empty or this proves nothing").toBeGreaterThan(0);
    expect(meta.total).toBe(windowed.length);
    expect(parseAggregateAmountPence(meta.total_amount)).toBe(expected);
  });

  it("stays exact across paging: the envelope totals the SET, not the page", async () => {
    const full = await metaFor({ site_id: SITE_UUID });
    const paged = await metaFor({ site_id: SITE_UUID, page: "3", per_page: "25" });
    expect(paged.total_amount).toBe(full.total_amount);
    expect(paged.total).toBe(full.total);
  });

  it("drops exactly what parseMoneyPence drops — the malformed row contributes nothing", async () => {
    const malformed = allPayments().filter((p) => parseMoneyPence(p.amount) === null);
    expect(malformed.length, "the fixtures must keep a deliberately malformed amount").toBeGreaterThan(0);
    for (const row of malformed) {
      expect(sumAmountsPence([row.amount]), `${JSON.stringify(row.amount)} must contribute 0`).toBe(0);
    }
  });

  it("gives the SAME verdict as parseMoneyPence on every value, including the ones the old inline copy got wrong", () => {
    // The old copy was /^(-?)(\d+)(?:\.(\d{1,2}))?$/ with Number(whole) * 100 and no
    // safe-integer guard. Each row below is [value, why it matters].
    const cases: Array<[string, string]> = [
      ["27.9", "the ordinary one-decimal Dentally amount"],
      ["185.00", "two decimals, trailing zeros"],
      ["0", "a bare zero is a real figure, not a failure"],
      ["0.0", "a day with no takings"],
      ["-148.6", "a refund"],
      ["", "the deliberately malformed fixture row"],
      ["  27.9  ", "surrounding whitespace is trimmed by both"],
      ["27.999", "three decimals: rounding a ROW would be inventing a number"],
      ["1,234.56", "a thousands separator means we are reading a field we do not understand"],
      ["+27.9", "a leading plus is not Dentally's grammar"],
      ["27.", "no fractional digits after the point"],
      [".9", "no whole part"],
      ["1e3", "an exponent is not money"],
      ["n/a", "a word where a number should be"],
      // THE OVERFLOW ROW. The old regex accepted this and Number()*100 produced
      // 1e20 — silently counted into total_amount while the app refused it.
      ["999999999999999999", "pence value beyond Number.MAX_SAFE_INTEGER"],
      ["99999999999999999999999", "longer than the parser will even look at"],
    ];

    for (const [value, why] of cases) {
      const app = parseMoneyPence(value);
      const mock = sumAmountsPence([value]);
      expect(mock, `${JSON.stringify(value)} — ${why}`).toBe(app ?? 0);
    }

    // And the property, stated directly: a rejected value moves the total by nothing.
    for (const [value] of cases) {
      const withIt = sumAmountsPence(["10.00", value, "5.50"]);
      const withoutIt = sumAmountsPence(["10.00", "5.50"]);
      const contribution = parseMoneyPence(value) ?? 0;
      expect(withIt - withoutIt).toBe(contribution);
    }
  });

  it("renders the total the way Dentally does, from an integer and only once", () => {
    // Exactly ONE trailing zero is trimmed, which is Dentally's own rendering:
    // "27240.9" for a round penny, and "0.0" for a day with no takings — a real
    // zero, and not the same fact as a failed read.
    expect(penceToDentallyAmount(2_724_090)).toBe("27240.9");
    expect(penceToDentallyAmount(18_500)).toBe("185.0");
    expect(penceToDentallyAmount(2_790)).toBe("27.9");
    expect(penceToDentallyAmount(25_257)).toBe("252.57");
    expect(penceToDentallyAmount(0)).toBe("0.0");
    expect(penceToDentallyAmount(-14_886)).toBe("-148.86");
    // The float trap this exists to avoid: Number("27240.9") * 100 is
    // 2724089.9999999995, which would render "27240.89" and be a penny out.
    expect(penceToDentallyAmount(sumAmountsPence(["27240.9"]))).toBe("27240.9");
    expect(sumAmountsPence(["27240.9"])).toBe(2_724_090);
  });

  it("TRIPWIRE: no fixture amount carries a sub-penny tail", () => {
    // parseMoneyPence rejects >2dp, correctly, for a ROW. Live payments can carry
    // one anyway (payment 28647 is "0.0015") and live's total_amount includes it
    // EXACTLY. So the moment a fixture gains a sub-penny amount, this aggregate would
    // silently drop it and stop agreeing with live — and the fix is to render the
    // exact decimal sum here, not to delete this test.
    const subPenny = allPayments().filter(
      (p) => parseMoneyPence(p.amount) === null && parseAggregateAmountPence(p.amount) !== null,
    );
    expect(
      subPenny.map((p) => `${p.id}=${p.amount}`),
      "a fixture gained a sub-penny amount: total_amount must now be summed exactly (see _money.ts)",
    ).toEqual([]);
  });
});
