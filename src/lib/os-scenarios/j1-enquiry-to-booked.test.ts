// ===========================================================================
// JOURNEY 1 — A WEBSITE ENQUIRY BECOMES A BOOKED APPOINTMENT.
//
// Somebody fills in the form on the practice's Invisalign page at nine at night.
// By the time the practice opens, the platform has texted them back, they have
// replied, the agent has tried to put them in the diary, and every one of those
// moments is on the patient's record and in the Dentally sync ledger.
//
// FIVE MODULES, ONE STORY: the landing form (src/app/api/landing-lead), the
// speed-to-lead sweep, the booking agent's tools, the Dentally write gate and
// its ledger, and the correspondence record. Each of those has its own tests.
// None of them can see the seams, and the seams are where this went wrong
// before: a lead that sends nothing because the sweep never selects it, a first
// contact that never reaches the record, a booking that reports success while
// the gate refused it.
//
// WHAT IS STUBBED, AND WHY IT IS ONLY THIS.
//   * draftFirstContact — it calls Anthropic. The wiring around it is real.
//   * the model turn in the booking step — same reason; the TOOL it names runs
//     for real, gate and all.
//   * @/lib/rate-budget — consumeBudget calls db.rpc(), which the in-memory
//     Supabase does not implement. Stubbed to ALLOW, which is the direction
//     that leaves the journey exercising everything after it.
//   * the Dentally client is a double. Nothing may put a request on a wire:
//     the fetch guard fails the test if anything tries.
// Everything else — the guards, the consent check, the suppression check, the
// claim, the send, the conversation thread, the write gate, the ledger, the
// record read — is the real code running against the migrations' own schema.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  CLIENT,
  SITE,
  MOCK_DENTALLY_BASE,
  MOCK_DENTALLY_HOST,
  createOsWorld,
  installFetchGuard,
  liveDentallyViolations,
  correspondenceViolations,
  dailyCapViolations,
  patientCopyViolations,
  type FetchGuard,
} from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const H = vi.hoisted(() => ({ drafted: [] as string[] }));

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));

// consumeBudget goes through db.rpc(), which the in-memory Supabase has no
// implementation for. Stubbed to allow — the permissive direction, so the
// journey keeps running through every guard that comes after it.
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));

vi.mock("@/lib/speed-to-lead/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speed-to-lead/draft")>();
  return {
    ...actual,
    draftFirstContact: async () => {
      const body =
        "Hi Rachel, it's Vitality Dental. Thanks for your enquiry about straightening — " +
        "when would suit you for a chat?";
      H.drafted.push(body);
      return { body, model: "stub" };
    },
  };
});

import { POST as landingLead } from "@/app/api/landing-lead/route";
import { POST as speedToLeadSweep } from "@/app/api/speed-to-lead/sweep/route";
import { getLead, listAttempts } from "@/lib/speed-to-lead/repository";
import { appendMessage, listMessages } from "@/lib/agent/repository";
import { getThreadForPatient } from "@/lib/inbox/repository";
import { makeDispatch, writeDisabledResult } from "@/lib/agent/tools";
import { dentallyAgentClient } from "@/lib/dentally/write";
import { precheckDentallyWrite } from "@/lib/dentally/write-gate";
import { countWriteIntents, listWriteIntents } from "@/lib/dentally/sync-ledger";
import { syncFacts, syncHeadline } from "@/lib/dentally/sync-surface";
import { BOOKING_SLOT_DURATION_MIN } from "@/lib/booking/slots";
import { dentallySiteId } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";
import { makeCopilotDispatch } from "@/lib/copilot/tools";
import { copilotAccessForRole } from "@/lib/copilot/scope";

/** The booking agent's write tool, as the dispatch names it. */
const BOOK_TOOL = "book";

const PHONE = "+447700900410";
const PATIENT_ID = "dp-rachel-1";
const PRACTITIONER = "prac-jawad";
const ORIGINAL_ENV = { ...process.env };

let guard: FetchGuard;

beforeEach(() => {
  world.reset();
  H.drafted.length = 0;
  slotMs = Date.now() + 12 * 60 * 60 * 1000;
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  // Absent means DRY RUN for messaging and OFF for Dentally writes. Both are the
  // production posture today, and both are the posture this journey runs in.
  delete process.env.MESSAGING_DRY_RUN;
  delete process.env.DENTALLY_WRITE_ENABLED;
  delete process.env.DENTALLY_WRITE_API_KEY;
  delete process.env.DENTALLY_WRITE_BASE_URL;
  delete process.env.DENTALLY_BASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.TWILIO_WHATSAPP_FROM;
  // The two switches this journey runs under, both explicitly ON so that a
  // "nothing happened" result can never be a switch nobody set.
  world.setToggle("speed-to-lead", true);
  world.setToggle("online-booking", true);
  world.setToggle("booking-agent", true);
  // The live landing page the enquiry comes from.
  world.fake.seed("landing_page", {
    id: "lp-1",
    client_id: CLIENT,
    site_id: SITE,
    slug: "invisalign",
    treatment: "invisalign",
    campaign_ref: null,
    status: "live",
    winner_variant: null,
    auto_promote: false,
    created_by: null,
  });
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// A Dentally client double.
//
// It carries the SEVEN methods ToolDeps asks for, so the agent's own dependency
// type is satisfied honestly rather than cast away, and it records what it was
// asked to do. Every method is local; the fetch guard proves nothing else went
// anywhere.
// ---------------------------------------------------------------------------

function slotAt(startMs: number): { start: string; finish: string } {
  return {
    start: new Date(startMs).toISOString(),
    finish: new Date(startMs + BOOKING_SLOT_DURATION_MIN * 60_000).toISOString(),
  };
}

/**
 * THE slot this test books, pinned ONCE per test in beforeEach.
 *
 * Two separate decisions, and both of them were bugs waiting to happen.
 *
 * AN OFFSET, NOT A CALENDAR HOP. It used to be "tomorrow at 10:00 UTC", which is
 * a different distance ahead depending on the hour the suite runs at; the
 * availability reader keeps only slots strictly in the future and inside the
 * booking horizon, and a UTC hop drifts across those edges as the clock moves.
 * Twelve hours ahead is twelve hours ahead at every hour of every day, and on
 * both sides of a DST change.
 *
 * PINNED, NOT RECOMPUTED. The availability window and the `book` input must name
 * the SAME instant to the millisecond — the agent re-reads availability
 * immediately before writing and refuses a slot it cannot find. Two calls to a
 * now-based helper can differ by a tick, so the instant is captured once and
 * both sides read it.
 */
let slotMs = 0;

interface DentallyDouble {
  created: Record<string, unknown>[];
  client: Parameters<typeof makeDispatch>[0]["dentally"];
}

function dentallyDouble(): DentallyDouble {
  const created: Record<string, unknown>[] = [];
  // A three-hour free window from the chosen slot, so the agent's own duration
  // clamp (the treatment length, not the model's echo) can never overrun what
  // the diary is offering. The reader chunks this into consecutive slots.
  const open = {
    start: new Date(slotMs).toISOString(),
    finish: new Date(slotMs + 3 * 60 * 60_000).toISOString(),
  };
  const client = {
    listPractitioners: async () => ({
      practitioners: [{ id: PRACTITIONER, active: true, site_id: dentallySiteId(SITE) }],
    }),
    getAvailability: async () => ({
      availability: [{ start_time: open.start, finish_time: open.finish, practitioner_id: PRACTITIONER }],
    }),
    getPatientAppointments: async () => ({ appointments: [] }),
    createAppointment: async (payload: Record<string, unknown>) => {
      created.push(payload);
      return { appointment: { id: "mock-appt-1" } };
    },
    createPatient: async () => ({ patient: { id: PATIENT_ID } }),
    updateAppointment: async () => ({ appointment: { id: "mock-appt-1" } }),
    cancelAppointment: async () => ({ appointment: { id: "mock-appt-1", state: "cancelled" } }),
  } as unknown as Parameters<typeof makeDispatch>[0]["dentally"];
  return { created, client };
}

/** Exactly the shape the model would send after find_slots offered this slot. */
/**
 * The double, but with the REAL client's createAppointment bound in.
 *
 * WHY THIS SHAPE AND NOT A HAND-WRITTEN THROW. In production the booking agent
 * hands the gate its OWN client (ToolDeps.dentally), so its availability read and
 * its booking cannot end up on two different Dentally instances. The gate says so
 * in as many words: it cannot see an injected client's base URL, so it cannot
 * pre-empt a refusal for one — it performs, and that client's own read-only latch
 * refuses. This helper keeps the reads local and lets the REAL latch do the
 * refusing, so what is being tested is the latch and the gate's handling of it,
 * not a throw this file invented.
 */
function latchedDouble(): DentallyDouble {
  const base = dentallyDouble();
  const real = dentallyAgentClient();
  const client = {
    ...(base.client as unknown as Record<string, unknown>),
    createAppointment: (payload: Record<string, unknown>) => real.createAppointment(payload),
  } as unknown as Parameters<typeof makeDispatch>[0]["dentally"];
  return { created: base.created, client };
}

function bookInput() {
  const slot = slotAt(slotMs);
  return {
    slotStart: slot.start,
    finishTime: slot.finish,
    practitionerId: PRACTITIONER,
    treatment: "Invisalign consultation",
  };
}

function agentDeps(dentally: DentallyDouble, writesEnabled?: boolean) {
  return {
    dentally: dentally.client,
    context: {
      patientId: PATIENT_ID,
      siteId: SITE,
      phone: PHONE,
      channel: "sms",
      patientName: "Rachel Bemand",
      treatment: "Invisalign",
      fundingType: null,
      known: true,
    },
    ...(writesEnabled === undefined ? {} : { writesEnabled }),
  } as Parameters<typeof makeDispatch>[0];
}

// ---------------------------------------------------------------------------
// The journey's own steps, each usable on its own so a later step can rebuild
// the state it needs without a shared mutable fixture.
// ---------------------------------------------------------------------------

async function submitEnquiry(): Promise<Response> {
  return landingLead(
    new Request("https://vitality.invalid/api/landing-lead", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({
        clientSlug: CLIENT,
        landingSlug: "invisalign",
        name: "Rachel Bemand",
        phone: PHONE,
        channel: "sms",
        consent: true,
        message: "I'd like to straighten my teeth before my wedding.",
      }),
    }),
  );
}

async function runSweep(): Promise<Record<string, unknown>> {
  const res = await speedToLeadSweep(
    new Request("https://vitality.invalid/api/speed-to-lead/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Age the lead past the 30-second SLA so listUncontacted selects it. */
function ageLead(): void {
  for (const row of world.fake.db.tables.speed_to_lead_lead ?? []) {
    row.created_at = new Date(Date.now() - 120_000).toISOString();
  }
}

/** Give the lead a Dentally patient id, as an identity match would. */
function matchLeadToPatient(): void {
  for (const row of world.fake.db.tables.speed_to_lead_lead ?? []) {
    row.dentally_patient_id = PATIENT_ID;
  }
}

async function enquiryThroughFirstContact(): Promise<void> {
  await submitEnquiry();
  matchLeadToPatient();
  ageLead();
  await runSweep();
}

describe("JOURNEY 1 — website enquiry → first text → reply → booking → Dentally intent", () => {
  it("step 1: the public form records the enquiry and sends NOTHING from the request", async () => {
    const res = await submitEnquiry();
    expect(res.status, await res.text()).toBe(200);

    const leads = world.rows("speed_to_lead_lead");
    expect(leads, "the enquiry did not become a lead").toHaveLength(1);
    expect(leads[0].stage).toBe("new");
    expect(leads[0].site_id).toBe(SITE);
    expect(leads[0].source).toBe("landing:invisalign");
    expect(leads[0].treatment_interest).toBe("Invisalign");

    // THE PROPERTY THAT MATTERS HERE: an unauthenticated HTTP request cannot
    // itself cause an outbound message. Nothing was drafted, nothing was
    // attempted, and no conversation exists yet.
    expect(H.drafted, "the public route drafted a message").toEqual([]);
    expect(world.rows("speed_to_lead_attempt")).toEqual([]);
    expect(world.rows("agent_conversation")).toEqual([]);
  });

  it("step 2: the sweep sends the first text in dry-run and puts it on the lead's record", async () => {
    await submitEnquiry();
    matchLeadToPatient();
    ageLead();

    const body = await runSweep();
    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(body.contacted, JSON.stringify(body)).toBe(1);
    expect(H.drafted, "nothing was drafted").toHaveLength(1);

    const leads = world.rows("speed_to_lead_lead");
    expect((await getLead(String(leads[0].id)))?.stage).toBe("contacted");

    const attempts = await listAttempts(String(leads[0].id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("sent");
    // DRY RUN IS VISIBLE IN THE ROW, not merely in an env var: the provider the
    // record shows is the provider that handled it.
    expect(attempts[0].provider).toBe("dry-run");
    expect(String(attempts[0].providerMessageId)).toMatch(/^dry-sms-/);

    // And the patient-facing words carry no funding jargon.
    expect(patientCopyViolations("first contact", [attempts[0].body])).toEqual([]);
  });

  it("step 3: the patient's reply threads onto the SAME conversation the first text opened", async () => {
    await enquiryThroughFirstContact();

    const convs = world.rows("agent_conversation");
    expect(convs, "the first contact opened no conversation").toHaveLength(1);
    const conversationId = String(convs[0].id);

    await appendMessage({ conversationId, role: "patient", body: "Yes please — is tomorrow morning free?" });

    const messages = await listMessages(conversationId);
    const roles = messages.map((m) => m.role);
    expect(roles, "the reply did not join the outbound message").toEqual(["agent", "patient"]);
  });

  it("step 4: booking with writes OFF — the agent refuses, tells the patient nothing, and FILES the attempt", async () => {
    await enquiryThroughFirstContact();
    const dentally = dentallyDouble();

    // writesEnabled unset ⇒ the deployment gate decides, and it is off. This is
    // production today. Ruling W3/16: the early-return trade was granted to the
    // co-pilot create_patient ONLY, so this door records (blocked/writes_disabled)
    // and then refuses, exactly as the desk cancel does.
    const dispatch = makeDispatch(agentDeps(dentally));
    const out = await dispatch(BOOK_TOOL, bookInput());

    expect(out).toBe(writeDisabledResult("book"));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.booked).toBe(false);
    // The refusal must forbid the one sentence that would do real harm.
    expect(String(parsed.error)).toContain("Do not tell the patient they have an appointment");

    expect(dentally.created, "a refusal reached the Dentally client").toEqual([]);

    const intents = world.rows("dentally_write_intent");
    expect(intents, "the patient's booking attempt left no trace").toHaveLength(1);
    expect(intents[0].kind).toBe("appointment.create");
    expect(intents[0].status).toBe("blocked");
    // `writes_disabled`, NOT the `client_read_only` of step 5, and the two are not
    // in tension. W2-C/3 governs the ARMED path below, where the agent's injected
    // client reaches its own latch; THIS path hands the gate no client at all
    // (src/lib/agent/tools.ts recordRefusedWrite says why), so the gate pre-empts
    // and files what the non-injecting staff doors file — the same reason the
    // coordinator reads in step 5b.
    expect(intents[0].blocked_reason).toBe("writes_disabled");
    expect(intents[0].source).toBe("booking-agent");
    expect(intents[0].module_slug).toBe("booking-agent");
    // An agent slug, never a person and never the patient's number.
    expect(intents[0].actor).toBe("agent:booking-agent");
    expect(intents[0].response_id ?? null).toBeNull();

    // W1-A/1's payload rule at the door where it is easiest to break: this agent
    // knows the lead's NAME and the mobile it has been texting, and neither may be
    // filed. Pinned as the whole field list rather than "no Rachel anywhere",
    // because the summariser's allow-list would swallow a personal field silently
    // — it would still be listed by name here. Anything personal added to this
    // payload later reddens this line before the allow-list is the only thing left
    // between it and the database.
    const summary = intents[0].payload_summary as { fields: string[]; values: Record<string, unknown> };
    const EXPECTED_FIELDS = ["booked_via_api", "patient_id", "reason", "start_time"];
    expect(summary.fields, "the filed payload grew a field").toEqual(EXPECTED_FIELDS);
    expect(Object.keys(summary.values).sort(), "a filed value is not on the non-personal list").toEqual(
      EXPECTED_FIELDS,
    );
    expect(summary.values.patient_id).toBe(PATIENT_ID);

    // Recording is not writing. The row names the live host, and "blocked" is the
    // only status that is safe there — the sweep is what says so, not this test.
    expect(liveDentallyViolations(world, guard)).toEqual([]);
    expect(guard.calls, "a refused booking still put a request on a wire").toEqual([]);
  });

  it("step 5: booking with the agent armed but the deployment not — the write is refused and filed blocked", async () => {
    await enquiryThroughFirstContact();
    const dentally = latchedDouble();

    // writesEnabled TRUE forces the agent's own early return open, so the write
    // reaches the gate. That is the point of the step: the agent's flag is not
    // the last line of defence, and this proves what stops the write once it is
    // past that flag.
    const dispatch = makeDispatch(agentDeps(dentally, true));

    // The ORIGINAL error is rethrown, unchanged, so every existing catch block
    // behaves exactly as it did before the gate existed.
    await expect(dispatch(BOOK_TOOL, bookInput())).rejects.toThrow(/read-only/);
    expect(dentally.created, "a refused write reached the appointment payload recorder").toEqual([]);

    const intents = world.rows("dentally_write_intent");
    expect(intents, "the refusal was not filed").toHaveLength(1);
    expect(intents[0].kind).toBe("appointment.create");
    expect(intents[0].status).toBe("blocked");
    // NOT "writes_disabled", and the difference is the point. The booking agent
    // INJECTS its own client, and the gate cannot see an injected client's base
    // URL, so it does not pre-empt: it performs, the client's own latch refuses,
    // and the row says client_read_only. A row reading "failed" here would tell a
    // practice that Dentally rejected something Dentally never saw.
    expect(intents[0].blocked_reason).toBe("client_read_only");
    expect(intents[0].source).toBe("booking-agent");
    expect(intents[0].module_slug).toBe("booking-agent");
    expect(intents[0].client_id).toBe(CLIENT);
    expect(intents[0].site_id).toBe(SITE);
    expect(intents[0].dentally_patient_id).toBe(PATIENT_ID);
    // The actor is an agent slug, never a person and never an address.
    expect(intents[0].actor).toBe("agent:booking-agent");
    expect(intents[0].response_id ?? null).toBeNull();

    expect(liveDentallyViolations(world, guard)).toEqual([]);
    // The latch threw BEFORE the fetch, which is the property that makes this
    // safe against 51,000 real records rather than merely unlikely to fire.
    expect(guard.calls).toEqual([]);
  });

  it("step 5b: the other door — a staff rebooking, with no injected client, is filed blocked/writes_disabled", async () => {
    await enquiryThroughFirstContact();
    world.setToggle("treatment-coordinator", true);

    // The same patient, the same kind of write, from the surface a coordinator
    // uses. This door hands the gate NO client, so the gate pre-empts: nothing is
    // constructed, nothing is called, and the reason the practice reads is the one
    // nearest to them — the deployment is not armed.
    const refused = await precheckDentallyWrite({
      ctx: { source: "coordinator", siteId: SITE, actor: "user-abc", patientId: PATIENT_ID },
      kind: "appointment.create",
      patientId: PATIENT_ID,
      payload: { patient_id: PATIENT_ID, reason: "Exam" },
    });

    expect(refused, "the precheck let a write through while unarmed").not.toBeNull();
    expect(refused!.reason).toBe("writes_disabled");

    const intents = world.rows("dentally_write_intent");
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe("appointment.create");
    expect(intents[0].status).toBe("blocked");
    expect(intents[0].blocked_reason).toBe("writes_disabled");
    expect(intents[0].source).toBe("coordinator");
    expect(intents[0].module_slug).toBe("treatment-coordinator");
    // An opaque id, never an email — the ledger's actor rule.
    expect(intents[0].actor).toBe("user-abc");

    expect(liveDentallyViolations(world, guard)).toEqual([]);
  });

  it("step 6 (CONTROL): pointed at the local mock, the SAME booking runs and is filed dry_run", async () => {
    // WHY THIS STEP EXISTS. Step 5 asserts a refusal. A refusal assertion passes
    // just as happily when the booking never happens for some unrelated reason —
    // a malformed slot, a missing practitioner, a typo in the tool name. This
    // step runs the identical call with only ONE thing changed (the Dentally base
    // URL now names the local mock rather than the live book), and requires it to
    // SUCCEED. If this fails, step 5 was proving nothing.
    process.env.DENTALLY_BASE_URL = MOCK_DENTALLY_BASE;
    await enquiryThroughFirstContact();
    const dentally = dentallyDouble();

    const dispatch = makeDispatch(agentDeps(dentally, true));
    const out = await dispatch(BOOK_TOOL, bookInput());
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.booked, out).toBe(true);
    expect(parsed.appointmentId).toBe("mock-appt-1");
    expect(dentally.created, "the mock client was never called").toHaveLength(1);
    expect(dentally.created[0].patient_id).toBe(PATIENT_ID);
    expect(dentally.created[0].booked_via_api).toBe(true);

    const intents = world.rows("dentally_write_intent");
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe("dry_run");
    expect(intents[0].blocked_reason ?? null).toBeNull();
    expect(intents[0].response_id).toBe("mock-appt-1");
    // The row names the host it actually used, so a reader can tell a simulated
    // write against the mock from one that never happened.
    expect(intents[0].target).toBe(MOCK_DENTALLY_HOST);

    expect(liveDentallyViolations(world, guard)).toEqual([]);
  });

  it("step 7: the ledger row is what the Sync Status surface shows the practice", async () => {
    await enquiryThroughFirstContact();
    const dispatch = makeDispatch(agentDeps(latchedDouble(), true));
    await expect(dispatch(BOOK_TOOL, bookInput())).rejects.toThrow(/read-only/);

    // The ledger read the surface uses, not a hand-built row.
    const listed = await listWriteIntents(CLIENT);
    expect(listed.rows, "the surface's own read cannot see the intent").toHaveLength(1);
    expect(listed.rows[0].kind).toBe("appointment.create");
    expect(listed.rows[0].status).toBe("blocked");
    expect(listed.rows[0].blockedReason).toBe("client_read_only");
    // One row is a long way from the page size, so this page is the whole story.
    expect(listed.more).toBe(false);

    const counted = await countWriteIntents(CLIENT);
    expect(counted.counts.blocked).toBe(1);
    expect(counted.total).toBe(1);
    // Nowhere near COUNT_CAP, so the surface may print this as a total rather
    // than as "at least".
    expect(counted.capped).toBe(false);

    // And the surface itself tells the owner, in words, that appointments are
    // ready but not flowing — the same two facts the ledger row carries.
    const facts = syncFacts("dry_run");
    const appointmentFact = facts.find((f) => f.id === "appointment.create");
    expect(appointmentFact, "Sync Status does not mention appointment creation").toBeTruthy();
    expect(appointmentFact!.group).toBe("pending_on_key");
    // The surface names the SURFACES in the owner's words, not slugs — and the
    // booking agent, which is the one that made this row, is among them.
    expect(
      appointmentFact!.sources?.some((label) => /Booking agent/i.test(label)),
      `the surface does not name the booking agent: ${JSON.stringify(appointmentFact!.sources)}`,
    ).toBe(true);
    expect(syncHeadline("dry_run")).toContain("Writing back to Dentally is OFF");
  });

  it("step 8: every message the journey sent is on the patient's record, from both sources", async () => {
    await enquiryThroughFirstContact();

    const read = await getThreadForPatient([SITE], PATIENT_ID);
    // BOTH sources, because this path writes to two: the threaded conversation
    // and the speed-to-lead attempt row. A record showing one and not the other
    // is a record that reads as "we texted them once" when we texted them once
    // and logged it twice, or worse, as nothing at all.
    expect(correspondenceViolations(read, ["agent", "speed-to-lead"])).toEqual([]);
    expect(read.failedSourceNames).toEqual([]);

    for (const message of read.thread!.messages) {
      expect(patientCopyViolations("record", [message.body])).toEqual([]);
    }
  });

  it("step 9: the owner asks the co-pilot, and the SAME intent comes back through sync_status", async () => {
    // TIGHTENED AT INTEGRATION (W2-A has landed). The journey no longer stops at
    // the repository: the row the booking agent's refusal filed is now read back
    // through the tool an owner actually reaches it by, at an owner's clearance,
    // through the real dispatch.
    await enquiryThroughFirstContact();
    const dispatch = makeDispatch(agentDeps(latchedDouble(), true));
    await expect(dispatch(BOOK_TOOL, bookInput())).rejects.toThrow(/read-only/);

    const access = copilotAccessForRole("client_owner");
    const copilot = makeCopilotDispatch([SITE], CLIENT, "user-owner", access, {
      resolveStaff: async () => null,
    });
    const out = JSON.parse(await copilot("sync_status", {})) as Record<string, unknown>;

    // The owner is told the truth about the connection, in the two halves that
    // are actually separate: the agency has not armed the deployment, and the
    // practice's own switch is not the thing in the way.
    expect(out.writingBackToDentally).toBe("off");
    expect(out.deploymentArmed).toBe(false);
    expect(out.practiceSwitchOff).toBe(false);
    expect(String(out.headline)).toContain("Writing back to Dentally is OFF");

    // And THIS journey's row is in it, by kind, by source and by reason.
    const recent = out.recentIntents as Array<Record<string, unknown>>;
    expect(recent, "the co-pilot cannot see the intent this journey filed").toHaveLength(1);
    expect(recent[0].what).toBe("appointment.create");
    expect(recent[0].madeBy).toBe("booking-agent");
    expect(recent[0].status).toBe("blocked");
    expect(recent[0].heldBackBecause).toBe("client_read_only");
    expect(recent[0].dentallyPatientId).toBe(PATIENT_ID);

    // A count, not a floor — one row is nowhere near the cap.
    expect((out.counts as Record<string, number>).blocked).toBe(1);
    expect(out.countIsAFloor).toBe(false);
    expect(out.ledgerError).toBeNull();

    // IDS ONLY. The ledger holds no patient name, number or address by
    // construction, and the tool must not add one back on the way out.
    const text = JSON.stringify(out);
    expect(text, "the co-pilot leaked a patient name out of the ledger").not.toContain("Rachel");
    expect(text, "the co-pilot leaked a mobile number out of the ledger").not.toContain(PHONE);
  });

  it("step 9b: a manager cannot read the sync ledger at all", async () => {
    // sync_status is filed under the `controls` domain, which the manager
    // clearance does not hold. The wall is asserted here as well as in journey 6
    // because THIS is the journey that puts a real row in the ledger — a refusal
    // against an empty ledger would pass for the wrong reason.
    await enquiryThroughFirstContact();
    const dispatch = makeDispatch(agentDeps(latchedDouble(), true));
    await expect(dispatch(BOOK_TOOL, bookInput())).rejects.toThrow(/read-only/);
    expect(world.rows("dentally_write_intent")).toHaveLength(1);

    const copilot = makeCopilotDispatch([SITE], CLIENT, "user-manager", copilotAccessForRole("client_coordinator"), {
      resolveStaff: async () => null,
    });
    const out = JSON.parse(await copilot("sync_status", {})) as Record<string, unknown>;
    expect(out.denied).toBe(true);
    expect(out.error).toBe("out_of_scope");
    expect(JSON.stringify(out)).not.toContain("appointment.create");
  });

  it("step 10: the three standing invariants hold across the whole journey", async () => {
    await enquiryThroughFirstContact();
    const dispatch = makeDispatch(agentDeps(latchedDouble(), true));
    await expect(dispatch(BOOK_TOOL, bookInput())).rejects.toThrow(/read-only/);

    expect(liveDentallyViolations(world, guard), "something reached a live Dentally host").toEqual([]);
    expect(guard.calls, "a scenario put a request on the network").toEqual([]);

    const read = await getThreadForPatient([SITE], PATIENT_ID);
    expect(correspondenceViolations(read, ["agent", "speed-to-lead"])).toEqual([]);

    expect(dailyCapViolations(world)).toEqual([]);

    // RULING W2-C/2 (3 Sep 2026), both halves of it.
    //
    // A speed-to-lead first contact is a REPLY to an inbound enquiry, so it does
    // NOT consult the cap — somebody who fills in the form must get an answer,
    // whatever unsolicited message reached them earlier today. But it DOES stamp
    // the day, so the unsolicited sweeps (recall, reactivation, the coordinator,
    // reviews) hold off for the rest of it and the patient is not chased twice.
    const stamps = world.rows("message_daily_log");
    expect(stamps, "the reply did not stamp the day, so an unsolicited sweep could pile on").toHaveLength(1);
    expect(stamps[0].address).toBe(PHONE);
    expect(stamps[0].source).toBe("speed-to-lead");
    expect(stamps[0].site_id).toBe(SITE);
  });

  it("step 11: the reply goes out even when the day is ALREADY stamped — it never consults the cap", async () => {
    // The other half of ruling W2-C/2, and the half a stamp assertion cannot
    // reach. An unsolicited recall text reached this person at nine this morning
    // and stamped the day; they then filled in the website form. The reply must
    // still go, because it is a reply.
    await submitEnquiry();
    matchLeadToPatient();
    ageLead();
    world.fake.seed("message_daily_log", {
      site_id: SITE,
      address: PHONE,
      // THE DAY KEY COMES FROM THE SAME FUNCTION THE CODE STAMPS WITH.
      //
      // This was a clock bomb. It used to read `toISOString().slice(0, 10)`,
      // which is the UTC day, while contact.ts stamps `londonDayKey(new Date())`
      // — the Europe/London one. Between 23:00 and midnight UTC during BST those
      // are two different dates, so the seeded row and the stamped row landed on
      // different days, the upsert did not collide, and the step saw two rows
      // where it asserts one. Green all day, red for one hour a night, seven
      // months a year. The fix is not a wider assertion, it is asking the same
      // question the code asks. Pinned by the shifted-clock step below.
      sent_on: londonDayKey(new Date()),
      source: "recall",
    });

    const body = await runSweep();
    expect(body.contacted, `the enquiry went unanswered because of the cap: ${JSON.stringify(body)}`).toBe(1);

    const [lead] = world.rows("speed_to_lead_lead");
    const attempts = await listAttempts(String(lead.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("sent");

    // And the stamp is an UPSERT on (site, address, day), so the reply does not
    // add a second row — which is what keeps the cap's own invariant true.
    expect(dailyCapViolations(world)).toEqual([]);
    expect(world.rows("message_daily_log")).toHaveLength(1);
  });

  it("step 12 (SHIFTED CLOCK): the same journey holds at 23:30 UTC, when the London day has already turned", async () => {
    // THE HOUR THE BUG LIVED IN. At 2026-09-03T23:30:00Z the clocks are on BST,
    // so it is already 00:30 on the 4th in London: the UTC day and the London day
    // are different dates. Every day key in this journey has to be the London one,
    // because that is the day the platform's cap is keyed on.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-03T23:30:00Z"));

      // The premise, asserted rather than assumed: if these were ever equal this
      // step would be testing nothing at all.
      const utcDay = new Date().toISOString().slice(0, 10);
      const londonDay = londonDayKey(new Date());
      expect(londonDay, "the two day keys agree at this instant — the shift is not biting").not.toBe(utcDay);
      expect(utcDay).toBe("2026-09-03");
      expect(londonDay).toBe("2026-09-04");

      await submitEnquiry();
      matchLeadToPatient();
      ageLead();
      world.fake.seed("message_daily_log", {
        site_id: SITE,
        address: PHONE,
        sent_on: londonDayKey(new Date()),
        source: "recall",
      });

      const body = await runSweep();
      expect(body.contacted, JSON.stringify(body)).toBe(1);

      // ONE row still, because the reply's stamp collided with the seeded one on
      // the London day. Seeded with the UTC day this is 2, and the cap's own
      // invariant breaks with it.
      const stamps = world.rows("message_daily_log");
      expect(stamps, `two day keys were used: ${JSON.stringify(stamps.map((r) => r.sent_on))}`).toHaveLength(1);
      expect(stamps[0].sent_on).toBe("2026-09-04");
      expect(dailyCapViolations(world)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
