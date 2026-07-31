// ===========================================================================
// FUNDING: NHS, Private, UDC.
//
// Funding is a PATIENT-level fact, not an appointment-level one. An appointment
// payload carries no payment plan at all, so the diary resolves the day's
// distinct patients and reads the plan from the patient record.
//
// The codes are this practice's OWN live-calibrated payment plan ids, taken from
// src/lib/patient/profile.ts (PAYMENT_PLANS): 1 = NHS, 2 = Private, 47752 = UDC.
//
// A FOUR-way union, never a boolean. The whitelist is what we accept for WRITES
// and is not proof the practice has only three plans, so a real fourth plan id
// resolves to "unknown" rather than to private. Nothing is ever inferred: a
// patient we cannot resolve shows NOTHING at all, and "Private" is never a
// default.
//
// Staff-facing only. PRODUCT.md forbids the words NHS and private in anything a
// patient reads; the diary is a staff screen, so both are correct here.
// ===========================================================================

import { PAYMENT_PLANS } from "@/lib/patient/profile";

export type FundingCode = "nhs" | "private" | "udc" | "unknown";

/**
 * The staff-facing label. "unknown" is the EMPTY STRING on purpose: an
 * unresolvable patient must render nothing at all, and a label like "Unknown" or
 * a dash would be a mark on the block that a reader could mistake for a fact.
 */
export const FUNDING_LABEL: Record<FundingCode, string> = {
  nhs: "NHS",
  private: "Private",
  udc: "UDC",
  unknown: "",
};

/**
 * Plan id -> code, built from the exported PAYMENT_PLANS array rather than from a
 * second hand-written list, so the diary and the patient editor can never drift
 * about which id is which. (PLAN_IDS itself is module-private in profile.ts.)
 */
const PLAN_CODE: ReadonlyMap<number, FundingCode> = new Map<number, FundingCode>(
  PAYMENT_PLANS.map((p) => {
    const label = p.label.toLowerCase();
    const code: FundingCode = label === "nhs" ? "nhs" : label === "udc" ? "udc" : "private";
    return [p.id, code];
  }),
);

/**
 * The payment plan id on a raw Dentally patient object, or null when there is
 * none on file.
 *
 * Reads the FLAT `payment_plan_id` and the NESTED `payment_plan.id`, exactly as
 * canonicaliseProfile does: Dentally exposes it flat and some payloads nest it,
 * and assuming the mock's shape is the systemic failure this project has already
 * recorded once. Zero and absent both mean "no plan", not "plan zero".
 */
export function readPlanId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nested =
    r.payment_plan && typeof r.payment_plan === "object"
      ? (r.payment_plan as Record<string, unknown>).id
      : undefined;
  const planRaw = r.payment_plan_id ?? nested;
  if (planRaw === null || planRaw === undefined || planRaw === "") return null;
  const plan = typeof planRaw === "number" ? planRaw : Number(planRaw);
  return Number.isFinite(plan) && plan !== 0 ? plan : null;
}

/**
 * A plan id resolved to a funding code.
 *
 * An id outside this practice's whitelist is "unknown", NEVER "private". A
 * Denplan-style scheme rendered as private would put an orange rail on an NHS
 * patient's block, and the whole point of the rail is that it is trusted.
 */
export function fundingFromPlanId(planId: number | null): FundingCode {
  if (planId === null || !Number.isFinite(planId)) return "unknown";
  return PLAN_CODE.get(planId) ?? "unknown";
}

/** True when this code should draw a rail and print a word. */
export function fundingIsResolved(code: FundingCode): boolean {
  return code !== "unknown";
}
