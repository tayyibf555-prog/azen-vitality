// ===========================================================================
// THE OWNER CO-PILOT'S COMMIT STEPS, JOINED UP.
//
// Two halves guard every co-pilot action that reaches a real patient:
//   1. run.ts holds a DETERMINISTIC gate — a confirm:true is inert unless the
//      owner's latest turn is an affirmative answering a prior read-back, and
//   2. each tool in copilot/tools.ts holds its OWN two-step preview.
// Both halves are unit-tested (run.test.ts, lead-tools.test.ts, tools.test.ts),
// and each is tested against a stand-in for the other: run.test.ts uses a fake
// dispatcher, and the tool tests call dispatch directly with no gate above them.
//
// This file runs them TOGETHER, the way the /api/copilot route wires them: the
// real runAgentTurn, the real COPILOT_TOOLS, the real makeCopilotDispatch, and a
// scripted model in the middle. It is the test that would fail if the route ever
// stopped routing a commit tool through the gate, or if a tool name were added to
// one half and not the other.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { SpeedToLeadLead, SpeedToLeadAttempt } from "@/lib/speed-to-lead/types";

const SITES: Record<string, { id: string; name: string; clientId: string }> = {
  "site-cc": { id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" },
};

const store = vi.hoisted(() => ({
  leads: [] as unknown[],
  attempts: [] as unknown[],
  patients: [] as unknown[],
  logged: [] as Record<string, unknown>[],
  contacted: [] as string[],
  sent: [] as Array<{ channel: string; to: string; body: string }>,
  systemOn: true,
  writeEnabled: false,
  suppressed: new Set<string>(),
  contactedToday: new Set<string>(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: async (a: Record<string, unknown>) => {
    store.logged.push(a);
  },
}));

vi.mock("@/lib/mock", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) =>
    id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => SITES[id],
  getSites: (clientId: string) => Object.values(SITES).filter((s) => s.clientId === clientId),
  getClient: (id: string) =>
    id === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
  dentallySiteId: (id: string) => `dentally-${id}`,
}));

vi.mock("@/lib/dentally/read", () => ({
  listPatients: async () => store.patients,
  searchPatients: async (_siteIds: string[], q: string) =>
    (store.patients as Array<{ name: string }>).filter((p) =>
      p.name.toLowerCase().includes(q.toLowerCase()),
    ),
  listAppointments: async () => [],
  listOutstanding: async () => [],
  getPatientDetail: async () => null,
  listSitePractitioners: async () => [],
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: () => ({}),
}));

// The Dentally WRITE gate, off by default (which is what a fresh deployment has).
vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => store.writeEnabled,
  dentallyAgentClient: () => {
    throw new Error("no co-pilot test may build a Dentally write client");
  },
}));

vi.mock("@/lib/messaging/send", () => ({
  sendMessage: async (m: { channel: string; to: string; body: string }) => {
    store.sent.push({ ...m });
    return { provider: "test", providerMessageId: `SM-${store.sent.length}` };
  },
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: async (_site: string, _ch: string, ref: string) => store.suppressed.has(ref),
  isStopKeyword: () => false,
  addSuppression: async () => {},
}));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async (_s: string, address: string) => store.contactedToday.has(address),
  recordContacted: async (_s: string, address: string) => {
    store.contactedToday.add(address);
  },
}));

vi.mock("@/lib/systems/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemEnabled: async () => store.systemOn,
  // nudge_lead reads the SEND door's version (W1-B/1-5); same answer here.
  isSystemEnabledForSend: async () => store.systemOn,
}));

vi.mock("@/lib/speed-to-lead/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLead: async (id: string) => {
    const found = (store.leads as SpeedToLeadLead[]).find((l) => l.id === id);
    return found ? { ...found } : null;
  },
  listLeads: async (args: { siteIds: string[]; stages?: string[]; limit?: number }) =>
    (store.leads as SpeedToLeadLead[])
      .filter((l) => args.siteIds.includes(l.siteId))
      .filter((l) => !args.stages?.length || args.stages.includes(l.stage))
      .map((l) => ({ ...l })),
  listLeadsByIds: async (args: { siteIds: string[]; ids: string[] }) =>
    (store.leads as SpeedToLeadLead[])
      .filter((l) => args.siteIds.includes(l.siteId) && args.ids.includes(l.id))
      .map((l) => ({ ...l })),
  listAttemptsForLeads: async (ids: string[]) =>
    (store.attempts as SpeedToLeadAttempt[]).filter((a) => ids.includes(a.leadId)),
  claimLeadFromStage: async (id: string, from: string) => {
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === id);
    if (!l || l.stage !== from) return false;
    l.stage = "contacting";
    return true;
  },
  setLeadStage: async (id: string, stage: string) => {
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === id);
    if (l) l.stage = stage as SpeedToLeadLead["stage"];
  },
}));

// toAddress + channelConsented stay REAL: the consent rule the co-pilot applies
// must be the pipeline's own, not a second copy written for a test.
vi.mock("@/lib/speed-to-lead/contact", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // FAITHFUL to the real one in the way nudge_lead depends on: a successful
  // contact WRITES AN ATTEMPT. The tool reads the attempt ledger to decide
  // whether anything really went out, so a mock that only flipped the stage
  // would let every "did it actually send?" assertion pass vacuously.
  contactLead: async (lead: SpeedToLeadLead) => {
    store.contacted.push(lead.id);
    const l = (store.leads as SpeedToLeadLead[]).find((x) => x.id === lead.id);
    if (l) l.stage = "contacted";
    store.attempts.push({
      id: `att-${store.attempts.length + 1}`,
      leadId: lead.id,
      channel: "sms",
      toAddress: lead.phone ?? "",
      body: "[first contact, drafted by the pipeline]",
      status: "sent",
      provider: "test",
      providerMessageId: `SM-${store.attempts.length + 1}`,
      createdAt: new Date().toISOString(),
    });
    store.sent.push({ channel: "sms", to: lead.phone ?? "", body: "[first contact, drafted by the pipeline]" });
  },
}));

import { runAgentTurn } from "@/lib/agent/run";
import { COPILOT_TOOLS, makeCopilotDispatch } from "@/lib/copilot/tools";

/* ---------------------------------------------------------------------------
 * The scripted model, and a helper that runs ONE owner turn through the loop.
 * ------------------------------------------------------------------------- */

type Round = { text: string } | { tools: Array<{ name: string; input: Record<string, unknown> }> };

const script: Round[] = [];
const modelCalls: Array<Record<string, unknown>> = [];
let seq = 0;

const anthropic = {
  messages: {
    create: async (args: Record<string, unknown>) => {
      modelCalls.push(args);
      const round = script.shift();
      if (!round) throw new Error("the model script ran out");
      if ("text" in round) return { content: [{ type: "text", text: round.text }], stop_reason: "end_turn" };
      return {
        content: round.tools.map((t) => {
          seq += 1;
          return { type: "tool_use", id: `tu-${seq}`, name: t.name, input: t.input };
        }),
        stop_reason: "tool_use",
      };
    },
  },
} as unknown as Parameters<typeof runAgentTurn>[1]["anthropic"];

/** The conversation so far, as the co-pilot route rebuilds it from the thread. */
const history: MessageParam[] = [];

async function ownerSays(text: string, rounds: Round[]): Promise<string> {
  history.push({ role: "user", content: text });
  script.length = 0;
  script.push(...rounds);
  const result = await runAgentTurn(history, {
    anthropic,
    dispatch: makeCopilotDispatch(["site-cc"], "vitality", "owner"),
    systemPrompt: "SYSTEM",
    tools: COPILOT_TOOLS,
  });
  history.push({ role: "assistant", content: result.replyText || "(no reply)" });
  return result.replyText;
}

/** What the model was told each time it called a tool, gate refusals included. */
function toolExchanges(): Array<{ name: string; result: string }> {
  const calls = new Map<string, string>();
  const seen = new Set<string>();
  const out: Array<{ name: string; result: string }> = [];
  for (const call of modelCalls) {
    for (const m of (call.messages ?? []) as Array<{ content: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const raw of m.content as Array<Record<string, unknown>>) {
        if (raw?.type === "tool_use") calls.set(String(raw.id), String(raw.name));
        if (raw?.type === "tool_result") {
          const id = String(raw.tool_use_id);
          if (seen.has(id)) continue;
          seen.add(id);
          const name = calls.get(id);
          if (name) out.push({ name, result: String(raw.content ?? "") });
        }
      }
    }
  }
  return out;
}

function lastResult(name: string): Record<string, unknown> {
  const hit = toolExchanges().filter((t) => t.name === name).pop();
  if (!hit) throw new Error(`${name} never ran (saw: ${toolExchanges().map((t) => t.name).join(", ") || "nothing"})`);
  return JSON.parse(hit.result) as Record<string, unknown>;
}

function openLead(over: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Priya Raman",
    email: null,
    phone: "+447700900500",
    channel: "sms",
    treatmentInterest: "Invisalign",
    source: "smile-assessment",
    score: 92,
    stage: "new",
    consent: { sms: true, email: false, whatsapp: false, marketing: false },
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    firstResponseAt: null,
    conversationId: null,
    updatedAt: new Date().toISOString(),
    nurtureStep: 0,
    nurtureNextAt: null,
    ...over,
  };
}

beforeEach(() => {
  store.leads.length = 0;
  store.attempts.length = 0;
  store.patients.length = 0;
  store.logged.length = 0;
  store.contacted.length = 0;
  store.sent.length = 0;
  store.suppressed.clear();
  store.contactedToday.clear();
  store.systemOn = true;
  store.writeEnabled = false;
  script.length = 0;
  modelCalls.length = 0;
  history.length = 0;
  seq = 0;
  // Belt and braces on top of the mocked sender: isDryRun() matches the literal
  // string "true" and nothing else, so this is set exactly as production would.
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
});
afterEach(() => vi.unstubAllEnvs());

/* =========================================================================== */

describe("nudge_lead: read the worklist, read it back, then send", () => {
  it("refuses a confirm set in the SAME turn as the owner's request", async () => {
    store.leads.push(openLead());
    await ownerSays("nudge Priya right now", [
      { tools: [{ name: "nudge_lead", input: { leadId: "lead-1", confirm: true } }] },
      { text: "I can re-send first contact to Priya Raman. Shall I go ahead?" },
    ]);
    expect(lastResult("nudge_lead")).toMatchObject({
      error: expect.stringContaining("Not confirmed in this turn"),
    });
    expect(store.contacted, "nothing may be sent on a same-turn confirm").toHaveLength(0);
  });

  it("previews without sending, then sends exactly once when the owner says yes", async () => {
    store.leads.push(openLead());

    // Turn 1: the owner asks who is waiting. Reads only.
    await ownerSays("who has not been contacted yet?", [
      { tools: [{ name: "list_speed_to_lead", input: {} }] },
      { text: "Priya Raman enquired 3 hours ago about Invisalign and has not been contacted." },
    ]);
    const worklist = lastResult("list_speed_to_lead") as { leads: Array<Record<string, unknown>> };
    expect(worklist.leads[0]).toMatchObject({ id: "lead-1", name: "Priya Raman" });
    expect(store.sent, "a read must never send").toHaveLength(0);

    // Turn 2: the owner asks for a nudge. PREVIEW only, nothing sent.
    await ownerSays("can you nudge her?", [
      { tools: [{ name: "nudge_lead", input: { leadId: "lead-1" } }] },
      { text: "Ready to re-send first contact to Priya Raman, nothing sent yet. Shall I send it?" },
    ]);
    const preview = lastResult("nudge_lead");
    expect(preview).toMatchObject({ sent: false, preview: true });
    expect(String(preview.note)).toContain("nothing sent yet");
    expect(store.contacted).toHaveLength(0);
    expect(store.leads[0]).toMatchObject({ stage: "new" });

    // Turn 3: a clear yes ANSWERING that read-back. Now it sends, once.
    await ownerSays("yes, send it", [
      { tools: [{ name: "nudge_lead", input: { leadId: "lead-1", confirm: true } }] },
      { text: "Sent. Priya has had the first-contact message again." },
    ]);
    // Dry run is ON here, exactly as the pilot runs it, so the tool must say so
    // rather than telling the owner a patient has heard from them.
    const confirmed = lastResult("nudge_lead");
    expect(confirmed).toMatchObject({ sent: true, dryRun: true });
    expect(String(confirmed.note)).toContain("not delivered to them");
    expect(store.contacted).toEqual(["lead-1"]);
    expect(store.leads[0]).toMatchObject({ stage: "contacted" });
    // And it is on the audit trail, as an owner action, labelled as a dry run.
    expect(store.logged.some((a) => a.action === "nudge_lead" && a.status === "dry_run")).toBe(true);
  });

  it("refuses when Speed-to-lead is switched off, even with a clean confirmation", async () => {
    store.leads.push(openLead());
    store.systemOn = false;
    await ownerSays("nudge Priya please", [
      { text: "Ready to re-send first contact to Priya Raman. Shall I send it?" },
    ]);
    await ownerSays("yes, send it", [
      { tools: [{ name: "nudge_lead", input: { leadId: "lead-1", confirm: true } }] },
      { text: "Speed-to-lead is switched off, so I have not sent anything." },
    ]);
    expect(lastResult("nudge_lead")).toMatchObject({ sent: false });
    expect(store.contacted).toHaveLength(0);
  });
});

describe("send_sms: the owner's own words, still gated", () => {
  const CORA = {
    id: "pat-500",
    siteId: "site-cc",
    name: "Cora Whitfield",
    phone: "+447700900501",
    email: "cora@example.com",
    smsConsent: true,
    emailConsent: true,
  };

  it("previews first, then sends on a yes that answers the read-back", async () => {
    store.patients.push(CORA);

    await ownerSays("text Cora to say her check-up is due", [
      {
        tools: [
          { name: "send_sms", input: { patient: "Cora", message: "Hi Cora, your check-up is due. Reply here and we will find you a time." } },
        ],
      },
      { text: "Here is what I would send Cora. Shall I send it?" },
    ]);
    expect(lastResult("send_sms")).toMatchObject({ sent: false, preview: true, patient: "Cora Whitfield" });
    expect(store.sent).toHaveLength(0);

    await ownerSays("yes please send it", [
      {
        tools: [
          {
            name: "send_sms",
            input: {
              patient: "Cora",
              message: "Hi Cora, your check-up is due. Reply here and we will find you a time.",
              confirm: true,
            },
          },
        ],
      },
      { text: "Sent." },
    ]);
    expect(lastResult("send_sms")).toMatchObject({ sent: true });
    expect(store.sent).toHaveLength(1);
    expect(store.sent[0].to).toBe(CORA.phone);
    // The message the patient would receive is the owner's own, verbatim.
    expect(store.sent[0].body).toBe("Hi Cora, your check-up is due. Reply here and we will find you a time.");
  });

  it("blocks forbidden wording at PREVIEW, so the owner is told before they confirm", async () => {
    store.patients.push(CORA);
    await ownerSays("text Cora that it is on the NHS", [
      { tools: [{ name: "send_sms", input: { patient: "Cora", message: "Hi Cora, your check-up is on the NHS." } }] },
      { text: "I cannot send that as written. Shall I reword it?" },
    ]);
    expect(lastResult("send_sms")).toMatchObject({ sent: false, reason: "guardrail" });
    expect(store.sent).toHaveLength(0);
    expect(store.logged.some((a) => a.status === "blocked:guardrail")).toBe(true);
  });

  it("never sends to a patient who has opted out", async () => {
    store.patients.push(CORA);
    store.suppressed.add(`patient:${CORA.id}`);
    await ownerSays("text Cora about her check-up", [
      { text: "Shall I send Cora a message about her check-up?" },
    ]);
    await ownerSays("yes send it", [
      { tools: [{ name: "send_sms", input: { patient: "Cora", message: "Hi Cora, your check-up is due.", confirm: true } }] },
      { text: "Cora has opted out, so nothing was sent." },
    ]);
    expect(lastResult("send_sms")).toMatchObject({ sent: false, reason: "opted_out" });
    expect(store.sent).toHaveLength(0);
  });
});

describe("create_patient: the write gate holds above the confirmation gate", () => {
  it("refuses before any network call while Dentally writes are off", async () => {
    await ownerSays("add a new patient, Mr Jamie Fletcher, born 1990-03-04, NHS, 07700900502", [
      // The read-back has to be phrased in a form the commit gate recognises (see
      // the phrasing test below), so this uses one that is.
      { text: "Here is what I would save for Mr Jamie Fletcher. Shall I go ahead?" },
    ]);
    await ownerSays("yes, create them", [
      {
        tools: [
          {
            name: "create_patient",
            input: {
              firstName: "Jamie",
              lastName: "Fletcher",
              title: "Mr",
              dateOfBirth: "1990-03-04",
              funding: "NHS",
              phone: "07700900502",
              confirm: true,
            },
          },
        ],
      },
      { text: "Creating patients is switched off, so I have not created anything." },
    ]);
    // dentallyAgentClient THROWS in this suite, so reaching a network client at all
    // would fail loudly. A clean refusal proves the gate is checked first.
    const result = lastResult("create_patient");
    expect(result.created).not.toBe(true);
    expect(JSON.stringify(result).toLowerCase()).toContain("off");
  });

  // DOCUMENTED, NOT ASSERTED AWAY. The commit gate recognises a read-back that
  // OFFERS to send / launch / publish / go ahead / confirm, and create_patient's
  // most natural wording ("Shall I create the record?") is in none of those
  // shapes. The refusal is the SAFE direction (nothing is written; the model is
  // told to read it back again), but it costs the owner a turn, and it does so
  // unpredictably: reword the same offer as "Shall I go ahead?" and it passes.
  // Pinned here so the behaviour is visible rather than folklore.
  it("does NOT recognise 'shall I create the record?' as a read-back the owner can answer", async () => {
    await ownerSays("add a new patient, Mr Jamie Fletcher, born 1990-03-04", [
      { text: "Here is what I would save. Shall I create the record?" },
    ]);
    await ownerSays("yes, create them", [
      {
        tools: [
          {
            name: "create_patient",
            input: {
              firstName: "Jamie",
              lastName: "Fletcher",
              title: "Mr",
              dateOfBirth: "1990-03-04",
              funding: "NHS",
              phone: "07700900502",
              confirm: true,
            },
          },
        ],
      },
      { text: "Let me read that back again. Shall I go ahead and create them?" },
    ]);
    expect(lastResult("create_patient")).toMatchObject({
      error: expect.stringContaining("Not confirmed in this turn"),
    });
  });
});
