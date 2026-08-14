// FP17 / PR consent + exemption declaration — domain types.
//
// ONE FACT SHAPES THIS WHOLE MODULE: no Dentally endpoint exists for any of it
// (/v1/consents, /v1/forms, /v1/nhs_exemptions, /v1/fp17s are all unmounted), so
// this is FULLY our-own-storage. It captures a patient's consent + NHS dental
// exemption declaration IN THIS PLATFORM. It is NOT submitted to the NHS (Compass)
// from here — /v1/nhs_claims is read for reporting only and is not a submission
// path. Every surface says so in plain words (see ./copy.ts).
//
// The exemption_category is one key from ./exemptions.ts (a free-treatment claim)
// or the literal "paying" opt-out, so a blank form is never mis-stored as exempt.

import type { Fp17ExemptionKey } from "./exemptions";

/** What the patient declared: one exemption claim, or the "I will pay" opt-out. */
export type Fp17DeclarationChoice = Fp17ExemptionKey | "paying";

/** How the signature was captured. `typed` is a full name; the others are images. */
export type SignatureMethod = "typed" | "drawn" | "ipad";

export interface Fp17Signature {
  method: SignatureMethod;
  /** Typed full name, or a data-URL for a drawn/iPad signature. Never a bucket URL. */
  value: string;
  /** ISO timestamp the patient signed. */
  signedAt: string;
}

/** The FRONT of the form: consent to the course of treatment + optional data sharing. */
export interface Fp17Consent {
  treatment: boolean;
  dataShare: boolean;
  signedAt: string | null;
}

/** Where a declaration was captured from. */
export type Fp17CapturedVia = "public-link" | "ipad";

/** Staff triage state for a captured declaration. */
export type Fp17Status = "new" | "reviewed" | "archived";

/** One stored fp17_declaration row, mapped to camelCase. */
export interface Fp17Declaration {
  id: string;
  clientId: string;
  siteId: string | null;
  /** Resolved from the signed link TOKEN on submit, never from the request body. */
  dentallyPatientId: string | null;
  patientName: string | null;
  dateOfBirth: string | null;
  consent: Fp17Consent | null;
  exemptionCategory: Fp17DeclarationChoice;
  exemptionEvidenceAck: boolean;
  declarationTruth: boolean;
  signature: Fp17Signature | null;
  capturedVia: Fp17CapturedVia;
  status: Fp17Status;
  createdAt: string;
}

/**
 * The list-safe view of a declaration: the signature VALUE is dropped (a drawn
 * data-URL is patient-identifying and heavy), leaving only method + signedAt so a
 * worklist can say "signed, typed, 14 Aug" without re-serving the image.
 */
export interface Fp17DeclarationSummary
  extends Omit<Fp17Declaration, "signature"> {
  signature: { method: SignatureMethod; signedAt: string } | null;
}
