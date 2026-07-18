import { describe, it, expect, vi, beforeEach } from "vitest";

// CONSENT POSTURE (GDPR): abandoned-booking leads are entered on IMPLIED consent from
// the booking step. That basis covers their single booking-related first contact, but
// NOT enrolment into the ongoing 3-touch MARKETING nurture cadence. listNurtureDue
// must therefore EXCLUDE source 'abandoned-booking' from the due-set, while genuine
// enquiry sources (smile-assessment, website, etc.), which gave marketing-shaped
// consent, still flow through and nurture as before.
//
// Verified against a chainable Supabase mock that HONOURS .neq(...) so the exclusion
// is proven behaviourally (the abandoned-booking row is filtered out of the returned
// leads), plus a check that the exclusion is wired on BOTH selection sub-queries
// (entry + subsequent).

const h = vi.hoisted(() => {
  let rows: Record<string, unknown>[] = [];
  const neqCalls: Array<[string, unknown]> = [];
  const makeBuilder = () => {
    const localNeq: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {};
    const pass = () => b;
    b.select = pass;
    b.eq = pass;
    b.in = pass;
    b.is = pass;
    b.not = pass;
    b.lte = pass;
    b.gte = pass;
    b.order = pass;
    b.neq = (col: string, val: unknown) => {
      localNeq.push([col, val]);
      neqCalls.push([col, val]);
      return b;
    };
    // .limit is terminal for these queries: resolve the seeded rows, minus anything
    // excluded by the .neq predicates recorded on THIS builder.
    b.limit = () => {
      const data = rows.filter((r) => localNeq.every(([col, val]) => r[col] !== val));
      return Promise.resolve({ data, error: null });
    };
    return b;
  };
  return {
    setRows: (r: Record<string, unknown>[]) => {
      rows = r;
    },
    reset: () => {
      rows = [];
      neqCalls.length = 0;
    },
    neqCalls,
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { listNurtureDue } from "./repository";

function leadRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lead-1",
    site_id: "site-cc",
    dentally_patient_id: null,
    name: "Test Lead",
    email: null,
    phone: "+447700900123",
    channel: "sms",
    treatment_interest: null,
    source: "smile-assessment",
    score: null,
    stage: "contacted",
    consent: { sms: true, marketing: true },
    created_at: "2026-06-20T09:00:00Z",
    first_response_at: "2026-06-20T09:01:00Z",
    conversation_id: "conv-1",
    updated_at: "2026-06-20T09:01:00Z",
    nurture_step: 0,
    nurture_next_at: null,
    ...o,
  };
}

const ARGS = {
  nowIso: "2026-07-01T00:00:00.000Z",
  entryCutoffIso: "2026-06-28T00:00:00.000Z",
  ageCutoffIso: "2026-05-02T00:00:00.000Z",
  limit: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe("listNurtureDue consent-posture exclusion", () => {
  it("EXCLUDES abandoned-booking leads but KEEPS genuine enquiry leads", async () => {
    h.setRows([
      leadRow({ id: "ab-1", source: "abandoned-booking" }),
      leadRow({ id: "sa-1", source: "smile-assessment" }),
    ]);

    const due = await listNurtureDue(ARGS);

    // The genuine enquiry lead is selected...
    expect(due.some((l) => l.source === "smile-assessment")).toBe(true);
    // ...and the abandoned-booking lead is NOT (implied consent does not extend to
    // the marketing nurture cadence).
    expect(due.some((l) => l.source === "abandoned-booking")).toBe(false);
    expect(due.some((l) => l.id === "ab-1")).toBe(false);
  });

  it("wires the source exclusion on BOTH selection sub-queries (entry + subsequent)", async () => {
    h.setRows([leadRow({ id: "sa-1", source: "smile-assessment" })]);

    await listNurtureDue(ARGS);

    const abExclusions = h.neqCalls.filter(([c, v]) => c === "source" && v === "abandoned-booking");
    expect(abExclusions).toHaveLength(2);
  });

  it("a website enquiry lead (marketing-shaped consent) still nurtures", async () => {
    h.setRows([leadRow({ id: "web-1", source: "website" })]);

    const due = await listNurtureDue(ARGS);

    expect(due.some((l) => l.id === "web-1")).toBe(true);
  });
});
