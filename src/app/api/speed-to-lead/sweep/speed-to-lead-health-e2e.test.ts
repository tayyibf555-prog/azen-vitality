// ===========================================================================
// SPEED-TO-LEAD, ABANDONED HOLDS AND THE FOLLOW-UP OVERRIDE, END TO END.
//
// The smile-assessment and speed-to-lead toggles are ON at go-live, which means a
// stranger finishing the quiz on a public page causes a REAL text to a REAL
// mobile within seconds, written by a language model. This drives that whole path
// with the real submit route, the real bridge, the real first-contact composer,
// the real output guardrail, the real nurture cadence and the real SLA sweep,
// over an in-memory database.
//
// WHAT IS FAKED: Supabase (an in-memory store that behaves like the tables), the
// SMS provider (captured, never sent), and the MODEL (scripted, because a model
// cannot be an assertion). Everything between them is the product.
//
// The exact patient-facing texts this produces are asserted AND printed, because
// the thing most worth reviewing before go-live is what the patient reads.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "@/lib/smile-assessment/quiz";
import type { SpeedToLeadLead, SpeedToLeadAttempt, LeadChannel } from "@/lib/speed-to-lead/types";
import type { LeadStage } from "@/lib/types";

const SITE_ID = "site-cc";
const SUBMIT_KEY = "test-submit-key";

/* ---------------------------------------------------------------------------
 * The scripted model, and every captured send.
 * ------------------------------------------------------------------------- */

const h = vi.hoisted(() => ({
  drafts: [] as string[],
  draftPrompts: [] as Array<{ system: string; user: string }>,
  sent: [] as Array<{ channel: string; to: string; body: string }>,
  sendFails: 0,
  modelThrows: false,
}));

vi.mock("server-only", () => ({}));

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (args: Record<string, unknown>) => {
        const msgs = (args.messages ?? []) as Array<{ content: string }>;
        h.draftPrompts.push({ system: String(args.system ?? ""), user: String(msgs[0]?.content ?? "") });
        if (h.modelThrows) throw new Error("model unavailable");
        const text = h.drafts.shift();
        if (text === undefined) throw new Error("the draft script ran out");
        return { content: [{ type: "text", text }], stop_reason: "end_turn" };
      },
    };
  }
  return { default: Anthropic };
});

vi.mock("@/lib/messaging/send", () => ({
  sendMessage: async (m: { channel: string; to: string; body: string }) => {
    if (h.sendFails > 0) {
      h.sendFails -= 1;
      throw new Error("provider rejected the message");
    }
    h.sent.push({ channel: m.channel, to: m.to, body: m.body });
    return { provider: "test", providerMessageId: `SM-${h.sent.length}` };
  },
}));

/* ---------------------------------------------------------------------------
 * The in-memory speed-to-lead tables.
 * ------------------------------------------------------------------------- */

const leads: SpeedToLeadLead[] = [];
const attempts: SpeedToLeadAttempt[] = [];
/**
 * The test clock. Both sweeps read Date.now() themselves, so a 21-day cadence is
 * walked by MOVING THE CLOCK rather than by waiting, and the store's own
 * timestamps move with it. Only Date is faked; nothing here schedules a timer.
 */
let clock = Date.parse("2026-08-21T09:00:00.000Z");
const nowIso = () => new Date(clock).toISOString();
function setClock(ms: number): void {
  clock = ms;
  vi.setSystemTime(new Date(ms));
}
function advance(ms: number): void {
  setClock(clock + ms);
}

function newLead(input: Partial<SpeedToLeadLead> & { siteId: string; name: string }): SpeedToLeadLead {
  const row: SpeedToLeadLead = {
    id: `lead-${leads.length + 1}`,
    siteId: input.siteId,
    dentallyPatientId: input.dentallyPatientId ?? null,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    channel: (input.channel ?? "sms") as LeadChannel,
    treatmentInterest: input.treatmentInterest ?? null,
    source: input.source ?? "smile-assessment",
    score: input.score ?? null,
    stage: (input.stage ?? "new") as LeadStage,
    consent: input.consent ?? { sms: true, email: false, whatsapp: false, marketing: false },
    createdAt: input.createdAt ?? nowIso(),
    firstResponseAt: input.firstResponseAt ?? null,
    conversationId: input.conversationId ?? null,
    updatedAt: nowIso(),
    nurtureStep: input.nurtureStep ?? 0,
    nurtureNextAt: input.nurtureNextAt ?? null,
  };
  leads.push(row);
  return row;
}

vi.mock("@/lib/speed-to-lead/repository", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    insertLead: async (input: Record<string, unknown>) =>
      newLead(input as Parameters<typeof newLead>[0]),
    getLead: async (id: string) => leads.find((l) => l.id === id) ?? null,
    setLeadStage: async (id: string, stage: LeadStage) => {
      const row = leads.find((l) => l.id === id);
      if (row) {
        row.stage = stage;
        row.updatedAt = nowIso();
      }
    },
    claimLeadForContact: async (id: string) => {
      const row = leads.find((l) => l.id === id);
      if (!row || row.stage !== "new") return false;
      row.stage = "contacting";
      return true;
    },
    releaseLeadClaim: async (id: string) => {
      const row = leads.find((l) => l.id === id);
      if (row && row.stage === "contacting") row.stage = "new";
    },
    resetStaleContacting: async () => 0,
    recordFirstResponse: async (id: string, patch: { firstResponseAt: string; conversationId: string }) => {
      const row = leads.find((l) => l.id === id);
      if (row) {
        row.firstResponseAt = patch.firstResponseAt;
        row.conversationId = patch.conversationId;
      }
    },
    listUncontacted: async (olderThanIso: string) =>
      leads.filter((l) => l.stage === "new" && !l.firstResponseAt && l.createdAt <= olderThanIso),
    findOpenLeadByAddress: async () => null,
    findEarlierOpenLead: async () => null,
    listNurtureDue: async (args: { nowIso: string; entryCutoffIso: string; ageCutoffIso: string }) =>
      leads.filter(
        (l) =>
          l.stage === "contacted" &&
          l.nurtureStep < 3 &&
          l.createdAt >= args.ageCutoffIso &&
          (l.nurtureNextAt
            ? l.nurtureNextAt <= args.nowIso
            : !!l.firstResponseAt && l.firstResponseAt <= args.entryCutoffIso),
      ),
    setNurtureSchedule: async (id: string, step: number, next: string | null) => {
      const row = leads.find((l) => l.id === id);
      if (row) {
        row.nurtureStep = step;
        row.nurtureNextAt = next;
      }
    },
    markNurtureDone: async (id: string) => {
      const row = leads.find((l) => l.id === id);
      if (row) {
        row.nurtureStep = 3;
        row.nurtureNextAt = null;
        row.stage = "nurture_done" as LeadStage;
      }
    },
    insertAttempt: async (input: Record<string, unknown>) => {
      const row = {
        id: `att-${attempts.length + 1}`,
        createdAt: nowIso(),
        provider: null,
        providerMessageId: null,
        ...input,
      } as SpeedToLeadAttempt;
      attempts.push(row);
      return row;
    },
    listAttempts: async (leadId: string) => attempts.filter((a) => a.leadId === leadId),
    findLeadByConversation: async (conversationId: string) =>
      leads.find((l) => l.conversationId === conversationId) ?? null,
  };
});

/* ---------------------------------------------------------------------------
 * The rest of the store.
 * ------------------------------------------------------------------------- */

const conversations = new Map<string, { id: string; lastInboundAt: string | null }>();
const convMessages: Array<{ conversationId: string; role: string; body: string }> = [];

vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: async () => {
    const id = `conv-${conversations.size + 1}`;
    const row = { id, lastInboundAt: null };
    conversations.set(id, row);
    return { ...row, status: "active", patientName: "", treatment: null, fundingType: null };
  },
  getConversation: async (id: string) => conversations.get(id) ?? null,
  appendMessage: async (m: { conversationId: string; role: string; body: string }) => {
    convMessages.push({ ...m });
  },
}));

const contactedToday = new Set<string>();
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async (siteId: string, address: string, day: string) =>
    contactedToday.has(`${siteId}|${address}|${day}`),
  recordContacted: async (siteId: string, address: string, day: string) => {
    contactedToday.add(`${siteId}|${address}|${day}`);
  },
}));

vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: async () => false,
  isStopKeyword: () => false,
  addSuppression: async () => {},
}));

const smileResponses: Array<{ id: string; leadId: string | null; responses: Record<string, string>; campaignId: string | null }> = [];
vi.mock("@/lib/smile-assessment/repository", () => ({
  insertResponse: async (input: Record<string, unknown>) => {
    const row = {
      id: `resp-${smileResponses.length + 1}`,
      leadId: null,
      responses: (input.responses ?? {}) as Record<string, string>,
      campaignId: (input.campaignId ?? null) as string | null,
    };
    smileResponses.push(row);
    return { id: row.id };
  },
  setResponseLead: async (responseId: string, leadId: string) => {
    const row = smileResponses.find((r) => r.id === responseId);
    if (row) row.leadId = leadId;
  },
  countRecent: async () => 0,
  latestResponseByLead: async (leadId: string) =>
    smileResponses.filter((r) => r.leadId === leadId).pop() ?? null,
}));

const campaignFollowUp = { value: null as unknown };
vi.mock("@/lib/smile-assessment/campaign-repository", () => ({
  getActiveCampaignBySlug: async () => null,
  getCampaignFollowUp: async () => campaignFollowUp.value,
}));

const holds: Array<{
  id: string;
  siteId: string;
  name: string;
  phone: string;
  email: string | null;
  treatment: string;
  slotStart: string;
  status: string;
  createdAt: string;
}> = [];
vi.mock("@/lib/booking/holds", () => ({
  listAbandonedHolds: async (olderThanIso: string, freshestIso: string, limit: number) =>
    holds
      .filter((x) => x.status === "held" && x.createdAt <= olderThanIso && x.createdAt >= freshestIso)
      .slice(0, limit),
  markHoldExpired: async (id: string) => {
    const row = holds.find((x) => x.id === id);
    if (row) row.status = "expired";
  },
  markHoldConfirmed: async () => {},
  createHold: async () => ({ id: "hold-x", slotStart: "", slotFinish: "" }),
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  isSystemEnabledStrict: async () => true,
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: async () => [] }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => true,
  releaseCronLock: async () => {},
  tryAcquireLease: async () => "acquired",
}));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/assess/meta-pixel-repository", () => ({
  resolveMetaPixel: async () => ({ enabled: false, pixelId: null, advancedMatching: false }),
}));
vi.mock("@/lib/assess/meta-capi-send", () => ({
  sendAssessmentLeadEvent: async () => ({ sent: false, reason: "disabled" }),
}));

import { POST as SUBMIT } from "@/app/api/smile-assessment/submit/route";
import { POST as SWEEP } from "./route";
import { nurtureFallback } from "@/lib/speed-to-lead/draft";
import { NURTURE_INTERVALS_DAYS } from "@/lib/speed-to-lead/nurture-cadence";

const DAY_MS = 86_400_000;

/** A HIGH-band answer set, using the real quiz weights (20/20 + 30/30 + 30/30). */
const HIGH_ANSWERS: Record<string, string> = {
  [Q_TREATMENT]: "invisalign",
  [Q_TIMELINE]: "asap",
  [Q_BUDGET]: "ready",
  [Q_LOCATION]: "england",
};
/** A MEDIUM-band answer set (18/20 + 22/30 + 8/30 = 60). */
const MEDIUM_ANSWERS: Record<string, string> = {
  [Q_TREATMENT]: "veneers",
  [Q_TIMELINE]: "1_2_months",
  [Q_BUDGET]: "covered",
};

let ipN = 0;
async function submit(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  ipN += 1;
  const res = await SUBMIT(
    new Request("http://localhost/api/smile-assessment/submit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `203.0.113.${ipN % 250}`,
        "x-intake-key": SUBMIT_KEY,
      },
      body: JSON.stringify({ clientSlug: "vitality", siteId: SITE_ID, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function sweep(): Promise<Record<string, unknown>> {
  const res = await SWEEP(new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  leads.length = 0;
  attempts.length = 0;
  holds.length = 0;
  smileResponses.length = 0;
  conversations.clear();
  convMessages.length = 0;
  contactedToday.clear();
  h.drafts.length = 0;
  h.draftPrompts.length = 0;
  h.sent.length = 0;
  h.sendFails = 0;
  h.modelThrows = false;
  campaignFollowUp.value = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(Date.parse("2026-08-21T09:00:00.000Z"));
  vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", SUBMIT_KEY);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PUBLIC_BASE_URL", "https://azen-vitality.vercel.app");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/* =========================================================================== */

describe("1. a high-band assessment becomes a lead and is texted within the request", () => {
  it("scores high, creates the lead, drafts a first contact and sends it", async () => {
    h.drafts.push(
      "Hi Priya, it's Vitality Dental. Thanks for telling us about straightening your teeth. " +
        "Would you like me to find you a time that suits for a consultation? Just reply here.",
    );

    const { status, json } = await submit({
      firstName: "Priya",
      phone: "07700 900456",
      channel: "sms",
      responses: HIGH_ANSWERS,
    });

    expect(status).toBe(202);
    expect(json).toMatchObject({ band: "high", leadCreated: true });
    // Online booking is on, so the result screen is handed the public booking page.
    expect(json.bookingUrl).toBe(`/book/vitality?site=${SITE_ID}`);

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ stage: "contacted", source: "smile-assessment", score: 100 });
    expect(leads[0].firstResponseAt).toBeTruthy();

    // THE MESSAGE THE PATIENT RECEIVES.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ channel: "sms", to: "+447700900456" });
    console.log("\n--- FIRST CONTACT (high band, model-drafted) ---\n" + h.sent[0].body + "\n");

    // The attempt is recorded as sent, and the message is on the thread the
    // patient's reply will land in.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "sent", toAddress: "+447700900456" });
    expect(convMessages.some((m) => m.body === h.sent[0].body)).toBe(true);
  });

  it("tells the model the house rules, and grounds the draft in their own answers", async () => {
    h.drafts.push("Hi Priya, thanks for getting in touch. Shall I find you a time that suits?");
    await submit({ firstName: "Priya", phone: "07700 900457", channel: "sms", responses: HIGH_ANSWERS });

    const prompt = h.draftPrompts[0];
    expect(prompt.system).toContain("Never use internal funding or treatment category wording");
    expect(prompt.system).toContain("Use no em-dash characters anywhere");
    expect(prompt.system).toContain("Under 60 words");
    // Their own answers ride along as tone context, with an explicit rule not to
    // recite them or mention money.
    expect(prompt.system).toContain("never reference money or how they would pay");
    expect(prompt.user).toContain("Smile assessment context");
  });

  it("never sends a draft that carries funding jargon, and retires the lead instead", async () => {
    h.drafts.push("Hi Priya, your consultation would be on the NHS so there is nothing to pay.");
    await submit({ firstName: "Priya", phone: "07700 900458", channel: "sms", responses: HIGH_ANSWERS });

    expect(h.sent, "a blocked draft must never reach a patient").toHaveLength(0);
    expect(leads[0].stage).toBe("lost");
    expect(attempts[0]).toMatchObject({ status: "failed" });
  });

  it("does not first-contact a MEDIUM band while the campaign override is off", async () => {
    const { json } = await submit({
      firstName: "Sam",
      phone: "07700 900459",
      channel: "sms",
      responses: MEDIUM_ANSWERS,
    });
    expect(json).toMatchObject({ band: "medium", leadCreated: false });
    expect(leads).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
});

describe("2. the SLA sweep is the failsafe when the first send fails", () => {
  it("leaves a failed first contact retryable, and the sweep gets the text out", async () => {
    h.sendFails = 1; // the in-request send fails
    h.drafts.push("Hi Priya, thanks for getting in touch. Shall I find you a time that suits?");
    await submit({ firstName: "Priya", phone: "07700 900460", channel: "sms", responses: HIGH_ANSWERS });

    expect(h.sent).toHaveLength(0);
    expect(attempts[0]).toMatchObject({ status: "failed" });
    expect(leads[0], "a failed send is the ONLY thing that leaves a lead retryable").toMatchObject({
      stage: "new",
      firstResponseAt: null,
    });

    // The SLA window passes and the sweep re-drafts and re-sends.
    advance(60_000);
    leads[0].createdAt = new Date(clock - 60_000).toISOString();
    h.drafts.push("Hi Priya, Vitality Dental here. Would you like us to find you a time this week?");
    const result = await sweep();

    expect(result).toMatchObject({ ok: true, checked: 1, claimed: 1, contacted: 1 });
    expect(h.sent).toHaveLength(1);
    expect(leads[0].stage).toBe("contacted");
    console.log("\n--- FIRST CONTACT, RETRIED BY THE SLA SWEEP ---\n" + h.sent[0].body + "\n");
  });

  it("stops re-drafting a lead that can never be delivered", async () => {
    const lead = newLead({ siteId: SITE_ID, name: "Unreachable Person", phone: "+447700900461" });
    for (let i = 0; i < 3; i += 1) {
      attempts.push({
        id: `att-pre-${i}`,
        leadId: lead.id,
        channel: "sms",
        toAddress: lead.phone!,
        body: "x",
        status: "failed",
        provider: null,
        providerMessageId: null,
        createdAt: nowIso(),
      });
    }
    advance(60_000);
    await sweep();
    // No model call at all: the cap is checked BEFORE the message is composed.
    expect(h.draftPrompts).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
});

describe("3. the nurture cadence: days 3, 10 and 21", () => {
  /** A lead already first-contacted, ready to enter nurture. */
  function contactedLead(): SpeedToLeadLead {
    const lead = newLead({
      siteId: SITE_ID,
      name: "Priya Raman",
      phone: "+447700900462",
      treatmentInterest: "Invisalign",
      stage: "contacted",
    });
    lead.firstResponseAt = nowIso();
    lead.conversationId = "conv-nurture";
    conversations.set("conv-nurture", { id: "conv-nurture", lastInboundAt: null });
    return lead;
  }

  it("sends exactly three nudges, on the cadence, then completes", async () => {
    const lead = contactedLead();
    const bodies: string[] = [];

    for (const [i, gap] of NURTURE_INTERVALS_DAYS.entries()) {
      advance(gap * DAY_MS);
      h.drafts.push(
        i === 0
          ? "Hi Priya, just checking in about your enquiry with Vitality Dental. Would you like us to find a time that suits you?"
          : i === 1
            ? "Hi Priya, Vitality Dental here. No pressure at all, but if you would like to come in, reply and we will find a time around you."
            : "Hi Priya, one last note from Vitality Dental. Reply whenever you are ready and we will find you a time.",
      );
      const result = (await sweep()).nurture as Record<string, number>;
      expect(result, `touch ${i + 1} should have gone out`).toMatchObject({ due: 1, sent: 1 });
      bodies.push(h.sent[h.sent.length - 1].body);
      expect(lead.nurtureStep).toBe(i + 1);
    }

    expect(lead.nurtureStep).toBe(3);
    expect(lead.nurtureNextAt).toBeNull();
    expect(lead.stage).toBe("nurture_done");
    console.log(
      "\n--- NURTURE CADENCE (days 3, 10, 21) ---\n" +
        bodies.map((b, i) => `[touch ${i + 1}] ${b}`).join("\n\n") +
        "\n",
    );

    // A fourth tick sends nothing, ever.
    advance(30 * DAY_MS);
    const after = (await sweep()).nurture as Record<string, number>;
    expect(after).toMatchObject({ due: 0, sent: 0 });
  });

  it("is not due before day 3", async () => {
    contactedLead();
    advance(2 * DAY_MS);
    const result = (await sweep()).nurture as Record<string, number>;
    expect(result).toMatchObject({ due: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("exits the moment the patient replies, and never nudges again", async () => {
    const lead = contactedLead();
    conversations.get("conv-nurture")!.lastInboundAt = nowIso();
    advance(3 * DAY_MS);

    const result = (await sweep()).nurture as Record<string, number>;
    expect(result).toMatchObject({ due: 1, sent: 0, exited: 1 });
    expect(h.sent).toHaveLength(0);
    expect(lead.stage).toBe("qualifying");
    expect(lead.nurtureNextAt).toBeNull();
  });

  it("stops the cadence dead once the lead is BOOKED", async () => {
    const lead = contactedLead();
    lead.stage = "booked"; // exactly what the inbound webhook does on a real booking
    advance(3 * DAY_MS);
    const result = (await sweep()).nurture as Record<string, number>;
    expect(result).toMatchObject({ due: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("falls back to safe deterministic copy when the model is unavailable", async () => {
    const lead = contactedLead();
    h.modelThrows = true;
    advance(3 * DAY_MS);
    const result = (await sweep()).nurture as Record<string, number>;
    expect(result).toMatchObject({ sent: 1 });
    const body = h.sent[0].body;
    expect(body).toBe(nurtureFallback(lead, 1, { name: "Vitality Dental" } as never));
    console.log("\n--- NURTURE FALLBACK (model unavailable) ---\n" + body + "\n");
    // The fallbacks are patient-facing copy in their own right, so print all three.
    console.log(
      "--- NURTURE FALLBACKS, ALL THREE TOUCHES ---\n" +
        [1, 2, 3]
          .map((t) => `[touch ${t}] ${nurtureFallback(lead, t, { name: "Vitality Dental" } as never)}`)
          .join("\n\n") +
        "\n",
    );
  });

  it("yields to the cross-module daily cap rather than double-texting", async () => {
    const lead = contactedLead();
    advance(3 * DAY_MS);
    // Another module already messaged this handset today.
    const day = new Date(clock).toISOString().slice(0, 10);
    contactedToday.add(`${SITE_ID}|${lead.phone}|${day}`);
    const result = (await sweep()).nurture as Record<string, number>;
    expect(result).toMatchObject({ due: 1, sent: 0, capped: 1 });
    expect(h.sent).toHaveLength(0);
    // The touch stays due: the cap defers, it does not consume a nudge.
    expect(lead.nurtureStep).toBe(0);
  });
});

describe("4. an abandoned booking hold becomes a chased lead", () => {
  it("converts a hold left for 20 minutes, then first-contacts it on the next tick", async () => {
    holds.push({
      id: "hold-1",
      siteId: SITE_ID,
      name: "Marcus Bell",
      phone: "+447700900463",
      email: null,
      treatment: "Check-up and hygiene clean",
      slotStart: "2026-08-25T09:00:00.000Z",
      status: "held",
      createdAt: new Date(clock - 25 * 60_000).toISOString(),
    });

    // Tick one: the hold is converted to a lead. Nothing is sent yet, because the
    // lead is brand new and has not aged past the SLA window.
    const first = await sweep();
    expect(first).toMatchObject({ abandonedConverted: 1 });
    expect(holds[0].status).toBe("expired");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ source: "abandoned-booking", stage: "new" });
    expect(leads[0].treatmentInterest).toContain("Check-up and hygiene clean");
    expect(leads[0].treatmentInterest, "the worklist must show the slot they wanted").toContain("wanted");

    // Tick two, after the SLA window: the win-back text goes out.
    advance(60_000);
    leads[0].createdAt = new Date(clock - 60_000).toISOString();
    h.drafts.push(
      "Hi Marcus, it's Vitality Dental. We noticed you started booking a check-up and hygiene clean " +
        "but did not finish. Would you like us to hold that time for you? Just reply here.",
    );
    const second = await sweep();
    expect(second).toMatchObject({ contacted: 1 });
    expect(h.sent).toHaveLength(1);
    console.log("\n--- ABANDONED-HOLD WIN-BACK ---\n" + h.sent[0].body + "\n");
    expect(leads[0].stage).toBe("contacted");
  });

  it("never double-chases a hold that is already an open lead", async () => {
    newLead({ siteId: SITE_ID, name: "Marcus Bell", phone: "+447700900463", stage: "contacted" });
    holds.push({
      id: "hold-2",
      siteId: SITE_ID,
      name: "Marcus Bell",
      phone: "+447700900463",
      email: null,
      treatment: "Check-up",
      slotStart: "2026-08-25T09:00:00.000Z",
      status: "held",
      createdAt: new Date(clock - 25 * 60_000).toISOString(),
    });
    // findOpenLeadByAddress is stubbed to the real behaviour for this one case.
    const repo = await import("@/lib/speed-to-lead/repository");
    const spy = vi
      .spyOn(repo, "findOpenLeadByAddress")
      .mockResolvedValue(leads[0] as never);
    const result = await sweep();
    expect(result).toMatchObject({ abandonedConverted: 0 });
    expect(holds[0].status).toBe("expired");
    expect(leads).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("5. the per-campaign follow-up override", () => {
  it("is OFF by default, so a medium band is recorded and never messaged", async () => {
    const { json } = await submit({
      firstName: "Sam",
      phone: "07700 900464",
      channel: "sms",
      responses: MEDIUM_ANSWERS,
    });
    expect(json).toMatchObject({ band: "medium", leadCreated: false });
    expect(h.sent).toHaveLength(0);
  });

  it("switched ON for a campaign, a medium band IS chased, in the owner's own words", async () => {
    // The owner's campaign: follow up EVERY submission, using their wording.
    const template = "Hi {name}, it is {practice}. Thanks for taking our smile quiz. Reply here and we will find you a time that suits.";
    // getCampaignFollowUp answers with a resolved FollowUpConfig, not raw columns.
    campaignFollowUp.value = { enabled: true, trigger: "all", template };
    const campaign = {
      id: "camp-1",
      siteId: SITE_ID,
      slug: "veneers-aug",
      // Deliberately NOT the treatment the patient picked: a goal match adds a
      // scoring bonus, and this test is about the TRIGGER widening the band, not
      // about the score sneaking over the high threshold.
      goal: "implants",
      idealCustomer: null,
      followUpEnabled: true,
      followUpTrigger: "all",
      followUpTemplate: template,
      targetBudget: null,
    };
    const repo = await import("@/lib/smile-assessment/campaign-repository");
    const spy = vi.spyOn(repo, "getActiveCampaignBySlug").mockResolvedValue(campaign as never);

    const { json } = await submit({
      firstName: "Sam Ellis",
      phone: "07700 900465",
      channel: "sms",
      campaignSlug: "veneers-aug",
      responses: MEDIUM_ANSWERS,
    });

    expect(json).toMatchObject({ leadCreated: true });
    expect(h.sent).toHaveLength(1);
    // SUBSTITUTION ONLY: no model call was made at all for this message.
    expect(h.draftPrompts, "an owner override must not cost a model call").toHaveLength(0);
    expect(h.sent[0].body).toBe(
      "Hi Sam, it is Vitality Dental. Thanks for taking our smile quiz. Reply here and we will find you a time that suits.",
    );
    console.log("\n--- OWNER-WRITTEN FIRST TOUCH (tokens rendered) ---\n" + h.sent[0].body + "\n");
    spy.mockRestore();
  });
});
