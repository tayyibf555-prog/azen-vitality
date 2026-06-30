import { describe, it, expect } from "vitest";
import { parseSubmission } from "./validate";
import { ONBOARDING_STEPS, ONBOARDING_FIELD_KEYS } from "./steps";
import type { OnboardingStep } from "./types";

// A tiny self-contained step set so the validator tests don't move every time the
// real flow's copy changes. The shape tests below assert the real steps separately.
const TEST_STEPS: OnboardingStep[] = [
  {
    id: "name",
    title: "Name",
    fields: [{ key: "first_name", label: "First name", type: "text", required: true }],
  },
  {
    id: "contact",
    title: "Contact",
    fields: [
      { key: "phone", label: "Mobile number", type: "tel", required: true },
      { key: "email", label: "Email address", type: "email", required: true },
    ],
  },
  {
    id: "site",
    title: "Site",
    fields: [
      {
        key: "site",
        label: "Preferred practice",
        type: "select",
        required: true,
        options: [
          { value: "site-cc", label: "City Centre" },
          { value: "any", label: "Any" },
        ],
      },
    ],
  },
  {
    id: "notes",
    title: "Notes",
    fields: [{ key: "concerns", label: "Concerns", type: "textarea" }],
  },
];

describe("parseSubmission", () => {
  it("accepts and normalises a valid submission", () => {
    const r = parseSubmission(
      {
        first_name: "  Alex ",
        phone: "07700 900123",
        email: " Alex@Example.COM ",
        site: "site-cc",
        concerns: "  none really ",
      },
      TEST_STEPS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.first_name).toBe("Alex"); // trimmed
    expect(r.answers.email).toBe("alex@example.com"); // lowercased + trimmed
    expect(r.answers.phone).toBe("07700 900123");
    expect(r.answers.concerns).toBe("none really");
  });

  it("drops unknown / injected keys", () => {
    const r = parseSubmission(
      {
        first_name: "Alex",
        phone: "07700 900123",
        email: "a@b.co",
        site: "any",
        not_a_field: "ignore me",
        status: "registered", // must never come from the form
      },
      TEST_STEPS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers).not.toHaveProperty("not_a_field");
    expect(r.answers).not.toHaveProperty("status");
  });

  it("rejects when a required field is missing", () => {
    const r = parseSubmission(
      { phone: "07700 900123", email: "a@b.co", site: "any" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/First name/);
  });

  it("treats an empty/whitespace required field as missing", () => {
    const r = parseSubmission(
      { first_name: "   ", phone: "07700 900123", email: "a@b.co", site: "any" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a bad email", () => {
    const r = parseSubmission(
      { first_name: "Alex", phone: "07700 900123", email: "not-an-email", site: "any" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Email/);
  });

  it("rejects a bad phone number", () => {
    const r = parseSubmission(
      { first_name: "Alex", phone: "12", email: "a@b.co", site: "any" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Mobile number/);
  });

  it("rejects a select value that is not one of the options", () => {
    const r = parseSubmission(
      { first_name: "Alex", phone: "07700 900123", email: "a@b.co", site: "site-evil" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Preferred practice/);
  });

  it("allows an optional field to be omitted", () => {
    const r = parseSubmission(
      { first_name: "Alex", phone: "07700 900123", email: "a@b.co", site: "any" },
      TEST_STEPS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers).not.toHaveProperty("concerns");
  });

  it("rejects a non-object payload", () => {
    expect(parseSubmission(null, TEST_STEPS).ok).toBe(false);
    expect(parseSubmission("nope", TEST_STEPS).ok).toBe(false);
    expect(parseSubmission([1, 2], TEST_STEPS).ok).toBe(false);
  });

  it("validates a real submission against the real steps", () => {
    const r = parseSubmission(
      {
        first_name: "Alex",
        last_name: "Morgan",
        date_of_birth: "1990-04-12",
        phone: "07700 900123",
        email: "alex@example.com",
        address_line1: "12 High Street",
        address_postcode: "AB1 2CD",
        site: "site-rv",
        reason: "Routine check-up",
        heard_about: "google",
      },
      ONBOARDING_STEPS,
    );
    expect(r.ok).toBe(true);
  });
});

describe("ONBOARDING_STEPS shape", () => {
  it("has a warm, not-overwhelming number of steps", () => {
    expect(ONBOARDING_STEPS.length).toBeGreaterThanOrEqual(8);
    expect(ONBOARDING_STEPS.length).toBeLessThanOrEqual(12);
  });

  it("keeps each step to at most two fields (one or two questions per screen)", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.fields.length).toBeLessThanOrEqual(2);
    }
  });

  it("has unique, non-empty field keys", () => {
    const keys = ONBOARDING_FIELD_KEYS;
    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has unique step ids", () => {
    const ids = ONBOARDING_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every select field a non-empty options list", () => {
    for (const step of ONBOARDING_STEPS) {
      for (const f of step.fields) {
        if (f.type === "select") {
          expect(f.options && f.options.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("collects required identity + contact fields", () => {
    const required = ONBOARDING_STEPS.flatMap((s) => s.fields)
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(required).toEqual(
      expect.arrayContaining([
        "first_name",
        "last_name",
        "date_of_birth",
        "phone",
        "email",
        "address_line1",
        "address_postcode",
        "site",
        "reason",
      ]),
    );
  });
});
