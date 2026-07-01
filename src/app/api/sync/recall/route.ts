import { DentallyClient } from "@/lib/dentally/client";
import {
  classifyRecall,
  rankByDue,
  DEFAULT_CONFIG,
  type RecallConfig,
  type RecallInput,
} from "@/lib/recall/normalise";
import { upsertTargets, listTargets, markGraduated, getSyncState, setSyncState } from "@/lib/recall/repository";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "recall";
const PER_PAGE = 100;
const DAY = 86_400_000;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// Recall needs much less than reactivation: just patient recall dates, consent,
// and whether a future appointment exists. No treatment plans or invoices.
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

function mapPatient(p: Raw, fallbackId: string): RecallInput["patient"] {
  return {
    id: pickString(p, "id") ?? fallbackId,
    first_name: pickString(p, "first_name", "firstName") ?? "",
    last_name: pickString(p, "last_name", "lastName") ?? "",
    use_sms: pickBoolean(p, "use_sms", "sms"),
    use_email: pickBoolean(p, "use_email", "email"),
    marketing: pickBoolean(p, "marketing"),
    dentist_recall_date: pickString(p, "dentist_recall_date", "dentistRecallDate") ?? null,
    hygienist_recall_date: pickString(p, "hygienist_recall_date", "hygienistRecallDate") ?? null,
  };
}

/** Whether any future appointment exists (a patient already coming in is not a recall candidate). */
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

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function config(): RecallConfig {
  return {
    leadWindowDays: Number(process.env.RECALL_LEAD_WINDOW_DAYS ?? DEFAULT_CONFIG.leadWindowDays),
    // Mirror reactivation's grace so the seam stays airtight.
    graceDays: Number(
      process.env.RECALL_GRACE_DAYS ?? process.env.REACTIVATION_RECALL_GRACE_DAYS ?? DEFAULT_CONFIG.graceDays,
    ),
  };
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: RecallConfig,
): Promise<{ siteId: string; pulled: number; upserted: number; processed: number; remaining: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;
  const now = new Date();

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
      const appts = summariseAppointments(apptsRes, now);
      const input: RecallInput = {
        siteId,
        patient,
        lastVisitAt: appts.lastVisitAt,
        futureBookingExists: appts.futureBookingExists,
      };

      for (const target of classifyRecall(input, now, cfg)) targets.push(target);

      // Advance the mark only after this record is fully processed.
      const updated = patientUpdatedAt(p);
      if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
      processed += 1;
    }

    if (capped) break outer;
    if (rawPatients.length < PER_PAGE) break;
    page += 1;
  }

  const ranked = rankByDue(targets);
  await upsertTargets(ranked);

  // Reconcile previously-classified, unenrolled `due` targets that have aged past
  // the grace boundary: graduate them so they leave the recall worklist and
  // reactivation can adopt them (closes the seam double-coverage gap).
  const openDue = await listTargets({ siteIds: [siteId], statuses: ["due"] });
  for (const t of openDue) {
    if ((now.getTime() - new Date(t.dueAt).getTime()) / DAY > cfg.graceDays) {
      await markGraduated(t.id);
    }
  }

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
  // Never overlap with another recall sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-recall", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
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
  } finally {
    await releaseCronLock("sync-recall");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
