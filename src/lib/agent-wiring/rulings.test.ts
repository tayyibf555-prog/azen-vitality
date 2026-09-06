// ===========================================================================
// THE FIVE RULINGS OF 3 SEP 2026, EACH DRIVEN THROUGH THE REAL CODE.
//
// The lane raised five questions it would not answer on its own authority,
// because each one changes a guard's fail direction, a patient-facing prompt, or
// what an owner's switch is understood to cover. All five were answered the same
// way, and the principle is worth writing down where the code can be measured
// against it:
//
//     ONCE MESSAGING IS LIVE, UNCERTAINTY FAILS CLOSED.
//     A skipped tick is a delay. A batch sent against an unknown switch is an
//     incident.
//
// Each describe below is one ruling. They drive the real recall sweep, the real
// systems repository, the real exclusion read, the real prompt builder and the
// real abandoned-hold rescue against the in-memory database, with only the
// Anthropic drafter stubbed.
// ===========================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const H = vi.hoisted(() => ({
  drafts: 0,
  /**
   * One counter per sweep that has its own drafter, plus a hook the test installs
   * to flip the owner's switch mid-batch. Counting the DRAFTER is how these tests
   * measure "how many rows did the run actually work on": it is the call the
   * ruling exists to stop, it happens once per admitted row, and it is the only
   * thing in the loop expensive enough that continuing past a switch-off costs
   * real money as well as real messages.
   */
  coordinatorDrafts: 0,
  reactivationDrafts: 0,
  reviewDrafts: 0,
  noshowDrafts: 0,
  onDraft: null as
    | null
    | ((sweep: "coordinator" | "reactivation" | "reviews" | "noshow", n: number) => void),
}));

const fake = createFakeSupabase();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => fake.client }));

// The ONLY stub: draftRecall calls Anthropic. Counting its calls is also how the
// tests below measure "how many rows did this run actually draft for".
vi.mock("@/lib/recall/draft", () => ({
  draftRecall: vi.fn(async () => {
    H.drafts += 1;
    return { body: "Time for your check-up with the practice.", rationale: "due" };
  }),
}));

// THE OTHER FOUR DRAFTERS, for the same reason and with the same shape.
// draftOutreach, draftReactivation and draftNoshow call Anthropic, so a test that drove the
// real sweep without stubbing them would put a network call in the suite (the
// programme's standing invariant forbids it). draftReviewRequest does not — it is
// pure, templated copy — so that one CALLS THROUGH and only counts, which keeps
// the reviews sweep drafting the real words while still giving the test a
// per-row hook to flip the switch from.
vi.mock("@/lib/coordinator/draft", () => ({
  draftOutreach: vi.fn(async () => {
    H.coordinatorDrafts += 1;
    H.onDraft?.("coordinator", H.coordinatorDrafts);
    return { body: "There is still some treatment to finish; shall we book you in?", rationale: "open plan" };
  }),
}));
vi.mock("@/lib/reactivation/draft", () => ({
  draftReactivation: vi.fn(async () => {
    H.reactivationDrafts += 1;
    H.onDraft?.("reactivation", H.reactivationDrafts);
    return { body: "It has been a while — would you like to come in?", rationale: "lapsed" };
  }),
}));
vi.mock("@/lib/noshow/draft", () => ({
  draftNoshow: vi.fn(async () => {
    H.noshowDrafts += 1;
    H.onDraft?.("noshow", H.noshowDrafts);
    return { body: "Your appointment is coming up — reply YES to confirm.", rationale: "confirm" };
  }),
}));
vi.mock("@/lib/reviews/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reviews/draft")>();
  return {
    ...actual,
    draftReviewRequest: (...args: Parameters<typeof actual.draftReviewRequest>) => {
      H.reviewDrafts += 1;
      H.onDraft?.("reviews", H.reviewDrafts);
      return actual.draftReviewRequest(...args);
    },
  };
});

import { POST as recallSweep } from "@/app/api/recall/sweep/route";
import { POST as coordinatorSweep } from "@/app/api/coordinator/sweep/route";
import { POST as reactivationSweep } from "@/app/api/reactivation/sweep/route";
import { POST as reviewsSweep } from "@/app/api/reviews/sweep/route";
import { POST as noshowSweep } from "@/app/api/noshow/sweep/route";
import { convertAbandonedHolds } from "@/lib/booking/abandoned-holds";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { FREE_TEXT_IS_DATA } from "@/lib/agent/free-text";
import { liveSwitch, SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";
import { loadExcludedTargetKeys, isExclusionsUnavailable } from "@/lib/patient-status/repository";
import type { AgentContext } from "@/lib/agent/types";

const SITE = "site-cc";
const CLIENT = "vitality";
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fake.reset();
  H.drafts = 0;
  H.coordinatorDrafts = 0;
  H.reactivationDrafts = 0;
  H.reviewDrafts = 0;
  H.noshowDrafts = 0;
  H.onDraft = null;
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CRON_SECRET;
  delete process.env.MESSAGING_DRY_RUN; // absent = dry run
  process.env.RECALL_DAILY_CONTACT_LIMIT = "1000";
});

/** MESSAGING_DRY_RUN is live only for the exact string "false". */
function goLive(): void {
  process.env.MESSAGING_DRY_RUN = "false";
}

function setToggle(slug: string, enabled: boolean): void {
  const rows = (fake.db.tables.system_toggle ??= []);
  const existing = rows.find((r) => r.client_id === CLIENT && r.module_slug === slug);
  if (existing) existing.enabled = enabled;
  else fake.seed("system_toggle", { client_id: CLIENT, module_slug: slug, enabled });
}

/** `n` recall targets, each with an active cadence already due. */
function seedDueRecalls(n: number): void {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  for (let i = 0; i < n; i += 1) {
    fake.seed("recall_target", {
      id: `t-${i}`,
      site_id: SITE,
      dentally_patient_id: `p-${i}`,
      patient_name: `Patient ${i}`,
      recall_type: "dentist",
      due_at: past,
      overdue_days: 10,
      last_visit_at: past,
      prior_attempts: 0,
      status: "due",
      consent: { sms: true, email: true, marketing: false },
    });
    fake.seed("recall_cadence", {
      id: `c-${i}`,
      target_id: `t-${i}`,
      site_id: SITE,
      current_step: 0,
      status: "active",
      next_due_at: past,
    });
  }
}

async function runRecallSweep(): Promise<Record<string, unknown>> {
  const res = await recallSweep(
    new Request("https://scenario.invalid/api/recall/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The other four long-running sweeps, seeded so that their OWN listing call
// returns more than twenty due rows. Nothing here shortcuts a repository: each
// helper writes the rows the real `listDue` / `listDueCadences` /
// `listOpportunities` select on, so a run that stops early stops for the reason
// under test rather than because it ran out of work.
// ---------------------------------------------------------------------------

/** `n` review requests, scheduled and already due. */
function seedDueReviews(n: number): void {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  for (let i = 0; i < n; i += 1) {
    fake.seed("review_request", {
      id: `rev-${i}`,
      site_id: SITE,
      dentally_appointment_id: `appt-${i}`,
      dentally_patient_id: `p-${i}`,
      patient_name: `Patient ${i}`,
      channel: "sms",
      attended_at: past,
      send_at: past,
      status: "scheduled",
    });
  }
}

/** `n` open treatment opportunities, none touched yet, all under the auto-send threshold. */
function seedOpenOpportunities(n: number): void {
  for (let i = 0; i < n; i += 1) {
    fake.seed("treatment_opportunity", {
      id: `opp-${i}`,
      site_id: SITE,
      dentally_patient_id: `p-${i}`,
      patient_name: `Patient ${i}`,
      treatment: "Composite bonding",
      planned_value: 120,
      amount_outstanding: 120, // < COORDINATOR_AUTO_SEND_THRESHOLD, so it auto-sends
      status: "accepted",
      last_touch_at: null,
      priority_score: 50,
      consent: { sms: true, email: true, marketing: false },
    });
  }
}

/** `n` reactivation targets with an active cadence already due, all auto-queueable. */
function seedDueReactivations(n: number): void {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  // Inside the lapse ceiling that the sweep re-checks at SEND time. Relative to
  // the real clock on purpose: a fixed date ages out and every row is retired.
  const lastVisit = new Date(Date.now() - 200 * 86_400_000).toISOString();
  fake.seed("reactivation_settings", { client_id: CLIENT, daily_contact_limit: 500 });
  for (let i = 0; i < n; i += 1) {
    fake.seed("reactivation_target", {
      id: `react-${i}`,
      site_id: SITE,
      dentally_patient_id: `p-${i}`,
      patient_name: `Patient ${i}`,
      reason: "lapsed",
      recoverable_value: 100, // < REACTIVATION_AUTO_SEND_THRESHOLD, so it auto-queues
      last_visit_at: lastVisit,
      prior_attempts: 0,
      status: "in_cadence",
      reactivation_score: 50,
      consent: { sms: true, email: true, marketing: false },
    });
    fake.seed("reactivation_cadence", {
      id: `rc-${i}`,
      target_id: `react-${i}`,
      site_id: SITE,
      current_step: 0,
      status: "active",
      next_due_at: past,
    });
  }
}

/**
 * `n` no-show cadences due now, for appointments still ahead of us.
 *
 * The appointment start is RELATIVE to the real clock and staggered, because
 * disposeCadence expires anything already started and the send pass orders by
 * soonest appointment — a fixed date would either expire the whole fixture or
 * make the ordering meaningless.
 */
function seedDueNoshows(n: number): void {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  for (let i = 0; i < n; i += 1) {
    fake.seed("noshow_target", {
      id: `ns-${i}`,
      site_id: SITE,
      dentally_patient_id: `p-${i}`,
      appointment_id: `appt-${i}`,
      patient_name: `Patient ${i}`,
      appointment_start_at: new Date(Date.now() + (i + 2) * 3_600_000).toISOString(),
      appointment_state: "active",
      duration_min: 30,
      practitioner: "Dr Vitality",
      risk_score: 40,
      risk_band: "medium",
      status: "scheduled",
      prior_attempts: 0,
      consent: { sms: true, email: true, marketing: false },
    });
    fake.seed("noshow_cadence", {
      id: `nsc-${String(i).padStart(3, "0")}`,
      target_id: `ns-${i}`,
      site_id: SITE,
      current_step: 0,
      status: "active",
      next_due_at: past,
    });
  }
}

async function runSweep(
  handler: (request: Request) => Promise<Response>,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await handler(new Request(`https://scenario.invalid${path}`, { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RULING 1 — a default-ON sweep fails CLOSED once messaging is live.
// ---------------------------------------------------------------------------

describe("ruling 1: a toggle table we cannot read stops a live sweep", () => {
  it("LIVE + unreadable toggles: the sweep drafts NOTHING and says why", async () => {
    goLive();
    seedDueRecalls(5);
    fake.failTable("system_toggle");

    const body = await runRecallSweep();
    expect(body.skipped, JSON.stringify(body)).toBe("system off");
    expect(H.drafts, "a live sweep drafted against an unreadable switch").toBe(0);
    expect(fake.rows("recall_touch")).toHaveLength(0);
    expect(fake.rows("recall_outbox")).toHaveLength(0);
  });

  it("DRY-RUN + unreadable toggles: it proceeds exactly as it did before", async () => {
    // The fail-open behaviour is kept where it costs nothing, so development
    // against a partial database still works.
    seedDueRecalls(3);
    fake.failTable("system_toggle");

    const body = await runRecallSweep();
    expect(body.skipped).toBeUndefined();
    expect(H.drafts).toBe(3);
    expect(fake.rows("recall_outbox")).toHaveLength(3);
  });

  it("LIVE + the switch explicitly OFF: nothing, as always", async () => {
    goLive();
    setToggle("recall", false);
    seedDueRecalls(3);

    expect((await runRecallSweep()).skipped).toBe("system off");
    expect(H.drafts).toBe(0);
  });

  it("LIVE + the switch explicitly ON: the sweep does its job", async () => {
    goLive();
    setToggle("recall", true);
    seedDueRecalls(3);

    const body = await runRecallSweep();
    expect(body.skipped).toBeUndefined();
    expect(H.drafts).toBe(3);
    expect(fake.rows("recall_outbox")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// RULING 2 — exclusions unknown means nobody may be drafted.
//
// THE OTHER HALF OF THIS RULING IS PINNED ELSEWHERE (wave-3b handoff H58, 5 Sep
// 2026). Everything below drives `loadExcludedTargetKeys` and the sweeps that
// call it. The SINGLE-SITE read, `loadExcludedPatientIds` — the only exclusion
// check anywhere on the outreach campaign path, and the one with the least room
// to be forgiving, because the audience it builds is a snapshot re-checked for
// everything except exclusions — joined the ruling on 4 September 2026 and is
// pinned in src/lib/patient-status/exclusion-fail-closed.test.ts. That file
// cites this describe block by name in the other direction; this is the return
// pointer, so neither half can be read as the whole ruling.
// ---------------------------------------------------------------------------

describe("ruling 2: an unreadable exclusion list stops a live tick", () => {
  it("the read itself REFUSES when live, and returns empty under dry-run", async () => {
    fake.failTable("patient_status_override");

    // Dry-run: the old, fail-open behaviour, so local work is unaffected.
    await expect(loadExcludedTargetKeys()).resolves.toEqual(new Set());

    goLive();
    await expect(loadExcludedTargetKeys()).rejects.toSatisfy(isExclusionsUnavailable);
  });

  it("LIVE: the sweep skips the tick rather than drafting for everybody", async () => {
    goLive();
    setToggle("recall", true);
    seedDueRecalls(5);
    fake.failTable("patient_status_override");

    const body = await runRecallSweep();
    expect(body.skipped, JSON.stringify(body)).toBe("exclusions unavailable");
    expect(H.drafts, "a patient marked inactive could have been drafted").toBe(0);
    expect(fake.rows("recall_outbox")).toHaveLength(0);
  });

  it("DRY-RUN: today's behaviour is kept", async () => {
    setToggle("recall", true);
    seedDueRecalls(2);
    fake.failTable("patient_status_override");

    const body = await runRecallSweep();
    expect(body.skipped).toBeUndefined();
    expect(H.drafts).toBe(2);
  });

  it("`inactive` now gets the protection `do_not_contact` already had", async () => {
    // do_not_contact is blocked a SECOND time at the send choke point by its
    // message_suppression rows. inactive has no such second line, so before this
    // ruling an unreadable override table meant an inactive patient was drafted
    // and sent to. Now the tick refuses instead.
    goLive();
    setToggle("recall", true);
    seedDueRecalls(1);
    fake.seed("patient_status_override", {
      site_id: SITE,
      dentally_patient_id: "p-0",
      status: "inactive",
    });

    // Readable: the exclusion is honoured and the patient is skipped, not drafted.
    const ok = await runRecallSweep();
    expect(ok.suppressed).toBe(1);
    expect(H.drafts).toBe(0);

    // Unreadable: the whole tick refuses rather than losing that protection.
    fake.failTable("patient_status_override");
    expect((await runRecallSweep()).skipped).toBe("exclusions unavailable");
    expect(H.drafts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RULING 3 — the booking agent is told its data is data.
// ---------------------------------------------------------------------------

describe("ruling 3: the data boundary is stated in the prompt, not just enforced", () => {
  const KNOWN: AgentContext = {
    patientId: "pat-77",
    siteId: SITE,
    channel: "sms",
    patientName: "Aisha Khan",
    treatment: null,
    fundingType: null,
    isKnownPatient: true,
  } as AgentContext;

  it("the known-patient branch carries the line", () => {
    expect(buildSystemPrompt(KNOWN)).toContain(FREE_TEXT_IS_DATA);
  });

  it("it sits with the values it is about, not adrift at the top", () => {
    const prompt = buildSystemPrompt(KNOWN);
    expect(prompt.indexOf(FREE_TEXT_IS_DATA)).toBeLessThan(prompt.indexOf("Patient: Aisha Khan"));
  });

  it("the unrecognised-number branch does NOT, because it interpolates no record", () => {
    const unknown = buildSystemPrompt({ ...KNOWN, isKnownPatient: false, patientName: "there" });
    expect(unknown).not.toContain(FREE_TEXT_IS_DATA);
  });

  it("the byte-identity pin was updated deliberately and says so", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/agent/reply-context-prompt.test.ts", "utf8");
    expect(src).toContain("W1-B/3");
    expect(src).toMatch(/Do not silently re-baseline/);
  });
});

// ---------------------------------------------------------------------------
// RULING 4 — the rescue needs both switches, and one message only.
// ---------------------------------------------------------------------------

describe("ruling 4: the abandoned-booking rescue", () => {
  function seedHold(): void {
    fake.seed("booking_hold", {
      id: "hold-1",
      client_id: CLIENT,
      site_id: SITE,
      slot_start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      slot_finish: new Date(Date.now() + 3 * 86_400_000 + 1_800_000).toISOString(),
      treatment: "Exam",
      name: "Lena Novak",
      phone: "+447700900444",
      status: "held",
      created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });
  }

  it("converts when BOTH switches are on", async () => {
    setToggle("speed-to-lead", true);
    setToggle("online-booking", true);
    seedHold();

    expect(await convertAbandonedHolds()).toMatchObject({ converted: 1 });
    expect(fake.rows("speed_to_lead_lead")).toHaveLength(1);
  });

  it.each([
    ["online booking is off", true, false],
    ["speed-to-lead is off", false, true],
    ["both are off", false, false],
  ])("converts NOTHING when %s", async (_label, leads, booking) => {
    setToggle("speed-to-lead", leads);
    setToggle("online-booking", booking);
    seedHold();

    expect(await convertAbandonedHolds()).toEqual({ checked: 0, converted: 0, deduped: 0 });
    expect(fake.rows("speed_to_lead_lead")).toHaveLength(0);
    // The hold is left alone, so it converts normally once the owner switches back on.
    expect(fake.rows("booking_hold")[0].status).toBe("held");
  });

  it("records the narrow basis it actually has, and never marketing consent", async () => {
    setToggle("speed-to-lead", true);
    setToggle("online-booking", true);
    seedHold();
    await convertAbandonedHolds();

    const consent = fake.rows("speed_to_lead_lead")[0].consent as Record<string, unknown>;
    expect(consent.source, "the consent basis is not recorded").toBe("booking-form");
    expect(consent.marketing, "a rescued lead was given marketing consent").toBe(false);
    expect(consent.sms).toBe(true);
  });

  it("gets ONE follow-up: the nurture cadence excludes it at both selection queries", async () => {
    const { readFileSync } = await import("node:fs");
    const repo = readFileSync("src/lib/speed-to-lead/repository.ts", "utf8");
    const fn = repo.slice(repo.indexOf("export async function listNurtureDue"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // Two queries, entry and subsequent; the exclusion has to be on both or a lead
    // that reached step 1 by any route would carry on being nurtured.
    expect([...body.matchAll(/\.neq\("source", "abandoned-booking"\)/g)]).toHaveLength(2);
  });

  it("fails CLOSED when the switches cannot be read and messaging is live", async () => {
    goLive();
    seedHold();
    fake.failTable("system_toggle");

    expect(await convertAbandonedHolds()).toEqual({ checked: 0, converted: 0, deduped: 0 });
    expect(fake.rows("speed_to_lead_lead")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RULING 5 — the switch is re-read inside the batch loop.
// ---------------------------------------------------------------------------

describe("ruling 5: a switch flipped mid-run stops the run", () => {
  it("does NOT re-read on every row: a flip at row 1 is not seen until row 10", async () => {
    // The bound has two sides and only one of them is about safety. Reading the
    // switch on every row would be safe and would also add a database round trip
    // to every Anthropic call in a 300-second sweep. This is the other side:
    // switching off immediately after row 0 must NOT stop the run before row 10,
    // which is exactly what proves the read is periodic rather than per-row.
    expect(SWITCH_RECHECK_EVERY_ROWS).toBe(10);
    setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");

    expect(await gate.stillOn()).toBe(true); // row 0, no read (the caller checked)
    setToggle("recall", false);

    let admitted = 1;
    for (let row = 1; row < 30; row += 1) {
      if (!(await gate.stillOn())) break;
      admitted += 1;
    }
    expect(admitted, "the gate read the switch more often than every ten rows").toBe(10);
    expect(gate.switchedOffMidRun).toBe(true);
  });

  it("admits every row while the switch stays on, however long the run", async () => {
    setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");
    for (let i = 0; i < 30; i += 1) expect(await gate.stillOn()).toBe(true);
    expect(gate.rowsAdmitted).toBe(30);
    expect(gate.switchedOffMidRun).toBe(false);
  });

  it("stops within ten rows of the flip: off after row 12 → nothing after row 20", async () => {
    setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");
    let admitted = 0;
    for (let row = 0; row < 40; row += 1) {
      if (row === 13) setToggle("recall", false); // the owner flips it after row 12
      if (!(await gate.stillOn())) break;
      admitted += 1;
    }
    // It must not stop instantly (that would mean it re-read on every row), and it
    // must not run past the bound the ruling sets.
    expect(admitted).toBeGreaterThan(12);
    expect(admitted, "the sweep kept drafting past the ten-row bound").toBeLessThanOrEqual(20);
    expect(gate.switchedOffMidRun).toBe(true);
  });

  it("once off it stays off for the run, even if the switch comes back", async () => {
    setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");
    for (let row = 0; row < 10; row += 1) await gate.stillOn();
    setToggle("recall", false);
    expect(await gate.stillOn()).toBe(false);
    setToggle("recall", true);
    expect(await gate.stillOn(), "a flicker resumed drafting inside the same tick").toBe(false);
  });

  it("the REAL recall sweep stops drafting when the switch flips mid-run", async () => {
    setToggle("recall", true);
    seedDueRecalls(40);
    // Flip the switch off once the sweep has drafted its thirteenth message.
    const draft = await import("@/lib/recall/draft");
    vi.mocked(draft.draftRecall).mockImplementation(async () => {
      H.drafts += 1;
      if (H.drafts === 13) setToggle("recall", false);
      return { body: "Time for your check-up with the practice.", rationale: "due" };
    });

    await runRecallSweep();
    expect(H.drafts).toBeGreaterThan(12);
    expect(H.drafts, "the sweep drafted past the ten-row bound after a mid-run switch-off").toBeLessThanOrEqual(20);
    expect(fake.rows("recall_outbox").length).toBeLessThanOrEqual(20);
  });

  it("every long-running sweep uses the shared gate rather than its own copy", async () => {
    const { readFileSync } = await import("node:fs");
    for (const route of [
      "src/app/api/recall/sweep/route.ts",
      "src/app/api/reactivation/sweep/route.ts",
      "src/app/api/noshow/sweep/route.ts",
      "src/app/api/coordinator/sweep/route.ts",
      "src/app/api/reviews/sweep/route.ts",
      // NAMED DELTA, 3 Sep 2026 (lane W2-C). The ruling enumerated five sweeps
      // because those were the five that existed when it was written. The
      // speed-to-lead SLA sweep is a SIXTH long-running drafting loop with the
      // same shape — maxDuration 300, one model call per lead — and W2-C caught
      // it drafting past a mid-run switch-off. It is added here rather than the
      // assertion being loosened: the list grows, the rule does not bend.
      "src/app/api/speed-to-lead/sweep/route.ts",
      // NAMED DELTA, 4 Sep 2026 (ruling W3/4, wave-3 review). The pre-visit
      // triage sweep is a SEVENTH long-running loop of the same shape —
      // maxDuration 300, a 310-second lease, one Dentally patient read per
      // distinct patient in pass 1, and up to `maxQueuedPerRun` patient-facing
      // links written to previsit_outbox in pass 2 — and it read its switch
      // once, at the top. Added here rather than the assertion being loosened:
      // the list grows, the rule does not bend. Behaviour is proven against the
      // real route in src/app/api/previsit/sweep/switch-recheck.test.ts.
      "src/app/api/previsit/sweep/route.ts",
      // NAMED DELTA, 4 Sep 2026 (wave-3 review, round 2). The Segment-outreach
      // sweep is an EIGHTH long-running drafting loop of the same shape —
      // maxDuration 300, a 310-second lease, one Anthropic draft plus an
      // auto-approved touch, an advanced cadence and a queued patient-facing
      // marketing SMS per due target, across every running campaign — and it
      // read its switch once, at the top. It is cron-ACTIVE (app-sweep-outreach,
      // */10, per the programme's cron.job truth of 4 Sep), unlike closer /
      // collection / postop, which are registered nowhere and so cannot run.
      // Added here rather than the assertion being loosened: the list grows, the
      // rule does not bend. Behaviour is proven against the real route in
      // src/app/api/outreach/sweep/switch-recheck.test.ts, which also pins that
      // the bound belongs to the RUN and not to each campaign.
      "src/app/api/outreach/sweep/route.ts",
      // NAMED DELTA, 6 Sep 2026 (wave-3d review). The shared messaging DRAIN is
      // not a sweep — it is the send path itself — and it is on this list for
      // exactly that reason. Every route above only DRAFTS; live-switch.ts's own
      // header justifies their ten-row bound by noting that with the old
      // behaviour "nothing was delivered (the drain re-reads the switch and
      // refuses the source)". The drain was written as their backstop and had
      // none of its own: it read `getDisabledSlugsForSend` once, then gated all
      // eleven sources on that one verdict for up to 300 seconds (a 310-second
      // lease), so a module switched off before its turn still drained in full
      // and the module in flight kept sending. It now re-reads the set for every
      // source AND carries the shared gate per row. Added here rather than the
      // assertion being loosened: the list grows, the rule does not bend.
      // Behaviour is proven against the real handler in
      // src/app/api/messaging/drain/switch-recheck.test.ts, which also pins that
      // a module switched off before its turn is never listed at all.
      "src/app/api/messaging/drain/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      expect(src, route).toContain("liveSwitch(");
      expect(src, route).toContain("gate.stillOn()");
    }
  });

  it("the speed-to-lead SLA sweep is the sixth, because the abandoned rescue rides it", async () => {
    // WHY THIS ROUTE IS NAMED SEPARATELY. Every other sweep on the list gates its
    // own agent. This one also hosts the abandoned-booking rescue, which has no
    // sweep of its own — roster.ts names this very file as the rescue's guard —
    // so an ungated loop here left the one agent the ruling's five did not cover
    // drafting for the rest of the run. Behaviour is proven against the real
    // route in src/app/api/speed-to-lead/sweep/switch-recheck.test.ts; what is
    // pinned here is that the gate is consulted BEFORE the lead is claimed, so a
    // stopped run strands nothing at 'contacting'.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/speed-to-lead/sweep/route.ts", "utf8");

    const { AGENT_BY_KEY } = await import("@/lib/agent-wiring/roster");
    expect(AGENT_BY_KEY.get("abandoned-booking-rescue")?.guard).toBe(
      "src/app/api/speed-to-lead/sweep/route.ts",
    );

    const gateAt = src.indexOf("gate.stillOn()");
    const claimAt = src.indexOf("claimLeadForContact(lead.id)");
    expect(gateAt, "the sweep has no mid-run gate").toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(gateAt, "the sweep claims a lead before asking whether the switch is still on").toBeLessThan(
      claimAt,
    );
  });

  it("the pre-visit sweep is the seventh, and its gate comes before the row is touched", async () => {
    // RULING W3/4 (4 Sep 2026). The order is the whole point here as well: the
    // gate is consulted before decideSend/stopTarget/enqueueSend, so a run the
    // owner halted mid-batch leaves every target it never reached at `pending`
    // rather than retiring it on a verdict that is now stale — and queues no
    // further links into an outbox that would drain the moment the module came
    // back on. The behaviour is proven against the real route in
    // src/app/api/previsit/sweep/switch-recheck.test.ts; what is pinned here is
    // the ordering, which a grep for the import alone would not catch.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/previsit/sweep/route.ts", "utf8");

    const gateAt = src.indexOf("if (!(await gate.stillOn())) break;\n\n      const decision");
    const stopAt = src.indexOf('await stopTarget(target.id, "stale")');
    const queueAt = src.indexOf("await enqueueSend({");
    expect(gateAt, "the queueing loop has no mid-run gate ahead of its first row mutation").toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    expect(queueAt).toBeGreaterThan(-1);
    expect(gateAt, "the sweep retires a target before asking whether the switch is still on").toBeLessThan(stopAt);
    expect(gateAt, "the sweep queues a link before asking whether the switch is still on").toBeLessThan(queueAt);
  });
});

// ---------------------------------------------------------------------------
// RULING 5, THE OTHER THREE SWEEPS — driven, not grepped.
//
// WHY THIS SECTION EXISTS. The enumeration above is a SOURCE CRAWL: it asserts
// that each of the seven routes contains the strings `liveSwitch(` and
// `gate.stillOn()`. The wave-3 review showed what that does not hold. Change
//
//     if (!(await gate.stillOn())) break;   ->   await gate.stillOn();
//
// in the coordinator, reviews, reactivation or no-show sweep and BOTH strings
// survive:
// the gate is still constructed, the switch is still read, its warning is still
// logged — and the loop carries on. tsc passed, eslint passed, and the whole
// suite (688 files, 13,263 tests) passed three separate times with that mutation
// in place, once per route. The crawl pins that the gate is CONSTRUCTED. It
// never pinned that the run STOPS.
//
// Recall had a behavioural companion ("the REAL recall sweep stops drafting when
// the switch flips mid-run") and speed-to-lead and pre-visit have theirs in their
// own directories. These are the four that had none — no-show included: the same
// mutation there survived every test in src/app/api/noshow, src/lib/noshow,
// src/lib/os-scenarios and src/lib/agent-wiring (28 files, 425 tests). Each test below drives the
// REAL route against the in-memory database with only the drafter stubbed, flips
// the owner's switch from inside the thirteenth draft, and asserts the two halves
// of the bound the ruling sets: more than twelve rows (so the gate is not being
// read on every row, which is the cost side of W1-B/5) and no more than twenty
// (so a halted system stops halting within ten rows).
//
// WHAT A RUN-PAST WOULD COST, per sweep, is asserted as well as the count:
//   reviews       claimForSend flips scheduled -> sent BEFORE the outbox write,
//                 so every row past the switch-off is both spent (listDue never
//                 re-selects it) and queued for 48 hours — it lands the moment
//                 the owner switches reviews back on.
//   coordinator   one Anthropic draft per row, then a queued patient SMS.
//   reactivation  the same, plus an advanced cadence, so the step is consumed.
// ---------------------------------------------------------------------------

describe("ruling 5, behaviourally: the remaining four sweeps stop when the switch flips", () => {
  /** Flip `slug` off from inside the Nth draft of `sweep`. */
  function flipOffDuringDraft(sweep: "coordinator" | "reactivation" | "reviews", slug: string, n: number): void {
    H.onDraft = (which, count) => {
      if (which === sweep && count === n) setToggle(slug, false);
    };
  }

  it("the REAL reviews sweep stops asking for reviews when the switch flips mid-run", async () => {
    process.env.REVIEW_LINK_URL = "https://g.page/r/vitality/review";
    setToggle("reviews", true);
    seedDueReviews(40);
    flipOffDuringDraft("reviews", "reviews", 13);

    const body = await runSweep(reviewsSweep, "/api/reviews/sweep");

    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(body.due, "the sweep did not see forty due requests").toBe(40);
    expect(H.reviewDrafts, "the sweep stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      H.reviewDrafts,
      "the reviews sweep kept drafting past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(20);
    expect(fake.rows("review_outbox").length).toBeLessThanOrEqual(20);

    // The requests it never reached are still SCHEDULED, so tomorrow's tick asks
    // them properly instead of them being silently spent by a halted run.
    const spent = fake.rows("review_request").filter((r) => r.status === "sent");
    expect(spent.length).toBeLessThanOrEqual(20);
    expect(
      fake.rows("review_request").filter((r) => r.status === "scheduled").length,
      "a stopped run spent every remaining request",
    ).toBeGreaterThanOrEqual(20);
  });

  it("the REAL coordinator sweep stops drafting when the switch flips mid-run", async () => {
    setToggle("treatment-coordinator", true);
    seedOpenOpportunities(40);
    flipOffDuringDraft("coordinator", "treatment-coordinator", 13);

    const body = await runSweep(coordinatorSweep, "/api/coordinator/sweep");

    // NOTE the shape difference: this route's `skipped` is a COUNTER (rows it
    // passed over), not the other sweeps' reason string, so the "it ran at all"
    // check is `ok` plus the row counts rather than an absent `skipped`.
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.swept, JSON.stringify(body)).toBeLessThanOrEqual(20);
    expect(H.coordinatorDrafts, "the sweep stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      H.coordinatorDrafts,
      "the coordinator sweep kept drafting past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(20);
    expect(fake.rows("coordinator_touch").length).toBeLessThanOrEqual(20);
    expect(
      fake.rows("outbox").length,
      "the coordinator queued patient messages after the owner switched it off",
    ).toBeLessThanOrEqual(20);
  });

  it("the REAL reactivation sweep stops drafting when the switch flips mid-run", async () => {
    setToggle("reactivation", true);
    seedDueReactivations(40);
    flipOffDuringDraft("reactivation", "reactivation", 13);

    const body = await runSweep(reactivationSweep, "/api/reactivation/sweep");

    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(body.swept, "the sweep did not see forty due cadences").toBe(40);
    expect(H.reactivationDrafts, "the sweep stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      H.reactivationDrafts,
      "the reactivation sweep kept drafting past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(20);
    expect(fake.rows("reactivation_outbox").length).toBeLessThanOrEqual(20);

    // The cadences it never reached are untouched: still active, still at step 0,
    // so nothing was consumed by a run the owner had already halted.
    const untouched = fake.rows("reactivation_cadence").filter(
      (c) => c.status === "active" && Number(c.current_step) === 0,
    );
    expect(untouched.length, "a stopped run advanced every remaining cadence").toBeGreaterThanOrEqual(20);
  });

  it("the REAL no-show sweep stops confirming when the switch flips mid-run", async () => {
    // THE ONE WITH ITS OWN CAP, which is why the numbers here are tighter. The
    // sweep settles the whole backlog first and then sends a bounded slice:
    // noshowSendCap() is 25 by default, so forty due cadences become twenty-five
    // send candidates BEFORE the gate is built. A run that ignored the gate would
    // send all twenty-five; the ruling's bound is twenty. Those two numbers are
    // four apart, which is the whole margin this test has — hence the explicit
    // "the cap did not do the stopping" assertion below.
    setToggle("no-show-defence", true);
    seedDueNoshows(40);
    H.onDraft = (which, count) => {
      if (which === "noshow" && count === 13) setToggle("no-show-defence", false);
    };

    const body = await runSweep(noshowSweep, "/api/noshow/sweep");

    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(H.noshowDrafts, "the sweep stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      H.noshowDrafts,
      "the no-show sweep kept confirming past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(20);
    expect(
      H.noshowDrafts,
      "the send cap, not the switch, is what stopped this run; the test proves nothing",
    ).toBeLessThan(25);
    expect(fake.rows("noshow_outbox").length).toBeLessThanOrEqual(20);

    // The cadences it never reached are untouched — still active at step 0, with
    // next_due_at in the past, which is exactly what listDueCadences selects on,
    // so the next tick takes them rather than them being silently consumed.
    const untouched = fake.rows("noshow_cadence").filter(
      (c) => c.status === "active" && Number(c.current_step) === 0,
    );
    expect(untouched.length, "a stopped run advanced every remaining cadence").toBeGreaterThanOrEqual(20);
  });

  it("and all four run to completion while the switch stays on", async () => {
    // The floor under the three tests above. Without it, a sweep that stopped for
    // some OTHER reason at row 13 — an exhausted fixture, a guard the seed does
    // not satisfy — would pass every bound assertion while proving nothing about
    // the switch. Same seeds, same routes, no flip: all forty rows are worked.
    process.env.REVIEW_LINK_URL = "https://g.page/r/vitality/review";
    setToggle("reviews", true);
    setToggle("treatment-coordinator", true);
    setToggle("reactivation", true);
    setToggle("no-show-defence", true);
    seedDueReviews(40);
    seedOpenOpportunities(40);
    seedDueReactivations(40);
    seedDueNoshows(40);

    await runSweep(reviewsSweep, "/api/reviews/sweep");
    await runSweep(coordinatorSweep, "/api/coordinator/sweep");
    await runSweep(reactivationSweep, "/api/reactivation/sweep");
    await runSweep(noshowSweep, "/api/noshow/sweep");

    expect(H.reviewDrafts, "the reviews fixture runs dry before row 40").toBe(40);
    expect(H.coordinatorDrafts, "the coordinator fixture runs dry before row 40").toBe(40);
    expect(H.reactivationDrafts, "the reactivation fixture runs dry before row 40").toBe(40);
    // No-show is capped at 25 by design (noshowSendCap), so its floor is the cap,
    // not the fixture: what matters is that the cap — and nothing else — is what
    // bounded the run while the switch stayed on.
    expect(H.noshowDrafts, "the no-show fixture does not reach its own send cap").toBe(25);
  });
});
