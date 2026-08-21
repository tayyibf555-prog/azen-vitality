import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `recordOutbound`, end to end: the REAL write, then the REAL record read.
 *
 * The claim this whole lane rests on is that a message the platform sends turns up
 * on the patient's record. These tests prove the mechanism once — write with
 * recordOutbound, read back with getThreadForPatient, assert the words are there —
 * so the per-path tests can lean on it rather than each re-proving Postgres.
 *
 * And they pin the fail-soft contract, which is the part that must never bend: by
 * the time this function is called the patient HAS the text, so no failure inside it
 * may throw, retry or send.
 */

vi.mock("@/lib/supabase/server", async () => {
  const mod = await import("./test-support/agent-store-fake");
  return { serviceClient: () => mod.serviceClientFake() };
});

import { agentStore, resetAgentStore, rowsIn } from "./test-support/agent-store-fake";
import { recordOutbound, outboundPatientKey } from "./record-outbound";
import { getThreadForPatient, listThreads } from "./repository";

const SITE = "site-n15";
const PATIENT = "pat-4471";

beforeEach(() => {
  resetAgentStore();
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a recorded message reaches the patient's timeline", () => {
  it("shows up in the record read, outbound, on the right channel, with the exact words", async () => {
    const body = "Thanks for confirming, we look forward to seeing you.";
    const ok = await recordOutbound({
      siteId: SITE,
      dentallyPatientId: PATIENT,
      patientName: "Sarah Ahmed",
      channel: "sms",
      body,
      source: "test",
    });
    expect(ok).toBe(true);

    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSources).toBe(0);
    const messages = read.thread?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe(body);
    // Outbound: the tab renders this as a message FROM the practice. An inbound
    // rendering would put the practice's own words in the patient's mouth.
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].channel).toBe("sms");
    expect(messages[0].source).toBe("agent");
    expect(read.thread?.contactRef).toBe(`patient:${PATIENT}`);
  });

  it("threads onto the SAME conversation as the patient's own replies", async () => {
    // The record groups by contactRef, so a recorded send that forked its own
    // conversation would still appear — but the site-wide Conversations inbox would
    // show two threads for one person, and the agent would answer with no history.
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "one", source: "test" });
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "two", source: "test" });

    expect(rowsIn("agent_conversation")).toHaveLength(1);
    expect(rowsIn("agent_message")).toHaveLength(2);
    const read = await getThreadForPatient([SITE], PATIENT);
    expect((read.thread?.messages ?? []).map((m) => m.body)).toEqual(["one", "two"]);
  });

  it("keeps a WhatsApp send on the WhatsApp channel", async () => {
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "whatsapp", body: "hi", source: "test" });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].channel).toBe("whatsapp");
  });

  it("does not leak across sites", async () => {
    await recordOutbound({ siteId: "site-rv", dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "other site", source: "test" });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread).toBeNull();
  });
});

describe("it fails soft, because the patient already has the message", () => {
  it("returns false instead of throwing when the conversation write fails", async () => {
    agentStore.failTables.add("agent_conversation");
    await expect(
      recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "x", source: "test" }),
    ).resolves.toBe(false);
  });

  it("returns false instead of throwing when the message write fails", async () => {
    agentStore.failTables.add("agent_message");
    await expect(
      recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "x", source: "test" }),
    ).resolves.toBe(false);
  });

  it("says so LOUDLY, because a sent message with no record is the defect this lane exists to fix", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    agentStore.failTables.add("agent_message");
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "x", source: "noshow-reply" });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("noshow-reply");
    expect(line).toContain(PATIENT);
    // The log has to state the consequence, not just that a write failed: someone
    // reading it needs to know a patient was texted and their record does not show it.
    expect(line).toContain("The patient has it; the record does not.");
  });

  it("never retries, so a flaky database cannot become duplicate rows", async () => {
    // Not a hypothetical: a retry loop around a conversation write is how the same
    // sentence lands on a record three times and a coordinator concludes the patient
    // was chased three times.
    agentStore.failTables.add("agent_message");
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "x", source: "test" });
    expect(agentStore.inserts.filter((i) => i.table === "agent_message")).toHaveLength(0);
    agentStore.failTables.clear();
    await recordOutbound({ siteId: SITE, dentallyPatientId: PATIENT, patientName: "Sarah", channel: "sms", body: "x", source: "test" });
    expect(rowsIn("agent_message")).toHaveLength(1);
  });

  it("refuses to file a message with no site or no patient key rather than inventing a thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await recordOutbound({ siteId: "", dentallyPatientId: PATIENT, patientName: "S", channel: "sms", body: "x", source: "test" }),
    ).toBe(false);
    expect(
      await recordOutbound({ siteId: SITE, dentallyPatientId: "", patientName: "S", channel: "sms", body: "x", source: "test" }),
    ).toBe(false);
    // An empty key would collect every unattributable message onto one shared
    // phantom conversation, which reads as a real patient's history.
    expect(rowsIn("agent_conversation")).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("outboundPatientKey", () => {
  it("uses the Dentally id when the caller is known", () => {
    expect(outboundPatientKey("pat-9", "+447700900123")).toBe("pat-9");
  });

  it("falls back to the SAME lead key the inbound webhook uses, so a reply threads here", () => {
    expect(outboundPatientKey(null, "+447700900123")).toBe("lead:+447700900123");
    expect(outboundPatientKey("", "+447700900123")).toBe("lead:+447700900123");
    expect(outboundPatientKey("   ", "+447700900123")).toBe("lead:+447700900123");
  });
});

describe("a message keyed lead:<number> does NOT reach the patient's record", () => {
  /**
   * THE CLAIM THE RUNBOOK GOT WRONG, pinned as the behaviour rather than the wish.
   *
   * docs/runbooks/correspondence-visibility.md said such a message "joins their
   * patient record automatically if the number is later identified." Nothing does
   * that. `getThreadForPatient` filters `dentally_patient_id` to [id, "patient:"+id]
   * and never sees a `lead:` row, and the only re-key in the codebase
   * (adoptConversationPatientId, in the inbound webhook) fires solely when the agent
   * REGISTERS a brand-new patient mid-thread — never on identifying an existing one.
   *
   * And this is not a lead's problem: `identifyByPhone` matches on `mobile_phone`
   * ALONE, so a real patient ringing from a landline, a work number or a shared
   * family number lands here, as does any caller whose Dentally lookup runs past the
   * voice route's 3-second cap. So the sentence on the screen names the exception
   * and the empty state points at the inbox, which is where this row IS visible.
   */
  const FROM = "+447700900456";

  it("is invisible to the patient's own record read, even though the patient exists", async () => {
    await recordOutbound({
      siteId: SITE,
      dentallyPatientId: outboundPatientKey(null, FROM),
      patientName: `Unknown ${FROM.slice(-4)}`,
      channel: "sms",
      body: "Sorry we missed your call. Reply here and we will ring you back.",
      source: "missed-call-callback",
    });

    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread, "a lead-keyed message must not be found under the patient id").toBeNull();
    expect(read.failedSources, "and this is a real empty, not a failed read").toBe(0);
  });

  it("IS visible in the Conversations inbox, which is what the copy sends the reader to", async () => {
    // The pointer on the empty state is only honest if the message is actually
    // findable there; the site-wide inbox reads every conversation, lead keys
    // included.
    await recordOutbound({
      siteId: SITE,
      dentallyPatientId: outboundPatientKey(null, FROM),
      patientName: `Unknown ${FROM.slice(-4)}`,
      channel: "sms",
      body: "Sorry we missed your call.",
      source: "missed-call-callback",
    });
    const threads = await listThreads([SITE]);
    expect(threads.map((t) => t.contactRef)).toContain(`lead:${FROM}`);
  });

  it("does not silently migrate when the same patient is identified on a LATER send", async () => {
    // The runbook's "joins their record automatically" would have to mean this. It
    // does not happen: the two rows are two conversations, and the earlier one stays
    // where it was filed.
    await recordOutbound({
      siteId: SITE,
      dentallyPatientId: outboundPatientKey(null, FROM),
      patientName: "Unknown 0456",
      channel: "sms",
      body: "first, unidentified",
      source: "missed-call-callback",
    });
    await recordOutbound({
      siteId: SITE,
      dentallyPatientId: outboundPatientKey(PATIENT, FROM),
      patientName: "Sarah Ahmed",
      channel: "sms",
      body: "second, identified",
      source: "missed-call-callback",
    });

    expect(rowsIn("agent_conversation")).toHaveLength(2);
    const read = await getThreadForPatient([SITE], PATIENT);
    expect((read.thread?.messages ?? []).map((m) => m.body)).toEqual(["second, identified"]);
  });
});
