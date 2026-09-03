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

const H = vi.hoisted(() => ({ drafts: 0 }));

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

import { POST as recallSweep } from "@/app/api/recall/sweep/route";
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
});
