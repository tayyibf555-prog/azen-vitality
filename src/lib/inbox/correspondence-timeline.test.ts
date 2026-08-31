import { describe, it, expect } from "vitest";
import {
  buildCorrespondenceTimeline,
  countByKind,
  isDated,
} from "./correspondence-timeline";
import type { InboxMessage } from "./types";
import type { DentallyDocumentRecord } from "@/lib/dentally/documents-shape";
import type { DentallyEmailRecord } from "@/lib/dentally/emails-shape";

// ===========================================================================
// THE MERGED TIMELINE. Four kinds of thing on one list, in one order.
//
// The rules under test are the ones a screen cannot recover from if they are
// wrong: an entry rendered at the wrong point in a patient's history, an entry
// silently dropped, or two entries collapsing onto one React key and rendering
// as one row. Each of those turns a clinical record into a false record.
// ===========================================================================

function message(id: string, at: string): InboxMessage {
  return {
    id,
    contactRef: "patient:p1",
    contactName: "Sarah Ahmed",
    channel: "sms",
    direction: "outbound",
    body: `body ${id}`,
    at,
    source: "agent",
    status: "sent",
    actionedBy: null,
  };
}

function document(id: string, at: string): DentallyDocumentRecord {
  return {
    id,
    description: "NHS PR",
    formId: "nhs_pr_en",
    at,
    signed: true,
    signedAt: at,
    requiresSigning: false,
    url: "https://dentally-assets.s3.eu-west-1.amazonaws.com/x",
    appointmentIds: [],
  };
}

function email(id: string, at: string): DentallyEmailRecord {
  return {
    id,
    subject: `subject ${id}`,
    body: `body ${id}`,
    direction: "outbound",
    at,
    externalProvider: false,
    unreadable: false,
  };
}

describe("the timeline merges every kind into one order", () => {
  it("interleaves messages, documents and emails strictly by time", () => {
    const built = buildCorrespondenceTimeline(
      [message("m1", "2026-08-01T09:00:00.000Z"), message("m2", "2026-08-03T09:00:00.000Z")],
      [document("d1", "2026-08-02T09:00:00.000Z")],
      [email("e1", "2026-08-04T09:00:00.000Z")],
    );
    // Oldest first — the chat order this tab has always rendered in.
    expect(built.entries.map((e) => e.kind)).toEqual(["message", "document", "message", "email"]);
    expect(built.entries.map((e) => e.at)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
      "2026-08-03T09:00:00.000Z",
      "2026-08-04T09:00:00.000Z",
    ]);
  });

  it("orders by INSTANT, not by the lexical ISO string", () => {
    // Dentally returns offsets ("+01:00") and the platform's own stores return "Z". A
    // lexical compare puts 09:00+01:00 (which is 08:00Z) AFTER 08:30Z, so a document
    // Dentally filed first would render after a message that came second.
    const built = buildCorrespondenceTimeline(
      [message("m1", "2026-08-01T08:30:00.000Z")],
      [document("d1", "2026-08-01T09:00:00.000+01:00")],
      [],
    );
    expect(built.entries.map((e) => e.id)).toEqual(["document:d1", "m1"]);
  });

  it("namespaces ids per kind so a document and an SMS cannot collide on one key", () => {
    // Both are bare integers from the same vendor and WILL collide eventually. Two
    // entries sharing a React key render as ONE row, silently losing a document from a
    // clinical record.
    const built = buildCorrespondenceTimeline(
      [message("42", "2026-08-01T09:00:00.000Z")],
      [document("42", "2026-08-02T09:00:00.000Z")],
      [email("42", "2026-08-03T09:00:00.000Z")],
    );
    const ids = built.entries.map((e) => e.id);
    expect(ids).toEqual(["42", "document:42", "email:42"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts kinds from the ENTRIES, so a count cannot disagree with the list", () => {
    const built = buildCorrespondenceTimeline(
      [message("m1", "2026-08-01T09:00:00.000Z")],
      [document("d1", "2026-08-02T09:00:00.000Z"), document("d2", "2026-08-03T09:00:00.000Z")],
      [],
    );
    expect(countByKind(built.entries)).toEqual({ message: 1, document: 2, email: 0 });
  });
});

describe("an entry with no readable date is kept, and kept OUT of the order", () => {
  it("does not sort an undated entry to the top as the oldest thing on the record", () => {
    // An empty timestamp parses to NaN and sorts before every real one, so an undated
    // document would render at the TOP of the record — a statement about when the
    // patient signed something, produced by a missing field.
    const built = buildCorrespondenceTimeline(
      [message("m1", "2026-08-01T09:00:00.000Z")],
      [document("d1", "")],
      [],
    );
    expect(built.entries.map((e) => e.id)).toEqual(["m1"]);
    expect(built.undated.map((e) => e.id)).toEqual(["document:d1"]);
  });

  it("keeps an UNPARSEABLE date out of the order too, not only an empty one", () => {
    const built = buildCorrespondenceTimeline([], [document("d1", "not-a-date")], []);
    expect(built.entries).toHaveLength(0);
    expect(built.undated).toHaveLength(1);
  });

  it("never DROPS an undated entry", () => {
    // The rule ./dentally-merge already holds for an SMS with an unparseable time: it
    // happened, we just cannot place it precisely.
    const built = buildCorrespondenceTimeline([], [document("d1", "")], [email("e1", "")]);
    expect(built.entries.length + built.undated.length).toBe(2);
  });

  it("isDated agrees with where the builder actually put each entry", () => {
    // The predicate and the split must not be able to drift: everything in `entries`
    // is dated and everything in `undated` is not.
    const built = buildCorrespondenceTimeline(
      [message("m1", "2026-08-01T09:00:00.000Z"), message("m2", "")],
      [document("d1", "2026-08-02T09:00:00.000Z")],
      [email("e1", "nonsense")],
    );
    expect(built.entries.every(isDated)).toBe(true);
    expect(built.undated.every((e) => !isDated(e))).toBe(true);
  });
});
