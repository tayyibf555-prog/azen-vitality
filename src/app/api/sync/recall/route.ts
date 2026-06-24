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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "recall";
const PER_PAGE = 100;
const DAY = 86_400_000;

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
): Promise<{ siteId: string; pulled: number; upserted: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;
  const now = new Date();

  const targets = [];
  let highWaterMark = updatedAfter ?? null;
  let pulled = 0;
  let page = 1;

  for (;;) {
    const res = await client.listPatients({ siteId, updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;

      const appts = summariseAppointments(await client.getPatientAppointments(patient.id), now);
      const input: RecallInput = {
        siteId,
        patient,
        lastVisitAt: appts.lastVisitAt,
        futureBookingExists: appts.futureBookingExists,
      };

      for (const target of classifyRecall(input, now, cfg)) targets.push(target);

      const updated = patientUpdatedAt(p);
      if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
    }

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
  const cfg = config();
  const perSite = [];
  for (const siteId of vitalitySiteIds()) {
    perSite.push(await syncSite(client, siteId, cfg));
  }
  return Response.json({ ok: true, perSite });
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
