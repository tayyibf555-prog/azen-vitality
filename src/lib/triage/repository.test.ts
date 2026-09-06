import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeSupabase, POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";
import type { TriageTarget } from "./types";

// ===========================================================================
// THE THREE PROPERTIES OF THIS REPOSITORY THAT NOTHING ELSE COULD HOLD.
//
// There was no test file here at all, which is why all three of the defects
// below shipped. Every other suite that touches this module mocks it: the public
// submit route's gate tests replace `@/lib/triage/repository` wholesale, the
// drain's pipeline tests replace every module's outbox reader, and the J2
// scenario drives the real code but only along the happy path, in a single
// simulated instant, with nothing failing. So this file runs the REAL functions
// — the exact ones the submit route and the shared messaging drain import —
// against an in-memory database that applies migration 0097's own column
// defaults, and makes the failures happen.
//
//   1. A PATIENT NEVER LOSES THEIR ANSWERS (ruling W3/6). recordResponse spends
//      the link before it writes the answers, so a failure on that write has to
//      hand the link back.
//   2. A PRE-VISIT LINK IS NEVER SENT AFTER THE VISIT (ruling W3/5). The queue
//      had a floor (`not_before_at`) and no ceiling.
//   3. A COUNT IS A TOTAL OR IT SAYS IT IS NOT (charter §0/5, ruling W3/11).
//      The interest tallies came off an unranged select, which PostgREST clips
//      at its max-rows with `error: null`.
//   4. AND IT COSTS WHAT IT IS WORTH. That scan runs inside the module page's
//      own server render, so its query shape is the page's latency: one page's
//      worth of rows must cost one round trip, and a table past the ceiling
//      must cost the count that proves it rather than twenty pages ending in
//      "The totals could not be read."
// ===========================================================================

const fake = createFakeSupabase();

// ---------------------------------------------------------------------------
// THE INTEREST SCAN'S OWN DATABASE DOUBLE.
//
// The shared fake has no `.or()`, because a keyset cursor is a PostgREST filter
// STRING rather than a chain of typed calls — and the things worth pinning about
// this scan are properties OF THE QUERY, which the shared fake cannot see: how
// many round trips one answer costs, that each page asks for "strictly older than
// the row I stopped at" rather than "skip the first N rows", and that the filter
// string is a shape PostgREST would actually understand. So SELECTs on
// treatment_interest go through this, and everything else — every other table, and
// the inserts on this one — stays on the shared fake.
//
// `.range()` is deliberately present and deliberately fatal: OFFSET paging is the
// defect this replaced, and if it ever comes back it fails loudly here rather than
// passing every assertion until a scan spends its budget re-reading rows.
// ---------------------------------------------------------------------------

interface FakeInterestRow extends Record<string, string> {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  treatment: string;
  answer: string;
  created_at: string;
}

const interest = {
  /** One entry per SELECT that reached treatment_interest, in order. */
  queries: [] as Array<"page" | "count">,
  /** Every keyset filter string the repository built, in order. */
  filters: [] as string[],
  /** Every page WIDTH the repository asked for (.limit), in order. */
  limits: [] as number[],
  /**
   * The server's own max-rows ceiling, modelling PostgREST (ruling W3/32).
   *
   * `null` is "no ceiling", which is what every test above wants: they set tiny
   * page sizes on purpose and a ceiling would only get in the way. Set it to a
   * number and the double CLIPS a page to it, silently — no error, exactly as
   * live does — which is the shape a page size sitting on the ceiling cannot see.
   */
  serverCeiling: null as number | null,
  /** Force the count read to fail, so the scan's life without it is testable. */
  failCount: false,
  /** Force the next page read to fail, for the fail-closed direction. */
  failPage: false,
  /** Fires after each page is served — the seam for a concurrent insert. */
  onPage: null as ((pageIndex: number) => void) | null,
  /**
   * What `interest_counts_by_treatment` answers, or null for a database where
   * migration 0101 has not been applied — which is every database today, and is
   * why the default is the refusal rather than the answer.
   */
  rpc: null as null | (() => { data: unknown; error: unknown }),
  /** Every rpc name called, in order. */
  rpcCalls: [] as string[],
  reset() {
    this.queries.length = 0;
    this.filters.length = 0;
    this.limits.length = 0;
    this.serverCeiling = null;
    this.failCount = false;
    this.failPage = false;
    this.onPage = null;
    this.rpc = null;
    this.rpcCalls.length = 0;
  },
};

/**
 * Read back the keyset filter the repository wrote, and apply it.
 *
 * Doubles as a syntax check: if the string ever stops being the shape PostgREST
 * would understand, this throws rather than quietly passing.
 */
function applyKeyset(rows: FakeInterestRow[], filter: string): FakeInterestRow[] {
  const m = filter.match(
    /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)$/,
  );
  if (!m) throw new Error(`unrecognised keyset filter: ${filter}`);
  const [, ltTs, eqTs, gtId] = m;
  expect(ltTs).toBe(eqTs);
  return rows.filter((r) => r.created_at < ltTs! || (r.created_at === eqTs! && r.id > gtId!));
}

function interestSelect(opts?: { count?: string; head?: boolean }) {
  const head = opts?.head === true;
  const pageIndex = interest.queries.length;
  interest.queries.push(head ? "count" : "page");
  const eqs: Array<[string, string]> = [];
  let sites: string[] = [];
  let keyset: string | null = null;
  const orderBy: Array<[string, boolean]> = [];
  let max: number | null = null;

  function result() {
    if (head && interest.failCount) return { data: null, error: { message: "count read down" }, count: null };
    if (!head && interest.failPage) return { data: null, error: { message: "page read down" }, count: null };
    let rows = (fake.rows("treatment_interest") as unknown as FakeInterestRow[])
      .filter((r) => sites.includes(r.site_id))
      .filter((r) => eqs.every(([k, v]) => r[k] === v));
    if (keyset) rows = applyKeyset(rows, keyset);
    for (const [col, asc] of [...orderBy].reverse()) {
      rows = [...rows].sort((a, b) => (asc ? 1 : -1) * (a[col]! < b[col]! ? -1 : a[col]! > b[col]! ? 1 : 0));
    }
    if (head) return { data: [], error: null, count: rows.length };
    const wanted = max === null ? rows : rows.slice(0, max);
    // The server's ceiling on top of the window, in that order, and the ceiling
    // wins — a clipped response is indistinguishable from a short one.
    const clipped = interest.serverCeiling === null ? wanted : wanted.slice(0, interest.serverCeiling);
    const page = clipped.map((r) => ({ ...r }));
    interest.onPage?.(pageIndex);
    return { data: page, error: null, count: null };
  }

  const api = {
    eq(col: string, val: string) {
      eqs.push([col, val]);
      return api;
    },
    in(_col: string, vals: string[]) {
      sites = vals;
      return api;
    },
    or(filter: string) {
      keyset = filter;
      interest.filters.push(filter);
      return api;
    },
    order(col: string, o?: { ascending?: boolean }) {
      orderBy.push([col, o?.ascending !== false]);
      return api;
    },
    limit(n: number) {
      max = n;
      interest.limits.push(n);
      return api;
    },
    range() {
      throw new Error("OFFSET paging (.range) is not allowed on the interest scan");
    },
    then<T>(onfulfilled?: (v: ReturnType<typeof result>) => T, onrejected?: (r: unknown) => T) {
      return Promise.resolve(result()).then(onfulfilled, onrejected);
    },
  };
  return api;
}

/**
 * treatment_interest gets the double for its SELECTs and the shared fake for its
 * INSERTs (recordResponse's, which the tests above read back with `fake.rows`).
 * Every other table is untouched. Anything else called on this table is a method
 * this double does not have, which fails loudly rather than silently.
 */
const client = {
  from(table: string) {
    if (table !== "treatment_interest") return fake.client.from(table);
    type Insert = Parameters<ReturnType<typeof fake.client.from>["insert"]>[0];
    return {
      insert: (rows: Insert) => fake.client.from(table).insert(rows),
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => interestSelect(opts),
    };
  },
  /**
   * PostgREST's function door. `PGRST202` is what a real project answers before
   * migration 0101 is applied — the function is not in the schema cache — and it
   * is the default here for exactly that reason: the fallback path is the one
   * every test above already exercises, and it must stay the one that runs.
   */
  async rpc(name: string) {
    interest.rpcCalls.push(name);
    if (interest.rpc) return interest.rpc();
    return {
      data: null,
      error: { code: "PGRST202", message: `Could not find the function public.${name}` },
    };
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => client }));

const {
  recordResponse,
  listQueuedOutbox,
  markOutboxBlocked,
  markOutboxFailed,
  listResponsesForPatient,
  countInterestByTreatment,
  countInterestByTreatmentDetailed,
  listInterestToCompletion,
} = await import("./repository");
const { previsitSummaryFor } = await import("./summary-read");

const SITE = "site-ng";
const OTHER_SITE = "site-n17";

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = Date.now();
function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}
const HOUR = 3_600_000;

function target(overrides: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: `${SITE}:appt-1`,
    siteId: SITE,
    dentallyPatientId: "dp-1",
    appointmentId: "appt-1",
    patientName: "Amara Okafor",
    fork: "brief",
    appointmentAt: iso(12 * HOUR),
    dueAt: iso(-1 * HOUR),
    status: "sent",
    stopReason: null,
    consentSms: true,
    linkToken: "tok-aaaaaaaaaaaaaaaaaaaa",
    createdAt: iso(-24 * HOUR),
    updatedAt: iso(-24 * HOUR),
    ...overrides,
  };
}

function seedTarget(t: TriageTarget): void {
  fake.seed("previsit_target", {
    id: t.id,
    site_id: t.siteId,
    dentally_patient_id: t.dentallyPatientId,
    appointment_id: t.appointmentId,
    patient_name: t.patientName,
    fork: t.fork,
    appointment_at: t.appointmentAt,
    due_at: t.dueAt,
    status: t.status,
    stop_reason: t.stopReason,
    consent_sms: t.consentSms,
    link_token: t.linkToken,
  });
}

const ANSWERS = [
  { key: "attending", value: "yes", kind: "logistics" as const },
  { key: "smile-change", value: "Straighter front teeth", kind: "cosmetic" as const },
];
const INTEREST = [
  { treatment: "whitening" as const, answer: "yes" as const },
  { treatment: "implants" as const, answer: "not_now" as const },
];

beforeEach(() => {
  fake.reset();
  interest.reset();
});

// ---------------------------------------------------------------------------
// 1. W3/6
// ---------------------------------------------------------------------------
describe("recordResponse: a failed write hands the link back (W3/6)", () => {
  it("a response insert that fails leaves the link SPENDABLE and loses nothing", async () => {
    const t = target();
    seedTarget(t);

    // The one write that can fail between spending the link and storing the
    // answers. 'answered' is terminal and both public doors refuse it, so a claim
    // left standing here would take the patient's answers with it for good.
    fake.failTable("previsit_response");
    await expect(
      recordResponse({ target: t, answers: ANSWERS, interest: INTEREST, submittedAt: iso(0) }),
    ).rejects.toBeDefined();

    expect(fake.rows("previsit_response")).toHaveLength(0);
    expect(fake.rows("previsit_target")[0].status, "the link was left spent for answers that were never stored").toBe(
      "sent",
    );

    // AND THE PATIENT'S RETRY WORKS, which is the whole point: the sentence the
    // route shows them is "please try again", and trying again has to be a thing
    // they can do.
    fake.clearFailures();
    const retry = await recordResponse({ target: t, answers: ANSWERS, interest: INTEREST, submittedAt: iso(0) });
    expect(retry.ok).toBe(true);
    expect(fake.rows("previsit_response")).toHaveLength(1);
    expect(fake.rows("previsit_target")[0].status).toBe("answered");
    expect(fake.rows("treatment_interest")).toHaveLength(2);
  });

  it("restores the status the link resolved under, not a status it never had", async () => {
    const t = target({ status: "queued" });
    seedTarget(t);
    fake.failTable("previsit_response");
    await expect(
      recordResponse({ target: t, answers: ANSWERS, interest: [], submittedAt: iso(0) }),
    ).rejects.toBeDefined();
    expect(fake.rows("previsit_target")[0].status).toBe("queued");
  });

  it("still spends the link exactly once on the happy path, so a double submit is a duplicate", async () => {
    // The property the claim-first order exists for. The rollback must not have
    // turned the at-most-once guarantee into a retry loop.
    const t = target();
    seedTarget(t);
    const first = await recordResponse({ target: t, answers: ANSWERS, interest: INTEREST, submittedAt: iso(0) });
    expect(first.ok).toBe(true);
    const second = await recordResponse({ target: t, answers: ANSWERS, interest: INTEREST, submittedAt: iso(0) });
    expect(second).toEqual({ ok: false, reason: "duplicate" });
    expect(fake.rows("previsit_response")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. W3/5
// ---------------------------------------------------------------------------
describe("listQueuedOutbox: never a pre-visit link after the visit (W3/5)", () => {
  function seedQueued(args: {
    outboxId: string;
    touchId: string;
    targetId: string | null;
    appointmentAt?: string;
    siteId?: string;
  }): void {
    const siteId = args.siteId ?? SITE;
    if (args.targetId) {
      seedTarget(
        target({
          id: args.targetId,
          siteId,
          appointmentAt: args.appointmentAt ?? iso(12 * HOUR),
          status: "queued",
        }),
      );
    }
    fake.seed("previsit_touch", {
      id: args.touchId,
      target_id: args.targetId ?? "no-such-target",
      site_id: siteId,
      channel: "sms",
      body: "Before your visit, a few quick questions.",
      status: "queued",
    });
    fake.seed("previsit_outbox", {
      id: args.outboxId,
      touch_id: args.touchId,
      site_id: siteId,
      channel: "sms",
      to_ref: "dp-1",
      body: "Before your visit, a few quick questions.",
      status: "queued",
      not_before_at: iso(-1 * HOUR),
      created_at: iso(-2 * HOUR),
    });
  }

  it("hands over a link whose appointment is still ahead", async () => {
    seedQueued({ outboxId: "ob-ahead", touchId: "touch-ahead", targetId: `${SITE}:ahead`, appointmentAt: iso(12 * HOUR) });
    const rows = await listQueuedOutbox([SITE]);
    expect(rows.map((r) => r.id)).toEqual(["ob-ahead"]);
    expect(fake.rows("previsit_outbox")[0].status).toBe("queued");
  });

  it("RETIRES a link whose appointment has already started, and never returns it", async () => {
    // The outage case the drain's own 48h staleness ceiling does not cover: the
    // link was composed inside the lead window, so it is hours old, not days.
    seedQueued({ outboxId: "ob-past", touchId: "touch-past", targetId: `${SITE}:past`, appointmentAt: iso(-30 * 60_000) });
    expect(await listQueuedOutbox([SITE])).toEqual([]);

    const outbox = fake.rows("previsit_outbox")[0];
    expect(outbox.status).toBe("failed");
    expect(outbox.provider).toBe("expired");
    expect(fake.rows("previsit_touch")[0].status).toBe("failed");
    const t = fake.rows("previsit_target")[0];
    expect(t.status).toBe("stopped");
    expect(t.stop_reason).toBe("expired");
  });

  it("retires rather than hides, so a dead row cannot sit at the head of the batch for ever", async () => {
    seedQueued({ outboxId: "ob-past", touchId: "touch-past", targetId: `${SITE}:past`, appointmentAt: iso(-1 * HOUR) });
    await listQueuedOutbox([SITE]);
    // A second tick sees nothing at all: the row is no longer 'queued'.
    expect(await listQueuedOutbox([SITE])).toEqual([]);
    expect(fake.rows("previsit_outbox").filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("FAILS CLOSED on a row whose appointment cannot be read at all", async () => {
    // Not sent. Staleness we cannot establish is not staleness we may ignore —
    // the same direction decideSend takes for an undatable appointment.
    seedQueued({ outboxId: "ob-orphan", touchId: "touch-orphan", targetId: null });
    expect(await listQueuedOutbox([SITE])).toEqual([]);
    expect(fake.rows("previsit_outbox")[0].status).toBe("failed");
  });

  it("sorts the sendable from the expired in one batch rather than dropping both", async () => {
    seedQueued({ outboxId: "ob-past", touchId: "touch-past", targetId: `${SITE}:past`, appointmentAt: iso(-1 * HOUR) });
    seedQueued({ outboxId: "ob-ahead", touchId: "touch-ahead", targetId: `${SITE}:ahead`, appointmentAt: iso(6 * HOUR) });
    const rows = await listQueuedOutbox([SITE]);
    expect(rows.map((r) => r.id)).toEqual(["ob-ahead"]);
  });

  // -------------------------------------------------------------------------
  // WHAT THE RECORD SAYS ABOUT THE PATIENT WHEN A SEND DOES NOT HAPPEN.
  //
  // The drain's contract is `markBlocked(id)` with NO reason, and it calls it
  // from four branches: an opt-out, the output guardrail, an undeliverable
  // number, and the once-per-day cap. This module recorded all four as
  // `opted_out`, so a landline on a Dentally record would have been written up
  // as a patient who asked us to stop contacting them. Nothing renders
  // previsit_target.stop_reason today, which is why this was only ever a LOW
  // finding, and also exactly why it could sit there unnoticed until something
  // did.
  //
  // MUTATION: put `"opted_out"` back in markOutboxBlocked and this goes red.
  // -------------------------------------------------------------------------
  it("a blocked send never claims the patient opted out, because the drain never said so", async () => {
    seedQueued({ outboxId: "ob-blocked", touchId: "touch-blocked", targetId: `${SITE}:blocked` });
    await markOutboxBlocked("ob-blocked");

    const outbox = fake.rows("previsit_outbox")[0];
    expect(outbox.status).toBe("failed");
    expect(outbox.provider).toBe("suppressed");
    expect(fake.rows("previsit_touch")[0].status).toBe("failed");
    const t = fake.rows("previsit_target")[0];
    expect(t.status).toBe("stopped");
    expect(t.stop_reason, "a drain block was recorded as a statement about consent").toBe("blocked");
    expect(t.stop_reason).not.toBe("opted_out");
  });

  it("an UNDELIVERABLE send still says undeliverable, which is a different fact", async () => {
    // The other half: markOutboxFailed IS told what happened (no deliverable
    // contact at all), so it keeps its own, more specific word. If the two ever
    // collapsed into one reason the distinction the record needs would be gone.
    seedQueued({ outboxId: "ob-failed", touchId: "touch-failed", targetId: `${SITE}:failed` });
    await markOutboxFailed("ob-failed");
    expect(fake.rows("previsit_outbox")[0].status).toBe("failed");
    expect(fake.rows("previsit_target")[0].stop_reason).toBe("undeliverable");
  });
});

// ---------------------------------------------------------------------------
// 3. §0/5 + W3/11
// ---------------------------------------------------------------------------
describe("interest counts are read to the end, or say they were not (W3/11)", () => {
  function seedInterest(rows: Array<{ id: string; treatment: string; patient: string; answer?: string; site?: string }>) {
    let n = 0;
    for (const r of rows) {
      fake.seed("treatment_interest", {
        id: r.id,
        site_id: r.site ?? SITE,
        dentally_patient_id: r.patient,
        patient_name: r.patient,
        treatment: r.treatment,
        answer: r.answer ?? "yes",
        response_id: "resp-1",
        created_at: iso(-(++n) * 60_000),
      });
    }
  }

  const FIVE = [
    { id: "i-1", treatment: "whitening", patient: "dp-1" },
    { id: "i-2", treatment: "whitening", patient: "dp-1" }, // the SAME person, twice
    { id: "i-3", treatment: "whitening", patient: "dp-2" },
    { id: "i-4", treatment: "implants", patient: "dp-3" },
    { id: "i-5", treatment: "implants", patient: "dp-3" },
  ];

  it("PAGES to the end of the table rather than stopping at one page", async () => {
    // The defect, in miniature: one page held two rows and the truth needed five.
    // An unranged select looks identical to this until the table outgrows the
    // server's max-rows, at which point it starts under-reporting in silence.
    seedInterest(FIVE);
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary.counts).toEqual({ whitening: 2, implants: 1 });
    expect(summary.scanned).toBe(5);
    expect(summary.capped).toBe(false);
    // Three pages, and the one count read that asks whether the ceiling is even
    // reachable — issued after the first FULL page, never before it.
    expect(interest.queries).toEqual(["page", "count", "page", "page"]);
  });

  it("costs ONE query when one page holds the answer, which is every practice for a long while", async () => {
    // The pre-visit page renders this inside its own Promise.all, on every load,
    // in both trees, with nothing caching it. A second round trip for a table that
    // fits in a single page would be a latency regression on the common case, so
    // the count read is only ever asked after a page has come back full.
    seedInterest(FIVE);
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 10 });
    expect(summary).toEqual({ counts: { whitening: 2, implants: 1 }, capped: false, scanned: 5 });
    expect(interest.queries).toEqual(["page"]);
  });

  it("counts DISTINCT PATIENTS, and only the yeses, and only the sites in view", async () => {
    seedInterest([
      ...FIVE,
      { id: "i-6", treatment: "whitening", patient: "dp-9", answer: "not_now" },
      { id: "i-7", treatment: "whitening", patient: "dp-8", site: OTHER_SITE },
    ]);
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary.counts).toEqual({ whitening: 2, implants: 1 });
  });

  it("says CAPPED when the scan hits its ceiling instead of returning a floor as a total", async () => {
    seedInterest(FIVE);
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2, ceiling: 4 });
    expect(summary.capped).toBe(true);
    // And it STOPS at the count that proved the ceiling unreachable rather than
    // walking every page to the same conclusion: at the real numbers that is two
    // round trips instead of twenty, for a panel that then prints a sentence
    // rather than a figure. `scanned` is what was actually read, as it always was.
    expect(interest.queries).toEqual(["page", "count"]);
    expect(summary.scanned).toBe(2);
  });

  it("keeps paging when the count read fails, because that read only ever saves time", async () => {
    // Fail direction: not knowing the total may cost round trips and must never
    // cost accuracy. The scan carries on to its own short page and the figures are
    // the true totals, not floors.
    seedInterest(FIVE);
    interest.failCount = true;
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary).toEqual({ counts: { whitening: 2, implants: 1 }, capped: false, scanned: 5 });
    expect(interest.queries).toEqual(["page", "count", "page", "page"]);
  });

  it("THROWS when a page read fails rather than tallying the pages it did get", async () => {
    // The other fail direction, and the opposite answer: a page decides the
    // figures, so a page that did not come back cannot be quietly left out of them.
    seedInterest(FIVE);
    interest.failPage = true;
    await expect(countInterestByTreatmentDetailed([SITE], { pageSize: 2 })).rejects.toBeDefined();
  });

  it("the bare Record<string, number> shape REFUSES a capped read rather than printing a floor", async () => {
    // The two callers render this map as a headline number and as "distinct
    // patients who answered yes". Neither shape can say "at least", so the honest
    // answer is the sentence they already have for a read that did not work.
    seedInterest(FIVE);
    await expect(countInterestByTreatment([SITE], { pageSize: 2, ceiling: 4 })).rejects.toThrow(/floors rather than totals/);
    await expect(countInterestByTreatment([SITE], { pageSize: 2 })).resolves.toEqual({ whitening: 2, implants: 1 });
  });

  it("pages by CURSOR, not by OFFSET: each page asks for the rows after the one it stopped at", async () => {
    // `.range()` is fatal in this file's double, so the OFFSET walk this replaced
    // cannot come back unnoticed; this pins the thing that took its place. The
    // filter is a PostgREST string built by hand, so its exact shape is the
    // contract — applyKeyset re-parses it and blows up if it drifts.
    seedInterest(FIVE);
    await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    const secondRow = fake.rows("treatment_interest").find((r) => r.id === "i-2")!;
    expect(interest.filters[0]).toBe(
      `created_at.lt."${secondRow.created_at}",and(created_at.eq."${secondRow.created_at}",id.gt."i-2")`,
    );
    expect(interest.filters).toHaveLength(2); // one per page after the first
  });

  // The other half of the cursor guard (see the export walk's own test for why an
  // unasserted guard is the finding). BOTH call sites survive independently, so
  // one test pins one walk.
  //
  // MUTATION (T79-count): neuter the guard in `countInterestByTreatmentDetailed`
  // (`if (false) { break; }`) and this goes red.
  it("stops and says the counts are floors rather than page on a cursor it could not quote", async () => {
    seedInterest([
      { id: "i-1", treatment: "whitening", patient: "dp-1" },
      { id: 'i-2"evil', treatment: "whitening", patient: "dp-2" },
      { id: "i-3", treatment: "implants", patient: "dp-3" },
      { id: "i-4", treatment: "implants", patient: "dp-4" },
    ]);
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(interest.filters, "a cursor carrying a quote was pasted into the filter string").toEqual([]);
    // ONE page, and not even the count read that follows a trusted cursor.
    expect(interest.queries).toEqual(["page"]);
    expect(summary.scanned).toBe(2);
    // FAILS CLOSED: `capped` stands, so the grid prints "at least N" and the
    // caller that demands a total (countInterestByTreatment) refuses outright.
    expect(summary.capped, "a scan that stopped early printed its tallies as totals").toBe(true);
    await expect(countInterestByTreatment([SITE], { pageSize: 2 })).rejects.toThrow(/floors rather than totals/);
  });

  it("holds its place across rows that share an instant, which one submit always writes", async () => {
    // A submitted form writes up to four interest rows inside the same instant, so
    // `created_at` alone is not a cursor: without the id tiebreak a page boundary
    // landing inside such a batch either re-reads it for ever or steps over it.
    const sameInstant = iso(-5 * 60_000);
    for (const [id, patient] of [
      ["i-a", "dp-1"],
      ["i-b", "dp-2"],
      ["i-c", "dp-3"],
      ["i-d", "dp-4"],
    ] as const) {
      fake.seed("treatment_interest", {
        id,
        site_id: SITE,
        dentally_patient_id: patient,
        patient_name: patient,
        treatment: "whitening",
        answer: "yes",
        response_id: "resp-1",
        created_at: sameInstant,
      });
    }
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary).toEqual({ counts: { whitening: 4 }, capped: false, scanned: 4 });
  });

  it("does not re-read rows when the public form writes while the scan is running", async () => {
    // treatment_interest is written by the PUBLIC submit endpoint, so rows arrive
    // mid-scan. Under OFFSET every such insert shifts the result set down and the
    // next page hands back a row the last one already had — which spends a scan's
    // fixed budget on rows it has already counted and pushes real ones past the
    // ceiling. A cursor cannot be moved by an insert above it.
    seedInterest(FIVE);
    interest.onPage = (i) => {
      if (i !== 0) return;
      interest.onPage = null;
      fake.seed("treatment_interest", {
        id: "i-0",
        site_id: SITE,
        dentally_patient_id: "dp-99",
        patient_name: "dp-99",
        treatment: "whitening",
        answer: "yes",
        response_id: "resp-1",
        created_at: iso(0), // newer than everything already there
      });
    };
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    // Five rows read once each — not six reads for five rows. The row written
    // after the scan passed that point belongs to the next read, not this one.
    expect(summary.scanned).toBe(5);
    expect(summary.counts).toEqual({ whitening: 2, implants: 1 });
    expect(summary.capped).toBe(false);
  });

  it("an empty site scope reads nothing at all", async () => {
    seedInterest(FIVE);
    expect(await countInterestByTreatmentDetailed([])).toEqual({ counts: {}, capped: false, scanned: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5. §0/5 + W3/11 + W3/29 — THE FILE, NOT THE FIRST PAGE
// ---------------------------------------------------------------------------
describe("the export walks the interest list to the END of the table (W3/29)", () => {
  function seed(n: number, over: { treatment?: string; answer?: string; site?: string } = {}) {
    for (let i = 0; i < n; i++) {
      fake.seed("treatment_interest", {
        id: `w-${String(i).padStart(3, "0")}`,
        site_id: over.site ?? SITE,
        dentally_patient_id: `dp-${i}`,
        patient_name: `Patient ${i}`,
        treatment: over.treatment ?? "whitening",
        answer: over.answer ?? "yes",
        response_id: "resp-1",
        created_at: iso(-(i + 1) * 60_000),
      });
    }
  }

  it("returns EVERY row, not one PostgREST page of them", async () => {
    // THE DEFECT this pins: the export read `listInterest` once with a limit, so
    // past PostgREST's own max-rows it produced a clipped file with no error —
    // a sample of a marketing list wearing the whole list's clothes.
    seed(7);
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2 });
    expect(walk.rows).toHaveLength(7);
    expect(walk.capped).toBe(false);
    expect(walk.scanned).toBe(7);
    // Four round trips for seven rows at two a page: 2, 2, 2, 1 — and the short
    // last page is what proves the end of the table.
    expect(interest.queries).toEqual(["page", "page", "page", "page"]);
  });

  it("pages by CURSOR, never by offset, and holds its place across a shared instant", async () => {
    // `.range()` is fatal in this file's double, so the offset walk cannot come
    // back unnoticed. The tiebreak matters here for the same reason it does in
    // the count scan: one submitted form writes up to four rows in one instant.
    const sameInstant = iso(-5 * 60_000);
    for (const [id, patient] of [
      ["w-a", "dp-1"],
      ["w-b", "dp-2"],
      ["w-c", "dp-3"],
      ["w-d", "dp-4"],
    ] as const) {
      fake.seed("treatment_interest", {
        id,
        site_id: SITE,
        dentally_patient_id: patient,
        patient_name: patient,
        treatment: "whitening",
        answer: "yes",
        response_id: "resp-1",
        created_at: sameInstant,
      });
    }
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2 });
    expect(walk.rows.map((r) => r.id)).toEqual(["w-a", "w-b", "w-c", "w-d"]);
    expect(interest.filters[0]).toBe(
      `created_at.lt."${sameInstant}",and(created_at.eq."${sameInstant}",id.gt."w-b")`,
    );
  });

  it("says CAPPED at its ceiling rather than handing back a sample as the list", async () => {
    seed(7);
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2, ceiling: 4 });
    expect(walk.rows).toHaveLength(4);
    expect(walk.capped, "a clipped export claimed to be the whole list").toBe(true);
  });

  it("is capped at exactly the ceiling, because a full last page proves nothing", async () => {
    // The conservative boundary, matching the count scan: a table holding exactly
    // `ceiling` rows reports capped, because the walk stops on a full page without
    // asking again. Over-claiming completeness is the failure that matters.
    seed(4);
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2, ceiling: 4 });
    expect(walk.rows).toHaveLength(4);
    expect(walk.capped).toBe(true);
  });

  it("measures the last page against what IT asked for, not against the page size", async () => {
    // The part-page at the ceiling. With pageSize 3 and ceiling 4 the second page
    // asks for ONE row and gets one — a full page by its own measure, and a short
    // one by the page size. Reading it as short would clear `capped` and hand back
    // four rows of a ten-row table as the whole list. Same rule, same reason, as
    // the count scan's own short-page test.
    seed(10);
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 3, ceiling: 4 });
    expect(walk.rows).toHaveLength(4);
    expect(walk.capped, "a part-page at the ceiling was read as the end of the table").toBe(true);
  });

  it("asks only for the yeses of one treatment, in the sites in view", async () => {
    seed(2);
    seed(2, { treatment: "implants" });
    seed(2, { answer: "not_now" });
    seed(2, { site: OTHER_SITE });
    const walk = await listInterestToCompletion({ siteIds: [SITE], treatment: "implants" });
    expect(walk.rows.map((r) => r.treatment)).toEqual(["implants", "implants"]);
  });

  it("THROWS when a page read fails rather than exporting the pages it did get", async () => {
    // A half-read list handed out as a file is the failure mode: nobody opening a
    // CSV can tell it from a complete one, and the people missing from it are the
    // people nobody rings.
    seed(7);
    interest.failPage = true;
    await expect(listInterestToCompletion({ siteIds: [SITE], pageSize: 2 })).rejects.toBeDefined();
  });

  it("an empty site scope reads nothing at all", async () => {
    seed(3);
    expect(await listInterestToCompletion({ siteIds: [] })).toEqual({ rows: [], capped: false, scanned: 0 });
  });

  // -------------------------------------------------------------------------
  // THE CURSOR GUARD, WHICH NOTHING ASSERTED.
  //
  // `INTEREST_CURSOR_SAFE` guards BOTH keyset walks, and it was reachable from no
  // test in the tree: its regex was never asserted and neither call site was ever
  // driven with a value it should refuse. The values are a timestamptz and a uuid
  // out of our own table, so this is belt-and-braces rather than a live hole (the
  // repository's own comment says exactly that) — but it is pasted into a
  // PostgREST filter STRING by hand, it is the fail-closed stop for a value
  // carrying a quote or a backslash, and an unasserted guard is one regex edit
  // away from being no guard at all. The same guard in the usage scan
  // (src/lib/telemetry.ts) is pinned this way, by "stops and says the figures are
  // floors rather than page on a cursor it cannot quote".
  //
  // MUTATION (T79-export): neuter the guard in `listInterestToCompletion`
  // (`if (false) { break; }`) and this test goes red — the walk builds a filter
  // string the double's `applyKeyset` cannot parse, which is the point.
  // -------------------------------------------------------------------------
  it("stops rather than page on a cursor it could not safely quote", async () => {
    // The last row of the FIRST page carries an id no double-quoted filter could
    // hold. Four rows at two a page, so a walk that ignored the guard would go on.
    for (const [i, id] of ["w-000", 'w-001"evil', "w-002", "w-003"].entries()) {
      fake.seed("treatment_interest", {
        id,
        site_id: SITE,
        dentally_patient_id: `dp-${i}`,
        patient_name: `Patient ${i}`,
        treatment: "whitening",
        answer: "yes",
        response_id: "resp-1",
        created_at: iso(-(i + 1) * 60_000),
      });
    }
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2 });
    expect(interest.filters, "a cursor carrying a quote was pasted into the filter string").toEqual([]);
    expect(interest.queries).toEqual(["page"]);
    expect(walk.rows.map((r) => r.id)).toEqual(["w-000", 'w-001"evil']);
    // FAILS CLOSED: the walk stopped early, so the file it feeds says "at least N".
    expect(walk.capped, "a walk that stopped early handed its rows back as the whole list").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. W3/33 — THE EXACT COUNTS, AND LIFE BEFORE THE MIGRATION
// ---------------------------------------------------------------------------
describe("the counts prefer Postgres's own tally, and work without it (W3/33)", () => {
  function seedFive() {
    let n = 0;
    for (const r of [
      { id: "c-1", treatment: "whitening", patient: "dp-1" },
      { id: "c-2", treatment: "whitening", patient: "dp-1" },
      { id: "c-3", treatment: "whitening", patient: "dp-2" },
      { id: "c-4", treatment: "implants", patient: "dp-3" },
      { id: "c-5", treatment: "implants", patient: "dp-3" },
    ]) {
      fake.seed("treatment_interest", {
        id: r.id,
        site_id: SITE,
        dentally_patient_id: r.patient,
        patient_name: r.patient,
        treatment: r.treatment,
        answer: "yes",
        response_id: "resp-1",
        created_at: iso(-(++n) * 60_000),
      });
    }
  }

  it("costs ONE call and reads no rows when the function is there", async () => {
    seedFive();
    interest.rpc = () => ({
      data: [
        { treatment: "whitening", patients: 2 },
        { treatment: "implants", patients: 1 },
      ],
      error: null,
    });
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary).toEqual({ counts: { whitening: 2, implants: 1 }, capped: false, scanned: 0 });
    expect(interest.rpcCalls).toEqual(["interest_counts_by_treatment"]);
    expect(interest.queries, "the exact answer still paged the table").toEqual([]);
  });

  it("is never capped, however large the table: an aggregate has no ceiling", async () => {
    interest.rpc = () => ({ data: [{ treatment: "whitening", patients: 250_000 }], error: null });
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2, ceiling: 4 });
    expect(summary.counts).toEqual({ whitening: 250_000 });
    expect(summary.capped).toBe(false);
  });

  it("WALKS when migration 0101 is not applied, which is every database today", async () => {
    // PGRST202 is PostgREST's "no such function". The platform has no migration
    // runner in the request path, so this code runs against both shapes of
    // database and the fallback is not a nicety.
    seedFive();
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(interest.rpcCalls).toEqual(["interest_counts_by_treatment"]);
    expect(summary.counts).toEqual({ whitening: 2, implants: 1 });
    expect(interest.queries).toEqual(["page", "count", "page", "page"]);
  });

  it("an exact grid above a capped file is two honest numbers, not one broken pair", async () => {
    // WHAT THIS PINS IS A COMMENT. `listInterestToCompletion` promised in prose
    // that it shared the counts' ceiling, "so the grid on the pre-visit screen
    // and the file exported from the same screen cannot disagree about the same
    // table". 0101 ended that: the counts became an aggregate, and an aggregate
    // has no ceiling, so on a migrated database the grid is exact at any scale
    // while the export walk still stops at INTEREST_COUNT_CEILING and its file
    // says "at least N". Both are true statements; the pair is no longer the
    // pair the comment described, and the comments are this codebase's contract
    // (charter §0/1). Here is the divergence, deliberately, in one test, so the
    // prose above cannot quietly become a promise again.
    seedFive();
    interest.rpc = () => ({ data: [{ treatment: "whitening", patients: 20_050 }], error: null });

    const grid = await countInterestByTreatmentDetailed([SITE], { pageSize: 2, ceiling: 4 });
    expect(grid.counts).toEqual({ whitening: 20_050 });
    expect(grid.capped, "the aggregate reported a ceiling it cannot hit").toBe(false);

    // The same scope, the same table, the same ceiling constant — and capped,
    // because the walk really does stop. The export route turns this flag into
    // the file's "at least N people" first line rather than hiding it.
    const file = await listInterestToCompletion({ siteIds: [SITE], pageSize: 2, ceiling: 4 });
    expect(file.rows).toHaveLength(4);
    expect(file.capped, "a clipped export claimed to be the whole list").toBe(true);
    expect(interest.rpcCalls, "the export asked Postgres for a tally it has no use for").toEqual([
      "interest_counts_by_treatment",
    ]);
  });

  it("walks rather than trusting a row it cannot read", async () => {
    // A partial map returned as an exact answer would be worse than the scan: it
    // would be a set of totals with a treatment silently missing from it.
    seedFive();
    interest.rpc = () => ({
      data: [{ treatment: "whitening", patients: 2 }, { treatment: null, patients: "?" }],
      error: null,
    });
    const summary = await countInterestByTreatmentDetailed([SITE], { pageSize: 2 });
    expect(summary.counts).toEqual({ whitening: 2, implants: 1 });
    expect(summary.scanned).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 9. W3/32 — THE PAGE WIDTH, WHICH IS WHAT MAKES `capped` MEAN ANYTHING.
//
// Both interest walks decide the table has ended from `rows.length < want`.
// Supabase clips every REST response at a server-side max-rows ceiling —
// POSTGREST_MAX_ROWS, measured on this project — and it does so SILENTLY: no
// error, nothing on the response to read. So a walk that asks for a page AT OR
// ABOVE that ceiling cannot tell "the table ended" from "you were cut off", and
// the failure is the dangerous direction: it sets `capped = false` on a scan that
// stopped in the middle, and the interest grid and the CSV export then print a
// floor as a total.
//
// The default page size used to be exactly 1,000, which is the ceiling. It was
// CORRECT at that width by coincidence — asking for exactly the cap gets exactly
// the cap, so the loop kept going — and one raise away from silently lying. The
// first test below is the hazard, demonstrated; the second is the shipped
// constant staying under it.
// ---------------------------------------------------------------------------
describe("the interest walks never ask for a page the server could clip (W3/32)", () => {
  function seedRows(n: number): void {
    for (let i = 0; i < n; i += 1) {
      fake.seed("treatment_interest", {
        id: `w-${String(i).padStart(5, "0")}`,
        site_id: SITE,
        dentally_patient_id: `dp-${i}`,
        patient_name: `Patient ${i}`,
        treatment: "whitening",
        answer: "yes",
        response_id: "resp-1",
        created_at: iso(-(i + 1) * 60_000),
      });
    }
  }

  it("A PAGE AT THE CEILING MAKES A TRUNCATED WALK CLAIM IT IS COMPLETE", async () => {
    // The hazard itself, at a scale a test can hold: the server will hand back at
    // most 5 rows, the walk asks for 10, and 5 < 10 reads as "the table ended".
    seedRows(30);
    interest.serverCeiling = 5;
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 10 });
    expect(walk.rows).toHaveLength(5);
    expect(
      walk.capped,
      "a clipped first page was read as the end of the table, so a floor is about to be printed as a total",
    ).toBe(false);
  });

  it("...and a page UNDER the ceiling walks the same table to the end", async () => {
    seedRows(30);
    interest.serverCeiling = 5;
    const walk = await listInterestToCompletion({ siteIds: [SITE], pageSize: 4 });
    expect(walk.rows).toHaveLength(30);
    expect(walk.capped).toBe(false);
  });

  // MUTATION: put INTEREST_COUNT_PAGE back to 1000 (or above). Every other test in
  // this file stays green — they all pass their own tiny pageSize — and the
  // shipped default is back on the ceiling, where the two tests above diverge.
  it("the shipped page size is strictly under the measured ceiling", async () => {
    seedRows(3);

    await listInterestToCompletion({ siteIds: [SITE] });
    await countInterestByTreatmentDetailed([SITE]);

    expect(interest.limits.length, "no page was ever asked for").toBeGreaterThan(1);
    for (const n of interest.limits) {
      expect(
        n,
        `a page of ${n} rows is at or above the ${POSTGREST_MAX_ROWS}-row ceiling, so a clipped page would read as the last one`,
      ).toBeLessThan(POSTGREST_MAX_ROWS);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. THE TWO JSONB COLUMNS, READ THROUGH THE REAL ROW.
// ---------------------------------------------------------------------------
// The projection's own tests call `readStoredInterest` and `projectSummary`
// directly, which pins the RULES and not the WIRING. These two drive the real
// repository against the fake database, so reverting `rowToResponse` to a cast or
// dropping the type out of `customQuestionsFor` fails here rather than in a review.
// ---------------------------------------------------------------------------

describe("the stored row reaches the projection already read (not cast)", () => {
  it("stored-interest-is-read-through-rowToResponse", async () => {
    fake.seed("previsit_response", {
      id: "resp-1",
      target_id: `${SITE}:appt-1`,
      site_id: SITE,
      dentally_patient_id: "dp-1",
      fork: "full",
      answers: [{ key: "attending", value: "yes", kind: "logistics" }],
      // The shape a hand edit or a partial restore leaves behind. `treatment_interest`
      // has a CHECK on both of its columns; this jsonb copy of the same fact has none.
      interest: [
        null,
        { treatment: "veneers", answer: "maybe" },
        { treatment: "whitening", answer: "yes" },
      ],
      submitted_at: iso(0),
    });

    const [resp] = await listResponsesForPatient([SITE], "dp-1");
    expect(resp.interest).toEqual([{ treatment: "whitening", answer: "yes" }]);
  });

  it("owner-authored-scale-survives-the-bank-read", async () => {
    // END TO END for the discomfort flag: the practice's own 0-10 slider, saved in
    // the bank editor, answered 9 by a patient, read back through getBanks ->
    // customQuestionsFor -> projectSummary. Without the question's TYPE travelling
    // that whole way the record says `discomfortReported: false`, and the practice
    // manager — who by ruling W1-C/2 has only the count and the flag — has nothing.
    fake.seed("previsit_bank", {
      client_id: "vitality",
      fork: "full",
      config: {
        enabledKeys: [],
        required: {},
        custom: [
          {
            key: "custom-discomfort",
            label: "How uncomfortable is your tooth right now?",
            type: "scale",
            kind: "symptom",
            required: false,
          },
        ],
      },
      updated_at: iso(-24 * HOUR),
      updated_by: null,
    });
    fake.seed("previsit_response", {
      id: "resp-2",
      target_id: `${SITE}:appt-2`,
      site_id: SITE,
      dentally_patient_id: "dp-2",
      fork: "full",
      answers: [{ key: "custom-discomfort", value: "9", kind: "symptom" }],
      interest: [],
      submitted_at: iso(0),
    });

    const [response] = await listResponsesForPatient([SITE], "dp-2");
    const summary = await previsitSummaryFor({
      clientId: "vitality",
      response,
      viewerRole: "client_coordinator",
    });
    expect(summary.discomfortReported, "a 9 out of 10 never reached the practice").toBe(true);
    expect(summary.clinical, "the manager was handed the words as well").toBeNull();
    expect(summary.flaggedForClinician).toBe(1);
  });
});
