import { describe, it, expect } from "vitest";
import {
  ALLOWED_DOCUMENT_MIME,
  ALLOWED_POLICY_MIME,
  CONTENT_LENGTH_CEILING,
  DOCUMENT_KINDS,
  EXPIRING_SOON_DAYS,
  MAX_DOCUMENT_BYTES,
  STAFF_DOCS_BUCKET,
  daysBetween,
  documentsMissing,
  documentsNeedingAttention,
  expiryState,
  extensionForMime,
  formatBytes,
  isDocumentKind,
  isPastRetention,
  isWithinOwnDocPrefix,
  isWithinStaffDocPrefix,
  safeDocLeafName,
  safeDocPath,
  safePolicyPath,
  type StaffDocument,
  type StaffDocumentKind,
} from "./documents";

// ===========================================================================
// These are the rules that stand between one practice's employee passports and
// another's, and between a vault and a file dump. Each has its own named test so a
// mutation to one line turns exactly one test red.
// ===========================================================================

const TODAY = "2026-08-14";

function doc(over: Partial<StaffDocument> = {}): StaffDocument {
  return {
    id: "doc-1",
    clientId: "vitality",
    staffId: "00000000-0000-0000-0000-0000000000f1",
    kind: "dbs",
    label: "DBS certificate",
    storagePath: "staff-docs/vitality/00000000-0000-0000-0000-0000000000f1/tok/dbs.pdf",
    mime: "application/pdf",
    sizeBytes: 1024,
    expiresOn: null,
    retainUntil: null,
    uploadedBy: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...over,
  };
}

describe("the MIME allow-list is the allow-list, and nothing else gets in", () => {
  it("accepts exactly PDF plus the four image types the onboarding upload accepts", () => {
    expect(Object.keys(ALLOWED_DOCUMENT_MIME).sort()).toEqual([
      "application/pdf",
      "image/heic",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("refuses an executable, an office document and an archive", () => {
    for (const mime of [
      "application/x-msdownload",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "text/html",
      "image/svg+xml", // SVG is script-capable: deliberately NOT on the list
    ]) {
      expect(extensionForMime(mime), mime).toBeNull();
    }
  });

  it("a policy may only ever be a PDF", () => {
    expect(Object.keys(ALLOWED_POLICY_MIME)).toEqual(["application/pdf"]);
    expect(extensionForMime("image/png", ALLOWED_POLICY_MIME)).toBeNull();
  });

  it("refuses a non-string content-type rather than coercing it", () => {
    expect(extensionForMime(undefined)).toBeNull();
    expect(extensionForMime(null)).toBeNull();
    expect(extensionForMime(42)).toBeNull();
  });

  it("the content-length pre-guard sits above the authoritative cap, not below it", () => {
    // Below it and a legitimate 10MB file is rejected before it is ever measured.
    expect(CONTENT_LENGTH_CEILING).toBeGreaterThan(MAX_DOCUMENT_BYTES);
  });
});

describe("the uploader's filename is never trusted", () => {
  it("forces the extension from the validated content-type, so cv.pdf.exe becomes a pdf", () => {
    expect(safeDocLeafName("cv.pdf.exe", "pdf")).toBe("cv.pdf.pdf");
    expect(safeDocLeafName("payload.exe", "png")).toBe("payload.png");
  });

  it("strips directory parts from a traversal filename", () => {
    expect(safeDocLeafName("../../../etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(safeDocLeafName("C:\\Windows\\system32\\evil.dll", "pdf")).toBe("evil.pdf");
  });

  it("collapses an exotic charset and never emits a leading or trailing dot or dash", () => {
    expect(safeDocLeafName("...my dbs (2026)!!!...", "pdf")).toBe("my-dbs-2026.pdf");
  });

  it("falls back to a name rather than emitting a bare extension", () => {
    expect(safeDocLeafName("", "pdf")).toBe("file.pdf");
    expect(safeDocLeafName("###", "pdf")).toBe("file.pdf");
    expect(safeDocLeafName(undefined, "pdf")).toBe("file.pdf");
  });

  it("bounds the length so a 5,000 character filename cannot be stored", () => {
    const leaf = safeDocLeafName("a".repeat(5000), "pdf");
    expect(leaf.length).toBeLessThanOrEqual(84);
  });
});

describe("safeDocPath builds an unguessable, tenant-prefixed path", () => {
  it("is bucket / client / staff / token / safe leaf", () => {
    expect(
      safeDocPath({
        clientSlug: "vitality",
        staffId: "00000000-0000-0000-0000-0000000000f1",
        token: "11111111-2222-3333-4444-555555555555",
        filename: "DBS certificate.pdf",
        mime: "application/pdf",
      }),
    ).toBe(
      "staff-docs/vitality/00000000-0000-0000-0000-0000000000f1/11111111-2222-3333-4444-555555555555/DBS-certificate.pdf",
    );
  });

  it("refuses a content-type that is not on the allow-list", () => {
    expect(
      safeDocPath({
        clientSlug: "vitality",
        staffId: "f1",
        token: "tok",
        filename: "x.zip",
        mime: "application/zip",
      }),
    ).toBeNull();
  });

  it("refuses a client slug or staff id carrying a path separator", () => {
    const base = { token: "tok", filename: "a.pdf", mime: "application/pdf" };
    expect(safeDocPath({ ...base, clientSlug: "vitality/../other", staffId: "f1" })).toBeNull();
    expect(safeDocPath({ ...base, clientSlug: "vitality", staffId: "../f1" })).toBeNull();
    expect(safeDocPath({ ...base, clientSlug: "", staffId: "f1" })).toBeNull();
  });

  it("policy PDFs land under a policies prefix, not under a staff member", () => {
    expect(
      safePolicyPath({
        clientSlug: "vitality",
        token: "tok",
        filename: "Infection control.pdf",
        mime: "application/pdf",
      }),
    ).toBe("staff-docs/vitality/policies/tok/Infection-control.pdf");
  });

  it("a policy upload of an image is refused even though the vault accepts images", () => {
    expect(
      safePolicyPath({
        clientSlug: "vitality",
        token: "tok",
        filename: "policy.png",
        mime: "image/png",
      }),
    ).toBeNull();
  });
});

describe("isWithinStaffDocPrefix is the tenancy guard, and it is strict", () => {
  it("admits a path under this client's own prefix", () => {
    expect(isWithinStaffDocPrefix("staff-docs/vitality/f1/tok/a.pdf", "vitality")).toBe(true);
  });

  it("REFUSES another practice's path", () => {
    expect(isWithinStaffDocPrefix("staff-docs/other-practice/f1/tok/a.pdf", "vitality")).toBe(false);
  });

  it("REFUSES a traversal even when the prefix matches", () => {
    expect(isWithinStaffDocPrefix("staff-docs/vitality/../other/f1/a.pdf", "vitality")).toBe(false);
  });

  it("REFUSES the onboarding bucket, which a client-slug-only check would admit", () => {
    // The exposure this exists for: patients' uploaded documents live in a different
    // bucket under the same client slug.
    expect(isWithinStaffDocPrefix("onboarding/vitality/tok/passport.pdf", "vitality")).toBe(false);
  });

  it("REFUSES a sibling client whose slug merely starts the same way", () => {
    expect(isWithinStaffDocPrefix("staff-docs/vitality-two/f1/a.pdf", "vitality")).toBe(false);
  });

  it("refuses an empty, missing or non-string path", () => {
    expect(isWithinStaffDocPrefix("", "vitality")).toBe(false);
    expect(isWithinStaffDocPrefix(undefined, "vitality")).toBe(false);
    expect(isWithinStaffDocPrefix(123, "vitality")).toBe(false);
  });

  it("refuses when the client slug itself is unsafe", () => {
    expect(isWithinStaffDocPrefix("staff-docs/../f1/a.pdf", "..")).toBe(false);
  });

  it("names the bucket the code actually writes to", () => {
    expect(STAFF_DOCS_BUCKET).toBe("staff-docs");
  });
});

describe("isWithinOwnDocPrefix is the SELF-SERVICE guard: my file, not my practice's", () => {
  // The manager's guard above proves a path belongs to this practice, which is all
  // a manager needs — they may open anybody's file. My work's read may not, and the
  // path comes from a browser, so this is what stands between a nurse and a
  // colleague's passport when she asks for a signed URL.
  const MINE = "00000000-0000-0000-0000-0000000000f1";
  const THEIRS = "00000000-0000-0000-0000-0000000000f2";

  it("admits my own document", () => {
    expect(isWithinOwnDocPrefix(`staff-docs/vitality/${MINE}/tok/dbs.pdf`, "vitality", MINE)).toBe(true);
  });

  it("REFUSES a colleague's document in the same practice", () => {
    // The tenancy guard says yes to this path; that is precisely why a second,
    // narrower guard is needed on the self-service branch.
    expect(isWithinStaffDocPrefix(`staff-docs/vitality/${THEIRS}/tok/dbs.pdf`, "vitality")).toBe(true);
    expect(isWithinOwnDocPrefix(`staff-docs/vitality/${THEIRS}/tok/dbs.pdf`, "vitality", MINE)).toBe(false);
  });

  it("REFUSES a staff id that merely starts the same way", () => {
    expect(isWithinOwnDocPrefix(`staff-docs/vitality/${MINE}9/tok/a.pdf`, "vitality", MINE)).toBe(false);
  });

  it("REFUSES the policy prefix, which is not anybody's own document", () => {
    expect(isWithinOwnDocPrefix("staff-docs/vitality/policies/tok/handbook.pdf", "vitality", MINE)).toBe(
      false,
    );
  });

  it("inherits every refusal of the tenancy guard (traversal, other bucket, other client)", () => {
    expect(isWithinOwnDocPrefix(`staff-docs/vitality/../${MINE}/a.pdf`, "vitality", MINE)).toBe(false);
    expect(isWithinOwnDocPrefix(`onboarding/vitality/${MINE}/a.pdf`, "vitality", MINE)).toBe(false);
    expect(isWithinOwnDocPrefix(`staff-docs/other/${MINE}/a.pdf`, "vitality", MINE)).toBe(false);
  });

  it("refuses an unsafe or empty staff id rather than building a prefix out of it", () => {
    expect(isWithinOwnDocPrefix(`staff-docs/vitality/${MINE}/tok/a.pdf`, "vitality", "")).toBe(false);
    expect(isWithinOwnDocPrefix("staff-docs/vitality/../tok/a.pdf", "vitality", "..")).toBe(false);
  });
});

describe("expiryState answers four questions, not three", () => {
  it("a document with no expiry is 'no-expiry', NOT 'valid'", () => {
    // Calling it valid would be a confident claim the data does not support.
    expect(expiryState(doc({ expiresOn: null }), TODAY)).toBe("no-expiry");
  });

  it("yesterday is expired", () => {
    expect(expiryState(doc({ expiresOn: "2026-08-13" }), TODAY)).toBe("expired");
  });

  it("TODAY is expiring, not expired: it is still in force for the whole of today", () => {
    expect(expiryState(doc({ expiresOn: TODAY }), TODAY)).toBe("expiring");
  });

  it("the last day inside the window is expiring and the first day outside it is valid", () => {
    expect(EXPIRING_SOON_DAYS).toBe(60);
    expect(expiryState(doc({ expiresOn: "2026-10-13" }), TODAY)).toBe("expiring"); // +60
    expect(expiryState(doc({ expiresOn: "2026-10-14" }), TODAY)).toBe("valid"); // +61
  });

  it("honours a caller-supplied window", () => {
    expect(expiryState(doc({ expiresOn: "2026-08-20" }), TODAY, 3)).toBe("valid");
    expect(expiryState(doc({ expiresOn: "2026-08-16" }), TODAY, 3)).toBe("expiring");
  });

  it("says nothing rather than guessing when the date is unparseable", () => {
    expect(expiryState(doc({ expiresOn: "not a date" }), TODAY)).toBe("no-expiry");
    expect(expiryState(doc({ expiresOn: "2026-02-31" }), TODAY)).toBe("no-expiry");
  });
});

describe("daysBetween crosses months, years and a leap day", () => {
  it("counts a leap year February correctly", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("is negative when the target is in the past", () => {
    expect(daysBetween("2026-08-14", "2026-08-13")).toBe(-1);
  });

  it("returns null for a non-date rather than NaN", () => {
    expect(daysBetween("2026-08-14", "soon")).toBeNull();
    expect(daysBetween(null, "2026-08-14")).toBeNull();
  });
});

describe("documentsMissing does not count an expired document as held", () => {
  it("reports a kind with no document at all", () => {
    expect(documentsMissing(["dbs", "indemnity"], [], TODAY)).toEqual(["dbs", "indemnity"]);
  });

  it("EXPIRED DOES NOT COUNT: a lapsed right to work check is not evidence of anything", () => {
    const held = [doc({ kind: "right-to-work", expiresOn: "2026-01-01" })];
    expect(documentsMissing(["right-to-work"], held, TODAY)).toEqual(["right-to-work"]);
  });

  it("expiring soon still counts as held: it has not lapsed yet", () => {
    const held = [doc({ kind: "right-to-work", expiresOn: "2026-09-01" })];
    expect(documentsMissing(["right-to-work"], held, TODAY)).toEqual([]);
  });

  it("a document with no expiry counts as held", () => {
    const held = [doc({ kind: "contract", expiresOn: null })];
    expect(documentsMissing(["contract"], held, TODAY)).toEqual([]);
  });

  it("one valid copy satisfies the kind even when an expired copy is also on file", () => {
    const held = [
      doc({ id: "old", kind: "dbs", expiresOn: "2025-01-01" }),
      doc({ id: "new", kind: "dbs", expiresOn: "2027-01-01" }),
    ];
    expect(documentsMissing(["dbs"], held, TODAY)).toEqual([]);
  });

  it("preserves the order asked for and deduplicates a repeated kind", () => {
    expect(documentsMissing(["indemnity", "dbs", "indemnity"], [], TODAY)).toEqual([
      "indemnity",
      "dbs",
    ]);
  });
});

describe("documentsNeedingAttention is the practice's worklist", () => {
  it("lists expired and expiring, soonest first, and leaves valid ones out", () => {
    const docs = [
      doc({ id: "valid", expiresOn: "2027-01-01" }),
      doc({ id: "soon", expiresOn: "2026-09-01" }),
      doc({ id: "gone", expiresOn: "2026-06-01" }),
      doc({ id: "undated", expiresOn: null }),
    ];
    expect(documentsNeedingAttention(docs, TODAY).map((d) => d.id)).toEqual(["gone", "soon"]);
  });
});

describe("retention is recorded and displayed, never enforced", () => {
  it("is past retention when the date has gone", () => {
    expect(isPastRetention(doc({ retainUntil: "2026-08-13" }), TODAY)).toBe(true);
  });

  it("is not past retention on the day itself, nor when no date is recorded", () => {
    expect(isPastRetention(doc({ retainUntil: TODAY }), TODAY)).toBe(false);
    expect(isPastRetention(doc({ retainUntil: null }), TODAY)).toBe(false);
  });

  it("is a pure predicate: it returns an answer and touches nothing", () => {
    // The whole point of decision 10. An automatic deleter that destroyed a right to
    // work check would be far worse than a date nobody actioned, so this function
    // reports and a person decides.
    const d = doc({ retainUntil: "2020-01-01" });
    isPastRetention(d, TODAY);
    expect(d.retainUntil).toBe("2020-01-01");
  });
});

describe("kinds are a closed list that matches the migration", () => {
  it("holds the nine kinds the check constraint names", () => {
    expect([...DOCUMENT_KINDS].sort()).toEqual([
      "contract",
      "dbs",
      "gdc-registration",
      "indemnity",
      "other",
      "passport",
      "qualification",
      "right-to-work",
      "training-certificate",
    ]);
  });

  it("refuses a kind nobody defined", () => {
    expect(isDocumentKind("visa")).toBe(false);
    expect(isDocumentKind(undefined)).toBe(false);
    expect(isDocumentKind("dbs" as StaffDocumentKind)).toBe(true);
  });
});

describe("formatBytes", () => {
  it("reads in bytes, kilobytes and megabytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("says 'unknown size' rather than NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});
