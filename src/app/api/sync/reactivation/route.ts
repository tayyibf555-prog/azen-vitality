import { DentallyClient } from "@/lib/dentally/client";
import {
  toReactivationTarget,
  DEFAULT_CONFIG,
  type ReactivationConfig,
  type ReactivationInput,
} from "@/lib/reactivation/normalise";
import { rankTargets } from "@/lib/reactivation/scoring";
import { upsertTargets, getSyncState, setSyncState } from "@/lib/reactivation/repository";
import { listOpenRecallPatientKeys } from "@/lib/recall/repository";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "reactivation";
const PER_PAGE = 100;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// Everything about the raw Dentally JSON shape lives in THIS block.
// Known unknowns to verify on calibration:
//   - patients[]      -> id, names, consent (use_sms/use_email/marketing),
//                        archived/archived_reason, dentist/hygienist recall dates
//   - appointments[]  -> start/date field; how past vs future is represented
//   - invoices[]      -> paid amount field (for historic spend)
//   - treatment_plans -> open plan id/name/value/accepted_at + outstanding
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

function mapPatient(p: Raw, fallbackId: string): ReactivationInput["patient"] {
  return {
    id: pickString(p, "id") ?? fallbackId,
    first_name: pickString(p, "first_name", "firstName") ?? "",
    last_name: pickString(p, "last_name", "lastName") ?? "",
    use_sms: pickBoolean(p, "use_sms", "sms"),
    use_email: pickBoolean(p, "use_email", "email"),
    marketing: pickBoolean(p, "marketing"),
    archived: pickBoolean(p, "archived"),
    archived_reason: pickString(p, "archived_reason", "archivedReason") ?? null,
    dentist_recall_date: pickString(p, "dentist_recall_date", "dentistRecallDate") ?? null,
    hygienist_recall_date: pickString(p, "hygienist_recall_date", "hygienistRecallDate") ?? null,
  };
}

/** Most recent past appointment date, and whether any future appointment exists. */
function summariseAppointments(payload: { appointments: unknown[] }, now: Date): {
  lastVisitAt: string | null;
  futureBookingExists: boolean;
} {
  const appts = Array.isArray(payload.appointments) ? payload.appointments : [];
  let lastVisitAt: string | null = null;
  let futureBookingExists = false;
  for (const raw of appts) {
    const a = asRecord(raw);
    const startIso = pickString(a, "start_time", "start", "date", "appointment_date");
    if (!startIso) continue;
    const t = new Date(startIso).getTime();
    if (t > now.getTime()) {
      futureBookingExists = true;
    } else if (!lastVisitAt || new Date(startIso).getTime() > new Date(lastVisitAt).getTime()) {
      lastVisitAt = startIso;
    }
  }
  return { lastVisitAt, futureBookingExists };
}

/** Sum of paid invoice amounts = lifetime spend proxy. */
function deriveHistoricSpend(payload: { invoices: unknown[] }): number {
  const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
  let total = 0;
  for (const raw of invoices) {
    const inv = asRecord(raw);
    total += pickNumber(inv, "paid", "amount_paid", "total_paid") ?? 0;
  }
  return total;
}

interface OpenPlan {
  plan: ReactivationInput["plan"];
  amountOutstanding: number;
}

/**
 * Index a site's treatment plans by patient id, keeping the open one
 * (outstanding > 0). The treatment plan carries accepted_at + outstanding,
 * which is what stalled-plan detection needs.
 */
function indexOpenPlansByPatient(rawPlans: unknown[]): Map<string, OpenPlan> {
  const byPatient = new Map<string, OpenPlan>();
  for (const raw of rawPlans) {
    const tp = asRecord(raw);
    const patientId = pickString(tp, "patient_id", "patientId");
    const outstanding = pickNumber(tp, "amount_outstanding", "outstanding", "balance") ?? 0;
    if (!patientId || outstanding <= 0) continue;
    byPatient.set(patientId, {
      plan: {
        id: pickString(tp, "id") ?? "",
        name: pickString(tp, "name", "title", "description") ?? "Treatment plan",
        planned_private_treatment_value:
          pickNumber(tp, "planned_private_treatment_value", "total", "value") ?? 0,
        accepted_at: pickString(tp, "accepted_at", "acceptedAt", "created_at") ?? new Date().toISOString(),
      },
      amountOutstanding: outstanding,
    });
  }
  return byPatient;
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function config(): ReactivationConfig {
  return {
    lapseMonths: Number(process.env.REACTIVATION_LAPSE_MONTHS ?? DEFAULT_CONFIG.lapseMonths),
    recallGraceDays: Number(process.env.REACTIVATION_RECALL_GRACE_DAYS ?? DEFAULT_CONFIG.recallGraceDays),
    staleDays: Number(process.env.REACTIVATION_STALE_DAYS ?? DEFAULT_CONFIG.staleDays),
    baselineValue: Number(process.env.REACTIVATION_BASELINE_VALUE ?? DEFAULT_CONFIG.baselineValue),
  };
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: ReactivationConfig,
): Promise<{ siteId: string; pulled: number; upserted: number; processed: number; remaining: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;
  const now = new Date();

  // Patients with an open recall target (due or in cadence), so an overdue recall
  // is not chased by both modules at once (recall owns it until it hands off).
  const openRecall = await listOpenRecallPatientKeys([siteId]);

  // 1. Index the site's open treatment plans by patient (carries outstanding + accepted_at).
  const openByPatient = new Map<string, OpenPlan>();
  for (let pp = 1; ; pp++) {
    const res = await client.listTreatmentPlans({ siteId, page: pp, perPage: PER_PAGE });
    const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
    for (const [k, v] of indexOpenPlansByPatient(rawPlans)) openByPatient.set(k, v);
    if (rawPlans.length < PER_PAGE) break;
  }

  // 2. Page patients and classify each into a cohort.
  const targets = [];
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

      // One bad record must not kill the run: on a failed secondary call, skip this
      // patient (treat as empty) and move on to the next.
      let apptsRes: { appointments: unknown[] };
      try {
        apptsRes = await client.getPatientAppointments(patient.id);
      } catch {
        continue;
      }
      let invoicesRes: { invoices: unknown[] };
      try {
        invoicesRes = await client.getPatientInvoices(patient.id);
      } catch {
        continue;
      }
      const appts = summariseAppointments(apptsRes, now);
      const historicSpend = deriveHistoricSpend(invoicesRes);
      const open = openByPatient.get(patient.id) ?? { plan: null, amountOutstanding: 0 };

      const input: ReactivationInput = {
        siteId,
        patient,
        lastVisitAt: appts.lastVisitAt,
        futureBookingExists: appts.futureBookingExists,
        plan: open.plan,
        amountOutstanding: open.amountOutstanding,
        historicSpend,
        lastTouchAt: null,
      };

      const target = toReactivationTarget(input, now, cfg);
      if (target && !(target.reason === "overdue_recall" && openRecall.has(target.id))) {
        targets.push(target);
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

  const ranked = rankTargets(targets, now);
  await upsertTargets(ranked);
  // Leave the prior mark UNCHANGED when no record contributed one, so the next run
  // re-fetches rather than skipping. Only persist when we actually advanced it.
  if (highWaterMark) await setSyncState(siteId, RESOURCE, highWaterMark);
  return { siteId, pulled, upserted: ranked.length, processed, remaining };
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
  const cfg = config();
  // One site's failure must not abort the rest: record the error and move on so a
  // partial failure is observable and self-heals next tick (no all-or-nothing 500).
  const perSite: Array<Record<string, unknown>> = [];
  for (const siteId of vitalitySiteIds()) {
    try {
      perSite.push(await syncSite(client, siteId, cfg));
    } catch (e) {
      perSite.push({ siteId, error: String(e) });
    }
  }
  return Response.json({ ok: true, perSite });
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
