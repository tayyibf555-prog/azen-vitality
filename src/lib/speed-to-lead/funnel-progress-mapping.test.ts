import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// THE TWO READS OF THE SAME SIX COLUMNS, held against each other.
//
// WHAT THIS FILE IS ACTUALLY FOR. funnel_last_step and friends are read by two
// different queries: `select("*")` behind the worklist and the drawer (rowToLead),
// and a seven-column select by name behind the PUBLIC progress endpoint
// (findLeadFunnelSession, which reads no patient details on purpose). They were
// mapped twice, in two places, with the same five lines — so nothing in the suite
// would have noticed one of them drifting.
//
// AND THE DRIFT IS NOT COSMETIC. These two mappings meet: the practice reads
// "Abandoned at question 3 of 5" from one, and the endpoint decides whether a
// patient's next post may move the lead using the other (canAdvanceFunnelProgress
// compares against exactly this shape). A `?? null` on one side where the other
// has numOrNull is a lead the worklist shows at question 3 that the endpoint reads
// as having no funnel at all — and every further post from that patient's browser
// is then silently refused.
//
// So: one row fixture, both reads, byte-identical progress. Whatever a row does —
// numbers, PostgREST's numeric-as-string, a pre-0094 row where the columns are not
// in the response at all — the two must say the same thing.

type Result = { data: unknown; error: unknown };

const h = vi.hoisted(() => {
  let result: Result = { data: null, error: null };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) {
      b[m] = () => b;
    }
    b.maybeSingle = () => Promise.resolve(result);
    b.single = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    set: (r: Result) => {
      result = r;
    },
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { findLeadFunnelSession, getLead } from "./repository";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "repository.ts"), "utf8");

/** Everything a lead row carries that is NOT one of the six 0094 columns. */
const BASE_ROW = {
  id: "lead-1",
  site_id: "site-n15",
  dentally_patient_id: null,
  name: "A Patient",
  email: null,
  phone: "+447700900001",
  channel: "sms",
  treatment_interest: "invisalign",
  source: "assessment",
  score: 70,
  stage: "new",
  consent: null,
  created_at: "2026-08-21T10:00:00.000Z",
  first_response_at: null,
  conversation_id: null,
  updated_at: "2026-08-21T10:00:00.000Z",
  nurture_step: 0,
  nurture_next_at: null,
  funnel_session_nonce: "tok-abcdef123456",
};

/** The same row down both reads: the worklist's, and the public endpoint's. */
async function bothReads(row: Record<string, unknown>) {
  h.set({ data: row, error: null });
  const lead = await getLead("lead-1");
  const session = await findLeadFunnelSession("tok-abcdef123456");
  expect(lead, "the fixture did not come back from getLead").not.toBeNull();
  expect(session, "the fixture did not come back from findLeadFunnelSession").not.toBeNull();
  return { fromRowToLead: lead!.funnelProgress, fromSessionLookup: session!.progress };
}

beforeEach(() => {
  h.set({ data: null, error: null });
  vi.clearAllMocks();
});

describe("the six funnel columns are read the same way by both queries", () => {
  // MUTATION: give either read its own copy of the mapping and let one of them
  // drift — `?? null` instead of numOrNull, a forgotten column, a cast. The
  // worklist and the public endpoint would then describe the same lead
  // differently, and the patient's next post would be refused with nothing said.
  it.each([
    [
      "a migrated row with real numbers",
      {
        funnel_last_step: 5,
        funnel_total_steps: 7,
        funnel_flow_version: 3,
        funnel_last_step_at: "2026-08-21T10:05:00.000Z",
        funnel_completed_at: null,
      },
      {
        lastStep: 5,
        totalSteps: 7,
        flowVersion: 3,
        lastStepAt: "2026-08-21T10:05:00.000Z",
        completedAt: null,
      },
    ],
    [
      "PostgREST handing the numerics back as strings",
      {
        funnel_last_step: "5",
        funnel_total_steps: "7",
        funnel_flow_version: "3",
        funnel_last_step_at: "2026-08-21T10:05:00.000Z",
        funnel_completed_at: "2026-08-21T10:06:00.000Z",
      },
      {
        lastStep: 5,
        totalSteps: 7,
        flowVersion: 3,
        lastStepAt: "2026-08-21T10:05:00.000Z",
        completedAt: "2026-08-21T10:06:00.000Z",
      },
    ],
    [
      "a lead that never came through an authored funnel",
      {
        funnel_last_step: null,
        funnel_total_steps: null,
        funnel_flow_version: null,
        funnel_last_step_at: null,
        funnel_completed_at: null,
      },
      { lastStep: null, totalSteps: null, flowVersion: null, lastStepAt: null, completedAt: null },
    ],
    [
      // THE PRE-0094 CASE the whole `?? null` decision exists for: 0094 not applied,
      // so the six keys are simply not in the response. `undefined` and a NULL
      // column must be indistinguishable — on BOTH reads.
      "a database where 0094 has not been applied, so the columns are absent",
      {},
      { lastStep: null, totalSteps: null, flowVersion: null, lastStepAt: null, completedAt: null },
    ],
    [
      "junk in the numeric columns",
      {
        funnel_last_step: "",
        funnel_total_steps: "not a number",
        funnel_flow_version: null,
        funnel_last_step_at: null,
        funnel_completed_at: null,
      },
      { lastStep: null, totalSteps: null, flowVersion: null, lastStepAt: null, completedAt: null },
    ],
  ])("%s reads identically down both paths", async (_why, columns, expected) => {
    const { fromRowToLead, fromSessionLookup } = await bothReads({ ...BASE_ROW, ...columns });
    expect(
      fromSessionLookup,
      "rowToLead and findLeadFunnelSession disagree about the same row",
    ).toEqual(fromRowToLead);
    expect(fromRowToLead).toEqual(expected);
  });

  // The structural half of the same claim: an inline copy that happens to agree
  // today is still a copy, and it is how the disagreement above comes back.
  it("maps the six columns in exactly one place", () => {
    const mappings = SOURCE.match(/numOrNull\(r\.funnel_flow_version\)/g) ?? [];
    expect(
      mappings.length,
      "the funnel_* mapping has been written twice again; there is one funnelProgressFromRow",
    ).toBe(1);
    expect(SOURCE).toContain("funnelProgress: funnelProgressFromRow(r)");
    expect(SOURCE).toContain("progress: funnelProgressFromRow(r)");
  });
});
