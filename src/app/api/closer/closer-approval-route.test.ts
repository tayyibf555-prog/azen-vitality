import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/types";

// ===========================================================================
// THE ONLY DOOR OUT OF `draft`.
//
// The treatment-plan closer's sweep writes drafts and nothing else; the shared
// messaging drain reads closer_outbox and nothing else. This route is the whole of
// what joins them, so it is where the module's promises are either kept or lost:
//
//   1. ONLY APPROVE QUEUES.       A discard, a bad edit, a refused compliance scan,
//                                 a wrong role, a switched-off system: none of them
//                                 may leave an outbox row behind.
//   2. AN EDIT IS RE-SCANNED.     A human's rewrite has been scanned by nobody. It
//                                 is checked with the REAL checkCloserDraft here,
//                                 against the REAL stored figure, BEFORE the
//                                 transition — so a refused edit leaves a draft
//                                 that is still a draft.
//   3. THE RECIPIENT IS OURS.     Never the caller's. A request naming somebody
//                                 else's number changes nothing.
//   4. A DISCARD CARRIES A REASON, and the reason reaches the repository.
//
// The compliance scan and the discard mapping are the REAL modules, not stubs:
// stubbing either would leave this file asserting that a mock was called.
// ===========================================================================

type User = { id: string; name: string; role: Role; clientId: string | null; siteIds: string[] };

const OWNER: User = {
  id: "u-owner",
  name: "Jawad",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-ng", "site-rv"],
};

const store = vi.hoisted(() => ({
  user: null as unknown,
  capabilityDenied: null as Response | null,
  systemEnabled: true,
  touch: null as Record<string, unknown> | null,
  opportunity: null as Record<string, unknown> | null,
  /** Every closer_outbox row this run produced. THE thing that must stay empty. */
  outbox: [] as Record<string, unknown>[],
  approveCalls: [] as Array<{ touchId: string; approvedBy: string; opts: Record<string, unknown> }>,
  discardCalls: [] as Array<{ touchId: string; by: string; reason: string; outcome: unknown }>,
  /** approveDraft returns null on a second call, exactly as the conditional update does. */
  approveConsumed: false,
}));

vi.mock("@/lib/auth/guard", async () => {
  // The REAL module predicate, not a stub: it is the only thing keeping a
  // clinician or a receptionist out of this queue, and a mock returning null
  // unconditionally would let that regress in silence.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.user,
    requireModuleApiAccess: (u: User | null, slug: string) =>
      u && !canRoleAccessModule(u.role, slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
    requireSiteAccess: (u: User | null, siteId: string) =>
      u && !u.siteIds.includes(siteId)
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : null,
  };
});

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => store.capabilityDenied,
}));

vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => (id.startsWith("site-") ? { id, clientId: "vitality" } : undefined),
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => store.systemEnabled,
}));

vi.mock("@/lib/coordinator/repository", () => ({
  getOpportunity: async (id: string) =>
    store.opportunity && store.opportunity.id === id ? store.opportunity : null,
}));

vi.mock("@/lib/closer/repository", () => ({
  getTouch: async (id: string) =>
    store.touch && store.touch.id === id ? store.touch : null,
  // A faithful stand-in for the conditional `draft -> approved` update: it
  // transitions once, writes ONE outbox row from the row it returned, and answers
  // null ever after.
  approveDraft: async (touchId: string, approvedBy: string, opts: Record<string, unknown>) => {
    store.approveCalls.push({ touchId, approvedBy, opts });
    if (store.approveConsumed) return null;
    store.approveConsumed = true;
    const stored = store.touch as Record<string, unknown>;
    const body = (opts.body as string | undefined) ?? (stored.body as string);
    const touch = { ...stored, status: "approved", body, approvedBy };
    store.outbox.push({ touchId, siteId: stored.siteId, toRef: opts.toRef, body });
    return { touch, outbox: store.outbox[store.outbox.length - 1] };
  },
  discardDraft: async (touchId: string, by: string, reason: string, outcome: unknown) => {
    store.discardCalls.push({ touchId, by, reason, outcome });
    if (store.approveConsumed) return null;
    store.approveConsumed = true;
    return { ...store.touch, status: "discarded", discardReason: reason };
  },
}));

import { POST } from "./[action]/route";

const TOUCH = {
  id: "t-1",
  opportunityId: "site-ng:p1:pl1",
  siteId: "site-ng",
  step: 1,
  channel: "sms" as const,
  direction: "outbound" as const,
  body: "Hi Sarah, you planned Invisalign full arch treatment with us and have not been back in yet. Ready to book? https://example.test/book\nN15 Vitality Dental",
  draftedBy: "claude" as const,
  status: "draft" as const,
  approvedBy: null,
  discardReason: null,
  createdAt: "2026-08-20T09:00:00.000Z",
  sentAt: null,
};

const OPPORTUNITY = {
  id: "site-ng:p1:pl1",
  siteId: "site-ng",
  dentallyPatientId: "p1",
  patientName: "Sarah Ahmed",
  treatment: "Invisalign full arch",
  amountOutstanding: 3400,
  consent: { sms: true, email: true, marketing: true },
};

function req(body: unknown): Request {
  return new Request("https://x.test/api/closer/approve", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function call(action: string, body: unknown) {
  const res = await POST(req(body), { params: Promise.resolve({ action }) });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  store.user = OWNER;
  store.capabilityDenied = null;
  store.systemEnabled = true;
  store.touch = { ...TOUCH };
  store.opportunity = { ...OPPORTUNITY };
  store.outbox = [];
  store.approveCalls = [];
  store.discardCalls = [];
  store.approveConsumed = false;
});

// ---------------------------------------------------------------------------
// 1. Approve is the release, and it is the only one.
// ---------------------------------------------------------------------------

describe("approve is the only action that queues anything", () => {
  it("queues the drafted text, to the recipient taken from the OPPORTUNITY", async () => {
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].body).toBe(TOUCH.body);
    // The recipient is derived server-side from the opportunity's Dentally patient
    // id, never from anything the caller sent.
    expect(store.outbox[0].toRef).toBe("patient:p1");
  });

  it("posts NO body when the message is unchanged, so the queued text is the scanned text", async () => {
    await call("approve", { touchId: "t-1" });
    expect(store.approveCalls[0].opts.body).toBeUndefined();
  });

  it("records the approver from the SESSION, not from the request", async () => {
    await call("approve", { touchId: "t-1", approvedBy: "somebody else" });
    expect(store.approveCalls[0].approvedBy).toBe("u-owner");
  });

  it("IGNORES a recipient the caller supplies, on every name it could arrive under", async () => {
    // The message goes to the patient on the plan. A caller that could name the
    // recipient could point an approved, compliance-scanned practice message at any
    // phone number in the country.
    await call("approve", {
      touchId: "t-1",
      toRef: "patient:someone-else",
      to_ref: "patient:someone-else",
      toAddress: "+447700900123",
      dentallyPatientId: "p999",
      siteId: "site-elsewhere",
      opportunityId: "not-mine",
    });
    expect(store.approveCalls[0].opts.toRef).toBe("patient:p1");
    expect(store.outbox[0].toRef).toBe("patient:p1");
    expect(JSON.stringify(store.outbox)).not.toContain("someone-else");
    expect(JSON.stringify(store.outbox)).not.toContain("447700900123");
    // ...and it is this touch's own site that was used, not a claimed one.
    expect(store.outbox[0].siteId).toBe("site-ng");
  });

  it("a second approve queues nothing: one draft, at most one message", async () => {
    await call("approve", { touchId: "t-1" });
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(200);
    expect(json.alreadyActioned).toBe(true);
    expect(store.outbox).toHaveLength(1);
  });

  it("a discard queues NOTHING", async () => {
    const { res, json } = await call("discard", { touchId: "t-1", reason: "wrong_tone" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(store.outbox).toEqual([]);
    expect(store.approveCalls).toEqual([]);
  });

  it("an unknown action is refused before anything is read", async () => {
    const { res } = await call("send", { touchId: "t-1" });
    expect(res.status).toBe(400);
    expect(store.outbox).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The edit, and its re-scan.
// ---------------------------------------------------------------------------

describe("a human's edit is re-scanned before it can be queued", () => {
  it("a clean edit is queued, and it is the EDITED text that goes", async () => {
    const edited = "Hi Sarah, just checking in about the Invisalign you planned with us. Happy to help whenever you are ready. N15 Vitality Dental";
    const { res } = await call("approve", { touchId: "t-1", body: edited });
    expect(res.status).toBe(200);
    expect(store.approveCalls[0].opts.body).toBe(edited);
    expect(store.outbox[0].body).toBe(edited);
  });

  it("REFUSES an edit that introduces funding jargon, and queues nothing", async () => {
    // The one rule that applies to every patient-facing message on the platform,
    // reached here through the shared guardrail rather than a copy of it.
    const { res, json } = await call("approve", {
      touchId: "t-1",
      body: "Hi Sarah, your NHS entitlement does not cover this so it would be private. N15 Vitality Dental",
    });
    expect(res.status).toBe(422);
    expect(json.refused).toBe(true);
    expect(json.category).toBe("funding");
    // A sentence for a human, not the category name.
    expect(String(json.error)).not.toContain("funding");
    // AND THE POINT: nothing transitioned, nothing queued. The draft is still a draft.
    expect(store.approveCalls).toEqual([]);
    expect(store.outbox).toEqual([]);
  });

  it("REFUSES an edit that tells the patient they owe money", async () => {
    const { res, json } = await call("approve", {
      touchId: "t-1",
      body: "Hi Sarah, you have an outstanding balance of £3400 to settle. N15 Vitality Dental",
    });
    expect(res.status).toBe(422);
    expect(json.category).toBe("debt");
    expect(store.outbox).toEqual([]);
  });

  it("REFUSES an edit that invents a figure the plan does not carry", async () => {
    // The plan's OWN stored figure is 3400. Any other amount was made up by whoever
    // typed it, and a human typing it is no better than a model typing it.
    const { res, json } = await call("approve", {
      touchId: "t-1",
      body: "Hi Sarah, we can do the Invisalign for £1200 if you come in this month. N15 Vitality Dental",
    });
    expect(res.status).toBe(422);
    expect(json.category).toBe("invented_figure");
    expect(json.matched).toBe("£1200");
    expect(store.outbox).toEqual([]);
  });

  it("ALLOWS the plan's own figure, which is the whole point of the rule", async () => {
    const { res } = await call("approve", {
      touchId: "t-1",
      body: "Hi Sarah, the Invisalign you planned comes to £3400. Happy to help you book. N15 Vitality Dental",
    });
    expect(res.status).toBe(200);
    expect(store.outbox).toHaveLength(1);
  });

  it("REFUSES an edit that presses the patient", async () => {
    const { res, json } = await call("approve", {
      touchId: "t-1",
      body: "Hi Sarah, last chance to book your Invisalign. N15 Vitality Dental",
    });
    expect(res.status).toBe(422);
    expect(json.category).toBe("pressure");
    expect(store.outbox).toEqual([]);
  });

  it("holds the edit to the STORED channel's length cap, not one the caller names", async () => {
    // The touch is an SMS. A caller claiming channel:"email" must not buy 1400
    // characters, because the message is going out by SMS whatever they say.
    const long = `Hi Sarah, ${"a".repeat(600)} N15 Vitality Dental`;
    const { res, json } = await call("approve", { touchId: "t-1", body: long, channel: "email" });
    expect(res.status).toBe(422);
    expect(json.category).toBe("too_long");
    expect(store.outbox).toEqual([]);
  });

  it("refuses a blank edit as a 400, without reaching the scan", async () => {
    const { res } = await call("approve", { touchId: "t-1", body: "   " });
    expect(res.status).toBe(400);
    expect(store.outbox).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Discard.
// ---------------------------------------------------------------------------

describe("a discard carries its reason all the way to the repository", () => {
  it("passes the reason and the resolved outcome through, and records the SESSION as the actor", async () => {
    const { json } = await call("discard", {
      touchId: "t-1",
      reason: "do_not_contact",
      // Whoever ends a patient's follow-up is named from the session. A caller that
      // could name themselves could end it under somebody else's name.
      by: "somebody else",
      approvedBy: "somebody else",
      discardedBy: "somebody else",
    });
    expect(json).toMatchObject({ ok: true, outcome: "stop", reason: "do_not_contact" });
    expect(store.discardCalls).toHaveLength(1);
    expect(store.discardCalls[0]).toMatchObject({
      touchId: "t-1",
      by: "u-owner",
      reason: "do_not_contact",
      // Resolved by the REAL discardOutcome, so the route cannot invent a stop
      // reason of its own.
      outcome: { kind: "stop", stopReason: "staff_stopped" },
    });
  });

  it("a 'try again' reason resolves to a cool-off, not a stop", async () => {
    const { json } = await call("discard", { touchId: "t-1", reason: "too_soon" });
    expect(json.outcome).toBe("retry");
    expect(store.discardCalls[0].outcome).toMatchObject({ kind: "retry" });
  });

  it("REFUSES a discard with no reason, so no discard is ever unreasoned", async () => {
    const { res } = await call("discard", { touchId: "t-1" });
    expect(res.status).toBe(400);
    expect(store.discardCalls).toEqual([]);
  });

  it("REFUSES a caller trying to set a stop reason directly", async () => {
    // 'opted_out' is an OUTPUT of the mapping. Settable directly, it would write
    // into the record that a patient asked us to stop when they never did.
    const { res } = await call("discard", { touchId: "t-1", reason: "opted_out" });
    expect(res.status).toBe(400);
    expect(store.discardCalls).toEqual([]);
  });

  it("a second discard changes nothing", async () => {
    await call("discard", { touchId: "t-1", reason: "wrong_tone" });
    const { json } = await call("discard", { touchId: "t-1", reason: "do_not_contact" });
    expect(json.alreadyActioned).toBe(true);
  });

  it("stays available when the system is switched OFF, so drafts are never stranded", async () => {
    // The direction that STOPS a message must not need the system that sends them.
    store.systemEnabled = false;
    const { res, json } = await call("discard", { touchId: "t-1", reason: "plan_not_live" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("does not need the send capability, so the person who cannot send can still refuse", async () => {
    store.capabilityDenied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { res } = await call("discard", { touchId: "t-1", reason: "wrong_tone" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. The guards, in order.
// ---------------------------------------------------------------------------

describe("every guard refuses before anything is queued", () => {
  it("a clinician is refused the queue entirely", async () => {
    store.user = { ...OWNER, role: "client_clinician" };
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(403);
    expect(store.outbox).toEqual([]);
  });

  it("a receptionist is refused the queue entirely", async () => {
    store.user = { ...OWNER, role: "client_staff" };
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(403);
    expect(store.outbox).toEqual([]);
  });

  it("the practice manager IS allowed: this is her worklist", async () => {
    store.user = { ...OWNER, role: "client_coordinator" };
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(200);
  });

  it("a caller who does not hold the touch's site is refused", async () => {
    store.user = { ...OWNER, siteIds: ["site-somewhere-else"] };
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(403);
    expect(store.outbox).toEqual([]);
  });

  it("WITHOUT the send capability, approve is refused", async () => {
    // Approve IS the release for this module — it writes the outbox row the drain
    // picks up — so this is the per-person gate that matters, not a `send` action.
    store.capabilityDenied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(403);
    expect(store.approveCalls).toEqual([]);
    expect(store.outbox).toEqual([]);
  });

  it("with the closer switched OFF, approve is refused", async () => {
    store.systemEnabled = false;
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(409);
    expect(String(json.error)).toMatch(/switched off/i);
    expect(store.outbox).toEqual([]);
  });

  it("the KILL SWITCH is asked first: a switched-off system says so, not 'forbidden'", async () => {
    // Both refuse, so the order is only observable when both would. It matters
    // because the two answers mean different things to the person reading them:
    // "the owner has switched this off" is a fact about the practice, and
    // "forbidden" is a fact about them. Telling somebody they lack a permission
    // when the truth is that nothing is running sends them to the wrong person.
    store.systemEnabled = false;
    store.capabilityDenied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(409);
    expect(String(json.error)).toMatch(/switched off/i);
  });

  it("a touch that does not exist is a 404, not a 500", async () => {
    const { res } = await call("approve", { touchId: "nope" });
    expect(res.status).toBe(404);
  });

  it("a touch whose opportunity has vanished is a 404, and queues nothing", async () => {
    store.opportunity = null;
    const { res } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(404);
    expect(store.outbox).toEqual([]);
  });

  it("a touch that is no longer a draft is already dealt with", async () => {
    store.touch = { ...TOUCH, status: "sent" };
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(200);
    expect(json.alreadyActioned).toBe(true);
    expect(store.approveCalls).toEqual([]);
    expect(store.outbox).toEqual([]);
  });

  it("an INBOUND touch can never be approved: a patient's own words are not ours to send", async () => {
    store.touch = { ...TOUCH, direction: "inbound", status: "draft" };
    const { json } = await call("approve", { touchId: "t-1" });
    expect(json.alreadyActioned).toBe(true);
    expect(store.outbox).toEqual([]);
  });

  it("refuses a draft on a channel the patient has not consented to, even manually", async () => {
    // Consent can be withdrawn in Dentally between the draft being written and a
    // human getting to it, and a draft may sit for days.
    store.opportunity = { ...OPPORTUNITY, consent: { sms: false, email: true, marketing: true } };
    const { res, json } = await call("approve", { touchId: "t-1" });
    expect(res.status).toBe(409);
    expect(json.consentBlocked).toBe(true);
    expect(store.outbox).toEqual([]);
  });

  it("malformed JSON is a 400", async () => {
    const res = await POST(
      new Request("https://x.test/api/closer/approve", { method: "POST", body: "{oops" }),
      { params: Promise.resolve({ action: "approve" }) },
    );
    expect(res.status).toBe(400);
  });
});
