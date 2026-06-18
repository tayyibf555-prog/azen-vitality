import { DentallyClient } from "@/lib/dentally/client";
import { toOpportunity, type DentallyPlanInput } from "@/lib/dentally/normalise";
import { rankOpportunities } from "@/lib/coordinator/scoring";
import {
  getSyncState,
  setSyncState,
  upsertOpportunities,
} from "@/lib/coordinator/repository";
import { SITES } from "@/lib/mock/clients";

export const dynamic = "force-dynamic";

const RESOURCE = "treatment_plans";
const PER_PAGE = 100;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
//
// Every assumption about the raw Dentally JSON shape lives in THIS block. When
// real sandbox responses are available, adjust the helpers below to match the
// actual field names/paths — nothing outside this block should need to change.
//
// Raw shapes are typed loosely (Record<string, unknown>) and narrowed with the
// small `pick*` helpers so we never reach for `any`.
//
// Known unknowns to verify on calibration:
//   - treatment_plans[]   -> plan id, name, value, accepted_at, patient_id
//   - patients/:id        -> first_name, last_name, contact_details, marketing
//   - payment_plans[]     -> how "amount outstanding" is represented/summed
// ===========================================================================

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value && typeof value === "object" ? (value as Raw) : {};
}

function pickString(obj: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickNumber(obj: Raw, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

function pickBoolean(obj: Raw, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/** Patient id referenced by a treatment plan. */
function planPatientId(plan: Raw): string | undefined {
  return pickString(plan, "patient_id", "patientId");
}

/** ISO timestamp used as the high-water mark for incremental sync. */
function planUpdatedAt(plan: Raw): string | undefined {
  return pickString(plan, "updated_at", "updatedAt");
}

/** Map a raw treatment plan into the normaliser's `plan` sub-shape. */
function mapPlan(plan: Raw): DentallyPlanInput["plan"] {
  return {
    id: pickString(plan, "id") ?? "",
    name: pickString(plan, "name", "title", "description") ?? "Treatment plan",
    planned_private_treatment_value:
      pickNumber(
        plan,
        "planned_private_treatment_value",
        "total",
        "value",
        "fee",
      ) ?? 0,
    accepted_at:
      pickString(plan, "accepted_at", "acceptedAt", "created_at") ??
      new Date().toISOString(),
  };
}

/** Map a raw patient record into the normaliser's `patient` sub-shape. */
function mapPatient(patient: Raw, fallbackId: string): DentallyPlanInput["patient"] {
  const contact = asRecord(patient["contact_details"] ?? patient["contactDetails"]);
  return {
    id: pickString(patient, "id") ?? fallbackId,
    first_name: pickString(patient, "first_name", "firstName") ?? "",
    last_name: pickString(patient, "last_name", "lastName") ?? "",
    contact_details: {
      sms_marketing: pickBoolean(contact, "sms_marketing", "smsMarketing"),
      email_marketing: pickBoolean(contact, "email_marketing", "emailMarketing"),
    },
    marketing: pickBoolean(patient, "marketing"),
  };
}

/**
 * Derive the amount outstanding from the account/payment-plans payload.
 * Sums any per-plan outstanding balances; falls back to a single top-level
 * field if that is how the sandbox returns it.
 */
function deriveOutstanding(payload: { payment_plans: unknown[] }): number {
  const plans = Array.isArray(payload.payment_plans) ? payload.payment_plans : [];
  let total = 0;
  let sawAny = false;
  for (const raw of plans) {
    const pp = asRecord(raw);
    const amount = pickNumber(
      pp,
      "outstanding",
      "amount_outstanding",
      "balance",
      "outstanding_balance",
    );
    if (amount !== undefined) {
      total += amount;
      sawAny = true;
    }
  }
  if (sawAny) return total;
  // Fallback: a single top-level outstanding figure on the payload itself.
  return pickNumber(asRecord(payload), "outstanding", "amount_outstanding") ?? 0;
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
): Promise<{ siteId: string; pulled: number; upserted: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;

  const now = new Date();
  const opportunities = [];
  let highWaterMark = updatedAfter ?? null;
  let pulled = 0;
  let page = 1;

  // Page until a page returns fewer than PER_PAGE items.
  for (;;) {
    const res = await client.listTreatmentPlans({
      siteId,
      updatedAfter,
      page,
      perPage: PER_PAGE,
    });
    const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
    pulled += rawPlans.length;

    for (const rawPlan of rawPlans) {
      const plan = asRecord(rawPlan);
      const patientId = planPatientId(plan);

      let patient: DentallyPlanInput["patient"];
      let amountOutstanding = 0;
      if (patientId) {
        const patientRes = await client.getPatient(patientId);
        patient = mapPatient(asRecord(patientRes.patient), patientId);
        const outstandingRes = await client.getAccountOutstanding(patientId);
        amountOutstanding = deriveOutstanding(outstandingRes);
      } else {
        patient = mapPatient({}, "");
      }

      const input: DentallyPlanInput = {
        siteId,
        patient,
        plan: mapPlan(plan),
        amountOutstanding,
        lastTouchAt: null,
      };

      opportunities.push(toOpportunity(input, new Date()));

      const planUpdated = planUpdatedAt(plan);
      if (planUpdated && (!highWaterMark || planUpdated > highWaterMark)) {
        highWaterMark = planUpdated;
      }
    }

    if (rawPlans.length < PER_PAGE) break;
    page += 1;
  }

  const ranked = rankOpportunities(opportunities, now);
  await upsertOpportunities(ranked);
  await setSyncState(siteId, RESOURCE, highWaterMark ?? now.toISOString());

  return { siteId, pulled, upserted: ranked.length };
}

export async function POST() {
  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }

  const client = new DentallyClient({
    apiKey,
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });

  const perSite = [];
  for (const siteId of vitalitySiteIds()) {
    perSite.push(await syncSite(client, siteId));
  }

  return Response.json({ ok: true, perSite });
}
