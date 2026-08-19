import { describe, it, expect, afterEach, vi } from "vitest";
import {
  TITLES,
  FUNDING_OPTIONS,
  FUNDING_PLAN_IDS,
  knownTitle,
  genderFromTitle,
  genderToDentally,
  knownPaymentPlanId,
  canonicalDob,
  describeMissing,
  buildPatientRegistration,
  configuredDefaultPaymentPlanId,
} from "./patient-payload";

// ===========================================================================
// THE SHARED DERIVATION, TESTED DIRECTLY.
//
// Four call sites drive this module, and each has its own tests. Those prove the
// paths; they do not reach every rule here, because each site guards its own inputs
// before it ever gets this far. A mutation sweep on 2026-08-18 found exactly that:
// five rules below survived breaking, because no test in the codebase could see
// them through a call site. They are the cases this file exists for.
//
// Every number cited comes from the GET-only live probe of 2026-08-17 recorded in
// src/app/api/booking/create/live-calibration.test.ts. Nothing here writes anywhere.
// ===========================================================================

/** A complete input, so each case can knock out exactly one thing. */
function input(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Alex",
    lastName: "Patient",
    title: "Mr",
    dateOfBirth: "1990-03-14",
    funding: "NHS",
    email: "alex@example.com",
    phone: "+447700900123",
    dentallySiteId: "3286d822-68c5-48ff-b1a2-065780dfcd15",
    useSms: true,
    useEmail: true,
    now: new Date("2026-08-18T12:00:00Z"),
    ...overrides,
  };
}

describe("knownTitle", () => {
  it("accepts the five titles live data actually uses, in any casing or spacing", () => {
    for (const t of TITLES) {
      expect(knownTitle(t)).toBe(t);
      expect(knownTitle(t.toUpperCase())).toBe(t);
      expect(knownTitle(`  ${t.toLowerCase()}  `)).toBe(t);
    }
  });

  it("returns the CANONICAL spelling, never the caller's", () => {
    expect(knownTitle("mrs")).toBe("Mrs");
    expect(knownTitle("MASTER")).toBe("Master");
  });

  it("refuses Dr and Rev, which live data contains but which predict no sex", () => {
    // Live: Dr -> one male, one female. Rev -> one male. Admitting them would mean
    // writing a coin flip into a real patient record.
    for (const t of ["Dr", "Rev", "Prof", "Sir", "Mx", "Lady"]) expect(knownTitle(t)).toBeUndefined();
  });

  it("refuses every Object.prototype key, and empty input", () => {
    for (const t of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(knownTitle(t)).toBeUndefined();
    }
    expect(knownTitle("")).toBeUndefined();
    expect(knownTitle("   ")).toBeUndefined();
    expect(knownTitle(null)).toBeUndefined();
    expect(knownTitle(undefined)).toBeUndefined();
  });
});

describe("genderFromTitle", () => {
  it("follows the live majority for each of the five, as a BOOLEAN", () => {
    // Mr 227/232 true, Master 23/23 true, Mrs 0/58, Miss 0/157, Ms 0/172.
    expect(genderFromTitle("Mr")).toBe(true);
    expect(genderFromTitle("Master")).toBe(true);
    expect(genderFromTitle("Mrs")).toBe(false);
    expect(genderFromTitle("Miss")).toBe(false);
    expect(genderFromTitle("Ms")).toBe(false);
    for (const t of TITLES) expect(typeof genderFromTitle(t)).toBe("boolean");
  });

  it("encodes a stated sex the same way live does: true is male", () => {
    expect(genderToDentally("male")).toBe(true);
    expect(genderToDentally("female")).toBe(false);
  });
});

describe("knownPaymentPlanId", () => {
  it("maps only the two plans the practice offers online, by their live ids", () => {
    // PROBE: GET /v1/payment_plans, 15 active. 1 IS "NHS"; 2 IS "Private".
    expect(knownPaymentPlanId("NHS")).toBe(1);
    expect(knownPaymentPlanId("nhs")).toBe(1);
    expect(knownPaymentPlanId("  Private ")).toBe(2);
  });

  it("refuses a real plan of this practice that no screen offers", () => {
    // UDC (47752) is 37% of the 500 most recent live registrations — bigger than
    // Private. It stays unreachable until the owner chooses to offer it.
    for (const v of ["UDC", "47752", "Denplan A", "Practice Plan", "DEN", ""]) {
      expect(knownPaymentPlanId(v)).toBeUndefined();
    }
    expect(knownPaymentPlanId(null)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // THE TWO BELTS, and an honest note about testing them.
  //
  // The 2026-08-17 defect was `funding: "constructor"` returning the Object
  // constructor from a bare object-literal lookup: not `undefined`, so it passed the
  // caller's guard, became `payment_plan_id: <function>`, and was then DROPPED by
  // JSON.stringify — producing exactly the "payment_plan: seems to be missing" that
  // live 422s on, from one word posted by a stranger.
  //
  // Two independent guards now stand: the map has a null prototype, and the answer
  // must be a number. Either alone fixes it, which is the point — and which also
  // means NO INPUT can tell them apart while both stand. So the null prototype is
  // asserted structurally below, and the number guard is a deliberate second belt
  // that no behavioural test can isolate. That is recorded here rather than papered
  // over with a test that only appears to cover it.
  // -------------------------------------------------------------------------
  it("keeps the null prototype that is the first belt", () => {
    expect(Object.getPrototypeOf(FUNDING_PLAN_IDS)).toBeNull();
    // And it is frozen, so nothing can graft a prototype or a plan onto it later.
    expect(Object.isFrozen(FUNDING_PLAN_IDS)).toBe(true);
  });

  it("answers a number or nothing at all, for every input including prototype keys", () => {
    const inputs = ["nhs", "private", "constructor", "toString", "valueOf", "__proto__", "isPrototypeOf", "UDC", ""];
    for (const v of inputs) {
      const out = knownPaymentPlanId(v);
      expect(out === undefined || typeof out === "number", `"${v}" answered ${typeof out}`).toBe(true);
      // The failure mode was a value that SURVIVED a `=== undefined` guard and then
      // vanished on the wire. Anything that does not survive JSON is the bug.
      if (out !== undefined) expect(JSON.parse(JSON.stringify({ id: out }))).toEqual({ id: out });
    }
  });

  it("offers exactly the plans a form or a staff member may choose", () => {
    expect(FUNDING_OPTIONS.map((o) => o.value)).toEqual(["nhs", "private"]);
    for (const o of FUNDING_OPTIONS) expect(knownPaymentPlanId(o.value)).toBeTypeOf("number");
  });
});

describe("canonicalDob", () => {
  it("accepts the date-only shape live carries on 100% of 800 probed records", () => {
    expect(canonicalDob("1990-03-14")).toBe("1990-03-14");
    expect(canonicalDob("  1968-11-11  ")).toBe("1968-11-11");
  });

  it("refuses a date that is REGEX-SHAPED but is not a real day", () => {
    // THE GAP A MUTATION SWEEP FOUND. Every existing case used an out-of-RANGE
    // month or day (1990-13-40), which the cheap bounds check already catches — so
    // deleting the UTC round trip broke nothing any test could see. These are the
    // dates only the round trip rejects: in range, and not days that exist.
    for (const d of [
      "2001-02-30",
      "1990-02-31",
      "2026-02-29", // 2026 is not a leap year
      "1900-02-29", // nor is 1900: a century year not divisible by 400
      "2025-04-31",
      "2025-06-31",
      "2025-09-31",
      "2025-11-31",
    ]) {
      expect(canonicalDob(d), `${d} is not a real day`).toBeNull();
    }
  });

  it("keeps the leap days that DO exist", () => {
    expect(canonicalDob("2024-02-29")).toBe("2024-02-29");
    expect(canonicalDob("2000-02-29")).toBe("2000-02-29"); // divisible by 400
  });

  it("refuses out-of-range parts, junk, and anything that is not date-only", () => {
    for (const d of [
      "1990-13-14",
      "1990-00-14",
      "1990-03-00",
      "1990-03-32",
      "last tuesday",
      "14/03/1990",
      "1990-3-4",
      "1990-03-14T00:00:00Z", // live never carries a timestamp
      "1990-03-141",
      "1990-03-14Z",
      "",
    ]) {
      expect(canonicalDob(d), `${d} must be refused`).toBeNull();
    }
    expect(canonicalDob(null)).toBeNull();
    expect(canonicalDob(undefined)).toBeNull();
  });

  it("trims surrounding whitespace rather than refusing on it", () => {
    // A form value and a model's answer both arrive padded often enough that
    // refusing on a stray space would be a refusal about nothing.
    expect(canonicalDob(" 1990-03-14 ")).toBe("1990-03-14");
    expect(canonicalDob("\n1990-03-14\t")).toBe("1990-03-14");
  });
});

describe("describeMissing", () => {
  // Read by a person or by a model that speaks to STAFF, so it has to name the
  // fields in words rather than echoing wire keys. A mutation that replaced the
  // words with the raw field names survived every other test in the codebase.
  it("names each field in words a human can act on", () => {
    expect(describeMissing(["title"])).toBe("a title (Mr, Mrs, Miss, Ms or Master)");
    expect(describeMissing(["date_of_birth"])).toBe("a date of birth (YYYY-MM-DD)");
    expect(describeMissing(["payment_plan"])).toBe("how they are to be seen (NHS or Private)");
    expect(describeMissing(["first_name"])).toBe("a first name");
    expect(describeMissing(["last_name"])).toBe("a last name");
    expect(describeMissing(["gender"])).toBe("a sex");
  });

  it("joins several into one readable clause", () => {
    expect(describeMissing(["title", "date_of_birth"])).toBe(
      "a title (Mr, Mrs, Miss, Ms or Master) and a date of birth (YYYY-MM-DD)",
    );
    expect(describeMissing(["first_name", "title", "payment_plan"])).toBe(
      "a first name, a title (Mr, Mrs, Miss, Ms or Master) and how they are to be seen (NHS or Private)",
    );
  });

  it("never leaks a wire key into something a person reads", () => {
    const all = describeMissing(["first_name", "last_name", "title", "date_of_birth", "payment_plan", "gender"]);
    for (const key of ["first_name", "last_name", "date_of_birth", "payment_plan"]) {
      expect(all, `"${key}" is a wire key, not English`).not.toContain(key);
    }
  });

  it("is empty for an empty list, so a caller can tell there is nothing to say", () => {
    expect(describeMissing([])).toBe("");
  });
});

describe("buildPatientRegistration", () => {
  it("builds exactly what live accepts, with sex derived from the title", () => {
    const out = buildPatientRegistration(input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload).toEqual({
      first_name: "Alex",
      last_name: "Patient",
      title: "Mr",
      date_of_birth: "1990-03-14",
      payment_plan_id: 1,
      gender: true,
      email_address: "alex@example.com",
      mobile_phone: "+447700900123",
      site_id: "3286d822-68c5-48ff-b1a2-065780dfcd15",
      use_sms: true,
      use_email: true,
    });
  });

  it("leaves an absent contact field OFF the payload rather than sending null", () => {
    const out = buildPatientRegistration(input({ email: null, phone: "" }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload).not.toHaveProperty("email_address");
    expect(out.payload).not.toHaveProperty("mobile_phone");
    // Live treats an explicit null as a value, so absence has to mean absence.
    expect(JSON.parse(JSON.stringify(out.payload))).not.toHaveProperty("email_address");
  });

  it("prefers a stated sex over the title derivation", () => {
    const out = buildPatientRegistration(input({ title: "Mr", gender: "female" }));
    expect(out.ok && out.payload.gender).toBe(false);
    const back = buildPatientRegistration(input({ title: "Mrs", gender: "male" }));
    expect(back.ok && back.payload.gender).toBe(true);
  });

  it("takes a caller-resolved plan id when there is no funding name", () => {
    const out = buildPatientRegistration(input({ funding: undefined, paymentPlanId: 47752 }));
    expect(out.ok && out.payload.payment_plan_id).toBe(47752);
  });

  it("refuses a plan id that is not a positive whole number", () => {
    // THE GAP A MUTATION SWEEP FOUND. Both live callers hand this a value that was
    // already validated somewhere else, so the guard was never exercised. An id is
    // what live keys a plan by; 0, a negative, a fraction or a NaN is a nonsense
    // write, not a plan.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      const out = buildPatientRegistration(input({ funding: undefined, paymentPlanId: bad }));
      expect(out.ok, `paymentPlanId ${String(bad)} must be refused`).toBe(false);
      if (out.ok) continue;
      expect(out.missing).toContain("payment_plan");
    }
  });

  it("lets a recognised funding NAME win over a caller-supplied id", () => {
    const out = buildPatientRegistration(input({ funding: "Private", paymentPlanId: 999 }));
    expect(out.ok && out.payload.payment_plan_id).toBe(2);
  });

  it.each([
    ["title", { title: undefined }, ["title", "gender"]],
    ["date of birth", { dateOfBirth: undefined }, ["date_of_birth"]],
    ["funding", { funding: undefined }, ["payment_plan"]],
    ["first name", { firstName: "  " }, ["first_name"]],
    ["last name", { lastName: null }, ["last_name"]],
  ])("refuses without a %s, and names it", (_label, override, expected) => {
    const out = buildPatientRegistration(input(override));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.missing).toEqual(expected);
    expect(out.reason).toContain(describeMissing(expected as never));
  });

  it("names gender alongside title, exactly as the live 422 listed them", () => {
    // Sex is derived from the title, so a missing title takes it down too — and the
    // caller is told to ask for the title, which is the thing a person can supply.
    const out = buildPatientRegistration(input({ title: undefined }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.missing).toEqual(["title", "gender"]);
  });

  it("does not name gender when the caller stated one, even with no title", () => {
    const out = buildPatientRegistration(input({ title: undefined, gender: "female" }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.missing).toEqual(["title"]);
  });

  it("names EVERY missing field at once, the way live's 422 did", () => {
    const out = buildPatientRegistration({
      firstName: "",
      lastName: "",
      title: undefined,
      dateOfBirth: undefined,
      dentallySiteId: "site-uuid",
      useSms: true,
      useEmail: true,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.missing).toEqual(["first_name", "last_name", "date_of_birth", "title", "payment_plan", "gender"]);
  });

  it("treats a future or implausible date of birth as ABSENT, not as a value to send", () => {
    // Live would accept 2999-01-01 without complaint and the practice would inherit
    // a record nobody can explain.
    for (const dateOfBirth of ["2999-01-01", "2026-08-19", "1850-01-01"]) {
      const out = buildPatientRegistration(input({ dateOfBirth }));
      expect(out.ok, `${dateOfBirth} must be refused`).toBe(false);
      if (out.ok) continue;
      expect(out.missing).toContain("date_of_birth");
    }
  });

  it("puts the age boundary exactly at 120, inclusive", () => {
    // The oldest verified human was 122; past 120 a date of birth is a typo, not a
    // patient. The boundary is asserted on both sides so it cannot drift by a year.
    const now = new Date("2026-08-18T12:00:00Z");
    expect(buildPatientRegistration(input({ dateOfBirth: "2026-08-18", now })).ok, "born today").toBe(true);
    expect(buildPatientRegistration(input({ dateOfBirth: "1906-08-18", now })).ok, "exactly 120").toBe(true);
    expect(buildPatientRegistration(input({ dateOfBirth: "1906-08-19", now })).ok, "119, turns 120 tomorrow").toBe(true);
    expect(buildPatientRegistration(input({ dateOfBirth: "1905-08-18", now })).ok, "121").toBe(false);
  });

  it("re-derives whitelisted values rather than trusting the caller", () => {
    // Two of the four callers are driven by a language model and one is public and
    // unauthenticated, so a value that arrived pre-checked is checked again.
    for (const bad of [{ title: "constructor" }, { funding: "constructor" }, { title: "Dr" }, { funding: "UDC" }]) {
      expect(buildPatientRegistration(input(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("trims names, and carries the canonical title casing through", () => {
    const out = buildPatientRegistration(input({ firstName: "  Alex ", lastName: " Patient  ", title: "mrs" }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.first_name).toBe("Alex");
    expect(out.payload.last_name).toBe("Patient");
    expect(out.payload.title).toBe("Mrs");
  });
});

describe("configuredDefaultPaymentPlanId", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null when the practice has not chosen one, which is production today", () => {
    vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "");
    expect(configuredDefaultPaymentPlanId()).toBeNull();
  });

  it("reads a deliberate positive whole number", () => {
    for (const [raw, want] of [
      ["1", 1],
      ["2", 2],
      ["  47752 ", 47752],
    ] as const) {
      vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", raw);
      expect(configuredDefaultPaymentPlanId()).toBe(want);
    }
  });

  it("refuses anything a deployment typo could produce, rather than inventing an id", () => {
    for (const raw of ["0", "-1", "1.5", "1e3", "NHS", "true", " ", "01x", "9007199254740993"]) {
      vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", raw);
      const out = configuredDefaultPaymentPlanId();
      expect(out === null || (Number.isSafeInteger(out) && out > 0), `"${raw}" answered ${String(out)}`).toBe(true);
      if (raw !== "9007199254740993") expect(out, `"${raw}" must not become a plan id`).toBeNull();
    }
  });
});
