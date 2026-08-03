import { describe, expect, it } from "vitest";
import {
  CONTINUING_TERMS,
  FAMILY_CONTINUITY,
  KEY_CONTINUITY,
  checkContinuity,
  continuityOf,
  familySlugs,
  typeMapKeys,
  type ContinuityInput,
} from "./continuity";

function input(over: Partial<ContinuityInput> = {}): ContinuityInput {
  return {
    reason: "Root canal review",
    fromPractitionerId: "prac-1",
    fromPractitionerName: "Dana Hale",
    toPractitionerId: "prac-2",
    ...over,
  };
}

describe("continuityOf: the three classes", () => {
  it("calls the routine visit Blerta named TRANSFERABLE", () => {
    expect(continuityOf("Checkup")).toBe("transferable");
    expect(continuityOf("check-up")).toBe("transferable");
    expect(continuityOf("Examination")).toBe("transferable");
    expect(continuityOf("New patient exam")).toBe("transferable");
    expect(continuityOf("Scale & Polish")).toBe("transferable");
    expect(continuityOf("Hygienist")).toBe("transferable");
    expect(continuityOf("Recall")).toBe("transferable");
  });

  it("calls a staged course CONTINUING", () => {
    expect(continuityOf("Continuing Treatment")).toBe("continuing");
    expect(continuityOf("Root canal review")).toBe("continuing");
    expect(continuityOf("Invisalign review")).toBe("continuing");
    expect(continuityOf("Implant fit")).toBe("continuing");
    expect(continuityOf("Extraction")).toBe("continuing");
    expect(continuityOf("Filling")).toBe("continuing");
    expect(continuityOf("Veneers review")).toBe("continuing");
    expect(continuityOf("Whitening")).toBe("continuing");
  });

  it("calls the ones it cannot read from the string UNCLEAR, never transferable", () => {
    expect(continuityOf("Review")).toBe("unclear");
    expect(continuityOf("Consultation")).toBe("unclear");
    expect(continuityOf("Emergency")).toBe("unclear");
    expect(continuityOf("Other")).toBe("unclear");
    // Nothing in the vocabulary at all.
    expect(continuityOf("Zzz unheard of thing")).toBe("unclear");
  });

  it("is UNCLEAR, not transferable, when no reason is recorded at all", () => {
    expect(continuityOf(null)).toBe("unclear");
    expect(continuityOf(undefined)).toBe("unclear");
    expect(continuityOf("")).toBe("unclear");
    expect(continuityOf("   \t ")).toBe("unclear");
  });

  it("reads the practice's own spelling, punctuation and case", () => {
    expect(continuityOf("  CONTINUING   TREATMENT ")).toBe("continuing");
    expect(continuityOf("scale and polish")).toBe("transferable");
    expect(continuityOf("Scale & Polish")).toBe("transferable");
  });
});

describe("continuityOf: resolution order", () => {
  it("lets the key table beat the family, which is the row that earns its place", () => {
    // "recall" sits in the `treatment` family, which is unclear. Pinned
    // transferable because a recall IS the routine check-up. Delete the pin and
    // every recall becomes undraggable across clinicians.
    expect(FAMILY_CONTINUITY.treatment).toBe("unclear");
    expect(KEY_CONTINUITY.get("recall")).toBe("transferable");
    expect(continuityOf("Recall")).toBe("transferable");
  });

  it("lets an explicit continuing term beat the family it would otherwise land in", () => {
    // Free text: not an exact key, and its family is `treatment` (unclear).
    // The substring pass makes it a named continuing course instead, so the
    // reader is told WHY rather than told we could not tell.
    expect(continuityOf("Continuing treatment - upper right 6")).toBe("continuing");
    expect(continuityOf("Course of treatment, stage 2")).toBe("continuing");
    for (const term of CONTINUING_TERMS) {
      expect(continuityOf(`${term} follow up`)).toBe("continuing");
    }
  });

  it("falls back to the clinical family for free text that is not a key", () => {
    expect(continuityOf("Upper left wisdom extraction")).toBe("continuing"); // surgical
    expect(continuityOf("Composite bonding upper 6")).toBe("continuing"); // restorative
    expect(continuityOf("Perio maintenance")).toBe("transferable"); // hygiene
    expect(continuityOf("Urgent toothache")).toBe("unclear"); // emergency
  });
});

describe("the classification contract", () => {
  it("gives EVERY checked-in treatment type an explicit row", () => {
    // The point of this test: adding a treatment type to TYPE_MAP without
    // deciding whether it is continuing is a FAILURE here, not a silent
    // fall-through to whatever family it happens to match.
    const missing = typeMapKeys().filter((k) => !KEY_CONTINUITY.has(k));
    expect(missing).toEqual([]);
  });

  it("gives EVERY clinical family an explicit row", () => {
    const missing = familySlugs().filter((s) => !(s in FAMILY_CONTINUITY));
    expect(missing).toEqual([]);
  });

  it("never leaves a class outside the three", () => {
    const allowed = new Set(["continuing", "transferable", "unclear"]);
    for (const v of KEY_CONTINUITY.values()) expect(allowed.has(v)).toBe(true);
    for (const v of Object.values(FAMILY_CONTINUITY)) expect(allowed.has(v)).toBe(true);
  });
});

describe("checkContinuity: a move in TIME is never touched", () => {
  it("allows a continuing course to move within its own clinician's column", () => {
    expect(checkContinuity(input({ toPractitionerId: "prac-1" }))).toEqual({ ok: true });
  });

  it("allows an UNCLEAR appointment to move within its own clinician's column", () => {
    expect(
      checkContinuity(input({ reason: "Emergency", toPractitionerId: "prac-1" })),
    ).toEqual({ ok: true });
  });

  it("allows an appointment with no reason at all to move within its own column", () => {
    expect(checkContinuity(input({ reason: null, toPractitionerId: "prac-1" }))).toEqual({
      ok: true,
    });
  });
});

describe("checkContinuity: a move across clinicians", () => {
  it("REFUSES a continuing course and names the clinician it must stay with", () => {
    const res = checkContinuity(input({ reason: "Root canal review" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a refusal");
    expect(res.code).toBe("continuing_treatment");
    expect(res.message).toContain("Dana Hale");
    expect(res.message).toContain("continuing treatment");
    // It must not read as a dead end: the reader is told what they CAN do.
    expect(res.message).toContain("another time in their column");
  });

  it("names the treatment on the refusal, so it is arguable rather than mysterious", () => {
    const res = checkContinuity(input({ reason: "Root canal review" }));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.message).toContain("Root canal review");
  });

  it("ALLOWS a checkup across clinicians, which is the whole point of the exception", () => {
    expect(checkContinuity(input({ reason: "Checkup" }))).toEqual({ ok: true });
    expect(checkContinuity(input({ reason: "Scale & Polish" }))).toEqual({ ok: true });
    expect(checkContinuity(input({ reason: "New patient exam" }))).toEqual({ ok: true });
  });

  it("REFUSES an ambiguous reason and says so in those words", () => {
    const res = checkContinuity(input({ reason: "Review" }));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.code).toBe("continuity_unclear");
    expect(res.message).toContain("cannot tell");
    expect(res.message).toContain("Dana Hale");
  });

  it("REFUSES an appointment with nothing recorded, with its own sentence", () => {
    const res = checkContinuity(input({ reason: null }));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.code).toBe("continuity_unclear");
    expect(res.message).toContain("no treatment type recorded");
    expect(res.message).toContain("Dana Hale");
    // Nothing bracketed, because there is nothing to bracket.
    expect(res.message).not.toContain("()");
  });

  it("still refuses usefully when the clinician's name is missing", () => {
    const res = checkContinuity(input({ fromPractitionerName: "  " }));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.message).toContain("the same clinician");
  });

  it("ALLOWS assigning an Unassigned appointment to a clinician: no course is broken", () => {
    expect(
      checkContinuity(input({ reason: "Root canal review", fromPractitionerId: null })),
    ).toEqual({ ok: true });
  });

  it("prints free text back verbatim but BOUNDED, so a pasted paragraph cannot become the refusal", () => {
    const long = `Continuing treatment ${"x".repeat(200)}`;
    const res = checkContinuity(input({ reason: long }));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.message).toContain("…");
    expect(res.message.length).toBeLessThan(260);
  });
});

describe("checkContinuity: the fail-safe direction", () => {
  it("refuses every non-transferable class across clinicians, and only those", () => {
    const reasons = [
      "Checkup",
      "Examination",
      "Scale & Polish",
      "Recall",
      "Root canal review",
      "Continuing Treatment",
      "Implant fit",
      "Review",
      "Emergency",
      "Zzz unheard of thing",
      null,
    ];
    for (const reason of reasons) {
      const allowed = checkContinuity(input({ reason })).ok;
      expect(allowed).toBe(continuityOf(reason) === "transferable");
    }
  });
});
