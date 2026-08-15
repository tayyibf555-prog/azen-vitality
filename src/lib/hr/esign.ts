// Staff policy e-sign — PURE rules. No I/O, no Supabase, no React.
//
// ===========================================================================
// WHAT THIS FEATURE ACTUALLY PRODUCES. Read this before changing anything here,
// and keep the UI copy at the bottom of this file in step with it.
// ===========================================================================
//
// It produces EVIDENCE THAT A NAMED LOGIN, AT A RECORDED TIME, WAS SHOWN VERSION N
// OF A NAMED DOCUMENT AND AFFIRMED IT.
//
// It is NOT a qualified electronic signature. There is no witness. There is no
// identity verification beyond the practice's own login. The stored IP hash and user
// agent are WEAK corroboration and are labelled as such on every surface that shows
// them. Under the UK Electronic Communications Act 2000 an attestation of this kind
// is generally admissible, and it is materially stronger than a signed sheet in a
// folder that nobody can date, but the platform says what it is rather than implying
// more. Same posture the compliance module takes: decision support and an organiser,
// not legal advice.
//
// THE SIGNATURE BINDS TO THE VERSION, NOT TO THE POLICY. This is the single design
// decision that makes the record worth anything. If the practice publishes version 3
// of the infection control policy, everybody's version 2 signature remains a true
// record of what they were shown, and `outstandingPolicies` asks them to sign again
// rather than treating an affirmation of superseded wording as covering the new text.
// A system that silently carried the old signature forward would be producing false
// evidence, which is worse than producing none.
//
// The size caps are IMPORTED from lib/fp17/validate.ts rather than retyped, so the
// patient-facing and staff-facing capture surfaces cannot drift apart.

import { MAX_IMAGE_SIGNATURE, MAX_TYPED_SIGNATURE } from "@/lib/fp17/validate";
import { londonDayKey } from "@/lib/time/london";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/**
 * How a staff signature was captured.
 *
 * Deliberately NARROWER than the patient-facing `SignatureMethod` (which also has
 * 'ipad'): a member of staff signs at their own login on their own device, and an
 * "iPad in reception" capture would be a different act with different evidence value.
 * If that is ever wanted it should be added on purpose, not inherited.
 */
export type StaffSignatureMethod = "typed" | "drawn";

export interface StaffSignature {
  method: StaffSignatureMethod;
  /** A typed full name, or a data-URL for a drawn signature. Never a bucket URL. */
  value: string;
  /** ISO timestamp the person signed. */
  signedAt: string;
}

export interface StaffPolicy {
  id: string;
  clientId: string;
  /** Stable identity across versions, e.g. "infection-control". */
  slug: string;
  title: string;
  version: number;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  /** Set when superseded or withdrawn. A retired version is never deleted. */
  retiredAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface StaffPolicySignature {
  id: string;
  clientId: string;
  staffId: string;
  policyId: string;
  /** Denormalised: which VERSION was affirmed. */
  policyVersion: number;
  signature: StaffSignature;
  signedAt: string;
  /** Hashed, never the raw address. Weak corroboration, honestly labelled. */
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * The list-safe view: the signature VALUE is dropped, leaving method + signedAt.
 *
 * Straight from the FP17 discipline (lib/fp17/repository.ts toSummary): a drawn
 * signature is a heavy, identifying image and a worklist has no business re-serving
 * it to say "signed, drawn, 14 August".
 */
export interface StaffPolicySignatureSummary
  extends Omit<StaffPolicySignature, "signature"> {
  signature: { method: StaffSignatureMethod; signedAt: string };
}

export function toSignatureSummary(
  sig: StaffPolicySignature,
): StaffPolicySignatureSummary {
  const { signature, ...rest } = sig;
  return {
    ...rest,
    signature: { method: signature.method, signedAt: signature.signedAt },
  };
}

// ---------------------------------------------------------------------------
// Signature validation. The caps are fp17's, imported.
// ---------------------------------------------------------------------------

/** Re-exported so a caller reads one module, and so a test can pin the identity. */
export const SIGNATURE_TYPED_CAP = MAX_TYPED_SIGNATURE;
export const SIGNATURE_IMAGE_CAP = MAX_IMAGE_SIGNATURE;

const STAFF_SIGNATURE_METHODS: readonly StaffSignatureMethod[] = ["typed", "drawn"];

/** A drawn signature must actually be an inline image, not a link to somewhere else. */
const DATA_URL_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;

/**
 * Is this a signature we are willing to store?
 *
 * The predicate the brief names, and the one the route calls. Every rejection is a
 * separate, testable reason:
 *   - a method we recognise (typed or drawn),
 *   - a non-empty value,
 *   - within the shared cap for that method,
 *   - and, for a drawn one, an actual inline image data-URL. A "drawn" signature
 *     holding "https://example.com/sig.png" would store a REFERENCE to evidence
 *     rather than the evidence, and the reference can be changed by whoever controls
 *     that host after the fact.
 */
export function signatureIsValid(sig: unknown): sig is StaffSignature {
  if (!sig || typeof sig !== "object") return false;
  const s = sig as Partial<StaffSignature>;
  if (typeof s.method !== "string") return false;
  if (!(STAFF_SIGNATURE_METHODS as readonly string[]).includes(s.method)) return false;
  if (typeof s.value !== "string") return false;
  const value = s.value.trim();
  if (value === "") return false;
  if (s.method === "typed") {
    if (value.length > SIGNATURE_TYPED_CAP) return false;
  } else {
    if (s.value.length > SIGNATURE_IMAGE_CAP) return false;
    if (!DATA_URL_IMAGE.test(s.value)) return false;
  }
  if (typeof s.signedAt !== "string" || s.signedAt.trim() === "") return false;
  return true;
}

export type SignatureResult =
  | { ok: true; value: StaffSignature }
  | { ok: false; error: string };

/**
 * Validate + normalise what the browser posted into a storable signature.
 *
 * `signedAt` is stamped from the SERVER's clock (`nowIso`), never from the body: a
 * time the signer supplies is a time the signer chose, and the whole evidential
 * claim is "at a recorded time".
 */
export function validateSignatureInput(
  input: { method?: unknown; value?: unknown },
  nowIso: string,
): SignatureResult {
  const candidate = {
    method: input.method,
    value: typeof input.value === "string" ? input.value : "",
    signedAt: nowIso,
  };
  if (typeof candidate.method !== "string" || !(STAFF_SIGNATURE_METHODS as readonly string[]).includes(candidate.method)) {
    return { ok: false, error: "Please sign the policy before confirming." };
  }
  if (candidate.value.trim() === "") {
    return { ok: false, error: "Please sign the policy before confirming." };
  }
  const normalised: StaffSignature = {
    method: candidate.method as StaffSignatureMethod,
    // A typed name is trimmed; a data-URL is stored byte for byte (trimming inside a
    // base64 payload would corrupt it, and the cap is checked against the raw length).
    value: candidate.method === "typed" ? candidate.value.trim() : candidate.value,
    signedAt: nowIso,
  };
  if (!signatureIsValid(normalised)) {
    return {
      ok: false,
      error: "That signature could not be accepted. Please sign again.",
    };
  }
  return { ok: true, value: normalised };
}

// ---------------------------------------------------------------------------
// Version binding.
// ---------------------------------------------------------------------------

/**
 * Does this signature affirm THIS version of THIS policy?
 *
 * Both halves matter. Matching only the policy id would treat a version 2 signature
 * as covering version 5. Matching only the version number would treat a signature on
 * the fire policy as covering the infection control policy.
 */
export function signatureBindsToVersion(
  sig: Pick<StaffPolicySignature, "policyId" | "policyVersion">,
  policy: Pick<StaffPolicy, "id" | "version">,
): boolean {
  return sig.policyId === policy.id && sig.policyVersion === policy.version;
}

/** The highest version number in force for a slug, or 0 when there is none. */
export function nextPolicyVersion(
  existing: readonly Pick<StaffPolicy, "slug" | "version">[],
  slug: string,
): number {
  let highest = 0;
  for (const p of existing) {
    if (p.slug !== slug) continue;
    if (p.version > highest) highest = p.version;
  }
  return highest + 1;
}

/**
 * Whether a version has been WITHDRAWN as of a given London day.
 *
 * `retiredAt` CAN BE IN THE FUTURE, and treating it as a plain boolean is the
 * bug this exists to stop. Publishing v2 "effective 1 September" retires v1 on
 * 1 September — not on the afternoon the manager uploaded the file. If v1 were
 * read as withdrawn the moment v2 was created, the slug would have NO version
 * in force for the whole gap: it vanishes from the signatures tab,
 * `outstandingPolicies` stops asking anyone to sign, and somebody who owed a
 * signature on v1 shows as owing nothing.
 *
 * One rule, used by `currentPolicies` AND by the sign route, so the screen that
 * offers a version and the route that accepts the signature can never disagree
 * about whether it is still live.
 *
 * An unreadable stamp is treated as withdrawn: fail closed, because the only
 * other option is offering a document whose status we cannot establish.
 */
export function policyWithdrawn(
  policy: Pick<StaffPolicy, "retiredAt">,
  todayKey: string,
): boolean {
  if (!policy.retiredAt) return false;
  const ms = Date.parse(policy.retiredAt);
  if (Number.isNaN(ms)) return true;
  return londonDayKey(new Date(ms)) <= todayKey;
}

/**
 * The version of each policy that is IN FORCE on a given day: the highest version
 * that is not retired and whose effective_from has arrived.
 *
 * A future-dated version is deliberately not in force yet — a practice publishing
 * "effective 1 September" must not have staff asked to sign it in August, or the
 * record says people affirmed a policy before it existed.
 */
export function currentPolicies(
  policies: readonly StaffPolicy[],
  todayKey: string,
): StaffPolicy[] {
  const bySlug = new Map<string, StaffPolicy>();
  for (const p of policies) {
    if (policyWithdrawn(p, todayKey)) continue;
    if (p.effectiveFrom > todayKey) continue; // ISO date keys compare lexicographically
    const held = bySlug.get(p.slug);
    if (!held || p.version > held.version) bySlug.set(p.slug, p);
  }
  return [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * What this person still has to sign.
 *
 * A policy is outstanding when it is in force today and this person holds no
 * signature binding to that exact version. Signatures for OTHER people must be
 * filtered out by the caller (the repository reads them per staff member); this
 * function does not know whose signatures it was handed, and asserting otherwise
 * would be a silent authorisation decision buried in a pure helper.
 */
export function outstandingPolicies(
  policies: readonly StaffPolicy[],
  signatures: readonly Pick<StaffPolicySignature, "policyId" | "policyVersion">[],
  todayKey: string,
): StaffPolicy[] {
  const inForce = currentPolicies(policies, todayKey);
  return inForce.filter(
    (policy) => !signatures.some((sig) => signatureBindsToVersion(sig, policy)),
  );
}

/**
 * Compliance's mirror of the above: for one policy version, who has signed and who
 * has not. Staff are supplied by the caller so this stays pure.
 */
export function signingProgress<S extends { id: string }>(
  policy: Pick<StaffPolicy, "id" | "version">,
  staff: readonly S[],
  signatures: readonly Pick<StaffPolicySignature, "staffId" | "policyId" | "policyVersion">[],
): { signed: S[]; outstanding: S[] } {
  const signedIds = new Set(
    signatures.filter((s) => signatureBindsToVersion(s, policy)).map((s) => s.staffId),
  );
  const signed: S[] = [];
  const outstanding: S[] = [];
  for (const person of staff) {
    if (signedIds.has(person.id)) signed.push(person);
    else outstanding.push(person);
  }
  return { signed, outstanding };
}

// ---------------------------------------------------------------------------
// Policy identity.
// ---------------------------------------------------------------------------

export const MAX_POLICY_TITLE = 160;
export const MAX_POLICY_SLUG = 60;

/**
 * A policy slug from its title: lower case, dashes, nothing exotic. Deterministic,
 * because the slug is the identity a signature's version binds through.
 */
export function policySlugFromTitle(title: unknown): string {
  const raw = typeof title === "string" ? title : "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_POLICY_SLUG)
    .replace(/-+$/g, "");
}

export function isValidPolicySlug(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= MAX_POLICY_SLUG &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)
  );
}

// ---------------------------------------------------------------------------
// Corroboration. Hashed, never raw.
// ---------------------------------------------------------------------------

/**
 * A stable, salted-per-client hash of the signer's IP.
 *
 * The raw address is never stored: it is personal data with no evidential value on
 * its own, and a hash answers the only question ever actually asked of it ("were
 * these two signatures made from the same place"). Deterministic so that question
 * stays answerable, and per-client so one practice's hashes cannot be matched against
 * another's.
 *
 * This is WEAK corroboration. It is not identity verification and the copy below
 * says so.
 */
export function hashIp(ip: unknown, clientId: string): string | null {
  if (typeof ip !== "string" || ip.trim() === "" || ip === "unknown") return null;
  const input = `${clientId}:${ip.trim()}`;
  // Small, dependency-free FNV-1a. A cryptographic hash would imply a security
  // property this value does not have and does not need: the point is that the raw
  // address is not retained, not that the digest resists a determined attacker who
  // already holds the database.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, "0")}`;
}

/** Bound so a hostile header cannot write a novel into the evidence row. */
export const MAX_USER_AGENT = 300;

export function trimUserAgent(ua: unknown): string | null {
  if (typeof ua !== "string") return null;
  const v = ua.trim().slice(0, MAX_USER_AGENT);
  return v === "" ? null : v;
}

// ---------------------------------------------------------------------------
// Copy. It lives beside the rules ON PURPOSE: the honest caveats and the code that
// makes them true must not drift apart, and a reviewer reading either sees both.
// ---------------------------------------------------------------------------

export const ESIGN_COPY = {
  /** Shown above every signing surface. This is the claim, in full. */
  whatThisIs:
    "Signing here records that you, signed in as yourself, were shown this version of this document at this time and confirmed it.",
  /** Shown with it, always. Never render one without the other. */
  whatThisIsNot:
    "This is not a witnessed signature and it is not a qualified electronic signature. The practice's own login is the only check on who you are. The time, and a rough note of the device and connection used, are recorded as supporting detail only.",
  versionBinding:
    "Your signature is recorded against this exact version. If the practice issues a new version, it will appear here for you to read and sign again.",
  managerNote:
    "This is a record keeping tool, not legal advice. It gives the practice dated evidence that each person was shown a named version of a policy and confirmed it. If you need witnessed or identity checked signatures, that is a different arrangement and this does not provide it.",
  corroborationNote:
    "The connection and device details stored alongside a signature are weak supporting detail. They are not proof of identity.",
  retiredNote:
    "Retired versions are kept, never deleted. People signed them, and the record of what they were shown is the point.",
  switchedOff:
    "Policy signing is switched off for this practice. An owner can turn it on in System controls once the practice has agreed the wording.",
  readFailed:
    "The policy library could not be read just now, so nothing is being shown. This is not an empty library: please try again, and tell the practice if it keeps happening.",
  notReady:
    "The policy library is not set up on this environment yet. Once the practice's storage is connected, published policies will appear here.",
  noStaffRecord:
    "Your login is not linked to a staff record, so there is nothing here to sign. Ask the practice manager to link it.",
} as const;
