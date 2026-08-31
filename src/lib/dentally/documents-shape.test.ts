import { describe, it, expect } from "vitest";
import {
  documentKind,
  documentLabel,
  documentsFromEnvelope,
  toDentallyDocumentRecords,
} from "./documents-shape";

// ===========================================================================
// THE DOCUMENTS SHAPE, PINNED AGAINST WHAT LIVE ACTUALLY RETURNED.
//
// The row below is copied field for field from a real 2026-08-31 read of
// /v1/patient_documents?patient_id=15. It is here so that a future change to the
// mapper is checked against the vendor's actual output rather than against a
// convenient invention.
// ===========================================================================

/** Patient 15, document 108698849, exactly as live Dentally returned it. */
const LIVE_ROW = {
  id: 108698849,
  created_at: "2023-08-04T12:25:20.813+01:00",
  form_completed: false,
  form_id: "nhs_pr_en",
  requires_signing: false,
  description: "NHS PR",
  patient_id: 15,
  url: "https://dentally-assets.s3.eu-west-1.amazonaws.com/uploads/practice_57/patient_15/2023-%204-08-12-25-20/originals/b7c5176b8baf9007?X-Amz-Expires=42033",
  signed: true,
  signed_at: "2023-08-04T12:25:22.000+01:00",
  skip_signing_after_signature_ref: null,
  updated_at: "2023-08-04T12:25:22.000+01:00",
  additional_fields: {},
  appointment_ids: [988044182],
};

describe("the envelope is unwrapped, and an unknown one is refused", () => {
  it("returns the rows from a real envelope", () => {
    expect(documentsFromEnvelope({ patient_documents: [LIVE_ROW], meta: { total: 1, page: 1 } })).toEqual([
      LIVE_ROW,
    ]);
  });

  it("treats an EMPTY array as an answer, not as a failure", () => {
    // Patient 56194 returned exactly this on live. "Dentally holds none" is an ordinary
    // reply and must not be confused with "we could not read it".
    expect(documentsFromEnvelope({ patient_documents: [], meta: { total: 0, page: 1 } })).toEqual([]);
  });

  it("THROWS on an envelope it does not recognise rather than degrading to empty", () => {
    // `?? []` here is what turns a shape change into a confident empty result, and a
    // confident empty on this tab reads as "this patient has signed nothing" — a claim
    // about their consent.
    expect(() => documentsFromEnvelope({ documents: [LIVE_ROW] })).toThrow(/patient_documents/);
    expect(() => documentsFromEnvelope(null)).toThrow();
    expect(() => documentsFromEnvelope({})).toThrow();
  });
});

describe("the live row maps to the record the screen consumes", () => {
  it("reads every field off the real 2026-08-31 row", () => {
    const [doc] = toDentallyDocumentRecords([LIVE_ROW]);
    expect(doc.id).toBe("108698849");
    expect(doc.description).toBe("NHS PR");
    expect(doc.formId).toBe("nhs_pr_en");
    expect(doc.at).toBe("2023-08-04T12:25:20.813+01:00");
    expect(doc.signed).toBe(true);
    expect(doc.requiresSigning).toBe(false);
    expect(doc.appointmentIds).toEqual(["988044182"]);
  });

  it("dates a document by created_at, NOT by updated_at", () => {
    // A document re-saved later would otherwise jump to the top of a chronological
    // record it does not belong at.
    const [doc] = toDentallyDocumentRecords([
      { ...LIVE_ROW, created_at: "2023-01-01T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" },
    ]);
    expect(doc.at).toBe("2023-01-01T00:00:00Z");
  });

  it("THROWS on rows carrying none of the calibrated fields", () => {
    expect(() => toDentallyDocumentRecords([{ wat: 1, huh: 2 }])).toThrow(/2026-08-31 calibration/);
  });

  it("empty in, empty out — a patient with no documents is an ordinary answer", () => {
    expect(toDentallyDocumentRecords([])).toEqual([]);
  });
});

describe("form and upload are told apart on the ONE field that carries the answer", () => {
  it("calls a row with no form_id an upload, and labels it with the owner's word", () => {
    // The owner asked on the call that uploads be labelled "Upload". Used verbatim: a
    // screen that renames the thing the reader already has a name for makes them
    // translate.
    const [doc] = toDentallyDocumentRecords([{ ...LIVE_ROW, form_id: null, description: "MH" }]);
    expect(documentKind(doc)).toBe("upload");
    expect(documentLabel(doc)).toBe("Upload");
  });

  it("does NOT decide it from the description, which was identical on all eight live rows", () => {
    // Every one of the eight rows read on 2026-08-31 had description "NHS PR". A
    // description test would have classified correctly on the whole sample and
    // misclassified the first scanned letter that arrived — the exact case the
    // distinction exists for.
    const [asUpload] = toDentallyDocumentRecords([{ ...LIVE_ROW, form_id: null }]);
    expect(asUpload.description).toBe("NHS PR");
    expect(documentKind(asUpload)).toBe("upload");
    const [asForm] = toDentallyDocumentRecords([{ ...LIVE_ROW, description: "MH scan" }]);
    expect(documentKind(asForm)).toBe("form");
  });

  it("labels a signed form with its description and its signed state", () => {
    const [doc] = toDentallyDocumentRecords([LIVE_ROW]);
    expect(documentLabel(doc)).toBe("NHS PR · signed");
  });

  it("says 'not signed' only when Dentally is actually WAITING for a signature", () => {
    // Three states, not two. Printing "not signed" against a document that never needed
    // one would invent an outstanding action on a clinical record.
    const [waiting] = toDentallyDocumentRecords([
      { ...LIVE_ROW, signed: false, requires_signing: true },
    ]);
    expect(documentLabel(waiting)).toBe("NHS PR · not signed");
    const [neverNeeded] = toDentallyDocumentRecords([
      { ...LIVE_ROW, signed: false, requires_signing: false },
    ]);
    expect(documentLabel(neverNeeded)).toBe("NHS PR");
  });

  it("falls back to 'Form' rather than printing a bare separator against nothing", () => {
    const [doc] = toDentallyDocumentRecords([{ ...LIVE_ROW, description: "" }]);
    expect(documentLabel(doc)).toBe("Form · signed");
  });
});
