import { describe, it, expect } from "vitest";
import {
  decideLeadBridge,
  onboardingLeadName,
  onboardingLeadSource,
  type OnboardingLeadContact,
} from "./lead-bridge";
import type { OnboardingConsent } from "./types";

// The pure rules behind the onboarding -> Speed-to-lead bridge. Every one of these
// decides whether a real person who registered gets chased, and on which channel,
// so each is asserted directly rather than through the route.

function consent(over: Partial<OnboardingConsent> = {}): OnboardingConsent {
  return { sms: false, email: false, marketing: false, data: true, ...over };
}

function contact(over: Partial<OnboardingLeadContact> = {}): OnboardingLeadContact {
  return {
    firstName: "Amira",
    lastName: "Khan",
    phone: "+447700900123",
    email: "amira@example.com",
    consent: consent({ sms: true, email: true }),
    ...over,
  };
}

describe("onboardingLeadName", () => {
  it("joins the two halves", () => {
    expect(onboardingLeadName("Amira", "Khan")).toBe("Amira Khan");
  });

  it("accepts either half alone, because a practice can disable the other", () => {
    expect(onboardingLeadName("Amira", null)).toBe("Amira");
    expect(onboardingLeadName(null, "Khan")).toBe("Khan");
  });

  it("trims, so a stray space does not become part of the worklist row", () => {
    expect(onboardingLeadName("  Amira ", " Khan  ")).toBe("Amira Khan");
  });

  it("is null when there is no name at all, including whitespace-only", () => {
    expect(onboardingLeadName(null, null)).toBeNull();
    expect(onboardingLeadName("", "")).toBeNull();
    expect(onboardingLeadName("   ", "\t")).toBeNull();
  });
});

describe("decideLeadBridge: who becomes a lead", () => {
  it("bridges a consented registration and prefers SMS", () => {
    const d = decideLeadBridge(contact());
    expect(d).toEqual({
      bridge: true,
      name: "Amira Khan",
      channel: "sms",
      consent: { sms: true, email: true, whatsapp: false, marketing: false },
    });
  });

  it("falls back to email when SMS is not consented", () => {
    const d = decideLeadBridge(contact({ consent: consent({ sms: false, email: true }) }));
    expect(d.bridge && d.channel).toBe("email");
  });

  it("falls back to email when there is no phone, even with SMS consent ticked", () => {
    // A consent flag is not an address. Choosing sms here would create a lead the
    // sweep can never deliver.
    const d = decideLeadBridge(contact({ phone: null, consent: consent({ sms: true, email: true }) }));
    expect(d.bridge && d.channel).toBe("email");
    expect(d.bridge && d.consent.sms).toBe(false);
  });

  it("uses SMS when there is no email, even with email consent ticked", () => {
    const d = decideLeadBridge(contact({ email: null, consent: consent({ sms: true, email: true }) }));
    expect(d.bridge && d.channel).toBe("sms");
    expect(d.bridge && d.consent.email).toBe(false);
  });
});

describe("decideLeadBridge: who does NOT", () => {
  it("refuses with no name", () => {
    expect(decideLeadBridge(contact({ firstName: null, lastName: null }))).toEqual({
      bridge: false,
      skip: "no_name",
    });
  });

  it("refuses with no deliverable contact", () => {
    expect(decideLeadBridge(contact({ phone: null, email: null }))).toEqual({
      bridge: false,
      skip: "no_contact",
    });
  });

  it("refuses when they gave a contact but consented to nothing", () => {
    // The whole point of the consent screen. contactLead would retire this lead to
    // 'lost' with a failed attempt on their record; better never to create it.
    expect(decideLeadBridge(contact({ consent: consent() }))).toEqual({
      bridge: false,
      skip: "no_consent",
    });
  });

  it("treats an ABSENT consent object as consent to nothing, not as consent", () => {
    expect(decideLeadBridge(contact({ consent: null }))).toEqual({
      bridge: false,
      skip: "no_consent",
    });
  });

  it("refuses a phone-only registration that withheld SMS consent", () => {
    expect(
      decideLeadBridge(contact({ email: null, consent: consent({ sms: false, email: true }) })),
    ).toEqual({ bridge: false, skip: "no_consent" });
  });

  it("checks the name before anything else, so a nameless submission is never mislabelled", () => {
    expect(decideLeadBridge(contact({ firstName: null, lastName: null, phone: null, email: null })))
      .toEqual({ bridge: false, skip: "no_name" });
  });
});

describe("decideLeadBridge: the consent it records", () => {
  it("never infers WhatsApp from SMS consent", () => {
    const d = decideLeadBridge(contact());
    expect(d.bridge && d.consent.whatsapp).toBe(false);
  });

  it("carries marketing through only when it was actually ticked", () => {
    const off = decideLeadBridge(contact());
    expect(off.bridge && off.consent.marketing).toBe(false);
    const on = decideLeadBridge(
      contact({ consent: consent({ sms: true, email: true, marketing: true }) }),
    );
    expect(on.bridge && on.consent.marketing).toBe(true);
  });

  it("does not read `data` consent as permission to contact", () => {
    // data: true is required to submit at all, and says nothing about channels.
    expect(decideLeadBridge(contact({ consent: consent({ data: true }) })).bridge).toBe(false);
  });

  it("does not treat a truthy non-true value as consent", () => {
    const sneaky = { sms: "yes", email: 1, marketing: "true", data: true } as unknown as OnboardingConsent;
    expect(decideLeadBridge(contact({ consent: sneaky }))).toEqual({
      bridge: false,
      skip: "no_consent",
    });
  });
});

describe("onboardingLeadSource", () => {
  it("attributes a named form to its slug", () => {
    expect(onboardingLeadSource("implants")).toBe("onboarding:implants");
  });

  it("names the legacy practice-default flow without a dangling prefix", () => {
    expect(onboardingLeadSource(null)).toBe("onboarding");
    expect(onboardingLeadSource(undefined)).toBe("onboarding");
    expect(onboardingLeadSource("")).toBe("onboarding");
    expect(onboardingLeadSource("   ")).toBe("onboarding");
  });

  it("is always distinguishable from a web enquiry, whichever flow it came from", () => {
    for (const slug of [null, "implants", "whitening"]) {
      expect(onboardingLeadSource(slug).startsWith("onboarding")).toBe(true);
      expect(onboardingLeadSource(slug)).not.toBe("web");
    }
  });
});
