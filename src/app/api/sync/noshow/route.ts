import { DentallyClient } from "@/lib/dentally/client";
import {
  toNoshowTarget,
  rankByRisk,
  DEFAULT_CONFIG,
  type NoshowConfig,
  type NoshowInput,
} from "@/lib/noshow/normalise";
import { enrolment } from "@/lib/noshow/cadence";
import {
  upsertTargets,
  listTargets,
  getCadenceByTarget,
  createCadence,
  setTargetStatus,
  getSyncState,
  setSyncState,
} from "@/lib/noshow/repository";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "noshow";
const DAY = 86_400_000;
// Hard per-run cap on appointments processed, so a large day's book can't blow the
// 300s function limit. Anything over the cap is reported as remaining and picked up
// on the next cron tick (the appointment window is re-queried each run).
const MAX_APPOINTMENTS_PER_RUN = 300;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// No-show needs upcoming appointments, the patient's consent, and their past
// attendance record (to score risk). No treatment plans or invoices.
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
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
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

interface ApptFields {
  id: string;
  patientId: string;
  start: string;
  state: string;
  durationMin: number;
  practitioner: string | null;
  bookedDaysAhead: number;
}

function mapAppointment(raw: unknown): ApptFields | null {
  const a = asRecord(raw);
  const id = pickString(a, "id");
  const patientId = pickString(a, "patient_id", "patientId");
  const start = pickString(a, "start_time", "start", "date");
  if (!id || !patientId || !start) return null;
  const state = pickString(a, "state", "status") ?? "booked";
  const durationMin = pickNumber(a, "duration", "duration_minutes", "durationMin") ?? 30;
  const practitioner = pickString(a, "practitioner", "practitioner_name") ?? null;
  // Lead time if a booking timestamp is present, else a neutral 14 days.
  const bookedAt = pickString(a, "created_at", "booked_at");
  const bookedDaysAhead = bookedAt
    ? Math.max(0, Math.round((new Date(start).getTime() - new Date(bookedAt).getTime()) / DAY))
    : 14;
  return { id, patientId, start, state, durationMin, practitioner, bookedDaysAhead };
}

/** Past-attendance summary for risk scoring, derived from the patient's history. */
function summariseHistory(payload: { appointments: unknown[] }, now: Date): {
  priorAppointments: number;
  priorNoShows: number;
  isNewPatient: boolean;
} {
  const appts = Array.isArray(payload.appointments) ? payload.appointments : [];
  let priorAppointments = 0;
  let priorNoShows = 0;
  let anyCompleted = false;
  for (const raw of appts) {
    const a = asRecord(raw);
    const start = pickString(a, "start_time", "start", "date");
    if (!start) continue;
    if (new Date(start).getTime() >= now.getTime()) continue; // only past appointments
    priorAppointments += 1;
    const state = (pickString(a, "state", "status") ?? "").toLowerCase();
    if (state === "did_not_attend" || state === "no_show") priorNoShows += 1;
    if (state === "completed") anyCompleted = true;
  }
  return { priorAppointments, priorNoShows, isNewPatient: !anyCompleted };
}

function mapPatientConsent(p: Raw): { sms: boolean; email: boolean; marketing: boolean; name: string } {
  const first = pickString(p, "first_name", "firstName") ?? "";
  const last = pickString(p, "last_name", "lastName") ?? "";
  return {
    sms: pickBoolean(p, "use_sms", "sms") ?? true,
    email: pickBoolean(p, "use_email", "email") ?? true,
    marketing: pickBoolean(p, "marketing") ?? false,
    name: `${first} ${last}`.trim() || (pickString(p, "name") ?? "there"),
  };
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function config(): NoshowConfig {
  return { leadDays: Number(process.env.NOSHOW_LEAD_DAYS ?? DEFAULT_CONFIG.leadDays) };
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: NoshowConfig,
): Promise<{ siteId: string; pulled: number; upserted: number; enrolled: number; processed: number; remaining: number }> {
  const now = new Date();
  const toDate = new Date(now.getTime() + cfg.leadDays * DAY);

  const res = await client.listAppointments({ siteId, fromDate: ymd(now), toDate: ymd(toDate) });
  const rawAppts = Array.isArray(res.appointments) ? res.appointments : [];

  const targets = [];
  let processed = 0;
  let remaining = 0;
  for (const rawAppt of rawAppts) {
    const appt = mapAppointment(rawAppt);
    if (!appt) continue;

    // Cap reached: count the rest as remaining for the next tick and stop processing.
    if (processed >= MAX_APPOINTMENTS_PER_RUN) {
      remaining += 1;
      continue;
    }

    const patientRes = await client.getPatient(appt.patientId).catch(() => ({ patient: {} }));
    const consent = mapPatientConsent(asRecord(patientRes.patient));
    // One bad record must not kill the run: on a failed secondary call, skip this
    // appointment and move on to the next.
    let historyRes: { appointments: unknown[] };
    try {
      historyRes = await client.getPatientAppointments(appt.patientId);
    } catch {
      continue;
    }
    const history = summariseHistory(historyRes, now);

    const input: NoshowInput = {
      siteId,
      dentallyPatientId: appt.patientId,
      patientName: consent.name,
      appointment: {
        id: appt.id,
        start: appt.start,
        state: appt.state,
        durationMin: appt.durationMin,
        practitioner: appt.practitioner,
      },
      priorAppointments: history.priorAppointments,
      priorNoShows: history.priorNoShows,
      isNewPatient: history.isNewPatient,
      bookedDaysAhead: appt.bookedDaysAhead,
      consent: { sms: consent.sms, email: consent.email, marketing: consent.marketing },
      now,
    };

    const target = toNoshowTarget(input, cfg);
    if (target) targets.push(target);
    processed += 1;
  }

  // Preserve a target's lifecycle status + attempt count across re-syncs, so a
  // confirmed/cancelled appointment is not reset to "scheduled".
  const existing = await listTargets({ siteIds: [siteId] });
  const prevById = new Map(existing.map((t) => [t.id, t]));
  for (const t of targets) {
    const prev = prevById.get(t.id);
    if (prev) {
      if (prev.status !== "scheduled") t.status = prev.status;
      t.priorAttempts = prev.priorAttempts;
    }
  }

  const ranked = rankByRisk(targets);
  await upsertTargets(ranked);

  // Auto-enrol a confirmation cadence for each newly-scheduled, SMS-consented
  // target that does not already have one. No consent -> stays on the worklist
  // for a manual call, but we never message without it.
  let enrolled = 0;
  for (const t of ranked) {
    if (t.status !== "scheduled" || !t.consent.sms) continue;
    if (await getCadenceByTarget(t.id)) continue;
    const e = enrolment(new Date(t.appointmentStartAt), now);
    if (!e) continue;
    await createCadence({ targetId: t.id, siteId, nextDueAt: e.nextDueAt, currentStep: e.currentStep });
    await setTargetStatus(t.id, "scheduled");
    enrolled += 1;
  }

  await setSyncState(siteId, RESOURCE, now.toISOString());
  return { siteId, pulled: rawAppts.length, upserted: ranked.length, enrolled, processed, remaining };
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
