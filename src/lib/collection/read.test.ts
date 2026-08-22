// ---------------------------------------------------------------------------
// F1 — THE CLOSER'S LIVE READ OF WHAT A REAL PATIENT OWES.
//
// readPatientInvoices is the verification read: the sweep and the approval route
// both refuse to say anything about a patient's balance until this read has come
// back and agreed with the snapshot. Its `truncated` flag is what turns a partial
// history into a refusal (summariseBalance gets `unreadableCount: 1` and the whole
// patient is skipped), and until now that flag was raised by ONE piece of evidence:
// a page that came back under PER_PAGE.
//
// A short page is not evidence that a walk finished. /v1/invoices publishes
// `meta.total` — how many rows match this request — and the walk ignored it, so a
// server that stated 40 invoices and handed back 12 produced a "complete" history
// with 28 invoices missing from it, and the closer would have quoted a balance
// summed over the 12. That is a claim about a person's own money, sent to them
// mid-conversation. It has to be refused, not estimated.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted<{ listInvoices: (arg: unknown) => Promise<unknown> }>(() => ({
  listInvoices: () => Promise.resolve({ invoices: [] }),
}));

vi.mock("@/lib/dentally/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dentally/read")>()),
  dentallyFromEnv: () => ({ listInvoices: (a: unknown) => state.listInvoices(a) }),
}));

import { readPatientInvoices } from "./read";

const PER_PAGE = 100;
const inv = (i: number) => ({ id: `inv-${i}`, patient_id: "pat-1", amount: "10.0", amount_outstanding: "10.0" });

/** `count` rows on page one, then a short page, with whatever meta is published. */
function source(count: number, meta: unknown) {
  state.listInvoices = ((a: { page?: number }) => {
    const page = a.page ?? 1;
    const start = (page - 1) * PER_PAGE;
    const rows = Array.from({ length: Math.max(0, Math.min(PER_PAGE, count - start)) }, (_, i) =>
      inv(start + i),
    );
    return Promise.resolve({ invoices: rows, meta });
  }) as never;
}

beforeEach(() => {
  state.listInvoices = () => Promise.resolve({ invoices: [] });
});

describe("F1: readPatientInvoices measures its walk against meta.total", () => {
  it("REFUSES to call the history complete when Dentally says more invoices match than it returned", async () => {
    // Twelve rows, a short page, and Dentally stating forty. The closer must not
    // quote a balance summed over a third of somebody's account.
    source(12, { total: 40, current_page: 1 });

    const read = await readPatientInvoices("pat-1");

    expect(read.rows).toHaveLength(12);
    expect(
      read.truncated,
      "a provably partial invoice history was handed to the closer as a whole one",
    ).toBe(true);
  });

  it("CONTROL: a short page that reaches the published count is a complete history", async () => {
    source(12, { total: 12, current_page: 1 });

    const read = await readPatientInvoices("pat-1");
    expect(read.rows).toHaveLength(12);
    expect(read.truncated).toBe(false);
  });

  it("CONTROL: an envelope with no count keeps the short-page stop, exactly as before", async () => {
    source(12, undefined);

    const read = await readPatientInvoices("pat-1");
    expect(read.truncated).toBe(false);
  });

  it("CONTROL: exhausting the page bound is still truncated, count or no count", async () => {
    // MAX_PAGES is 5, so 500 full rows never reaches a short page.
    source(500, { total: 500, current_page: 1 });

    const read = await readPatientInvoices("pat-1");
    expect(read.rows).toHaveLength(500);
    expect(read.truncated).toBe(true);
  });

  it("counts RAW rows against the total, not the ones that survived the patient filter", async () => {
    // The client-side patient filter is a safety net against an endpoint that ignores
    // patient_id. Comparing the FILTERED rows against a total describing the raw
    // result set would report every such response as truncated for ever.
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve(
        (a.page ?? 1) === 1
          ? {
              invoices: [inv(1), { ...inv(2), patient_id: "someone-else" }],
              meta: { total: 2, current_page: 1 },
            }
          : { invoices: [], meta: { total: 2, current_page: 2 } },
      )) as never;

    const read = await readPatientInvoices("pat-1");
    expect(read.rows).toHaveLength(1); // the other patient's row is dropped
    expect(read.truncated).toBe(false); // but the WALK saw everything Dentally holds
  });
});
