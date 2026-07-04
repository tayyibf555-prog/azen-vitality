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
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";

import { dentallyReadKey } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "treatment_plans";
const PER_PAGE = 100;
// Hard per-run cap on plans processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PLANS_PER_RUN = 300;

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
): Promise<{ siteId: string; pulled: number; upserted: number; processed: number; remaining: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;

  const now = new Date();
  const opportunities = [];
  // Only advance the mark once at least one record actually contributed a parsed
  // updatedAt; never fall back to `now` (that would skip records on an early exit).
  let highWaterMark = updatedAfter ?? null;
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let capped = false;
  let page = 1;

  // Page until a page returns fewer than PER_PAGE items.
  outer: for (;;) {
    const res = await client.listTreatmentPlans({
      siteId,
      updatedAfter,
      page,
      perPage: PER_PAGE,
    });
    const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
    pulled += rawPlans.length;

    for (const rawPlan of rawPlans) {
      // Cap reached: stop before processing this plan and leave the mark at the
      // last fully-processed record so the next tick resumes from here.
      if (processed >= MAX_PLANS_PER_RUN) {
        remaining += 1;
        capped = true;
        continue;
      }

      const plan = asRecord(rawPlan);
      const patientId = planPatientId(plan);

      // Outstanding comes from the plan itself (see CALIBRATION block); we no
      // longer call the payment_plans endpoint for the amount.
      const amountOutstanding = planAmountOutstanding(plan);

      let patient: DentallyPlanInput["patient"];
      if (patientId) {
        // One bad record must not kill the run: default to an empty patient and
        // skip this plan on a failed lookup.
        let patientRes: { patient: unknown };
        try {
          patientRes = await client.getPatient(patientId);
        } catch {
          continue;
        }
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

      // Advance the mark only after this record is fully processed.
      const planUpdated = planUpdatedAt(plan);
      if (planUpdated && (!highWaterMark || planUpdated > highWaterMark)) {
        highWaterMark = planUpdated;
      }
      processed += 1;
    }

    if (capped) break outer;
    if (rawPlans.length < PER_PAGE) break;
    page += 1;
  }

  const ranked = rankOpportunities(opportunities, now);
  await upsertOpportunities(ranked);
  // Leave the prior mark UNCHANGED when no record contributed one, so the next run
  // re-fetches rather than skipping. Only persist when we actually advanced it.
  if (highWaterMark) await setSyncState(siteId, RESOURCE, highWaterMark);

  return { siteId, pulled, upserted: ranked.length, processed, remaining };
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  if (!(await isSystemEnabled("vitality", "treatment-coordinator"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }

  // Never overlap with another dentally sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-dentally", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
    });

    // One site's failure must not abort the rest: record the error and move on so a
    // partial failure is observable and self-heals next tick (no all-or-nothing 500).
    const perSite: Array<Record<string, unknown>> = [];
    for (const siteId of vitalitySiteIds()) {
      try {
        perSite.push(await syncSite(client, siteId));
      } catch (e) {
        perSite.push({ siteId, error: String(e) });
      }
    }

    return Response.json({ ok: true, perSite });
  } finally {
    await releaseCronLock("sync-dentally");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
