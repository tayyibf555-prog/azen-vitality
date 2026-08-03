// The /v1/notes page shape.
//
// The clinical-notes tab read /v1/patient_notes, a path that DOES NOT EXIST on real
// Dentally. Every live patient record 404'd, fell into the read-health catch, and
// rendered "We could not read Dentally's clinical notes just now" permanently. The
// local mock served the invented path, so nothing here ever went red.
//
// The collection key below is calibrated: a read-only GET on 2026-08-03 returned 200
// and `{"notes":[],"meta":{"total":0,...}}`. The ROW field names are NOT calibrated —
// that practice has zero notes on this endpoint, so no live row exists to look at.
// These tests pin both halves of that state: the key is asserted as fact, and the
// uncalibrated row shape is asserted to FAIL LOUDLY rather than render as "none".
import { describe, it, expect } from "vitest";
import { notesFromEnvelope, toNoteRecords } from "./notes-shape";

describe("notesFromEnvelope", () => {
  it("reads the live-calibrated `notes` key", () => {
    expect(notesFromEnvelope({ notes: [{ id: 1 }, { id: 2 }] })).toHaveLength(2);
  });

  it("returns [] for the honest empty page (Dentally saying 'none')", () => {
    // This is the ONLY empty result the reader is allowed to produce, and it is the
    // shape live actually returns today for every patient.
    expect(notesFromEnvelope({ notes: [], meta: { total: 0 } })).toEqual([]);
  });

  it("THROWS on the old invented patient_notes envelope instead of silently emptying", () => {
    // A regression to the 404 path would surface as this key (from a stale mock or a
    // cached fixture). `res.patient_notes ?? []` used to swallow it: zero rows, read
    // health "ok", and "No clinical notes in Dentally" printed as fact.
    expect(() => notesFromEnvelope({ patient_notes: [{ id: 1 }] })).toThrow(/no 'notes' array/);
  });

  it("names the keys it did see, so a shape change is diagnosable from the log", () => {
    expect(() => notesFromEnvelope({ data: [], meta: {} })).toThrow(/data, meta/);
  });

  it("throws on null, undefined and a non-array notes value", () => {
    expect(() => notesFromEnvelope(null)).toThrow(/no 'notes' array/);
    expect(() => notesFromEnvelope(undefined)).toThrow(/no 'notes' array/);
    expect(() => notesFromEnvelope({ notes: "soon" })).toThrow(/no 'notes' array/);
  });
});

describe("toNoteRecords", () => {
  it("maps id, body, author and created_at onto the record shape", () => {
    const [note] = toNoteRecords([
      { id: 77, body: "Latex allergy — no gloves", author: "Dr Shah", created_at: "2026-07-30T09:15:00Z" },
    ]);
    expect(note).toEqual({
      id: "77",
      body: "Latex allergy — no gloves",
      author: "Dr Shah",
      createdAt: "2026-07-30T09:15:00Z",
    });
  });

  it("stringifies a numeric id (real Dentally sends numbers, the mock sends strings)", () => {
    expect(toNoteRecords([{ id: 56194, body: "x" }])[0].id).toBe("56194");
  });

  it("falls back to 'Team' for an unattributed note, and to empty for a missing date", () => {
    const [note] = toNoteRecords([{ id: "n1", body: "Called re: crown" }]);
    expect(note.author).toBe("Team");
    expect(note.createdAt).toBe("");
  });

  it("maps a whole page in order", () => {
    const rows = toNoteRecords([
      { id: "a", body: "first" },
      { id: "b", body: "second" },
    ]);
    expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
  });

  it("returns [] for no rows — a patient with no notes is an ordinary answer", () => {
    expect(toNoteRecords([])).toEqual([]);
  });

  // THE CLINICAL-SAFETY ASSERTION OF THIS FILE. body/author/created_at were the field
  // names of an endpoint that never existed, so they are a guess until a live row is
  // seen. If rows arrive under different names, the record must say "we could not read
  // this" — never a page of blank notes, and never "No clinical notes in Dentally" for
  // a patient whose allergy is sitting in a field we failed to read.
  it("THROWS when rows exist but carry none of the fields we read", () => {
    expect(() => toNoteRecords([{ id: 1, note_text: "Latex allergy", entered_by: "Dr Shah" }])).toThrow(
      /carry none of body\/author\/created_at/,
    );
  });

  it("names the fields it did see, so the real shape can be read off the failure", () => {
    expect(() => toNoteRecords([{ id: 1, note_text: "x" }])).toThrow(/saw: id, note_text/);
  });

  it("accepts the page when ANY row is readable (one odd row must not fail the read)", () => {
    const rows = toNoteRecords([{ id: 1 }, { id: 2, body: "Latex allergy" }]);
    expect(rows).toHaveLength(2);
    expect(rows[1].body).toBe("Latex allergy");
  });
});
