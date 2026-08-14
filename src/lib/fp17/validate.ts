// Pure validation + normalisation for an FP17 / PR consent + exemption declaration.
//
// Mirrors onboarding/validate.ts: takes the raw fields a public form POSTs and
// returns either a cleaned, typed declaration or one error message. No I/O, no side
// effects — easy to unit test AND to mutation-test (each required check has a test
// that flips exactly that field and asserts the rejection).
//
// THE RULES, in the order they are checked (first failure wins):
//   1. Exactly one declaration choice — a known exemption key OR the "paying"
//      opt-out. A blank/unknown choice is refused so a form is never stored as
//      exempt-by-omission.
//   2. Consent to the course of treatment (the FRONT of the form) must be given.
//   3. For an EXEMPTION claim (not "paying"), the evidence acknowledgement must be
//      ticked — it is the penalty-charge acknowledgement that makes the claim
//      legally meaningful. Not required for "paying" (there is nothing to prove).
//   4. The declaration-truth tick must be given.
//   5. A signature is required: a known method with a non-empty, length-bounded value.
//
// Identity fields (name, date of birth) are OPTIONAL and length-bounded; the
// binding patient id comes from the signed link token on the server, never from here.

import { isDeclarationChoice, isExemptionKey, PAYING_KEY } from "./exemptions";
import type { SignatureMethod } from "./types";

export interface Fp17ValidateInput {
  exemptionCategory?: unknown;
  evidenceAck?: unknown;
  declarationTruth?: unknown;
  consentTreatment?: unknown;
  consentDataShare?: unknown;
  signatureMethod?: unknown;
  signatureValue?: unknown;
  patientName?: unknown;
  dateOfBirth?: unknown;
}

export interface Fp17ValidatedDeclaration {
  exemptionCategory: string;
  /** True when a free-treatment exemption was claimed; false for the "paying" opt-out. */
  isExemption: boolean;
  evidenceAck: boolean;
  declarationTruth: true;
  consent: { treatment: boolean; dataShare: boolean };
  signature: { method: SignatureMethod; value: string };
  patientName: string | null;
  dateOfBirth: string | null;
}

export type Fp17ValidateResult =
  | { ok: true; value: Fp17ValidatedDeclaration }
  | { ok: false; error: string };

const SIGNATURE_METHODS: readonly SignatureMethod[] = ["typed", "drawn", "ipad"];

// Length caps. This is a public, unauthenticated write into jsonb, so an unbounded
// value is a cheap DoS. A typed signature is a name; a drawn/iPad signature is a
// small PNG data-URL. The worklist never re-serves the signature VALUE (only method
// + signedAt), so the larger cap bounds storage abuse, not response size.
const MAX_TYPED_SIGNATURE = 120;
const MAX_IMAGE_SIGNATURE = 250_000; // ~250 KB data-URL, enough for a drawn signature
const MAX_NAME = 120;
const MAX_DOB = 40;

/** A truthy tick from a form: accepts boolean true or the canonical string markers. */
function isTicked(v: unknown): boolean {
  return v === true || v === "true" || v === "yes" || v === "on" || v === 1 || v === "1";
}

function trimStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isSignatureMethod(v: unknown): v is SignatureMethod {
  return typeof v === "string" && (SIGNATURE_METHODS as readonly string[]).includes(v);
}

/**
 * Validate + normalise a raw declaration. Pure.
 */
export function validateFp17Declaration(input: Fp17ValidateInput): Fp17ValidateResult {
  // 1. Declaration choice.
  const choice = input.exemptionCategory;
  if (!isDeclarationChoice(choice)) {
    return { ok: false, error: "Please choose one option: an exemption you are claiming, or that you will pay." };
  }
  const category = choice as string;
  const isExemption = isExemptionKey(category); // "paying" -> false

  // 2. Consent to treatment (the front of the form).
  if (!isTicked(input.consentTreatment)) {
    return { ok: false, error: "Please confirm you consent to the course of treatment." };
  }

  // 3. Evidence acknowledgement — required for an exemption claim only.
  const evidenceAck = isTicked(input.evidenceAck);
  if (isExemption && !evidenceAck) {
    return {
      ok: false,
      error: "Please confirm you understand you may be asked to show evidence of your entitlement.",
    };
  }

  // 4. Declaration-truth tick — always required.
  if (!isTicked(input.declarationTruth)) {
    return { ok: false, error: "Please confirm that the information you have given is correct." };
  }

  // 5. Signature.
  const method = input.signatureMethod;
  if (!isSignatureMethod(method)) {
    return { ok: false, error: "Please add your signature to the declaration." };
  }
  const value = trimStr(input.signatureValue);
  if (value === "") {
    return { ok: false, error: "Please add your signature to the declaration." };
  }
  const cap = method === "typed" ? MAX_TYPED_SIGNATURE : MAX_IMAGE_SIGNATURE;
  if (value.length > cap) {
    return { ok: false, error: "That signature could not be accepted, please try again." };
  }

  // Optional identity fields, length-bounded.
  const patientName = trimStr(input.patientName);
  if (patientName.length > MAX_NAME) {
    return { ok: false, error: "That name is too long." };
  }
  const dateOfBirth = trimStr(input.dateOfBirth);
  if (dateOfBirth.length > MAX_DOB) {
    return { ok: false, error: "That date of birth is not valid." };
  }

  return {
    ok: true,
    value: {
      exemptionCategory: category === PAYING_KEY ? PAYING_KEY : category,
      isExemption,
      // For "paying" there is nothing to prove, so store the ack as false rather than
      // carrying a stray true; for an exemption it is guaranteed true by check 3.
      evidenceAck: isExemption ? true : false,
      declarationTruth: true,
      consent: { treatment: true, dataShare: isTicked(input.consentDataShare) },
      signature: { method, value },
      patientName: patientName || null,
      dateOfBirth: dateOfBirth || null,
    },
  };
}
