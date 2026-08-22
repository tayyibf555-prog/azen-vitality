import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// F4 — SITE-SCOPING THE UNPAID READ MEANS AGREEING NOT TO SEE SOME ROWS. SAY SO.
//
// The ACCOUNTS balance is read as three `site_id` slices of `paid=false`, one per
// practice. That lifted a 4,000-row ceiling live was 147 invoices away from hitting,
// and it stopped the group-wide slice dragging in debtors of practices this client
// does not run. It also introduced a silence: an unpaid invoice filed under NO site
// reaches none of the three reads.
//
// Such a row is not hypothetical rubbish. Balances are attributed to a PATIENT
// (siteByPatientId), not to the invoice's own site, so an unsited invoice can belong
// to a patient of this very practice — and that patient's balance was simply short,
// with nothing on the screen to say a row had been left out. Meanwhile
// src/lib/dashboard/accounts.ts still explained the patient-based attribution by
// claiming invoices "do not carry a site", which /v1/invoices flatly contradicts: it
// carries site_id and filters on it (live: 22,600 of 34,201 rows for N15 alone).
//
// THE FIX IS A RECONCILIATION, NOT A FOURTH READ. `paid=false` with per_page=1 costs
// ONE request and returns `meta.total` — every unpaid invoice in the account. What
// the three slices actually brought back, minus that, is what is missing. Reading
// those rows instead would be a group-wide walk of ~39 pages on live, which is the
// walk the site split exists to avoid.
//
// AND THE SENTENCE DOES NOT OVERCLAIM. The key sees an umbrella of five sites, of
// which this client runs three, so the gap is unsited rows AND other practices' rows
// mixed together, and no cheap read separates them. The caveat names both causes and
// commits to neither.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "unpaid-site-reconciliation";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

const NOW = new Date("2026-08-20T10:00:00Z");
const SITE_IDS = ["site-cc", "site-rv", "site-ng"] as const;
/** Two unpaid invoices a site, £10 outstanding each. */
const PER_SITE = 2;
const OWED_PENCE = 1_000;

interface Probe {
  /** Every `paid=false` request that carried no site_id: the reconciliation probe. */
  probes: URLSearchParams[];
}

/**
 * An upstream that honours site_id on /v1/invoices, exactly as live does.
 *
 * `groupUnpaidTotal` is what the group-wide probe reports. Set above the sum of the
 * site slices and the difference is rows the slices cannot see — the unsited invoice
 * below is one of them, and it is deliberately NOT returned by any site read, because
 * that is precisely what "carries no site" means to a site-scoped query.
 */
function upstream(opts: {
  probe: Probe;
  groupUnpaidTotal: number | null;
  probeStatus?: number;
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (key !== "invoices") return json({ [key]: [], meta: { total: 0, current_page: 1 } });

    const site = q.get("site_id");
    const paid = q.get("paid");
    const page = Number(q.get("page") ?? "1");

    // THE PROBE: paid=false, no site, one row.
    if (paid === "false" && site === null) {
      opts.probe.probes.push(q);
      if (opts.probeStatus !== undefined) {
        return new Response("upstream is sick", { status: opts.probeStatus });
      }
      if (opts.groupUnpaidTotal === null) return json({ invoices: [] });
      return json({ invoices: [], meta: { total: opts.groupUnpaidTotal, current_page: 1 } });
    }

    // A SITE SLICE. Only rows filed under this site — an unsited invoice is invisible.
    if (paid === "false" && site !== null) {
      const rows =
        page > 1
          ? []
          : Array.from({ length: PER_SITE }, (_, i) => ({
              id: `inv-${site}-${i}`,
              patient_id: `pat-${site}-${i}`,
              site_id: site,
              amount: "10.00",
              amount_outstanding: "10.00",
              paid: false,
            }));
      return json({ invoices: rows, meta: { total: PER_SITE, current_page: page } });
    }

    // The windowed INVOICED read: not this file's subject.
    return json({ invoices: [], meta: { total: 0, current_page: page } });
  }) as typeof fetch;
}

type View = import("./view").PracticeDashboardView;

async function assemble(opts: {
  probe: Probe;
  groupUnpaidTotal: number | null;
  probeStatus?: number;
}): Promise<View> {
  globalThis.fetch = upstream(opts);
  const { readPracticeDashboard } = await import("./read");
  return readPracticeDashboard({ clientId: "vitality", now: NOW });
}

function group(view: View) {
  const scope = view.scopes.find((s) => s.siteId === null);
  expect(scope).toBeTruthy();
  return scope!;
}

const READ_ROWS = PER_SITE * SITE_IDS.length;

describe("F4: an unpaid invoice with no site is disclosed, not swallowed", () => {
  it("counts the gap between what the site reads returned and what Dentally holds", async () => {
    const probe: Probe = { probes: [] };
    // One more unpaid invoice exists than the three site slices could see. On live it
    // is either an unsited row — which may be one of THESE patients' — or another
    // practice's. The read cannot tell, and does not pretend to.
    const view = await assemble({ probe, groupUnpaidTotal: READ_ROWS + 1 });

    expect(group(view).accounts.unattributedUnpaid).toBe(1);

    // The probe is a probe: one request, one row asked for, no rows used.
    expect(probe.probes.length).toBe(1);
    expect(probe.probes[0]!.get("per_page")).toBe("1");
    expect(probe.probes[0]!.get("site_id")).toBeNull();
  }, 120_000);

  it("says it on the screen, in a sentence that claims only what was measured", async () => {
    const { accountsCaveats } = await import("@/components/client/dashboard/caveats");
    const probe: Probe = { probes: [] };
    const view = await assemble({ probe, groupUnpaidTotal: READ_ROWS + 3 });

    const caveat = accountsCaveats(group(view).accounts).find(
      (c) => c.id === "accounts-unattributed",
    );
    expect(caveat, "the omission is back to being silent").toBeTruthy();
    expect(caveat!.material).toBe(true);
    expect(caveat!.text).toContain("3 unpaid invoices");
    // BOTH causes, neither claimed. "N invoices carry no site" is a number this read
    // cannot stand behind while the key spans practices this client does not run.
    expect(caveat!.text).toContain("filed under no site, or under a practice outside this group");
    expect(caveat!.text).toContain("may be understated");
  }, 120_000);

  it("changes no figure: the balance is still what was actually read", async () => {
    // Disclosure only. A caveat that moved the total would be inventing debt.
    const probe: Probe = { probes: [] };
    const view = await assemble({ probe, groupUnpaidTotal: READ_ROWS + 1 });

    expect(group(view).accounts.netBalancePence.value).toBe(READ_ROWS * OWED_PENCE);
    expect(group(view).accounts.patientsInDebt.value).toBe(READ_ROWS);
  }, 120_000);

  it("CONTROL: says nothing when the site reads did see everything", async () => {
    const { accountsCaveats } = await import("@/components/client/dashboard/caveats");
    const probe: Probe = { probes: [] };
    const view = await assemble({ probe, groupUnpaidTotal: READ_ROWS });

    expect(group(view).accounts.unattributedUnpaid).toBe(0);
    expect(
      accountsCaveats(group(view).accounts).find((c) => c.id === "accounts-unattributed"),
    ).toBeUndefined();
  }, 120_000);

  it("CONTROL: a probe that could not be made is 'not checked', not 'none'", async () => {
    // And it must not blank a panel that read perfectly well. A disclosure we could
    // not make is not a reason to withhold the balance.
    const { accountsCaveats } = await import("@/components/client/dashboard/caveats");
    const probe: Probe = { probes: [] };
    const view = await assemble({ probe, groupUnpaidTotal: null, probeStatus: 503 });

    expect(group(view).accounts.unattributedUnpaid).toBeNull();
    expect(
      accountsCaveats(group(view).accounts).find((c) => c.id === "accounts-unattributed"),
    ).toBeUndefined();
    expect(group(view).accounts.netBalancePence.value).toBe(READ_ROWS * OWED_PENCE);
  }, 120_000);

  it("CONTROL: an endpoint that publishes no count is also 'not checked'", async () => {
    const probe: Probe = { probes: [] };
    const view = await assemble({ probe, groupUnpaidTotal: null });
    expect(group(view).accounts.unattributedUnpaid).toBeNull();
  }, 120_000);
});

describe("F4: a source that ignores site_id cannot manufacture a phantom gap", () => {
  it("compares the DE-DUPLICATED rows, not the sum of three site totals", async () => {
    // Our own mock ignores site_id and hands every site the whole set. Summing the
    // three per-site meta.totals there would report 3x the group total and turn the
    // subtraction into nonsense; the de-duplicated row count is what the panel is
    // actually built from, and is the honest left-hand side.
    const probe: Probe = { probes: [] };
    const shared = Array.from({ length: PER_SITE }, (_, i) => ({
      id: `inv-shared-${i}`,
      patient_id: `pat-shared-${i}`,
      amount: "10.00",
      amount_outstanding: "10.00",
      paid: false,
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      const q = url.searchParams;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (key !== "invoices") return json({ [key]: [], meta: { total: 0, current_page: 1 } });
      if (q.get("paid") !== "false") return json({ invoices: [], meta: { total: 0 } });
      if (q.get("site_id") === null) {
        probe.probes.push(q);
        return json({ invoices: [], meta: { total: PER_SITE, current_page: 1 } });
      }
      // site_id IGNORED: every site gets the same rows back.
      const page = Number(q.get("page") ?? "1");
      return json({
        invoices: page > 1 ? [] : shared,
        meta: { total: PER_SITE, current_page: page },
      });
    }) as typeof fetch;

    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    // 3 x 2 rows arrived, 2 distinct invoices survived the dedup, and the group holds
    // exactly those 2. Nothing is missing, and nothing is claimed to be.
    expect(group(view).accounts.unattributedUnpaid).toBe(0);
    expect(group(view).accounts.netBalancePence.value).toBe(PER_SITE * OWED_PENCE);
  }, 120_000);
});
