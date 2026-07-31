import { describe, expect, it } from "vitest";
import { clampToSendWindow, willNotifyPatient } from "./notify";

describe("willNotifyPatient", () => {
  it("is FALSE for a clinician-only move: the same instant, a different clinician", () => {
    // The proof is structural, not behavioural: the function takes no
    // practitioner argument at all, so a clinician change cannot reach it.
    expect(
      willNotifyPatient(
        { startIso: "2026-07-31T13:30:00Z" },
        { startIso: "2026-07-31T13:30:00Z" },
      ),
    ).toBe(false);
  });

  it("is TRUE for a time change with the same clinician", () => {
    expect(
      willNotifyPatient(
        { startIso: "2026-07-31T13:30:00Z" },
        { startIso: "2026-07-31T14:30:00Z" },
      ),
    ).toBe(true);
  });

  it("is TRUE when both the time and the clinician change", () => {
    expect(
      willNotifyPatient(
        { startIso: "2026-07-31T09:30:00Z" },
        { startIso: "2026-07-31T14:30:00Z" },
      ),
    ).toBe(true);
  });

  it("compares INSTANTS, not strings: Z and +01:00 of the same moment is not a change", () => {
    // The mock emits Z and live Dentally emits London offsets. A string
    // comparison would text every patient on every reassignment the first time
    // this ran against the real API.
    expect(
      willNotifyPatient(
        { startIso: "2026-07-31T13:30:00Z" },
        { startIso: "2026-07-31T14:30:00+01:00" },
      ),
    ).toBe(false);
  });

  it("treats an unreadable instant as a CHANGE, on purpose", () => {
    // Of the two errors, a patient never told their appointment moved arrives at
    // an empty surgery; a patient told about a move that did not happen makes a
    // phone call. draftMoveText refuses an unreadable time, so nothing garbled is
    // ever actually sent.
    expect(willNotifyPatient({ startIso: "nonsense" }, { startIso: "nonsense" })).toBe(true);
    expect(willNotifyPatient({ startIso: "2026-07-31T13:30:00Z" }, { startIso: "nonsense" })).toBe(true);
  });
});

describe("clampToSendWindow", () => {
  it("pushes 21:15 London to 08:00 the NEXT London day", () => {
    const at = Date.parse("2026-07-31T20:15:00Z"); // 21:15 London (BST)
    expect(new Date(clampToSendWindow(at)).toISOString()).toBe("2026-08-01T07:00:00.000Z"); // 08:00 London
  });

  it("pushes 06:40 London to 08:00 the SAME London day", () => {
    const at = Date.parse("2026-07-31T05:40:00Z"); // 06:40 London
    expect(new Date(clampToSendWindow(at)).toISOString()).toBe("2026-07-31T07:00:00.000Z"); // 08:00 London
  });

  it("leaves 14:30 London untouched", () => {
    const at = Date.parse("2026-07-31T13:30:00Z");
    expect(clampToSendWindow(at)).toBe(at);
  });

  it("treats exactly 20:00 as out of hours and 08:00 as in", () => {
    const eight = Date.parse("2026-07-31T07:00:00Z"); // 08:00 London
    expect(clampToSendWindow(eight)).toBe(eight);
    const twenty = Date.parse("2026-07-31T19:00:00Z"); // 20:00 London
    expect(new Date(clampToSendWindow(twenty)).toISOString()).toBe("2026-08-01T07:00:00.000Z");
  });

  it("works in GMT as well as BST", () => {
    const at = Date.parse("2026-01-15T21:15:00Z"); // 21:15 London (GMT)
    expect(new Date(clampToSendWindow(at)).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });
});
