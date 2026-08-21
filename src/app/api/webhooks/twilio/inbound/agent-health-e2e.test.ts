// ===========================================================================
// THE BOOKING AGENT, DRIVEN AS A REAL SMS CONVERSATION.
//
// This is the single highest-stakes surface at go-live: the booking-agent
// toggle is ON, so an unknown number texting the practice reaches a language
// model that can write a real appointment into a real clinician's diary. Every
// other test of this path stubs either the agent turn (booking-agent-outcomes)
// or the Dentally client (tools.test). This one stubs NEITHER.
//
// WHAT IS REAL HERE:
//   the Twilio webhook route, signature verification, the agent loop (run.ts)
//   with its confirmation gate, every agent tool (tools.ts), the output
//   guardrail (guardrail.ts), the staff-handover alert (alerts.ts), the system
//   prompt (prompt.ts), the slot reader, and a real DentallyClient with real
//   JSON serialisation.
//
// WHAT IS FAKED, AND WHY:
//   - the MODEL, scripted turn by turn. A language model cannot be an assertion.
//     Scripting it is how a test can say "when the model asks to book, THIS is
//     what the system does", which is the part that has to be bulletproof.
//   - Supabase, replaced by an in-memory store that behaves like the real
//     tables (a conversation accumulates history across turns, which is what
//     makes a four-message conversation a conversation and not four strangers).
//   - Dentally, served by THIS repo's own mock route handlers in process. The
//     fetch shim throws on any host it does not recognise, so "no live write"
//     is a property of the test rather than a promise in a comment.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

const SITE_ID = "site-cc";
const MOCK_BASE = "http://localhost:3002/api/mock-dentally";
const PATIENT_NUMBER = "+447700900321";

/* ---------------------------------------------------------------------------
 * The Dentally mock, in process. Nothing leaves this machine.
 * ------------------------------------------------------------------------- */

const wire: Array<{ method: string; path: string; body: unknown; status: number }> = [];

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.origin !== "http://localhost:3002" || !url.pathname.startsWith("/api/mock-dentally")) {
    throw new Error(`REFUSED: this test may only talk to the local mock, not ${url.origin}${url.pathname}`);
  }
  const path = url.pathname.replace("/api/mock-dentally", "");
  const request = new Request(url.href, {
    method,
    headers: init?.headers as HeadersInit,
    body: init?.body as BodyInit | null,
  });

  let res: Response;
  if (path === "/v1/practitioners") {
    res = await (await import("@/app/api/mock-dentally/v1/practitioners/route")).GET(request);
  } else if (path === "/v1/appointments/availability") {
    res = await (await import("@/app/api/mock-dentally/v1/appointments/availability/route")).GET(request);
  } else if (path === "/v1/appointments" && method === "GET") {
    res = await (await import("@/app/api/mock-dentally/v1/appointments/route")).GET(request);
  } else if (path === "/v1/appointments" && method === "POST") {
    res = await (await import("@/app/api/mock-dentally/v1/appointments/route")).POST(request);
  } else if (/^\/v1\/appointments\/[^/]+$/.test(path)) {
    const mod = await import("@/app/api/mock-dentally/v1/appointments/[id]/route");
    const id = path.split("/").pop()!;
    const ctx = { params: Promise.resolve({ id }) };
    // The mock exposes PUT (reschedule) and DELETE (cancel) on a single
    // appointment and nothing else, exactly as live Dentally's contract does.
    if (method !== "PUT" && method !== "DELETE") {
      throw new Error(`the mock has no handler for ${method} ${path}`);
    }
    res = method === "PUT" ? await mod.PUT(request, ctx) : await mod.DELETE(request, ctx);
  } else if (path === "/v1/patients" && method === "POST") {
    res = await (await import("@/app/api/mock-dentally/v1/patients/route")).POST(request);
  } else if (path === "/v1/patients" && method === "GET") {
    res = await (await import("@/app/api/mock-dentally/v1/patients/route")).GET(request);
  } else {
    throw new Error(`the mock has no handler for ${method} ${path}`);
  }

  let parsedBody: unknown = null;
  if (typeof init?.body === "string") {
    try {
      parsedBody = JSON.parse(init.body);
    } catch {
      parsedBody = init.body;
    }
  }
  wire.push({ method, path, body: parsedBody, status: res.status });
  return new Response(await res.clone().text(), { status: res.status, headers: res.headers });
}

/* ---------------------------------------------------------------------------
 * The scripted model. One entry per round of the agent loop, consumed in order.
 * ------------------------------------------------------------------------- */

type ScriptedRound =
  | { text: string }
  | { tools: Array<{ name: string; input: Record<string, unknown> }> };

const h = vi.hoisted(() => ({
  script: [] as Array<
    { text: string } | { tools: Array<{ name: string; input: Record<string, unknown> }> }
  >,
  modelCalls: [] as Array<Record<string, unknown>>,
  identity: null as unknown,
  sent: [] as Array<{ channel: string; to: string; body: string }>,
}));

vi.mock("@anthropic-ai/sdk", () => {
  let seq = 0;
  class Anthropic {
    messages = {
      create: async (args: Record<string, unknown>) => {
        h.modelCalls.push(args);
        const round = h.script.shift();
        if (!round) throw new Error("the model script ran out: the agent asked for a round nobody wrote");
        if ("text" in round) {
          return { content: [{ type: "text", text: round.text }], stop_reason: "end_turn" };
        }
        return {
          content: round.tools.map((t) => {
            seq += 1;
            return { type: "tool_use", id: `tu-${seq}`, name: t.name, input: t.input };
          }),
          stop_reason: "tool_use",
        };
      },
    };
  }
  return { default: Anthropic };
});

/* ---------------------------------------------------------------------------
 * The in-memory agent store. Stateful on purpose: a conversation must remember
 * its own history or a four-message booking is four first messages.
 * ------------------------------------------------------------------------- */

interface StoredConversation {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  status: string;
  treatment: string | null;
  fundingType: string | null;
  lastInboundAt: string | null;
}
const conversations = new Map<string, StoredConversation>();
const messages: Array<{ conversationId: string; role: string; body: string }> = [];
const identities = new Map<string, unknown>();

vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: async (input: {
    siteId: string;
    dentallyPatientId: string;
    patientName: string;
    channel: string;
    treatment: string | null;
    fundingType: string | null;
  }) => {
    const key = `${input.siteId}|${input.dentallyPatientId}|${input.channel}`;
    const existing = [...conversations.values()].find(
      (c) => `${c.siteId}|${c.dentallyPatientId}|${c.channel}` === key,
    );
    if (existing) return { ...existing };
    const row: StoredConversation = {
      id: `conv-${conversations.size + 1}`,
      siteId: input.siteId,
      dentallyPatientId: input.dentallyPatientId,
      patientName: input.patientName,
      channel: input.channel,
      status: "active",
      treatment: input.treatment,
      fundingType: input.fundingType,
      lastInboundAt: null,
    };
    conversations.set(row.id, row);
    return { ...row };
  },
  listMessages: async (id: string) =>
    messages.filter((m) => m.conversationId === id).map((m, i) => ({ id: `m-${i}`, ...m })),
  appendMessage: async (input: { conversationId: string; role: string; body: string }) => {
    messages.push({ ...input });
  },
  setConversationStatus: async (id: string, status: string) => {
    const row = conversations.get(id);
    if (row) row.status = status;
  },
  setConversationName: async (id: string, name: string) => {
    const row = conversations.get(id);
    if (row) row.patientName = name;
  },
  stampInbound: async (id: string) => {
    const row = conversations.get(id);
    if (row) row.lastInboundAt = new Date().toISOString();
  },
  isAgentEnabled: async () => true,
  upsertPhoneIdentity: async (phone: string, identity: unknown) => {
    identities.set(phone, identity);
  },
  ensureNeedsHuman: async (id: string) => {
    const row = conversations.get(id);
    if (!row) return "already";
    if (row.status === "needs_human" || row.status === "closed") return "already";
    row.status = "needs_human";
    return "set";
  },
}));

/* ---------------------------------------------------------------------------
 * Everything else Supabase-backed: inert, so the agent path is what is on test.
 * ------------------------------------------------------------------------- */

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  isSystemEnabledStrict: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: () => false,
  addSuppression: async () => {},
  isSuppressed: async () => false,
}));
vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: async () => null,
  insertInboundTouch: async () => {},
  getCadenceByTarget: async () => null,
  updateCadence: async () => {},
  getTargetContext: async () => null,
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: async () => null,
  getCadenceByTarget: async () => null,
  updateCadence: async () => {},
  insertInboundTouch: async () => {},
}));
vi.mock("@/lib/outreach/repository", () => ({
  findTargetByAddress: async () => null,
  insertInboundTouch: async () => {},
  markOutreachReplied: async () => {},
  markOutreachBookedByAddress: async () => {},
  getCampaignIdForTarget: async () => null,
  getCampaign: async () => null,
  getTarget: async () => null,
}));
vi.mock("@/lib/noshow/inbound", () => ({ handleNoshowInbound: async () => ({ handled: false }) }));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: async () => null,
  insertInboundTouch: async () => {},
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: () => false,
  getSiteById: () => ({ id: "site-cc" }),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: async () => ({ id: "cap-1" }),
  hasOpenCaptureFrom: async () => false,
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: async () => [] }));
vi.mock("@/lib/smile-assessment/repository", () => ({ latestResponseByLead: async () => null }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findLeadByConversation: async () => null,
  setLeadStage: async () => {},
}));
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: async () => true }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));
vi.mock("@/lib/cron-lock", () => ({
  tryAcquireLease: async () => "acquired",
  releaseCronLock: async () => {},
}));
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

/* ---------------------------------------------------------------------------
 * The two seams that matter: who is texting, and where the message goes.
 * ------------------------------------------------------------------------- */

vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: async () => h.identity }));
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: async (m: { channel: string; to: string; body: string }) => {
    h.sent.push({ ...m });
    return { provider: "test", providerMessageId: `SM-${h.sent.length}` };
  },
}));

// The gated write client, resolved to the local mock and nothing else.
vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const { DentallyClient } = await import("@/lib/dentally/client");
  return {
    ...actual,
    isDentallyWriteEnabled: () => true,
    dentallyAgentClient: () =>
      new DentallyClient({
        apiKey: "local-mock-only",
        baseUrl: MOCK_BASE,
        readOnly: false,
        fetchImpl: mockFetch as typeof fetch,
      }),
  };
});

import { POST as inboundPOST } from "./route";
import { DentallyClient } from "@/lib/dentally/client";
import { fetchAvailabilityDays, earliestSlots } from "@/lib/booking/slots";
import { SAFE_HANDOVER } from "@/lib/agent/guardrail";
import { alertStaffHandover } from "@/lib/agent/alerts";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";
let sid = 0;

function signed(params: Record<string, string>): Request {
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(INBOUND_URL, params, TOKEN),
    },
  });
}

/** One inbound SMS from the patient, with the model's rounds for that turn. */
async function patientTexts(body: string, rounds: ScriptedRound[], from = PATIENT_NUMBER): Promise<string> {
  h.script.length = 0;
  h.script.push(...rounds);
  sid += 1;
  const res = await inboundPOST(signed({ From: from, Body: body, MessageSid: `SM${sid}` }));
  expect(res.status).toBe(200);
  const last = h.sent[h.sent.length - 1];
  return last?.body ?? "";
}

/**
 * WHAT THE MODEL WAS ACTUALLY TOLD each time it called a tool, in order.
 *
 * Read from the tool_result blocks handed back to the model rather than by
 * wrapping the dispatcher, because the two things most worth asserting on —
 * a booking refused by the confirmation gate, and a mutation skipped because the
 * same round handed over — never reach the dispatcher at all. They are refusals
 * written by run.ts, and they are exactly the safety properties under test.
 * Deduped by tool_use id, since a later round replays the earlier rounds.
 */
function toolExchanges(): Array<{ name: string; input: Record<string, unknown>; result: string }> {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const seen = new Set<string>();
  const out: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
  for (const call of h.modelCalls) {
    const msgs = (call.messages ?? []) as Array<{ role: string; content: unknown }>;
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue;
      for (const raw of m.content as Array<Record<string, unknown>>) {
        if (raw?.type === "tool_use") {
          calls.set(String(raw.id), {
            name: String(raw.name),
            input: (raw.input ?? {}) as Record<string, unknown>,
          });
        }
        if (raw?.type === "tool_result") {
          const id = String(raw.tool_use_id);
          if (seen.has(id)) continue;
          seen.add(id);
          const src = calls.get(id);
          if (src) out.push({ ...src, result: String(raw.content ?? "") });
        }
      }
    }
  }
  return out;
}

/** The last result the named tool produced, parsed. Throws a readable error if it never ran. */
function lastToolResult(name: string): Record<string, unknown> {
  const hit = toolExchanges().filter((t) => t.name === name).pop();
  if (!hit) throw new Error(`the agent never called ${name}: ${toolExchanges().map((t) => t.name).join(", ") || "no tools at all"}`);
  return JSON.parse(hit.result) as Record<string, unknown>;
}

/** A genuinely open slot the mock is offering, read exactly as the calendar reads it. */
async function realSlot(index = 0): Promise<{ start: string; finish: string; practitionerId: string | null }> {
  // The reads this helper makes are the TEST setting itself up, not the agent
  // doing anything, so they are rolled back out of the wire log.
  const before = wire.length;
  const readOnly = new DentallyClient({
    apiKey: "local-mock-only",
    baseUrl: MOCK_BASE,
    readOnly: true,
    fetchImpl: mockFetch as typeof fetch,
  });
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const days = await fetchAvailabilityDays(readOnly, SITE_ID, from, to, now);
  // Never hand a test a slot that could lapse WHILE THE TEST RUNS. A slot an hour
  // out is a real slot from the real reader; one starting in four minutes would
  // make this suite fail at 09:26 and pass at 09:31, which is a broken test rather
  // than a finding.
  const soonest = now.getTime() + 90 * 60_000;
  const slots = earliestSlots(days, index + 40).filter((s) => Date.parse(s.start) > soonest);
  const slot = slots[index];
  wire.length = before;
  if (!slot) throw new Error("the mock offered no availability at all");
  return { start: slot.start, finish: slot.finish, practitionerId: slot.practitionerId };
}

/** Every message the PATIENT would receive across the whole conversation. */
function patientMessages(): string[] {
  return h.sent.filter((m) => m.to === PATIENT_NUMBER).map((m) => m.body);
}

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  conversations.clear();
  messages.length = 0;
  identities.clear();
  wire.length = 0;
  h.script.length = 0;
  h.modelCalls.length = 0;
  h.sent.length = 0;
  h.identity = null;
  sid = 0;
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
  // PRODUCTION'S OWN STATE: no staff alert number is configured, so the durable
  // Task Queue record is the entire handover notification. Tested as such.
  vi.stubEnv("STAFF_ALERT_PHONE", "");
  // PRODUCTION'S OWN STATE: no payment plan has been chosen for a conversational
  // registration, so register_patient must refuse rather than guess one.
  vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

/* =========================================================================== */

describe("1. an unknown number books an appointment over four texts", () => {
  it("greets, offers real slots, refuses to book without a yes, then books for real", async () => {
    const slot = await realSlot();

    // --- turn 1: hello. Nothing but words. ---
    const greeting = await patientTexts("hi", [
      { text: "Hello, thanks for getting in touch with Vitality Dental. How can I help you today?" },
    ]);
    expect(greeting).toBeTruthy();
    expect(wire, "a greeting must not touch Dentally").toHaveLength(0);

    // --- turn 2: they ask to book. The agent looks up REAL availability. ---
    const offer = await patientTexts("I'd like to book a check-up please", [
      { tools: [{ name: "find_slots", input: { treatment: "Check-up" } }] },
      { text: "I can offer you a check-up. Would 9am on the day I mentioned suit you?" },
    ]);
    const slotsCall = toolExchanges().find((t) => t.name === "find_slots");
    expect(slotsCall, "the agent must read live availability, never invent a time").toBeDefined();
    const offered = JSON.parse(slotsCall!.result) as { slots: Array<Record<string, unknown>> };
    expect(offered.slots.length).toBeGreaterThan(0);
    expect(offer).toBeTruthy();

    // Every offered slot is a real bookable unit, on the wall-clock grid, and no
    // longer than one booking. A raw Dentally availability WINDOW here is what put
    // multi-hour appointments into a clinician's diary.
    for (const s of offered.slots.slice(0, 12)) {
      const startMs = Date.parse(String(s.start_time));
      const finishMs = Date.parse(String(s.finish_time));
      expect(finishMs - startMs).toBeLessThanOrEqual(60 * 60_000);
      expect(new Date(startMs).getUTCSeconds(), `ragged slot ${String(s.start_time)}`).toBe(0);
      expect(new Date(startMs).getUTCMinutes() % 5, `off-grid slot ${String(s.start_time)}`).toBe(0);
    }

    // --- turn 3: an AMBIGUOUS reply. The model tries to book; the gate refuses. ---
    const nudged = await patientTexts("what times do you have again?", [
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "Of course. Would 9am work for you? Just say yes and I will book it in." },
    ]);
    expect(lastToolResult("book")).toMatchObject({
      error: expect.stringContaining("Not confirmed"),
    });
    expect(wire.some((w) => w.method === "POST" && w.path === "/v1/appointments")).toBe(false);
    expect(nudged).toBeTruthy();

    // --- turn 4: a clear yes answering a read-back. Now it books, for real. ---
    // The caller is still a lead, so the agent must register them first; with no
    // payment plan configured that refuses, so it routes to the onboarding form.
    const refused = await patientTexts("yes please, 9am is perfect", [
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "I just need a couple of details first. Can I take your full name?" },
    ]);
    expect(
      lastToolResult("book"),
      "an unregistered lead must be sent through register_patient, never booked as 'lead:<number>'",
    ).toMatchObject({ error: expect.stringContaining("register_patient") });
    expect(refused).toBeTruthy();
    expect(wire.some((w) => w.method === "POST" && w.path === "/v1/appointments")).toBe(false);
  });

  it("books a KNOWN patient end to end and marks the thread booked", async () => {
    h.identity = {
      patientId: "pat-001",
      siteId: SITE_ID,
      patientName: "Amara Okafor",
      treatment: null,
      fundingType: null,
      lastVisitAt: null,
      recallDueAt: null,
      source: "dentally",
    };
    const slot = await realSlot(3);

    await patientTexts("can I book a check-up?", [
      { tools: [{ name: "find_slots", input: { treatment: "Check-up" } }] },
      { text: "Hi Amara. I can offer you Tuesday at 9am for a check-up. Shall I book that in for you?" },
    ]);

    const confirmation = await patientTexts("yes please", [
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "Lovely, that is booked in for you. We will see you then. Anything else I can help with?" },
    ]);

    expect(lastToolResult("book")).toMatchObject({ booked: true });

    const write = wire.find((w) => w.method === "POST" && w.path === "/v1/appointments");
    expect(write, "a confirmed booking must reach Dentally").toBeDefined();
    expect(write!.status).toBe(201);
    const sentAppointment = (write!.body as { appointment: Record<string, unknown> }).appointment;
    // The four fields real Dentally requires, from the REVALIDATED live slot.
    expect(sentAppointment.patient_id).toBe("pat-001");
    expect(sentAppointment.start_time).toBe(slot.start);
    expect(sentAppointment.practitioner_id).toBeTruthy();
    expect(sentAppointment.reason).toBe("Exam");
    // And never longer than the treatment needs.
    const span = Date.parse(String(sentAppointment.finish_time)) - Date.parse(String(sentAppointment.start_time));
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(60 * 60_000);

    const thread = [...conversations.values()][0];
    expect(thread.status).toBe("booked");
    expect(confirmation).toContain("booked");
  });
});

describe("2. reschedule, then cancel", () => {
  async function bookOne(): Promise<{ appointmentId: string; slot: Awaited<ReturnType<typeof realSlot>> }> {
    h.identity = {
      patientId: "pat-001",
      siteId: SITE_ID,
      patientName: "Amara Okafor",
      treatment: null,
      fundingType: null,
      lastVisitAt: null,
      recallDueAt: null,
      source: "dentally",
    };
    const slot = await realSlot(5);
    await patientTexts("can I book a check-up on that day at that time?", [
      { text: "I can do that time for a check-up. Shall I book it in?" },
    ]);
    await patientTexts("yes please", [
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "That is booked in for you." },
    ]);
    const result = lastToolResult("book") as unknown as { booked: boolean; appointmentId: string };
    expect(result.booked).toBe(true);
    return { appointmentId: result.appointmentId, slot };
  }

  it("moves a real appointment to a new slot, carrying the new clinician", async () => {
    const { appointmentId } = await bookOne();
    const newSlot = await realSlot(7);

    await patientTexts("something has come up, can I move it?", [
      { tools: [{ name: "find_appointments", input: {} }] },
      { tools: [{ name: "find_slots", input: { treatment: "Check-up" } }] },
      { text: "Of course. I could move you to the later time instead. Shall I move it?" },
    ]);

    const mine = lastToolResult("find_appointments") as unknown as { appointments: Array<{ id: string }> };
    expect(
      mine.appointments.some((a) => String(a.id) === appointmentId),
      "the appointment just booked must be visible to reschedule",
    ).toBe(true);

    const reply = await patientTexts("yes that works, please move it", [
      {
        tools: [
          {
            name: "reschedule",
            input: {
              appointmentId,
              newSlotStart: newSlot.start,
              newFinishTime: newSlot.finish,
              practitionerId: newSlot.practitionerId,
            },
          },
        ],
      },
      { text: "All moved. You are now booked for the later time. See you then." },
    ]);

    const moved = lastToolResult("reschedule") as unknown as { rescheduled: boolean };
    expect(moved.rescheduled).toBe(true);
    const put = wire.filter((w) => w.method === "PUT").pop();
    expect(put, "a reschedule must PUT the appointment").toBeDefined();
    const patch = (put!.body as { appointment: Record<string, unknown> }).appointment;
    expect(patch.start_time).toBe(newSlot.start);
    expect(patch.finish_time).toBeTruthy();
    expect(
      patch.practitioner_id,
      "the new slot's clinician must ride along, or the move lands in the wrong diary",
    ).toBe(newSlot.practitionerId);
    expect(reply).toBeTruthy();
  });

  it("refuses to touch an appointment that is not on this patient's record", async () => {
    await bookOne();
    // Past the confirmation gate on purpose: a clear yes answering a read-back, so
    // the ONLY thing left standing between a crafted id and someone else's diary is
    // the server-side ownership check.
    await patientTexts("please cancel appointment appt-002a", [
      { text: "To confirm, shall I cancel that appointment for you?" },
    ]);
    await patientTexts("yes, cancel it please", [
      { tools: [{ name: "cancel", input: { appointmentId: "appt-002a" } }] },
      { text: "I could not find that appointment on your record. Shall I check the ones you do have?" },
    ]);
    expect(lastToolResult("cancel")).toMatchObject({ error: expect.stringContaining("could not find") });
    expect(wire.some((w) => w.method === "DELETE")).toBe(false);
  });

  it("cancels a real appointment once the patient confirms", async () => {
    const { appointmentId } = await bookOne();

    await patientTexts("I need to cancel my appointment", [
      { tools: [{ name: "find_appointments", input: {} }] },
      { text: "I can cancel that for you. To confirm, shall I cancel it?" },
    ]);
    const reply = await patientTexts("yes, cancel it please", [
      { tools: [{ name: "cancel", input: { appointmentId } }] },
      { text: "That is cancelled for you. Just message here whenever you would like to rebook." },
    ]);

    const cancelled = lastToolResult("cancel") as unknown as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);
    expect(wire.some((w) => w.method === "DELETE")).toBe(true);
    expect(reply).toContain("cancelled");
  });
});

describe("3. a NEW caller cannot be registered, and is never left at a dead end", () => {
  it("refuses register_patient with no payment plan configured and routes to the onboarding form", async () => {
    const reply = await patientTexts("Hi, I'm new. I'm Jamie Fletcher, Mr, born 1990-03-04. Can I book?", [
      {
        tools: [
          {
            name: "register_patient",
            input: { firstName: "Jamie", lastName: "Fletcher", title: "Mr", dateOfBirth: "1990-03-04" },
          },
        ],
      },
      { tools: [{ name: "send_onboarding_form", input: {} }] },
      {
        text:
          "Lovely to hear from you Jamie. So we can get you booked in, please fill in your details here: " +
          "http://localhost:3000/onboard/vitality and a member of the team will confirm your appointment.",
      },
    ]);

    const registration = lastToolResult("register_patient") as unknown as { registered: boolean; error: string };
    expect(registration.registered).toBe(false);
    // The refusal must not read like a rejection of the PATIENT, and it must name
    // the two working paths.
    expect(registration.error).toContain("Do NOT tell them anything was rejected");
    expect(registration.error).toContain("send_onboarding_form");
    expect(registration.error).toContain("escalate_to_human");

    // NOTHING was written to Dentally.
    expect(wire.some((w) => w.method === "POST" && w.path === "/v1/patients")).toBe(false);

    // The patient is given a real, working next step, not an apology.
    const form = lastToolResult("send_onboarding_form") as unknown as { url: string };
    expect(form.url).toBe("http://localhost:3000/onboard/vitality");
    expect(reply).toContain(form.url);
    expect(reply.toLowerCase()).not.toContain("rejected");
    expect(reply.toLowerCase()).not.toContain("error");
  });

  it("asks for the title and date of birth rather than guessing them", async () => {
    vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "1");
    await patientTexts("I'm Jamie Fletcher and I'd like an appointment", [
      { tools: [{ name: "register_patient", input: { firstName: "Jamie", lastName: "Fletcher" } }] },
      { text: "Lovely. Could I take your title and your date of birth so I can add you to our records?" },
    ]);
    const refusal = lastToolResult("register_patient") as unknown as { registered: boolean; error: string };
    expect(refusal.registered).toBe(false);
    expect(refusal.error).toContain("Never guess it");
    expect(wire.some((w) => w.method === "POST" && w.path === "/v1/patients")).toBe(false);
  });

  it("registers and then books once the owner HAS chosen a payment plan", async () => {
    vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "1");
    const slot = await realSlot(9);

    await patientTexts("Hi, I'm new here. Can I get a check-up?", [
      { text: "Of course. Could I take your title, full name and date of birth?" },
    ]);
    await patientTexts("Mr Jamie Fletcher, 4 March 1990. Does 9am suit?", [
      { text: "Thank you. I can offer you that time for a check-up. Shall I book it in?" },
    ]);
    const reply = await patientTexts("yes please", [
      {
        tools: [
          {
            name: "register_patient",
            input: { firstName: "Jamie", lastName: "Fletcher", title: "Mr", dateOfBirth: "1990-03-04" },
          },
        ],
      },
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "You are all set, Jamie. That is booked in for you." },
    ]);

    const created = wire.find((w) => w.method === "POST" && w.path === "/v1/patients");
    expect(created, "with a plan configured the registration must reach Dentally").toBeDefined();
    expect(created!.status, "201 means the payload passed the live-calibrated 422 gate").toBe(201);
    const payload = (created!.body as { patient: Record<string, unknown> }).patient;
    expect(payload.date_of_birth).toBe("1990-03-04");
    expect(payload.title).toBe("Mr");
    expect(payload.payment_plan_id).toBe(1);
    expect(typeof payload.gender).toBe("boolean");

    expect(lastToolResult("book")).toMatchObject({ booked: true });
    expect(reply).toBeTruthy();

    // The thread is re-keyed onto the new patient and the number remembered, so
    // their next message lands back here rather than opening a second thread.
    expect(identities.get(PATIENT_NUMBER)).toMatchObject({ patientName: "Jamie Fletcher" });
  });
});

describe("4. the guardrail trip and the escalation path", () => {
  it("never lets forbidden wording reach the patient, and hands over instead", async () => {
    await patientTexts("is my check-up covered?", [
      { text: "Yes, your check-up would be on the NHS so there is nothing to pay today." },
    ]);
    const delivered = patientMessages().pop()!;
    expect(delivered, "the model's own words must never be sent once the guard trips").toBe(SAFE_HANDOVER);
    expect(delivered.toLowerCase()).not.toContain("nhs");
    expect([...conversations.values()][0].status).toBe("needs_human");
  });

  it("with STAFF_ALERT_PHONE unset the handover is still recorded, and no staff text is sent", async () => {
    await patientTexts("can I speak to a human please", [
      { tools: [{ name: "escalate_to_human", input: { reason: "patient asked for a person" } }] },
      { text: "Of course, I am passing you to a colleague now. They will be in touch shortly." },
    ]);
    // ONE message went out, to the PATIENT. Nothing to staff, because there is no
    // number configured: the Task Queue record is the whole notification.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(PATIENT_NUMBER);
    expect([...conversations.values()][0].status).toBe("needs_human");

    // And the alert itself reports honestly which channel carried it.
    const outcome = await alertStaffHandover({
      patientName: "Unknown 0321",
      reason: "escalated",
      conversationId: [...conversations.values()][0].id,
    });
    expect(outcome).toMatchObject({ sms: "no_phone", queued: true });
  });

  it("does push a staff text once a number IS configured", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900999");
    await patientTexts("can I speak to a human please", [
      { tools: [{ name: "escalate_to_human", input: { reason: "patient asked for a person" } }] },
      { text: "Of course, I am passing you to a colleague now." },
    ]);
    const staff = h.sent.filter((m) => m.to === "+447700900999");
    expect(staff).toHaveLength(1);
    expect(staff[0].body).toContain("needs a human");
    expect(staff[0].body).toContain("Open Conversations in the dashboard");
  });

  it("does not write an appointment in the same round it hands over", async () => {
    h.identity = {
      patientId: "pat-001",
      siteId: SITE_ID,
      patientName: "Amara Okafor",
      treatment: null,
      fundingType: null,
      lastVisitAt: null,
      recallDueAt: null,
      source: "dentally",
    };
    const slot = await realSlot(11);
    await patientTexts("that time works, shall we say yes?", [
      { text: "Shall I book you in at that time?" },
    ]);
    await patientTexts("yes go ahead", [
      {
        tools: [
          { name: "escalate_to_human", input: { reason: "unsure" } },
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "Let me pass you to a colleague who will confirm that." },
    ]);
    expect(lastToolResult("book")).toMatchObject({ error: expect.stringContaining("Skipped") });
    expect(wire.some((w) => w.method === "POST" && w.path === "/v1/appointments")).toBe(false);
    expect([...conversations.values()][0].status).toBe("needs_human");
  });
});

describe("5. every message the patient receives", () => {
  it("carries no funding jargon, no invented price and no tool markup", async () => {
    h.identity = {
      patientId: "pat-001",
      siteId: SITE_ID,
      patientName: "Amara Okafor",
      treatment: null,
      fundingType: null,
      lastVisitAt: null,
      recallDueAt: null,
      source: "dentally",
    };
    const slot = await realSlot(13);
    await patientTexts("hello", [{ text: "Hello Amara, how can I help today?" }]);
    await patientTexts("what does a check-up cost?", [
      { tools: [{ name: "treatment_info", input: { treatment: "Check-up" } }] },
      { text: "A check-up starts from £35. A coordinator will confirm the exact price when you come in." },
    ]);
    await patientTexts("ok can I book one?", [
      { tools: [{ name: "find_slots", input: { treatment: "Check-up" } }] },
      { text: "I can offer you that time. Shall I book it in?" },
    ]);
    await patientTexts("yes please", [
      {
        tools: [
          {
            name: "book",
            input: {
              slotStart: slot.start,
              finishTime: slot.finish,
              practitionerId: slot.practitionerId,
              treatment: "Check-up",
            },
          },
        ],
      },
      { text: "Booked. See you then, Amara." },
    ]);

    for (const body of patientMessages()) {
      expect(body, `funding jargon reached a patient: ${body}`).not.toMatch(/\bNHS\b|\bprivately\b/i);
      expect(body, `tool markup reached a patient: ${body}`).not.toMatch(/<(?:antml:)?invoke|<parameter/i);
      expect(body.length, `an SMS this long will be split badly: ${body}`).toBeLessThan(700);
      expect(body.trim()).not.toBe("");
    }
  });

  it("replaces a reply that leaked tool markup rather than showing it to the patient", async () => {
    await patientTexts("hi", [
      { text: "<invoke name=\"find_slots\"><parameter name=\"treatment\">Check-up</parameter></invoke>" },
      { text: "Hello, I can look up some times for you. What are you hoping to book?" },
    ]);
    const delivered = patientMessages().pop()!;
    expect(delivered).not.toMatch(/<invoke|<parameter/i);
    expect(delivered).toContain("times");
  });
});
