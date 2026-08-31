import { describe, it, expect } from "vitest";
import { emailsFromEnvelope, toDentallyEmailRecords, unreadableCount } from "./emails-shape";

// ===========================================================================
// THE EMAILS SHAPE, AND WHY IT IS THE LOOSE ONE.
//
// /v1/emails answered 200 six times on 2026-08-31 (three patients, both of its
// mandatory buckets) and returned ZERO ROWS every time. So the ENVELOPE is
// calibrated and the ROW HAS NEVER BEEN SEEN.
//
// That asymmetry is the whole design, and these tests hold both halves of it: the
// envelope keeps the strict rule and throws, and the row mapper never throws —
// because throwing on the first real email would mean that the very day this
// practice's mail became readable, the tab reported a failed read and showed
// nothing.
// ===========================================================================

describe("the envelope keeps the strict rule, because the envelope IS calibrated", () => {
  it("returns rows from the envelope live actually sent", () => {
    // Exactly the shape all six reads returned, empty array and all.
    expect(
      emailsFromEnvelope({ emails: [], meta: { total: 0, current_page: 1, total_pages: 0 } }),
    ).toEqual([]);
  });

  it("THROWS on an envelope it does not recognise", () => {
    expect(() => emailsFromEnvelope({ messages: [] })).toThrow(/emails/);
    expect(() => emailsFromEnvelope(null)).toThrow();
  });
});

describe("the row mapper NEVER throws, because the row is not calibrated", () => {
  it("reads a plausibly shaped row", () => {
    const [row] = toDentallyEmailRecords(
      [
        {
          id: 7,
          subject: "Your treatment plan",
          body: "Please find your plan attached.",
          direction: "outbound",
          sent_at: "2026-08-06T10:00:00.000Z",
        },
      ],
      false,
    );
    expect(row.id).toBe("7");
    expect(row.subject).toBe("Your treatment plan");
    expect(row.body).toBe("Please find your plan attached.");
    expect(row.at).toBe("2026-08-06T10:00:00.000Z");
    expect(row.unreadable).toBe(false);
  });

  it("tolerates alternative field spellings rather than refusing the row", () => {
    // The key names this mapper looks for are PREDICTIONS — no live row has ever been
    // seen. Refusing a real email because we guessed its field name wrongly would
    // reintroduce the exact defect this whole build exists to remove.
    const [row] = toDentallyEmailRecords(
      [{ id: 1, title: "Reminder", text_body: "See you Tuesday.", created_at: "2026-08-01T09:00:00Z" }],
      false,
    );
    expect(row.subject).toBe("Reminder");
    expect(row.body).toBe("See you Tuesday.");
    expect(row.at).toBe("2026-08-01T09:00:00Z");
    expect(row.unreadable).toBe(false);
  });

  it("marks a row it could not read at all, and KEEPS it", () => {
    // The row exists because something is filed there. Dropping it hides a real email
    // behind a wrong guess about a field name; rendering it blank reads as an empty
    // email, which is a different and wrong fact.
    const [row] = toDentallyEmailRecords([{ id: 9, mystery_field: "x" }], false);
    expect(row.unreadable).toBe(true);
    expect(row.id).toBe("9");
  });

  it("does not let an id alone count as a readable row", () => {
    // A row carrying nothing but an id is exactly the case the flag exists for:
    // something happened here and we cannot say what.
    const [row] = toDentallyEmailRecords([{ id: 9 }], false);
    expect(row.unreadable).toBe(true);
  });

  it("gives two unreadable rows DIFFERENT ids so they cannot render as one", () => {
    // Two entries sharing a React key collapse into a single row, which would silently
    // under-report how many emails could not be read.
    const rows = toDentallyEmailRecords([{ a: 1 }, { b: 2 }], false);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("keeps the two buckets' synthesised ids apart as well", () => {
    const own = toDentallyEmailRecords([{ a: 1 }], false);
    const external = toDentallyEmailRecords([{ a: 1 }], true);
    expect(own[0].id).not.toBe(external[0].id);
  });

  it("never throws, on any row at all", () => {
    expect(() => toDentallyEmailRecords([null, undefined, 42, "x", {}], false)).not.toThrow();
  });

  it("defaults direction to OUTBOUND, and only 'inbound' overrides it", () => {
    // Asymmetric costs: an inbound email mislabelled "To patient" is visible and
    // correctable, whereas guessing "From patient" over something the practice sent
    // puts words in the patient's mouth on a record read during a complaint.
    expect(toDentallyEmailRecords([{ id: 1 }], false)[0].direction).toBe("outbound");
    expect(toDentallyEmailRecords([{ id: 1, direction: "inbound" }], false)[0].direction).toBe("inbound");
    expect(toDentallyEmailRecords([{ id: 1, direction: "whatever" }], false)[0].direction).toBe("outbound");
  });

  it("records which bucket each row came from", () => {
    expect(toDentallyEmailRecords([{ id: 1 }], true)[0].externalProvider).toBe(true);
    expect(toDentallyEmailRecords([{ id: 1 }], false)[0].externalProvider).toBe(false);
  });
});

describe("unreadable rows are counted rather than rounded away", () => {
  it("counts only the rows that could not be read", () => {
    const rows = toDentallyEmailRecords(
      [{ id: 1, subject: "ok" }, { id: 2 }, { id: 3 }],
      false,
    );
    expect(unreadableCount(rows)).toBe(2);
  });

  it("counts zero when everything was readable", () => {
    expect(unreadableCount(toDentallyEmailRecords([{ id: 1, subject: "ok" }], false))).toBe(0);
  });
});
