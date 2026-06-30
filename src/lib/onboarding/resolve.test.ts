import { describe, it, expect } from "vitest";
import { resolveSteps, activeFieldKeys, DOCUMENTS_STEP } from "./resolve";
import { ONBOARDING_LIBRARY } from "./library";
import type { OnboardingConfig, OnboardingStep } from "./types";

/** All field keys across the resolved steps, in order (excludes the documents step). */
function keysOf(steps: OnboardingStep[]): string[] {
  return steps.flatMap((s) => s.fields.map((f) => f.key));
}

/** Find a field by key anywhere in the resolved steps. */
function fieldOf(steps: OnboardingStep[], key: string) {
  return steps.flatMap((s) => s.fields).find((f) => f.key === key);
}

const defaultEnabledKeys = ONBOARDING_LIBRARY.filter((q) => q.defaultEnabled).map((q) => q.key);

describe("resolveSteps — default (null/empty config)", () => {
  it("reproduces the default flow: every default-enabled library question, plus the documents step", () => {
    const steps = resolveSteps(null);
    const keys = keysOf(steps);
    // The default flow contains exactly the default-enabled library questions.
    for (const k of defaultEnabledKeys) expect(keys).toContain(k);
    expect(keys.length).toBe(defaultEnabledKeys.length);
    // Documents is always the last step and has no fields.
    expect(steps[steps.length - 1].id).toBe(DOCUMENTS_STEP.id);
    expect(steps[steps.length - 1].fields).toHaveLength(0);
  });

  it("an empty config behaves the same as null", () => {
    const empty: OnboardingConfig = { enabledKeys: [], required: {}, custom: [] };
    expect(keysOf(resolveSteps(empty))).toEqual(keysOf(resolveSteps(null)));
  });

  it("keeps the original required identity + contact + address + site + reason fields required", () => {
    const steps = resolveSteps(null);
    for (const k of [
      "first_name",
      "last_name",
      "date_of_birth",
      "phone",
      "email",
      "address_line1",
      "address_postcode",
      "site",
      "reason",
    ]) {
      expect(fieldOf(steps, k)?.required).toBe(true);
    }
    // And leaves the optional intake fields optional.
    for (const k of ["last_visit", "medical_conditions", "gp", "concerns", "heard_about"]) {
      expect(fieldOf(steps, k)?.required).toBe(false);
    }
  });

  it("never emits more than two fields per step", () => {
    for (const step of resolveSteps(null)) {
      expect(step.fields.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("resolveSteps — enabling/disabling library questions", () => {
  it("includes only the questions named in enabledKeys", () => {
    const config: OnboardingConfig = {
      enabledKeys: ["first_name", "email"],
      required: {},
      custom: [],
    };
    const keys = keysOf(resolveSteps(config));
    expect(keys).toEqual(["first_name", "email"]);
  });

  it("turns on an opt-in question that the default flow omits", () => {
    expect(keysOf(resolveSteps(null))).not.toContain("nervous_patient");
    const config: OnboardingConfig = {
      enabledKeys: ["first_name", "nervous_patient"],
      required: {},
      custom: [],
    };
    expect(keysOf(resolveSteps(config))).toContain("nervous_patient");
  });

  it("ignores unknown library keys in enabledKeys", () => {
    const config: OnboardingConfig = {
      enabledKeys: ["first_name", "totally-made-up"],
      required: {},
      custom: [],
    };
    expect(keysOf(resolveSteps(config))).toEqual(["first_name"]);
  });
});

describe("resolveSteps — required overrides", () => {
  it("applies a required override to a requirable question", () => {
    const config: OnboardingConfig = {
      enabledKeys: ["first_name", "last_visit"],
      // last_visit is requirable=false in the library, so the override must NOT take.
      // date_of_birth is requirable; flip it off via override.
      required: { last_visit: true },
      custom: [],
    };
    const steps = resolveSteps(config);
    expect(fieldOf(steps, "last_visit")?.required).toBe(false); // not requirable -> stays optional
  });

  it("lets the owner make a requirable question optional and vice versa", () => {
    const onConfig: OnboardingConfig = {
      enabledKeys: ["date_of_birth"],
      required: { date_of_birth: false },
      custom: [],
    };
    expect(fieldOf(resolveSteps(onConfig), "date_of_birth")?.required).toBe(false);

    const offConfig: OnboardingConfig = {
      enabledKeys: ["preferred_contact"],
      // preferred_contact is requirable=false; the override is ignored.
      required: { preferred_contact: true },
      custom: [],
    };
    expect(fieldOf(resolveSteps(offConfig), "preferred_contact")?.required).toBe(false);
  });
});

describe("resolveSteps — custom questions", () => {
  const config: OnboardingConfig = {
    enabledKeys: ["first_name"],
    required: {},
    custom: [
      {
        key: "custom-favourite-time",
        label: "Best time of day to call?",
        type: "text",
        required: true,
        category: "preferences",
      },
      {
        key: "custom-referral-code",
        label: "Referral code",
        type: "text",
        required: false,
        category: "marketing",
      },
    ],
  };

  it("includes custom questions in the resolved steps", () => {
    const keys = keysOf(resolveSteps(config));
    expect(keys).toContain("custom-favourite-time");
    expect(keys).toContain("custom-referral-code");
  });

  it("carries each custom question's own required flag", () => {
    const steps = resolveSteps(config);
    expect(fieldOf(steps, "custom-favourite-time")?.required).toBe(true);
    expect(fieldOf(steps, "custom-referral-code")?.required).toBe(false);
  });

  it("still ends with the documents step and respects the 1-2 fields per step rule", () => {
    const steps = resolveSteps(config);
    expect(steps[steps.length - 1].id).toBe(DOCUMENTS_STEP.id);
    for (const step of steps) expect(step.fields.length).toBeLessThanOrEqual(2);
  });
});

describe("activeFieldKeys", () => {
  it("returns the resolved field keys (no documents pseudo-fields)", () => {
    const config: OnboardingConfig = {
      enabledKeys: ["first_name", "email"],
      required: {},
      custom: [
        { key: "custom-x", label: "X", type: "text", required: false, category: "marketing" },
      ],
    };
    expect(activeFieldKeys(config)).toEqual(["first_name", "email", "custom-x"]);
  });

  it("matches keysOf for the default flow", () => {
    expect(activeFieldKeys(null)).toEqual(keysOf(resolveSteps(null)));
  });
});
