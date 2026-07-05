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
  updateCadence,
  setTargetStatus,
  getSyncState,
  setSyncState,
} from "@/lib/noshow/repository";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";
import type { NoshowStatus, NoshowTarget } from "@/lib/noshow/types";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { normaliseAppointmentState } from "@/lib/dentally/appointment-state";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

import { dentallyReadKey } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "noshow";
const DAY = 86_400_000;
const PER_PAGE = 100;
// Hard per-run cap on appointments processed, so a large day's book can't blow the
// 300s function limit. Anything over the cap is reported as remaining and picked up
// on the next cron tick (the appointment window is re-queried each run).
const MAX_APPOINTMENTS_PER_RUN = 300;
// Bound on the consent-map build (paged listPatients). Generous for a dental
// practice's active list; a site larger than this leaves late-page patients out of
// the map, and their appointments are safely skipped (never messaged) until covered.
const MAX_PATIENT_PAGES = 200;

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
  // Canonicalised: real Dentally sends "Did not attend" / "In surgery" etc.; the
  // terminal checks below and toNoshowTarget compare did_not_attend-style.
  const state = normaliseAppointmentState(pickString(a, "state", "status"));
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
    const state = normaliseAppointmentState(pickString(a, "state", "status"), "");
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

/**
 * Preserve a target's lifecycle status + attempt count across re-syncs, so an
 * (incremental) upsert never resets a confirmed/cancelled appointment to
 * "scheduled". A moved appointment (same id, new start) is re-defended afresh:
 * status back to scheduled + flagged for cadence re-anchoring.
 */
function preserveStatus(
  t: NoshowTarget,
  prevById: Map<string, NoshowTarget>,
  reanchorIds: Set<string>,
): void {
  const prev = prevById.get(t.id);
  if (!prev) return;
  const terminal = prev.status === "cancelled" || prev.status === "attended" || prev.status === "no_show";
  const rescheduled = !terminal && prev.appointmentStartAt !== t.appointmentStartAt;
  if (rescheduled) {
    t.status = "scheduled";
    reanchorIds.add(t.id);
  } else if (prev.status !== "scheduled") {
    t.status = prev.status;
  }
  t.priorAttempts = prev.priorAttempts;
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: NoshowConfig,
): Promise<{ siteId: string; pulled: number; upserted: number; enrolled: number; reanchored: number; reconciled: number; processed: number; remaining: number }> {
  const now = new Date();
  const toDate = new Date(now.getTime() + cfg.leadDays * DAY);
  const dentallyId = dentallySiteId(siteId);

  // Consent + name lookup for the whole site, built ONCE from paged listPatients
  // (server-filtered by site) instead of a getPatient call per appointment. On the
  // biggest site that per-appointment call doubled the Dentally load and tripped the
  // rate limit / function time limit mid-run, which — with a single end-of-loop
  // upsert — discarded the entire site's work. A patient ABSENT from this map is
  // treated exactly like the old failed-getPatient path: we skip their appointment
  // and never fabricate consent (never auto-enrol an unverified patient into SMS).
  const consentByPatient = new Map<string, ReturnType<typeof mapPatientConsent>>();
  for (let pp = 1; pp <= MAX_PATIENT_PAGES; pp++) {
    let rows: unknown[];
    try {
      const res = await client.listPatients({ siteId: dentallyId, page: pp, perPage: PER_PAGE });
      rows = Array.isArray(res.patients) ? res.patients : [];
    } catch {
      break; // partial map: unknown patients are safely skipped; retried next run
    }
    for (const raw of rows) {
      const p = asRecord(raw);
      const id = pickString(p, "id");
      if (id) consentByPatient.set(id, mapPatientConsent(p));
    }
    if (rows.length < PER_PAGE) break;
  }

  // Load existing targets up front: needed for per-page status preservation (so an
  // incremental upsert never resets a confirmed/cancelled target) and for the
  // reconciliation pass after the loop.
  const existing = await listTargets({ siteIds: [siteId] });
  const prevById = new Map(existing.map((t) => [t.id, t]));
  // Targets whose appointment MOVED (same id, new start): re-anchor their cadence.
  const reanchorIds = new Set<string>();
  // Per-run history cache: the risk score needs each patient's past attendance,
  // which is patient-level not appointment-level. Fetch getPatientAppointments at
  // most once per unique patient and reuse it for their other slots in the window.
  const historyCache = new Map<string, ReturnType<typeof summariseHistory>>();

  const allTargets: NoshowTarget[] = [];
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let listingError = false;
  // Reconciliation bookkeeping (findings #4/#5): every appointment id we actually
  // saw in the window this run, and the ones that came back in a TERMINAL state.
  // toNoshowTarget skips terminal appointments, so without tracking them here an
  // existing target would keep status 'scheduled' with a live confirmation cadence.
  const seenTargetIds = new Set<string>();
  const terminalByTargetId = new Map<string, string>();

  // Page the appointment window rather than pulling it in one unpaged call: the
  // real Dentally API caps a page, so a single call would silently drop a busy
  // practice's later appointments (they would never be defended). Stop paging
  // once the per-run cap is hit; the rest is reported as `remaining` and picked
  // up on the next tick (the window is re-queried each run).
  appt_loop: for (let page = 1; ; page++) {
    let rawAppts: unknown[];
    try {
      const res = await client.listAppointments({
        siteId: dentallyId, fromDate: ymd(now), toDate: ymd(toDate), page, perPage: PER_PAGE,
      });
      rawAppts = Array.isArray(res.appointments) ? res.appointments : [];
    } catch {
      // A listing-page failure (rate limit / timeout) must NOT discard the pages we
      // already upserted this run. Stop paging and keep partial progress; the window
      // is re-queried next tick. Flag it so reconciliation does not treat unseen
      // appointments as vanished (we did not cover the whole window).
      listingError = true;
      break appt_loop;
    }
    pulled += rawAppts.length;

    const pageTargets: NoshowTarget[] = [];
    for (const rawAppt of rawAppts) {
      const appt = mapAppointment(rawAppt);
      if (!appt) continue;

      const targetId = `${siteId}:${appt.patientId}:${appt.id}`;
      // Mark BEFORE any transient skip so a momentary consent/history miss or a
      // cap-skip can never be mistaken for the appointment having vanished.
      seenTargetIds.add(targetId);

      // Cap reached: count the rest as remaining for the next tick and stop processing.
      if (processed >= MAX_APPOINTMENTS_PER_RUN) {
        remaining += 1;
        continue;
      }

      // Terminal in Dentally (cancelled at reception, completed, or a no-show): do not
      // build a defence target (toNoshowTarget would drop it anyway) and skip the extra
      // history call. Record it so the reconciliation pass below can end the existing
      // target's cadence and, for a cancellation, free the slot to the waitlist.
      const stLower = appt.state.toLowerCase();
      if (stLower === "cancelled" || stLower === "did_not_attend" || stLower === "no_show" || stLower === "completed") {
        terminalByTargetId.set(targetId, stLower);
        processed += 1;
        continue;
      }

      // Consent from the site map. A MISS = we could not read this patient's consent,
      // so we skip (never fabricate), exactly as the old getPatient-failure path did.
      const consent = consentByPatient.get(appt.patientId);
      if (!consent) continue;

      // History once per unique patient (cached). A failed fetch skips this
      // appointment (retry next run), never messaging on an unread record.
      let history = historyCache.get(appt.patientId);
      if (history === undefined) {
        try {
          // includeCancelled: real Dentally EXCLUDES Did-not-attend rows by default,
          // which would zero priorNoShows and gut the risk score's history component.
          const historyRes = await client.getPatientAppointments(appt.patientId, 1, 100, true);
          history = summariseHistory(historyRes, now);
        } catch {
          continue;
        }
        historyCache.set(appt.patientId, history);
      }

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
      if (target) pageTargets.push(target);
      processed += 1;
    }

    // Preserve lifecycle status + attempts for this page before upserting, then
    // upsert THIS page so a later listing-page failure can never lose its work.
    for (const t of pageTargets) preserveStatus(t, prevById, reanchorIds);
    if (pageTargets.length > 0) {
      await upsertTargets(rankByRisk(pageTargets));
      allTargets.push(...pageTargets);
    }

    // Stop paging once the cap is hit (any rows in this page past the cap were
    // counted as remaining above) or the API returns a short/empty final page.
    if (processed >= MAX_APPOINTMENTS_PER_RUN) break appt_loop;
    if (rawAppts.length < PER_PAGE) break appt_loop;
    // Belt-and-braces termination guard: if a misbehaving API kept returning full
    // pages of unmappable rows, `processed` would never reach the cap and the loop
    // would page forever. Cap the page count so a run is always bounded regardless
    // of upstream behaviour. Enough pages to fill the per-run cap plus a margin.
    if (page >= Math.ceil(MAX_APPOINTMENTS_PER_RUN / PER_PAGE) + 2) break appt_loop;
  }

  // Auto-enrol a confirmation cadence for each newly-scheduled, SMS-consented
  // target that does not already have one. No consent -> stays on the worklist
  // for a manual call, but we never message without it. A RESCHEDULED target keeps
  // its cadence row but has it re-anchored to the new appointment time.
  let enrolled = 0;
  let reanchored = 0;
  for (const t of allTargets) {
    if (t.status !== "scheduled" || !t.consent.sms) continue;
    const e = enrolment(new Date(t.appointmentStartAt), now);
    if (!e) continue;
    const cadence = await getCadenceByTarget(t.id);
    if (cadence) {
      if (!reanchorIds.has(t.id)) continue; // unchanged appointment: leave the cadence as-is
      // Rescheduled: re-point the existing cadence at the new start (recompute the
      // current step + next due time), re-activating it if the old time had confirmed.
      await updateCadence(cadence.id, {
        status: "active",
        currentStep: e.currentStep,
        nextDueAt: e.nextDueAt,
        endedAt: null,
      });
      reanchored += 1;
      continue;
    }
    await createCadence({ targetId: t.id, siteId, nextDueAt: e.nextDueAt, currentStep: e.currentStep });
    await setTargetStatus(t.id, "scheduled");
    enrolled += 1;
  }

  // Reconcile appointments that ended terminally in Dentally, or (only when the whole
  // window was covered this run) vanished from it — the dominant reception-cancel path.
  // Without this the target keeps status 'scheduled' with a live cadence, the sweep
  // keeps sending "please confirm" for a dead appointment, and a cancelled slot never
  // reaches the waitlist.
  let reconciled = 0;
  // Only treat absence-from-the-pull as "vanished" when we actually covered the whole
  // window: no cap hit AND no listing-page error cut us short. A partial pull must not
  // mark unseen-but-still-booked appointments cancelled (which would free their slots).
  const fullWindow = remaining === 0 && !listingError;
  for (const prev of existing) {
    if (prev.status === "attended" || prev.status === "no_show") continue; // already final
    const startMs = new Date(prev.appointmentStartAt).getTime();
    const inWindow = startMs >= now.getTime() && startMs <= toDate.getTime();
    const terminalState = terminalByTargetId.get(prev.id);
    const vanished = fullWindow && inWindow && !seenTargetIds.has(prev.id);
    if (!terminalState && !vanished) continue;

    const newStatus: NoshowStatus =
      terminalState === "completed" ? "attended"
        : terminalState === "did_not_attend" || terminalState === "no_show" ? "no_show"
          : "cancelled"; // explicit 'cancelled', or vanished from a fully-covered window
    if (prev.status === newStatus) continue; // already reconciled on an earlier run

    await setTargetStatus(prev.id, newStatus);
    const cadence = await getCadenceByTarget(prev.id);
    if (cadence && (cadence.status === "active" || cadence.status === "paused")) {
      await updateCadence(cadence.id, {
        status: newStatus === "cancelled" ? "cancelled" : "exhausted",
        endedAt: now.toISOString(),
      });
    }
    // A cancellation frees a still-future slot: offer it to the best-matched waitlist
    // entry, exactly as the in-app / inbound-SMS cancel paths do. Guarded on a future
    // start so we never offer a slot that has already passed. Idempotent: the
    // status-equality check above stops us re-offering on subsequent runs.
    if (newStatus === "cancelled" && startMs > now.getTime()) {
      await offerSlotToNextCandidate(
        {
          appointmentId: prev.appointmentId,
          siteId: prev.siteId,
          startAt: prev.appointmentStartAt,
          durationMin: prev.durationMin || 30,
          practitioner: prev.practitioner,
        },
        now,
      );
    }
    reconciled += 1;
  }

  await setSyncState(siteId, RESOURCE, now.toISOString());
  return { siteId, pulled, upserted: allTargets.length, enrolled, reanchored, reconciled, processed, remaining };
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  // Never overlap with another noshow sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-noshow", 310))) {
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
    await releaseCronLock("sync-noshow");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
