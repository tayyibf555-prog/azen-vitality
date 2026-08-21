import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

/**
 * THE TWO STRUCTURED REPLIES, ON THE PATIENT'S RECORD.
 *
 * Both branches at the top of this webhook answer a patient and RETURN, before the
 * conversation store is written further down. So until `recordOutbound` was added
 * to them, the platform texted "Thanks for confirming, we look forward to seeing
 * you" and "Thank you for letting us know, someone will be in touch" to real
 * patients and their Correspondence tab showed only their own inbound word — under
 * a heading claiming to hold every message this platform has sent them.
 *
 * These tests run the REAL handlers (`handleNoshowInbound`, `handlePostopInbound`,
 * their repositories faked), the REAL webhook, the REAL `recordOutbound`, and read
 * back with the REAL `getThreadForPatient`. That chain is what the claim rests on;
 * mocking the recorder and asserting it was called would prove none of it.
 */

const noshowRepo = vi.hoisted(() => ({
  offer: null as unknown,
  target: null as unknown,
  match: null as unknown,
  statuses: [] as Array<[string, string]>,
}));
const postopRepo = vi.hoisted(() => ({
  match: null as unknown,
  target: null as unknown,
  escalations: [] as unknown[],
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
  return {
    isStopKeyword: (b: string) => STOP.has(String(b).trim().toLowerCase()),
    addSuppression: vi.fn(async () => {}),
    isSuppressed: vi.fn(async () => false),
  };
});

// --- the REAL no-show handler, over a faked repository --------------------
vi.mock("@/lib/noshow/repository", () => ({
  findOpenOfferByAddress: async () => noshowRepo.offer,
  findTargetByAddress: async () => noshowRepo.match,
  getTarget: async () => noshowRepo.target,
  getCadenceByTarget: async () => null,
  listActiveTargetIdsByAddress: async () =>
    noshowRepo.match ? [(noshowRepo.match as { targetId: string }).targetId] : [],
  insertInboundTouch: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async (id: string, status: string) => {
    noshowRepo.statuses.push([id, status]);
  }),
  updateCadence: vi.fn(async () => {}),
  claimOffer: vi.fn(async () => null),
  setOfferStatus: vi.fn(async () => {}),
  setWaitlistStatus: vi.fn(async () => {}),
  slotIsFilled: vi.fn(async () => false),
}));
vi.mock("@/lib/noshow/fill", () => ({ offerSlotToNextCandidate: vi.fn(async () => null) }));

// --- the REAL post-op handler, over a faked repository --------------------
vi.mock("@/lib/postop/repository", () => ({
  findTargetByAddress: async () => postopRepo.match,
  getTarget: async () => postopRepo.target,
  insertInboundTouch: vi.fn(async () => {}),
  recordEscalation: vi.fn(async (e: unknown) => {
    postopRepo.escalations.push(e);
  }),
  setTargetStatus: vi.fn(async () => {}),
}));

vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: async () => null,
  insertInboundTouch: vi.fn(async () => {}),
  getCadenceByTarget: async () => null,
  updateCadence: vi.fn(async () => {}),
  getTargetContext: async () => null,
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: async () => null,
  getCadenceByTarget: async () => null,
  updateCadence: vi.fn(async () => {}),
  insertInboundTouch: vi.fn(async () => {}),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: async () => null,
  insertInboundTouch: vi.fn(async () => {}),
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: () => false,
  getSiteById: () => ({ id: "site-cc" }),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class DentallyClient {} }));
vi.mock("@/lib/dentally/write", () => ({
  dentallyAgentClient: () => ({ cancelAppointment: async () => {} }),
  isDentallyWriteEnabled: () => false,
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" }),
  getSites: () => [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" }],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: async () => true }));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: async () => null }));

// Postgres is the only thing faked underneath recordOutbound.
vi.mock("@/lib/supabase/server", async () => {
  const mod = await import("@/lib/inbox/test-support/agent-store-fake");
  return { serviceClient: () => mod.serviceClientFake() };
});

/**
 * A recorder that BREAKS ITS CONTRACT, for the tests at the foot of this file.
 *
 * `recordOutbound` promises never to throw, and both branches here relied on that
 * promise with a bare `await`. A promise is not a guard: the day an edit lets one
 * escape, an unguarded await on a Twilio webhook is a 500, and Twilio retries a
 * non-2xx. The retry re-runs the turn and can confirm or cancel the appointment
 * twice and text the patient again, which is a far worse outcome than the missing
 * row it started as. Off by default so every test above runs the real recorder.
 */
const recorderThrows = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/inbox/record-outbound", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/inbox/record-outbound")>();
  return {
    ...real,
    recordOutbound: async (input: Parameters<typeof real.recordOutbound>[0]) => {
      if (recorderThrows.on) throw new Error("recordOutbound broke its never-throws contract");
      return real.recordOutbound(input);
    },
  };
});

const sendMessage = vi.fn();

import { agentStore, resetAgentStore, rowsIn } from "@/lib/inbox/test-support/agent-store-fake";
import { POST } from "./route";
import { getThreadForPatient } from "@/lib/inbox/repository";

const TOKEN = "test-auth-token";
const URL_ = "http://localhost:3000/api/webhooks/twilio/inbound";
const FROM = "+447700900321";
const SITE = "site-cc";
const PATIENT = "pat-4471";

function signed(params: Record<string, string>): Request {
  return new Request(URL_, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(URL_, params, TOKEN),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentStore();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
  recorderThrows.on = false;
  noshowRepo.offer = null;
  noshowRepo.match = null;
  noshowRepo.target = null;
  noshowRepo.statuses = [];
  postopRepo.match = null;
  postopRepo.target = null;
  postopRepo.escalations = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A defended appointment for this number, so YES resolves to a confirmation. */
function seedNoshowTarget(): void {
  noshowRepo.match = { targetId: `${SITE}:${PATIENT}:appt-1`, siteId: SITE };
  noshowRepo.target = {
    id: `${SITE}:${PATIENT}:appt-1`,
    siteId: SITE,
    dentallyPatientId: PATIENT,
    appointmentId: "appt-1",
    patientName: "Sarah Ahmed",
    appointmentStartAt: "2026-09-01T09:00:00Z",
    appointmentState: "scheduled",
    durationMin: 30,
    practitioner: "Dr Khan",
    riskScore: 10,
    riskBand: "low",
    status: "scheduled",
    priorAttempts: 1,
    consent: { sms: true, email: false, marketing: false },
    updatedFromDentallyAt: "2026-08-20T09:00:00Z",
  };
}

/** A recent post-op check-in for this number, so a reply is triaged here. */
function seedPostopTarget(): void {
  const sentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  postopRepo.match = { targetId: "postop-1", siteId: SITE, sentAt };
  postopRepo.target = {
    id: "postop-1",
    siteId: SITE,
    dentallyPatientId: PATIENT,
    appointmentId: "appt-9",
    patientName: "Sarah Ahmed",
    status: "sent",
  };
}

describe("a no-show confirmation reply lands on the record", () => {
  it("shows the answer we sent, outbound, on the patient's own timeline", async () => {
    seedNoshowTarget();
    const res = await POST(signed({ From: FROM, Body: "YES", MessageSid: "SM1" }));
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = String(sendMessage.mock.calls[0][0].body);
    expect(sent).toContain("Thanks for confirming");

    const read = await getThreadForPatient([SITE], PATIENT);
    const messages = read.thread?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe(sent);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].channel).toBe("sms");
    expect(read.thread?.contactRef).toBe(`patient:${PATIENT}`);
  });

  it("keeps a WhatsApp confirmation on the WhatsApp channel", async () => {
    seedNoshowTarget();
    await POST(signed({ From: `whatsapp:${FROM}`, Body: "YES", MessageSid: "SM2" }));
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].channel).toBe("whatsapp");
  });

  it("writes nothing when the send failed, so no unsent message reaches a record", async () => {
    seedNoshowTarget();
    sendMessage.mockRejectedValue(new Error("twilio down"));
    const res = await POST(signed({ From: FROM, Body: "YES", MessageSid: "SM3" }));
    expect(res.status).toBe(200);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });

  it("still confirms the appointment and answers Twilio when the record write fails", async () => {
    // Fail-soft: the patient has the text and the appointment is confirmed. A
    // logging failure must not 500 (Twilio retries a non-2xx, which would re-run
    // the whole turn) and must not send a second text.
    seedNoshowTarget();
    agentStore.failTables.add("agent_message");
    const res = await POST(signed({ From: FROM, Body: "YES", MessageSid: "SM4" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(noshowRepo.statuses).toContainEqual([`${SITE}:${PATIENT}:appt-1`, "confirmed"]);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });
});

describe("a post-op acknowledgement lands on the record", () => {
  it("shows the acknowledgement we sent, outbound, on the patient's own timeline", async () => {
    seedPostopTarget();
    const res = await POST(signed({ From: FROM, Body: "my jaw is quite sore today", MessageSid: "SM5" }));
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = String(sendMessage.mock.calls[0][0].body);

    const read = await getThreadForPatient([SITE], PATIENT);
    const messages = read.thread?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe(sent);
    expect(messages[0].direction).toBe("outbound");
    expect(read.thread?.contactRef).toBe(`patient:${PATIENT}`);
  });

  it("writes nothing when the module said nothing", async () => {
    // handled:true with reply:null is a valid outcome (switched off, opted out, no
    // usable name). Nothing was said, so nothing belongs on the record.
    seedPostopTarget();
    const { isSuppressed } = await import("@/lib/messaging/suppression");
    vi.mocked(isSuppressed).mockResolvedValue(true);
    const res = await POST(signed({ From: FROM, Body: "my jaw is quite sore today", MessageSid: "SM6" }));
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(rowsIn("agent_message")).toHaveLength(0);
    vi.mocked(isSuppressed).mockResolvedValue(false);
  });

  it("still records the ESCALATION and answers Twilio when the record write fails", async () => {
    // The escalation is the clinically load-bearing write. A correspondence-logging
    // failure must not cost it, must not 500, and must not re-send the acknowledgement.
    seedPostopTarget();
    agentStore.failTables.add("agent_conversation");
    const res = await POST(signed({ From: FROM, Body: "my jaw is quite sore today", MessageSid: "SM7" }));
    expect(res.status).toBe(200);
    expect(postopRepo.escalations).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });
});

describe("a recorder that throws cannot 500 this webhook", () => {
  /**
   * The contract says recordOutbound never throws. These tests assume it DOES,
   * because that is the assumption the code has to survive: a 500 on this route is
   * a Twilio retry, and a retry re-runs a turn that has already cancelled an
   * appointment and already texted the patient.
   */
  it("still answers Twilio 200 on the no-show branch, and does not text twice", async () => {
    seedNoshowTarget();
    recorderThrows.on = true;
    const res = await POST(signed({ From: FROM, Body: "YES", MessageSid: "SM8" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The clinically load-bearing write still happened: the appointment is confirmed.
    expect(noshowRepo.statuses).toContainEqual([`${SITE}:${PATIENT}:appt-1`, "confirmed"]);
  });

  it("still answers Twilio 200 on the post-op branch, and keeps the escalation", async () => {
    seedPostopTarget();
    recorderThrows.on = true;
    const res = await POST(signed({ From: FROM, Body: "my jaw is quite sore today", MessageSid: "SM9" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(postopRepo.escalations).toHaveLength(1);
  });

  it("does not let the post-op catch report a triage failure that did not happen", async () => {
    // Without the guard the throw lands in the post-op try/catch, which logs
    // "post-op triage failed; not answering this message" — untrue on both counts:
    // the triage succeeded and the patient was answered.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seedPostopTarget();
    recorderThrows.on = true;
    await POST(signed({ From: FROM, Body: "my jaw is quite sore today", MessageSid: "SM10" }));
    const lines = error.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("post-op triage failed"))).toBe(false);
  });
});
