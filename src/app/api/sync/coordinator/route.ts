import { DentallyClient } from "@/lib/dentally/client";
import {
  toTreatmentOpportunity,
  rankOpportunities,
  type CoordinatorInput,
  type PatientInput,
  type PlanInput,
} from "@/lib/coordinator/normalise";
import {
  upsertOpportunities,
  listOpportunities,
  setOpportunityStatus,
  getSyncState,
  setSyncState,
} from "@/lib/coordinator/repository";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "coordinator";
const PER_PAGE = 100;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// The coordinator needs accepted-but-incomplete treatment plans (id, name,
// planned value, outstanding, accepted_at, status) joined to the patient
// (names + consent). Everything about the raw Dentally JSON shape lives here.
//   - treatment_plans[] -> id, patient_id, name, planned value, outstanding,
//                          accepted_at, optional status/state
//   - patients[]        -> id, names, consent (use_sms/use_email/marketing)
// ===========================================================================

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}
function pickString(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}
function pickNumber(o: Raw, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}
function pickBoolean(o: Raw, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
  }
  return undefined;
}

function patientUpdatedAt(p: Raw): string | undefined {
  return pickString(p, "updated_at", "updatedAt");
}

function mapPatient(p: Raw, fallbackId: string): PatientInput {
  return {
    id: pickString(p, "id") ?? fallbackId,
    first_name: pickString(p, "first_name", "firstName") ?? "",
    last_name: pickString(p, "last_name", "lastName") ?? "",
    use_sms: pickBoolean(p, "use_sms", "sms"),
    use_email: pickBoolean(p, "use_email", "email"),
    marketing: pickBoolean(p, "marketing"),
  };
}

function mapPlan(tp: Raw): PlanInput | null {
  const id = pickString(tp, "id");
  if (!id) return null;
  return {
    id,
    name: pickString(tp, "name", "title", "description") ?? "Treatment plan",
    plannedValue: pickNumber(tp, "planned_private_treatment_value", "total", "value") ?? 0,
    amountOutstanding: pickNumber(tp, "amount_outstanding", "outstanding", "balance") ?? 0,
    acceptedAt: pickString(tp, "accepted_at", "acceptedAt", "created_at") ?? new Date().toISOString(),
    status: pickString(tp, "status", "state") ?? null,
    financePresented: pickBoolean(tp, "finance_presented", "financePresented") ?? false,
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
): Promise<{ siteId: string; pulled: number; upserted: number; retired: number; processed: number; remaining: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;
  const now = new Date();

  // 1. Index the site's plans by patient id (the open one) and by plan id (the
  //    full current set, used below to retire opportunities whose plan is now paid).
  const plansByPatient = new Map<string, PlanInput>();
  const plansById = new Map<string, PlanInput>();
  for (let pp = 1; ; pp++) {
    const res = await client.listTreatmentPlans({ siteId, page: pp, perPage: PER_PAGE });
    const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
    for (const raw of rawPlans) {
      const tp = asRecord(raw);
      const patientId = pickString(tp, "patient_id", "patientId");
      const plan = mapPlan(tp);
      if (!plan) continue;
      plansById.set(plan.id, plan);
      if (!patientId) continue;
      // Keep the open one (outstanding > 0); the normalise step drops the rest.
      const existing = plansByPatient.get(patientId);
      if (!existing || plan.amountOutstanding > existing.amountOutstanding) {
        plansByPatient.set(patientId, plan);
      }
    }
    if (rawPlans.length < PER_PAGE) break;
  }

  // 2. Page patients, join to their open plan, and map each accepted-but-incomplete
  //    plan into an opportunity.
  const opportunities = [];
  // Only advance the mark once at least one record actually contributed a parsed
  // updatedAt; never fall back to `now` (that would skip records on an early exit).
  let highWaterMark = updatedAfter ?? null;
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let capped = false;
  let page = 1;

  outer: for (;;) {
    const res = await client.listPatients({ siteId, updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;

      // Cap reached: stop before processing this patient and leave the mark at the
      // last fully-processed record so the next tick resumes from here.
      if (processed >= MAX_PATIENTS_PER_RUN) {
        remaining += 1;
        capped = true;
        continue;
      }

      const plan = plansByPatient.get(patient.id);
      if (plan) {
        const input: CoordinatorInput = { siteId, patient, plan, lastTouchAt: null };
        const opportunity = toTreatmentOpportunity(input, now);
        if (opportunity) opportunities.push(opportunity);
      }

      // Advance the mark only after this record is fully processed.
      const updated = patientUpdatedAt(p);
      if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
      processed += 1;
    }

    if (capped) break outer;
    if (rawPatients.length < PER_PAGE) break;
    page += 1;
  }

  const ranked = rankOpportunities(opportunities, now);
  await upsertOpportunities(ranked);

  // Retire stale opportunities: the incremental patient window misses patients
  // whose record didn't change, so an opportunity for a plan that has since been
  // paid (outstanding 0), gone, or marked terminal would keep being messaged.
  // Re-check every stored OPEN opportunity against the full current plan list and
  // mark the settled ones 'completed' so the sweep stops targeting them.
  const TERMINAL = ["completed", "declined", "rejected", "cancelled"];
  const stored = await listOpportunities({
    siteIds: [siteId],
    statuses: ["accepted", "in_progress", "stalled"],
  });
  let retired = 0;
  for (const opp of stored) {
    const plan = plansById.get(opp.dentallyPlanId);
    const stillOpen =
      plan !== undefined &&
      plan.amountOutstanding > 0 &&
      !TERMINAL.includes((plan.status ?? "").toLowerCase());
    if (!stillOpen) {
      await setOpportunityStatus(opp.id, "completed");
      retired += 1;
    }
  }

  // Leave the prior mark UNCHANGED when no record contributed one, so the next run
  // re-fetches rather than skipping. Only persist when we actually advanced it.
  if (highWaterMark) await setSyncState(siteId, RESOURCE, highWaterMark);
  return { siteId, pulled, upserted: ranked.length, retired, processed, remaining };
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  if (!(await isSystemEnabled("vitality", "treatment-coordinator"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  // Never overlap with another coordinator sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-coordinator", 310))) {
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
    await releaseCronLock("sync-coordinator");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
