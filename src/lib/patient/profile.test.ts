// The whitelist, the validation and the diff that stand between a practice manager's
// form and a REAL clinical record. Every case here is a way a bad write could reach
// live Dentally, so the coverage is deliberately paranoid.
import { describe, it, expect } from "vitest";
import {
  auditValue,
  buildAuditRows,
  buildUpdatePayload,
  canonicalGender,
  canonicaliseProfile,
  canonicalPostcode,
  detectConflicts,
  diffProfile,
  parseProfileChanges,
  PROFILE_FIELDS,
} from "./profile";

function ok(raw: unknown) {
  const r = parseProfileChanges(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got ${JSON.stringify(r.errors)}`);
  return r.parsed;
}
function errs(raw: unknown) {
  const r = parseProfileChanges(raw);
  if (r.ok) throw new Error("expected parse to fail");
  return r.errors;
}

describe("whitelist", () => {
  it("drops an unexpected field instead of forwarding it", () => {
    const p = ok({ first_name: "Ada", id: "999", site_id: "site-ng", balance: 100, active: false });
    expect(p.values).toEqual({ first_name: "Ada", active: false });
    expect(p.dropped.sort()).toEqual(["balance", "id", "site_id"]);
  });

  it("cannot smuggle a patient id through under any casing or nesting", () => {
    const p = ok({ ID: "1", patient_id: "2", patient: { id: "3" }, first_name: "Ada" });
    expect(p.values).toEqual({ first_name: "Ada" });
    expect("id" in p.values).toBe(false);
  });

  it("a body that is not an object yields no values at all", () => {
    expect(ok(null).values).toEqual({});
    expect(ok("first_name=Ada").values).toEqual({});
    expect(ok(["first_name"]).values).toEqual({});
  });

  it("every whitelisted field is accepted", () => {
    const p = ok({
      title: "Mrs",
      first_name: "Ada",
      last_name: "Lovelace",
      date_of_birth: "1965-12-10",
      gender: false,
      mobile_phone: "07700 900123",
      email_address: "Ada@Example.co.uk",
      address_line_1: "12 Green Lanes",
      address_line_2: "Harringay",
      address_line_3: "London",
      postcode: "n154ab",
      payment_plan_id: 2,
      active: true,
    });
    expect(Object.keys(p.values).sort()).toEqual([...PROFILE_FIELDS].sort());
  });
});

describe("validation reuses the existing helpers", () => {
  it("normalises the mobile through toE164", () => {
    expect(ok({ mobile_phone: "07700 900123" }).values.mobile_phone).toBe("+447700900123");
    expect(ok({ mobile_phone: "(07700) 900-123" }).values.mobile_phone).toBe("+447700900123");
    expect(errs({ mobile_phone: "not a phone" }).mobile_phone).toBeTruthy();
  });

  it("normalises the email through normaliseEmail", () => {
    expect(ok({ email_address: "  Ada@Example.CO.UK " }).values.email_address).toBe("ada@example.co.uk");
    expect(errs({ email_address: "ada@example" }).email_address).toBeTruthy();
  });

  it("date of birth must be a real PAST calendar date", () => {
    expect(ok({ date_of_birth: "1965-12-10" }).values.date_of_birth).toBe("1965-12-10");
    expect(errs({ date_of_birth: "2001-02-31" }).date_of_birth).toBeTruthy(); // not a real day
    expect(errs({ date_of_birth: "2001-13-01" }).date_of_birth).toBeTruthy();
    expect(errs({ date_of_birth: "10/12/1815" }).date_of_birth).toBeTruthy();
    expect(errs({ date_of_birth: "2099-01-01" }).date_of_birth).toBeTruthy(); // future
    expect(errs({ date_of_birth: "1799-01-01" }).date_of_birth).toBeTruthy(); // absurd
  });

  it("gender is a BOOLEAN, and a string is refused rather than coerced", () => {
    expect(ok({ gender: true }).values.gender).toBe(true);
    expect(ok({ gender: false }).values.gender).toBe(false);
    // "male" is truthy: coercing it would silently record every patient as male.
    expect(errs({ gender: "male" }).gender).toBeTruthy();
    expect(errs({ gender: 1 }).gender).toBeTruthy();
  });

  it("title and payment plan are whitelists, not free text", () => {
    expect(ok({ title: "mrs" }).values.title).toBe("Mrs"); // canonical spelling, not the caller's
    expect(errs({ title: "Lord" }).title).toBeTruthy();
    expect(ok({ payment_plan_id: 47752 }).values.payment_plan_id).toBe(47752); // UDC
    expect(errs({ payment_plan_id: 3 }).payment_plan_id).toBeTruthy();
  });

  it("canonicalises a UK postcode and refuses junk", () => {
    expect(ok({ postcode: "n154ab" }).values.postcode).toBe("N15 4AB");
    expect(ok({ postcode: " e1  6an " }).values.postcode).toBe("E1 6AN");
    expect(errs({ postcode: "<script>" }).postcode).toBeTruthy();
  });

  it("only genuinely optional fields may be cleared", () => {
    expect(ok({ email_address: "" }).values).toEqual({ email_address: null });
    expect(ok({ address_line_2: null }).values).toEqual({ address_line_2: null });
    // Blanking these would break the record or lose the practice's only way to reach them.
    expect(errs({ first_name: "" }).first_name).toBeTruthy();
    expect(errs({ mobile_phone: "" }).mobile_phone).toBeTruthy();
    expect(errs({ date_of_birth: "" }).date_of_birth).toBeTruthy();
    expect(errs({ active: null }).active).toBeTruthy();
  });
});

describe("canonicaliseProfile", () => {
  it("reads a live-shaped Dentally patient", () => {
    const p = canonicaliseProfile({
      id: "42",
      title: "Mr",
      first_name: "  Alan ",
      last_name: "Turing",
      date_of_birth: "1962-06-23",
      gender: true,
      mobile_phone: "07834 123456",
      email_address: "Alan@Example.co.uk",
      postcode: "n174ab",
      payment_plan_id: 1,
      active: true,
    });
    expect(p.first_name).toBe("Alan");
    expect(p.mobile_phone).toBe("+447834123456");
    expect(p.email_address).toBe("alan@example.co.uk");
    expect(p.postcode).toBe("N17 4AB");
    expect(p.gender).toBe(true);
  });

  it("fills every field with null when the record does not carry it", () => {
    const p = canonicaliseProfile({});
    for (const f of PROFILE_FIELDS) expect(p[f]).toBeNull();
  });

  it("reads a nested payment_plan as well as the flat id", () => {
    expect(canonicaliseProfile({ payment_plan: { id: 2 } }).payment_plan_id).toBe(2);
    expect(canonicaliseProfile({ payment_plan_id: 47752 }).payment_plan_id).toBe(47752);
  });

  it("gender: a boolean passes through, legacy strings normalise, junk is null", () => {
    expect(canonicalGender(true)).toBe(true);
    expect(canonicalGender(false)).toBe(false);
    expect(canonicalGender("Female")).toBe(false);
    expect(canonicalGender("Male")).toBe(true);
    expect(canonicalGender("unknown")).toBeNull();
    expect(canonicalGender(undefined)).toBeNull();
  });

  it("a non-UK postcode is uppercased rather than refused", () => {
    expect(canonicalPostcode("75008")).toBe("75008");
    expect(canonicalPostcode("a".repeat(40))).toBeNull();
  });
});

describe("diffProfile sends ONLY what changed", () => {
  const current = canonicaliseProfile({
    first_name: "Alan",
    last_name: "Turing",
    mobile_phone: "07834 123456",
    email_address: "alan@example.co.uk",
    active: true,
  });

  it("returns just the field that moved", () => {
    const changes = ok({ email_address: "a.turing@example.co.uk", first_name: "Alan" }).values;
    expect(diffProfile(current, changes)).toEqual(["email_address"]);
  });

  it("a resubmitted identical value is not a change (no needless write)", () => {
    expect(diffProfile(current, ok({ first_name: "Alan" }).values)).toEqual([]);
  });

  it("a differently FORMATTED but identical mobile is not a change", () => {
    // Dentally stores "07834 123456"; the form posts "+447834123456". Same number.
    expect(diffProfile(current, ok({ mobile_phone: "+447834123456" }).values)).toEqual([]);
  });

  it("clearing a field that has a value IS a change", () => {
    expect(diffProfile(current, ok({ email_address: "" }).values)).toEqual(["email_address"]);
  });

  it("clearing a field that is already empty is NOT a change", () => {
    expect(diffProfile(current, ok({ address_line_2: "" }).values)).toEqual([]);
  });

  it("a field the caller never sent is never in the diff", () => {
    expect(diffProfile(current, ok({ email_address: "x@y.co.uk" }).values)).not.toContain("last_name");
  });

  it("the payload is rebuilt from the diff, not from the caller's object", () => {
    const changes = ok({ first_name: "Alan", email_address: "a.turing@example.co.uk" }).values;
    const changed = diffProfile(current, changes);
    expect(buildUpdatePayload(changes, changed)).toEqual({ email_address: "a.turing@example.co.uk" });
  });

  it("active never goes in the Dentally profile payload (the status service owns it)", () => {
    const changes = ok({ active: false, first_name: "Alan Mathison" }).values;
    const changed = diffProfile(current, changes);
    expect(changed.sort()).toEqual(["active", "first_name"]);
    expect(buildUpdatePayload(changes, changed)).toEqual({ first_name: "Alan Mathison" });
  });
});

describe("detectConflicts (concurrent edit)", () => {
  const current = canonicaliseProfile({ first_name: "Alan", email_address: "alan@example.co.uk" });

  it("no conflict when the form matches the record", () => {
    const expectedSnapshot = canonicaliseProfile({ first_name: "Alan", email_address: "alan@example.co.uk" });
    expect(detectConflicts(expectedSnapshot, current, ["email_address"])).toEqual([]);
  });

  it("conflict when someone else changed the SAME field first", () => {
    const stale = canonicaliseProfile({ first_name: "Alan", email_address: "old@example.co.uk" });
    expect(detectConflicts(stale, current, ["email_address"])).toEqual(["email_address"]);
  });

  it("no conflict when the other edit touched a DIFFERENT field", () => {
    const stale = canonicaliseProfile({ first_name: "Al", email_address: "alan@example.co.uk" });
    expect(detectConflicts(stale, current, ["email_address"])).toEqual([]);
  });
});

describe("audit record shape", () => {
  it("one row per changed field, carrying the before and after values", () => {
    const current = canonicaliseProfile({
      first_name: "Alan",
      email_address: "alan@example.co.uk",
      active: true,
    });
    const changes = ok({ first_name: "Alan Mathison", email_address: "", active: false }).values;
    const changed = diffProfile(current, changes);
    expect(buildAuditRows(current, changes, changed)).toEqual([
      { field: "first_name", from: "Alan", to: "Alan Mathison" },
      { field: "email_address", from: "alan@example.co.uk", to: "" },
      // `active` is deliberately absent: the status service writes its own entry.
    ]);
  });

  it("a field that had no prior value records from = null", () => {
    const current = canonicaliseProfile({});
    const changes = ok({ postcode: "N15 4AB" }).values;
    expect(buildAuditRows(current, changes, diffProfile(current, changes))).toEqual([
      { field: "postcode", from: null, to: "N15 4AB" },
    ]);
  });

  it("renders booleans and numbers as text, and a cleared value as an empty string", () => {
    expect(auditValue(true)).toBe("true");
    expect(auditValue(false)).toBe("false");
    expect(auditValue(47752)).toBe("47752");
    expect(auditValue(null)).toBe("");
  });
});
