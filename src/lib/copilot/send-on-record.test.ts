import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CO-PILOT'S SEND, ON THE PATIENT'S RECORD.
 *
 * This was the worst of the four holes in the Correspondence tab's "every message
 * this platform has sent" claim, because it is the only one a person chose. A
 * practice manager types "text Cora and tell her the crown is back", confirms it,
 * is told "Sent" — and the patient's record shows nothing. The next colleague to
 * open that record, to answer "what have we already said to her?", is looking at an
 * incomplete history with no sign that it is incomplete.
 *
 * `send_sms` / `send_email` dispatch DIRECTLY: no outbox, no drain, no *_touch row.
 * `recordOutbound` is the whole of the record for this path, so these tests run it
 * for real and read the record back with the real `getThreadForPatient`.
 */

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const wasContactedToday = vi.fn();
const recordContacted = vi.fn();
const logCopilotAction = vi.fn();
const searchPatients = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: (...a: unknown[]) => wasContactedToday(...a),
  recordContacted: (...a: unknown[]) => recordContacted(...a),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: vi.fn(),
  searchPatients: (...a: unknown[]) => searchPatients(...a),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
}));

// The ONE thing faked below recordOutbound: Postgres. The conversation write, the
// message write and the record read are all the real code.
vi.mock("@/lib/supabase/server", async () => {
  const mod = await import("@/lib/inbox/test-support/agent-store-fake");
  return { serviceClient: () => mod.serviceClientFake() };
});

/**
 * A recorder that BREAKS ITS CONTRACT, for the test at the foot of this file.
 *
 * `recordOutbound` promises never to throw, and this tool used to lean on the
 * promise with a bare `await`. If one ever escaped, the tool call would reject
 * AFTER the patient already had the message: the manager is told the send failed
 * and sends it again. Off by default so every test above runs the real recorder.
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

import { agentStore, resetAgentStore, rowsIn } from "@/lib/inbox/test-support/agent-store-fake";
import { makeCopilotDispatch } from "./tools";
import { getThreadForPatient } from "@/lib/inbox/repository";

const CORA = {
  id: "pat-c1",
  name: "Cora Consented",
  phone: "+447700900001",
  email: "cora@example.co.uk",
  siteId: "site-cc",
  active: true,
  archivedReason: null,
  recallDueAt: null,
  lastVisitAt: null,
  dateOfBirth: null,
  smsConsent: true,
  emailConsent: true,
};

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "Blerta");

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentStore();
  recorderThrows.on = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  searchPatients.mockImplementation(async (_siteIds: string[], q: string) =>
    String(q).trim().length < 2 ? [] : [CORA],
  );
  isSuppressed.mockResolvedValue(false);
  wasContactedToday.mockResolvedValue(false);
  recordContacted.mockResolvedValue(undefined);
  sendMessage.mockResolvedValue({ providerMessageId: "dry-sms-1", provider: "dry-run", status: "dry_run" });
});

describe("a co-pilot text lands on the patient's record", () => {
  it("appears in the record read, outbound, with the words the manager sent", async () => {
    const message = "Hi Cora, your crown is back from the lab.";
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message, confirm: true }));
    expect(out.sent).toBe(true);
    expect(out.recorded).toBe(true);

    const read = await getThreadForPatient(["site-cc"], CORA.id);
    const messages = read.thread?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe(message);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].channel).toBe("sms");
    expect(read.thread?.contactRef).toBe(`patient:${CORA.id}`);
  });

  it("records an email with its subject line, exactly as the audit row captures it", async () => {
    const out = JSON.parse(
      await dispatch("send_email", {
        patient: "Cora",
        subject: "Your crown",
        message: "It is back from the lab.",
        confirm: true,
      }),
    );
    expect(out.sent).toBe(true);
    const read = await getThreadForPatient(["site-cc"], CORA.id);
    expect(read.thread?.messages[0].body).toBe("Subject: Your crown\n\nIt is back from the lab.");
    expect(read.thread?.messages[0].channel).toBe("email");
  });

  it("records the DRY RUN too, so the practice can see what it would have said", async () => {
    // A record that starts existing only when a flag flips is a record nobody learns
    // to trust. logCopilotAction and the daily ledger already behave this way.
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "dry", confirm: true }));
    expect(out.dryRun).toBe(true);
    expect(rowsIn("agent_message")).toHaveLength(1);
  });

  it("writes NOTHING when the send was refused, because nothing was said", async () => {
    // Consent, suppression, guardrail and the preview step all return before the
    // send. A record row for any of them would put words on the patient's history
    // that the patient never received.
    isSuppressed.mockResolvedValue(true);
    const blocked = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "no", confirm: true }));
    expect(blocked.sent).toBe(false);

    isSuppressed.mockResolvedValue(false);
    const preview = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "no" }));
    expect(preview.preview).toBe(true);

    expect(rowsIn("agent_conversation")).toHaveLength(0);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });
});

describe("recording failure never touches the send", () => {
  it("still reports the message as sent, and does not send it twice", async () => {
    agentStore.failTables.add("agent_message");
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "Hi Cora", confirm: true }));
    // The patient HAS the text. A logging failure that reported "not sent" would
    // invite the manager to send it again.
    expect(out.sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });

  it("tells the owner the record is missing it, rather than swallowing the failure", async () => {
    agentStore.failTables.add("agent_conversation");
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "Hi Cora", confirm: true }));
    expect(out.recorded).toBe(false);
    expect(out.note).toContain("could not be added to the patient's Correspondence record");
  });

  it("does not retry, and does not stop the audit row or the daily ledger", async () => {
    // The two writes that follow the record are the ones that stop a SECOND message
    // going out today; letting a logging failure skip them would turn one lost row
    // into a duplicate text.
    agentStore.failTables.add("agent_message");
    await dispatch("send_sms", { patient: "Cora", message: "Hi Cora", confirm: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logCopilotAction).toHaveBeenCalledTimes(1);
    expect(recordContacted).toHaveBeenCalledTimes(1);
    expect(agentStore.inserts.filter((i) => i.table === "agent_message")).toHaveLength(0);
  });
});

describe("a recorder that throws cannot fail the tool", () => {
  it("still reports the message as sent, once, with recorded false", async () => {
    // The message has already left. A rejected tool call would tell the manager it
    // failed and invite them to send a second one to the same patient.
    recorderThrows.on = true;
    const out = JSON.parse(
      await dispatch("send_sms", { patient: "Cora", message: "Hi Cora", confirm: true }),
    );
    expect(out.sent).toBe(true);
    expect(out.recorded).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // And the two writes that stop a SECOND message going out today still ran.
    expect(logCopilotAction).toHaveBeenCalledTimes(1);
    expect(recordContacted).toHaveBeenCalledTimes(1);
  });

  it("tells the owner the record is missing it, exactly as a soft failure does", async () => {
    recorderThrows.on = true;
    const out = JSON.parse(
      await dispatch("send_sms", { patient: "Cora", message: "Hi Cora", confirm: true }),
    );
    expect(out.note).toContain("could not be added to the patient's Correspondence record");
  });
});
