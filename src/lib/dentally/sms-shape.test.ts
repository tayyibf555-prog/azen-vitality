import { describe, it, expect } from "vitest";
import { smsFromEnvelope, toDentallySmsRecords } from "./sms-shape";

/**
 * The guards on an UNDOCUMENTED endpoint. `/v1/sms` is absent from
 * developer.dentally.co and from its changelog; its shape comes from one recorded
 * read-only session. These tests pin the two rules that make that guess safe rather
 * than silent, and they are the same two rules ./notes-shape.test.ts pins — because
 * the failure they prevent is the one this repo has already shipped once, when the
 * clinical-notes read was pointed at a path that did not exist and answered "no
 * clinical notes" on every live patient for months.
 */

describe("smsFromEnvelope", () => {
  it("reads the calibrated collection key", () => {
    expect(smsFromEnvelope({ sms: [{ id: "1" }], meta: { total: 1 } })).toHaveLength(1);
  });

  it("returns [] for a real, empty answer", () => {
    // Dentally saying "this patient has no SMS" is an ordinary answer, not a failure.
    expect(smsFromEnvelope({ sms: [], meta: { total: 0 } })).toEqual([]);
  });

  it("THROWS on an envelope it does not recognise, rather than returning []", () => {
    // `?? []` here is the whole defect class: it stops the pager, leaves read health
    // "ok", and prints "Dentally holds no SMS for this patient" as a fact.
    expect(() => smsFromEnvelope({ messages: [] })).toThrow(/no 'sms' array/);
    expect(() => smsFromEnvelope({})).toThrow(/no 'sms' array/);
    expect(() => smsFromEnvelope(null)).toThrow(/no 'sms' array/);
    expect(() => smsFromEnvelope("not json")).toThrow(/no 'sms' array/);
  });

  it("names the keys it DID see, so a shape change is diagnosable from the log", () => {
    expect(() => smsFromEnvelope({ text_messages: [], meta: {} })).toThrow(/text_messages, meta/);
  });
});

describe("toDentallySmsRecords", () => {
  const row = {
    id: 918273,
    archived: false,
    body: "Reminder: you have an appointment on Thu 18 Jun at 10:20am.",
    created_at: "2026-06-16T08:59:58Z",
    direction: "outbound",
    from: "VitalityDental",
    read: true,
    read_at: null,
    sent_at: "2026-06-16T09:00:00Z",
    to: "+447700900001",
    user_id: 4021,
    message_type: "pms_appointment_reminder",
  };

  it("maps a live-shaped row", () => {
    const [r] = toDentallySmsRecords([row]);
    expect(r.id).toBe("918273");
    expect(r.body).toContain("Reminder");
    expect(r.direction).toBe("outbound");
    expect(r.messageType).toBe("pms_appointment_reminder");
  });

  it("prefers sent_at over created_at: when it LEFT, not when it was written", () => {
    expect(toDentallySmsRecords([row])[0].at).toBe("2026-06-16T09:00:00Z");
    expect(toDentallySmsRecords([{ ...row, sent_at: null }])[0].at).toBe("2026-06-16T08:59:58Z");
  });

  it("reads the address from the end that is not the practice", () => {
    expect(toDentallySmsRecords([row])[0].address).toBe("+447700900001");
    const inbound = { ...row, direction: "inbound", from: "+447700900001", to: "VitalityDental" };
    expect(toDentallySmsRecords([inbound])[0].address).toBe("+447700900001");
  });

  it("treats anything that is not 'inbound' as outbound", () => {
    expect(toDentallySmsRecords([{ ...row, direction: null }])[0].direction).toBe("outbound");
    expect(toDentallySmsRecords([{ ...row, direction: "inbound" }])[0].direction).toBe("inbound");
  });

  it("does not branch on message_type, it just carries it", () => {
    // The vocabulary is undocumented. A value we have not seen must not change
    // behaviour; it is provenance, shown verbatim.
    const odd = toDentallySmsRecords([{ ...row, message_type: "some_type_invented_next_year" }])[0];
    expect(odd.messageType).toBe("some_type_invented_next_year");
    expect(odd.body).toBe(row.body);
  });

  it("empty in, empty out: a patient Dentally has never texted is ordinary", () => {
    expect(toDentallySmsRecords([])).toEqual([]);
  });

  it("THROWS when rows carry none of the calibrated fields", () => {
    // Rows arriving in a shape nobody has seen would otherwise render as a list of
    // blank messages on a patient record.
    expect(() => toDentallySmsRecords([{ id: 1, content: "hi", ts: "x" }])).toThrow(/never|no longer matches/i);
  });

  it("accepts a page where only SOME rows carry a known field", () => {
    // A single unusual row must not fail a whole page; only a page that is entirely
    // unrecognisable is a shape failure.
    expect(toDentallySmsRecords([{ id: 1 }, row])).toHaveLength(2);
  });
});
