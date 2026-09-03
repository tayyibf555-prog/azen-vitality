import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const searchKnowledge = vi.fn();
const sendMessage = vi.fn(async () => ({ provider: "test", providerMessageId: "SM-1" }));
const logCopilotAction = vi.fn();

vi.mock("@/lib/practice-brain/retrieval", () => ({ searchKnowledge: (...a: unknown[]) => searchKnowledge(...(a as [])) }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...(a as [])) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false, isStopKeyword: () => false, addSuppression: async () => {} }));
vi.mock("@/lib/messaging/frequency", () => ({ wasContactedToday: async () => false, recordContacted: async () => {} }));
vi.mock("@/lib/inbox/record-outbound", () => ({ recordOutbound: async () => {} }));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...(a as [])) }));
vi.mock("@/lib/mock", () => ({ getSite: (id: string) => ({ id, name: "N15 Vitality Dental" }) }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => ({ id, name: "N15 Vitality Dental" }),
  getSites: () => [{ id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" }],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: async () => [],
  searchPatients: async () => [
    {
      id: "p1",
      name: "Amina Ahmed",
      phone: "07700900123",
      email: "amina@example.com",
      siteId: "site-cc",
      active: true,
      archivedReason: null,
      lastVisitAt: null,
      recallDueAt: null,
      smsConsent: true,
      emailConsent: true,
    },
  ],
  listAppointments: async () => [],
  listOutstanding: async () => [],
  getPatientDetail: async () => null,
  listSitePractitioners: async () => [],
  dentallyReadKey: () => "k",
  dentallyFromEnv: () => ({}),
}));

import { makeCopilotDispatch } from "./tools";
import {
  KNOWLEDGE_ECHO_REFUSAL,
  MIN_ECHO_CHARS,
  MAX_RETAINED_BODIES,
  PROTECTED_TIER,
  makeKnowledgeEchoGuard,
  normaliseForEcho,
} from "./knowledge-echo";

// ===========================================================================
// THE PRACTICE'S INTERNAL KNOWLEDGE MUST NOT GO OUT IN A PATIENT MESSAGE.
//
// The hole is a two-tool turn: `search_knowledge` at tier 4, then `send_sms`
// with the words it just returned. Retrieval's clearance filter is working
// correctly in that story — the OWNER is entitled to read tier 4 — and the leak
// happens downstream of it, which is why it needs its own floor.
// ===========================================================================

// A tier-3 body long enough to be worth protecting: the kind of internal note a
// practice really does write, and really must not text to a patient.
const TIER_3_BODY =
  "When a patient hesitates on the implant price, do not discount. Restate the five year cost against a bridge, mention the finance option second, and book the review before they leave the chair.";

const TIER_1_BODY =
  "Our cancellation policy is that we ask for twenty four hours notice so we can offer the time to somebody else who is waiting.";

describe("the echo guard, on its own", () => {
  it("remembers a protected body and finds a verbatim run from it", () => {
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 3, body: TIER_3_BODY, snippet: null }]);
    expect(guard.size()).toBe(1);
    const run = guard.echoedRun(`Hello Amina, ${TIER_3_BODY.slice(0, 90)}`);
    expect(run).not.toBeNull();
    expect(run).toHaveLength(MIN_ECHO_CHARS);
  });

  it("ignores tier 1, because general knowledge is what a patient message is FOR", () => {
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 1, body: TIER_1_BODY, snippet: null }]);
    expect(guard.size()).toBe(0);
    expect(guard.echoedRun(TIER_1_BODY)).toBeNull();
  });

  it("protects from tier 2 upwards, and the line is stated once", () => {
    expect(PROTECTED_TIER).toBe(2);
    for (const tier of [2, 3, 4]) {
      const guard = makeKnowledgeEchoGuard();
      guard.remember([{ tier, body: TIER_3_BODY, snippet: null }]);
      expect(guard.size(), `tier ${tier} was not protected`).toBeGreaterThan(0);
    }
  });

  it("is not defeated by reformatting: line breaks, double spaces and case", () => {
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 3, body: TIER_3_BODY, snippet: null }]);
    const reflowed = TIER_3_BODY.slice(0, 120).toUpperCase().replace(/ /g, "\n  ");
    expect(guard.echoedRun(reflowed)).not.toBeNull();
  });

  it("does NOT trip on a message the model wrote itself about the same subject", () => {
    // The ordinary path, and the one that must keep working: the model reads the
    // internal note and writes its own patient-appropriate sentence. A guard that
    // refused this would make the knowledge base useless for drafting.
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 3, body: TIER_3_BODY, snippet: null }]);
    const written =
      "Hello Amina, I have put some information together about the implant and what it would involve. Shall I book you a review so we can go through it?";
    expect(guard.echoedRun(written)).toBeNull();
  });

  it("does not trip on a short message, however similar", () => {
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 3, body: TIER_3_BODY, snippet: null }]);
    expect(guard.echoedRun("do not discount")).toBeNull();
  });

  it("remembers the SNIPPET too, which is the part a model is most likely to copy", () => {
    const guard = makeKnowledgeEchoGuard();
    guard.remember([{ tier: 4, body: null, snippet: TIER_3_BODY }]);
    expect(guard.echoedRun(TIER_3_BODY)).not.toBeNull();
  });

  it("bounds what one session retains rather than growing without limit", () => {
    const guard = makeKnowledgeEchoGuard();
    for (let i = 0; i < MAX_RETAINED_BODIES + 10; i += 1) {
      guard.remember([{ tier: 3, body: `${i} ${TIER_3_BODY}`, snippet: null }]);
    }
    expect(guard.size()).toBe(MAX_RETAINED_BODIES);
  });

  it("normalises whitespace and case and nothing else", () => {
    expect(normaliseForEcho("  A   B\nC  ")).toBe("a b c");
    // Punctuation survives: exact agreement on commas is the signal, and
    // stripping them would widen the net towards false positives.
    expect(normaliseForEcho("Hello, world.")).toBe("hello, world.");
  });
});

describe("the floor, on the real send path", () => {
  const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");

  beforeEach(() => {
    sendMessage.mockClear();
    logCopilotAction.mockClear();
    searchKnowledge.mockReset();
  });

  it("refuses an SMS that pastes tier-3 knowledge the same session just read", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    await dispatch("search_knowledge", { query: "implant objection" });

    const out = JSON.parse(
      await dispatch("send_sms", { patient: "Amina", message: `Hi Amina. ${TIER_3_BODY}`, confirm: true }),
    );
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("knowledge_echo");
    expect(out.message).toBe(KNOWLEDGE_ECHO_REFUSAL);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses the PREVIEW too, so the owner is never asked to approve it", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    const fresh = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await fresh("search_knowledge", { query: "implant objection" });
    const out = JSON.parse(await fresh("send_sms", { patient: "Amina", message: TIER_3_BODY }));
    expect(out.reason).toBe("knowledge_echo");
  });

  it("catches it in an email SUBJECT as well as the body", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    const fresh = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await fresh("search_knowledge", { query: "implant objection" });
    const out = JSON.parse(
      await fresh("send_email", { patient: "Amina", subject: TIER_3_BODY.slice(0, 90), message: "See below." }),
    );
    expect(out.reason).toBe("knowledge_echo");
  });

  it("audits the block WITHOUT writing the confidential wording into the audit row", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    const fresh = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await fresh("search_knowledge", { query: "implant objection" });
    await fresh("send_sms", { patient: "Amina", message: TIER_3_BODY });
    const blocked = logCopilotAction.mock.calls.map((c) => c[0]).find((a) => a.status === "blocked:knowledge_echo");
    expect(blocked).toBeTruthy();
    expect(blocked.body).toBeNull();
    // Recording that the wording must not leave the practice, by writing the
    // wording down, is the same mistake in a smaller box.
    expect(JSON.stringify(blocked)).not.toContain(TIER_3_BODY.slice(0, 40));
  });

  it("lets a normal message through, so the floor is not a filter", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    const fresh = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await fresh("search_knowledge", { query: "implant objection" });
    const out = JSON.parse(
      await fresh("send_sms", {
        patient: "Amina",
        message: "Hello Amina, shall I book you a review to go through the implant options?",
      }),
    );
    expect(out.reason).not.toBe("knowledge_echo");
  });

  it("lets TIER 1 through: general knowledge is what a patient message is for", async () => {
    searchKnowledge.mockResolvedValue([
      { node: { id: "k2", title: "Cancellation policy", body: TIER_1_BODY, tier: 1, tags: [] }, score: 9, snippet: TIER_1_BODY },
    ]);
    const fresh = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await fresh("search_knowledge", { query: "cancellation" });
    const out = JSON.parse(await fresh("send_sms", { patient: "Amina", message: TIER_1_BODY }));
    expect(out.reason).not.toBe("knowledge_echo");
  });

  it("remembers nothing across SESSIONS: a fresh dispatch starts empty", async () => {
    // The memory is a closure the dispatch owns, not a module-level cache. A
    // process-wide one would keep one practice's confidential knowledge alive in
    // a serverless instance long after the session that read it ended.
    searchKnowledge.mockResolvedValue([
      { node: { id: "k1", title: "Implant objections", body: TIER_3_BODY, tier: 3, tags: [] }, score: 9, snippet: TIER_3_BODY },
    ]);
    const first = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    await first("search_knowledge", { query: "implant objection" });

    const second = makeCopilotDispatch(["site-cc"], "vitality", "owner", "full");
    const out = JSON.parse(await second("send_sms", { patient: "Amina", message: TIER_3_BODY }));
    // Nothing was READ in this session, so there is nothing to echo. The floor is
    // about a turn that read and then sent, which is the only shape it can see.
    expect(out.reason).not.toBe("knowledge_echo");
  });
});
