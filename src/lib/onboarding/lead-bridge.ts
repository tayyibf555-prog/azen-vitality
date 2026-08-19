// Pure decision layer for the onboarding -> Speed-to-lead bridge.
//
// A completed onboarding form is a person who has just told the practice they want
// to join. Until now the submission was recorded and NOBODY was contacted: the row
// sat in the onboarding worklist and nothing chased it. This module decides, from
// the submitted contact details and the consent screen alone, whether that
// submission should also become a Speed-to-lead lead (which the existing SLA sweep
// then chases) and on which channel.
//
// No I/O, no clock, no env. The route does the writes; every rule lives here so it
// can be asserted directly.

import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";
import type { OnboardingConsent } from "./types";

/** Everything the decision needs, already normalised by the caller. */
export interface OnboardingLeadContact {
  firstName: string | null;
  lastName: string | null;
  /** E.164, or null when the submitted number did not normalise. */
  phone: string | null;
  /** Normalised address, or null when the submitted email did not normalise. */
  email: string | null;
  /** The consent screen's answers, or null when none were submitted. */
  consent: OnboardingConsent | null;
}

/** Why no lead was created. Each is a real, distinct reason, not a catch-all. */
export type LeadBridgeSkip =
  /** Nothing we could put in the worklist's "Contact <name>" row. */
  | "no_name"
  /** Neither a deliverable phone nor a deliverable email survived normalisation. */
  | "no_contact"
  /** They gave us a contact but withheld consent on every channel it could use. */
  | "no_consent";

export type LeadBridgeDecision =
  | { bridge: false; skip: LeadBridgeSkip }
  | { bridge: true; name: string; channel: LeadChannel; consent: LeadConsent };

/**
 * The lead's display name, or null when the form carried none.
 *
 * Both halves are optional on the form (a practice can disable either), so this
 * joins whatever is present and refuses only when nothing is.
 */
export function onboardingLeadName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const name = [firstName, lastName]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(" ");
  return name === "" ? null : name;
}

/**
 * Should this submission become a lead, and on what channel?
 *
 * CONSENT IS THE GATE, and it is the form's own explicit answer, never implied.
 * The Speed-to-lead intake route may imply consent from the act of enquiring
 * because its forms ask for nothing; the onboarding form puts a consent screen in
 * front of the patient and asks outright, so the stated answer decides. A lead
 * whose chosen channel is not consented would be picked up by the SLA sweep,
 * refused by contactLead's own consent check, and retired to 'lost' with a failed
 * attempt against their name: a worse record than never creating it.
 *
 * SMS is preferred over email when both are consented, because that is the channel
 * the whole pipeline is built around (the reply threads back through the inbound
 * webhook into the booking agent; email has no inbound leg yet).
 *
 * `consent.data` is deliberately NOT part of this gate. It governs storing the
 * submission at all, which has already happened by the time the bridge runs, and
 * the form makes it a hard requirement before Submit is enabled. Reusing it here
 * would silently mean "no lead" for any future config that words that checkbox
 * differently, while adding no protection the channel gate does not already give.
 */
export function decideLeadBridge(contact: OnboardingLeadContact): LeadBridgeDecision {
  const name = onboardingLeadName(contact.firstName, contact.lastName);
  if (name === null) return { bridge: false, skip: "no_name" };

  const phone = contact.phone ?? null;
  const email = contact.email ?? null;
  if (!phone && !email) return { bridge: false, skip: "no_contact" };

  // Absent consent is NOT consent: a submission with no consent object at all is
  // treated exactly as one that ticked nothing.
  const smsConsented = contact.consent?.sms === true;
  const emailConsented = contact.consent?.email === true;

  const channel: LeadChannel | null =
    phone && smsConsented ? "sms" : email && emailConsented ? "email" : null;
  if (channel === null) return { bridge: false, skip: "no_consent" };

  // The recorded consent is the intersection of what they agreed to and what they
  // actually gave us, so a flag can never authorise a channel with no address on it.
  const consent: LeadConsent = {
    sms: smsConsented && phone !== null,
    email: emailConsented && email !== null,
    // The onboarding form does not ask about WhatsApp, and SMS consent is not
    // consent for a different app. Never inferred.
    whatsapp: false,
    // Marketing is its own opt-in on the consent screen and is only ever carried
    // through as stated. Registering is not a marketing opt-in.
    marketing: contact.consent?.marketing === true,
  };

  return { bridge: true, name, channel, consent };
}

/**
 * The `source` recorded on the lead, so the worklist and the ROI reports can tell
 * an onboarding registration from a web enquiry, and one named form from another.
 *
 * Mirrors the smile assessment's `smile:<campaignSlug>` / `smile-assessment` pair:
 * a named form (/onboard/<client>/<slug>) is attributed to its slug, and the legacy
 * practice-default flow (/onboard/<client>), which has no slug, gets the bare name.
 * Never returns a dangling `onboarding:` prefix with nothing after it.
 */
export function onboardingLeadSource(formSlug: string | null | undefined): string {
  const slug = (formSlug ?? "").trim();
  return slug === "" ? "onboarding" : `onboarding:${slug}`;
}
