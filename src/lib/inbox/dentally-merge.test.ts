import { describe, it, expect } from "vitest";
import { DUPLICATE_WINDOW_MS, bodyKey, mergeDentallySms } from "./dentally-merge";
import type { DentallySmsRecord } from "@/lib/dentally/sms-shape";
import type { InboxMessage } from "./types";

function platformMsg(p: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "recall:1",
    contactRef: "patient:pat-001",
    contactName: "Sarah Lindqvist",
    channel: "sms",
    direction: "outbound",
    body: "It is time for your check-up.",
    at: "2026-06-16T09:00:00.000Z",
    source: "recall",
    status: "sent",
    actionedBy: "Blerta",
    ...p,
  };
}

function dentallyRow(p: Partial<DentallySmsRecord> = {}): DentallySmsRecord {
  return {
    id: "sms-1",
    body: "It is time for your check-up.",
    direction: "outbound",
    at: "2026-06-16T09:00:00.000Z",
    address: "+447700900001",
    messageType: "recall",
    ...p,
  };
}

describe("bodyKey", () => {
  it("ignores whitespace and casing so two renderings of one text match", () => {
    expect(bodyKey("  It IS   time\nfor your check-up. ")).toBe(bodyKey("it is time for your check-up."));
  });
});

describe("mergeDentallySms", () => {
  it("adds Dentally's own messages the platform does not hold", () => {
    const out = mergeDentallySms(
      [platformMsg()],
      [dentallyRow({ id: "sms-9", body: "Your appointment is confirmed.", at: "2026-06-17T10:00:00.000Z" })],
      "pat-001",
      "Sarah Lindqvist",
    );
    expect(out).toHaveLength(2);
    const added = out.find((m) => m.source === "dentally");
    expect(added?.id).toBe("dentally:sms-9");
    expect(added?.contactRef).toBe("patient:pat-001");
  });

  it("does NOT claim Dentally's messages were delivered", () => {
    // Dentally's log records that the message exists, not that Twilio delivered it.
    const [added] = mergeDentallySms([], [dentallyRow()], "pat-001", "Sarah");
    expect(added.status).toBe("unknown");
    expect(added.actionedBy).toBeNull();
  });

  it("collapses the same text seen from both sides into ONE row", () => {
    // Both systems hold it because Dentally's Twilio number sent it. Printing it
    // twice reads as "we chased her twice", which is a false statement about the
    // practice on a record that may be read during a complaint.
    const out = mergeDentallySms([platformMsg()], [dentallyRow()], "pat-001", "Sarah");
    expect(out).toHaveLength(1);
  });

  it("keeps the PLATFORM row when it collapses, because it is strictly richer", () => {
    const out = mergeDentallySms([platformMsg()], [dentallyRow()], "pat-001", "Sarah");
    expect(out[0].source).toBe("recall");
    expect(out[0].status).toBe("sent");
    expect(out[0].actionedBy).toBe("Blerta");
  });

  it("never drops Dentally's copy SILENTLY: the survivor is flagged", () => {
    const out = mergeDentallySms([platformMsg()], [dentallyRow()], "pat-001", "Sarah");
    expect(out[0].alsoInDentally).toBe(true);
  });

  it("leaves an unmatched platform row unflagged", () => {
    const out = mergeDentallySms([platformMsg()], [], "pat-001", "Sarah");
    expect(out[0].alsoInDentally).toBeUndefined();
  });

  it("shows BOTH when the same words are a genuine second chase", () => {
    // Identical text a week apart is not one message seen twice; it is the practice
    // chasing again, and collapsing it would hide a real contact.
    const later = dentallyRow({ id: "sms-2", at: "2026-06-23T09:00:00.000Z" });
    const out = mergeDentallySms([platformMsg()], [later], "pat-001", "Sarah");
    expect(out).toHaveLength(2);
  });

  it("matches inside the window and stops matching outside it", () => {
    const inside = dentallyRow({ at: new Date(Date.parse("2026-06-16T09:00:00.000Z") + DUPLICATE_WINDOW_MS - 1000).toISOString() });
    const outside = dentallyRow({ at: new Date(Date.parse("2026-06-16T09:00:00.000Z") + DUPLICATE_WINDOW_MS + 1000).toISOString() });
    expect(mergeDentallySms([platformMsg()], [inside], "p", "n")).toHaveLength(1);
    expect(mergeDentallySms([platformMsg()], [outside], "p", "n")).toHaveLength(2);
  });

  it("never matches on timing alone", () => {
    // A reminder and a recall in the same minute are two different things said to
    // the patient, and both belong on the record.
    const other = dentallyRow({ body: "Your appointment has moved to 9:40am." });
    expect(mergeDentallySms([platformMsg()], [other], "p", "n")).toHaveLength(2);
  });

  it("never matches across directions", () => {
    // A patient echoing our words back is their message, not ours.
    const echoed = dentallyRow({ direction: "inbound" });
    expect(mergeDentallySms([platformMsg()], [echoed], "p", "n")).toHaveLength(2);
  });

  it("INCLUDES a Dentally row whose timestamp cannot be parsed", () => {
    // It happened; we just cannot place it precisely. Dropping it would hide a real
    // message, and matching it would be concluding "same message" from an unknown time.
    const out = mergeDentallySms([platformMsg()], [dentallyRow({ at: "" })], "p", "n");
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.source === "dentally")).toBe(true);
  });

  it("returns chat order, oldest first, across both systems", () => {
    const platform = [
      platformMsg({ id: "recall:1", at: "2026-06-16T09:00:00.000Z", body: "one" }),
      platformMsg({ id: "recall:2", at: "2026-06-20T09:00:00.000Z", body: "three" }),
    ];
    const out = mergeDentallySms(platform, [dentallyRow({ at: "2026-06-18T09:00:00.000Z", body: "two" })], "p", "n");
    expect(out.map((m) => m.body)).toEqual(["one", "two", "three"]);
  });

  it("does not mutate the caller's array", () => {
    const platform = [platformMsg()];
    mergeDentallySms(platform, [dentallyRow()], "p", "n");
    expect(platform[0].alsoInDentally).toBeUndefined();
  });
});
