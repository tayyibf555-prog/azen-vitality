import { DentallyClient } from "@/lib/dentally/client";
import { toOpportunity, type DentallyPlanInput } from "@/lib/dentally/normalise";
import { rankOpportunities } from "@/lib/coordinator/scoring";
import {
  getSyncState,
  setSyncState,
  upsertOpportunities,
} from "@/lib/coordinator/repository";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
// Calibrated against the local mock at src/app/api/mock-dentally (which mirrors
// the real Dentally response shapes). Field paths confirmed:
//   - treatment_plans[] -> id, name, patient_id, planned_private_treatment_value,
//       amount_outstanding (MOCK source for outstanding — see note below),
//       accepted_at, updated_at (high-water mark).
//   - patients/:id      -> id, first_name, last_name, and the consent fields
//       use_sms / use_email (boolean) + marketing (integer 0/1). These mirror
//       the real Dentally patient object exactly.
//   - payment_plans[]   -> NOT used for the amount. We prefer the plan's
//       amount_outstanding directly (see MOCK SIMPLIFICATION below). The call
//       is dropped to avoid an extra round-trip per patient.
//
// MOCK SIMPLIFICATION: real Dentally does not expose a clean treatment-plans-
// with-outstanding list — outstanding really lives on invoices/accounts. The
// mock carries amount_outstanding directly on the plan so the pipeline runs.
// When wiring the real sandbox, replace `planAmountOutstanding` with the proper
// invoice/account lookup; the rest of the mapping should be unaffected.
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

/**
 * Amount outstanding sourced directly from the treatment plan.
 *
 * MOCK SIMPLIFICATION: the mock carries `amount_outstanding` on the plan. For
 * the real sandbox, outstanding lives on invoices/accounts — replace this with
 * the proper lookup (the rest of the mapping is independent of it).
 */
function planAmountOutstanding(plan: Raw): number {
  return pickNumber(plan, "amount_outstanding", "amountOutstanding") ?? 0;
}

/** Map a raw patient record into the normaliser's `patient` sub-shape. */
function mapPatient(patient: Raw, fallbackId: string): DentallyPlanInput["patient"] {
  return {
    id: pickString(patient, "id") ?? fallbackId,
    first_name: pickString(patient, "first_name", "firstName") ?? "",
    last_name: pickString(patient, "last_name", "lastName") ?? "",
    // Consent: flat top-level fields, mirroring the real Dentally patient.
    use_sms: pickBoolean(patient, "use_sms", "useSms"),
    use_email: pickBoolean(patient, "use_email", "useEmail"),
    // `marketing` is an integer (0/1) in Dentally; the normaliser accepts
    // number|boolean and coerces with Boolean(), so 0 -> false, 1 -> true.
    marketing: pickNumber(patient, "marketing"),
  };
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

      // Outstanding comes from the plan itself (see CALIBRATION block); we no
      // longer call the payment_plans endpoint for the amount.
      const amountOutstanding = planAmountOutstanding(plan);

      let patient: DentallyPlanInput["patient"];
      if (patientId) {
        const patientRes = await client.getPatient(patientId);
        patient = mapPatient(asRecord(patientRes.patient), patientId);
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

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

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

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
