import { dentallyScopeRefusal, dentallyScopeRefused, runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import {
  toReactivationTarget,
  DEFAULT_CONFIG,
  type ReactivationConfig,
  type ReactivationInput,
} from "@/lib/reactivation/normalise";
import { rankTargets } from "@/lib/reactivation/scoring";
import {
  upsertTargets,
  getSyncState,
  setSyncState,
  getBackfillCursor,
  setBackfillCursor,
  listTargets,
  getCadenceByTarget,
  createCadence,
  updateCadence,
  listCadences,
  listDueCadences,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import { getDailyContactLimit, countContactedToday, getMaxLapseMonths } from "@/lib/reactivation/settings";
import { withinLapseWindow } from "@/lib/reactivation/normalise";
import { listOpenRecallPatientKeys } from "@/lib/recall/repository";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { mapWithConcurrency } from "@/lib/async/pool";
import { isSystemEnabled } from "@/lib/systems/repository";
import { loadExcludedTargetKeys, excludedTargetKey } from "@/lib/patient-status/repository";
import { enrolmentBudget } from "@/lib/enrolment/budget";

import { dentallyReadKey } from "@/lib/dentally/read";
import { metaTotal } from "@/lib/dentally/paging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "reactivation";
const PER_PAGE = 100;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;
// Hard bound on the open-plan index scan. Real Dentally ignores the site filter on
// /v1/treatment_plans and returns no outstanding on the plan, so the early-stop below
// halts this at one page on live data; the cap is a backstop against a large mock.
const MAX_PLAN_PAGES = 30;
// Concurrency for the per-patient secondary reads (appointments + invoices). Bounded
// so a site finishes fast — serial ~2 calls/patient made a big site burn the whole
// 300s function and starve the sites after it — without spiking Dentally load.
const PATIENT_CONCURRENCY = 8;
// Hard per-run cap on AUTO-ENROLMENTS across all sites. The sync classifies
// thousands of targets; this is the ceiling on how many cadences one run may
// start, on top of the daily-cap arithmetic in enrolmentBudget.
const MAX_ENROLMENTS_PER_RUN = 25;
// How many dormant rows one site's enrol pass reads. Removing the one year lapse cap
// takes the addressable pool from ~4k to ~30k rows, so the pass reads a WINDOW of the
// worklist (newest lapse first) rather than the whole book. Comfortably larger than
// MAX_ENROLMENTS_PER_RUN so consent and exclusion skips inside it are absorbed.
const ENROL_WINDOW = 1000;
// One-time historical backfill uses a page-NUMBER cursor. Dentally's /v1/patients has
// NO sort control (only updated_after/created_after/site_id filters), so the
// updated_after high-water-mark + per-run cap strands older-updated patients on a
// from-scratch pass (they never get classified). Until the full pass finishes we page
// EVERY patient by page number, storing the cursor in the sync_state row's
// backfill_page/backfill_done columns (high_water_mark is a timestamptz and cannot hold
// a page number); once done we switch to the updated_after mark for steady-state
// incremental (which only ever sees the small set of changed patients).

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
    active: pickBoolean(p, "active"),
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

/** A numeric env override, or the default when unset/malformed. Number('') is 0 and
 *  Number('12m') is NaN — both would silently break a window check (a NaN ceiling is
 *  never exceeded, a 0 lapse marks everyone lapsed), so anything non-finite or <= 0
 *  logs and falls back rather than being trusted. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[reactivation] invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`);
    return fallback;
  }
  return n;
}

async function config(clientId: string): Promise<ReactivationConfig> {
  const cfg: ReactivationConfig = {
    lapseMonths: envNum("REACTIVATION_LAPSE_MONTHS", DEFAULT_CONFIG.lapseMonths),
    // Unlimited unless the practice has set an outer edge (reactivation_settings)
    // or the deployment has (REACTIVATION_MAX_LAPSE_MONTHS). Every lapsed patient
    // is addressable by default, which is what the practice asked for.
    maxLapseMonths: await getMaxLapseMonths(clientId),
    recallGraceDays: envNum("REACTIVATION_RECALL_GRACE_DAYS", DEFAULT_CONFIG.recallGraceDays),
    staleDays: envNum("REACTIVATION_STALE_DAYS", DEFAULT_CONFIG.staleDays),
    baselineValue: envNum("REACTIVATION_BASELINE_VALUE", DEFAULT_CONFIG.baselineValue),
  };
  // The lapsed window is lapseMonths..maxLapseMonths; lapse >= max empties it
  // silently (the ceiling excludes everyone before the lapse test runs). A
  // misordered setting reverts BOTH to the code defaults so the module keeps
  // its intended behaviour, loudly. (Never trips while max is unlimited.)
  if (cfg.lapseMonths >= cfg.maxLapseMonths) {
    console.error(
      `[reactivation] lapse months (${cfg.lapseMonths}) >= max lapse (${cfg.maxLapseMonths}); reverting both to defaults ${DEFAULT_CONFIG.lapseMonths}/${DEFAULT_CONFIG.maxLapseMonths}`,
    );
    cfg.lapseMonths = DEFAULT_CONFIG.lapseMonths;
    cfg.maxLapseMonths = DEFAULT_CONFIG.maxLapseMonths;
  }
  return cfg;
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

/** Run-wide auto-enrolment allowance, shared by every site (see the enrol pass). */
interface EnrolAllowance {
  remaining: number;
  /** `${siteId}:${patientId}` keys the platform admin has excluded from outreach. */
  excludedKeys: Set<string>;
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: ReactivationConfig,
  allowance: EnrolAllowance,
  maxPatients: number = MAX_PATIENTS_PER_RUN,
): Promise<{
  siteId: string;
  pulled: number;
  upserted: number;
  converted: number;
  enrolled: number;
  processed: number;
  remaining: number;
  mode: string;
  backfillPage: number | null;
  /**
   * True when the shared Dentally budget refused this run part-way through
   * (src/lib/dentally/budget.ts). NOT an error and NOT a fault of this site: the
   * platform declined to spend more of the practice's hourly quota. Coverage is
   * deliberately partial and the next tick picks up where this one stopped.
   */
  budgetRefused?: boolean;
}> {
  const now = new Date();
  // Backfill vs incremental. The cursor (backfill_page + backfill_done) lives on this
  // site's sync_state row; done=false (the default) means the one-time full pass has
  // not finished, so we resume paging from backfill_page + 1.
  const cursor = await getBackfillCursor(siteId, RESOURCE);
  const backfilling = !cursor.done;
  const startPage = backfilling && cursor.page ? cursor.page + 1 : 1;
  const mainState = backfilling ? null : await getSyncState(siteId, RESOURCE);
  // Backfill pages EVERY patient (no filter); incremental pages the updated_after window.
  const updatedAfter = backfilling ? undefined : (mainState?.highWaterMark ?? undefined);

  // Patients with an open recall target (due or in cadence), so an overdue recall
  // is not chased by both modules at once (recall owns it until it hands off).
  const openRecall = await listOpenRecallPatientKeys([siteId]);

  // Currently-enrolled targets, so that a patient who has since rebooked (or otherwise
  // stopped qualifying) can have their active cadence STOPPED rather than chased forever.
  const inCadenceIds = new Set(
    (await listTargets({ siteIds: [siteId], statuses: ["in_cadence"] })).map((t) => t.id),
  );
  let converted = 0;

  // 1. Index the site's OPEN treatment plans by patient (outstanding + accepted_at),
  //    used only for stalled-plan detection. GUARDED + BOUNDED: real Dentally ignores
  //    the site filter (returns the whole 5-practice group's plans) AND carries no
  //    amount_outstanding on the plan (it lives on invoices), so unbounded this pages
  //    the entire group's plan history sequentially for ZERO open plans — slow and
  //    fragile enough to error the whole site sync (that starved N17/Romford Road on
  //    the full-pass catch-up). Stop once a full first page yields no open plan (the
  //    live-data signature); cap the pages; and never let a plan-read failure sink the
  //    run (lapsed detection does not need plan data).
  const openByPatient = new Map<string, OpenPlan>();
  try {
    for (let pp = 1; pp <= MAX_PLAN_PAGES; pp++) {
      const res = await client.listTreatmentPlans({ siteId, page: pp, perPage: PER_PAGE });
      const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
      for (const [k, v] of indexOpenPlansByPatient(rawPlans)) openByPatient.set(k, v);
      if (rawPlans.length < PER_PAGE) break;
      // A full first page with no open plan => this endpoint isn't giving us
      // outstanding data (real Dentally); paging the rest is wasted. Stop.
      if (pp === 1 && openByPatient.size === 0) break;
    }
  } catch (err) {
    console.error(`[reactivation] plan indexing failed for site ${siteId}; continuing without plan data`, err);
  }

  // 2. Page patients, collecting raw records with NO per-patient I/O yet (batched in
  //    step 3). BACKFILL pages by NUMBER from the cursor and takes WHOLE pages (so the
  //    cursor never skips a partially-processed page); INCREMENTAL pages the
  //    updated_after window with a mid-page cap. Both bound the run at ~cap patients so
  //    a large base can't blow the 300s limit.
  const pending: Array<{ p: Raw; patient: ReactivationInput["patient"]; page: number }> = [];
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let lastCompletedPage = startPage - 1;
  let reachedEnd = false;

  for (let page = startPage; ; page += 1) {
    const res = await client.listPatients({ siteId: dentallySiteId(siteId), updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;
      // Incremental honours the cap mid-page (rest of the page = remaining, retried
      // next run). Backfill takes the whole page and enforces the cap at the boundary.
      if (!backfilling && processed >= maxPatients) {
        remaining += 1;
        continue;
      }
      pending.push({ p, patient, page });
      processed += 1;
    }

    lastCompletedPage = page;
    if (rawPatients.length < PER_PAGE) {
      reachedEnd = true;
      break;
    }
    if (processed >= maxPatients) break; // stop at this page boundary; resume next run
  }

  // 3. Fetch each pending patient's appointments + invoices in BOUNDED-CONCURRENCY
  //    batches (was a serial ~2-calls-per-patient loop that starved later sites). A
  //    failed read leaves the patient unenriched -> skipped below (retry next run),
  //    never messaging on an unread record and never advancing the mark past them.
  const enriched = new Map<string, { lastVisitAt: string | null; futureBookingExists: boolean; historicSpend: number }>();
  let budgetRefused = false;
  await mapWithConcurrency(pending, PATIENT_CONCURRENCY, async ({ patient }) => {
    // THE SHARED DENTALLY BUDGET HAS ALREADY REFUSED THIS RUN'S CLASS. The catch
    // below cannot tell a refusal from a transient error and treats both as "leave
    // the patient unenriched and carry on" — right for a blip, and a way to walk the
    // whole 300-patient cap producing nothing when it is a refusal (two reads each).
    // Returning here leaves the patient unset, which is the SAME outcome the catch
    // produces, so step 4's cursor rewind still covers them: nobody is lost.
    if (dentallyScopeRefused()) {
      budgetRefused = true;
      return;
    }
    try {
      // Page the patient's appointments: an unpaged call caps at ~100 rows, so a
      // long-standing patient's FUTURE booking could sit past page 1 and be missed,
      // making futureBookingExists a false negative — we'd reactivate a patient who
      // already has an appointment. Loop until a short page (bounded).
      const all: unknown[] = [];
      for (let ap = 1; ap <= 20; ap += 1) {
        const r = await client.getPatientAppointments(patient.id, ap, PER_PAGE);
        const rows = Array.isArray(r.appointments) ? r.appointments : [];
        all.push(...rows);
        if (rows.length < PER_PAGE) break;
      }
      // AND PAGE THE INVOICES, for the same reason and with the same stop. This was
      // a single unpaged call — one 100-row page, no truncation signal — feeding
      // deriveHistoricSpend, three lines under an appointment read that had already
      // been paged for exactly this. Historic spend ranks who gets chased and shapes
      // what they are offered, so a long-standing patient whose older invoices sat
      // past page one was scored on a fraction of what they have actually spent.
      const invoiceRows: unknown[] = [];
      let invoicesExpected: number | null = null;
      for (let ip = 1; ip <= 20; ip += 1) {
        const r = await client.getPatientInvoices(patient.id, ip, PER_PAGE);
        const rows = Array.isArray(r.invoices) ? r.invoices : [];
        // Page one carries the count. Live read-only probe, 2026-08-22: /v1/invoices
        // reports meta.total 34,209 unfiltered and 1 for a sampled `patient_id`, with
        // the returned row belonging to that patient — the total describes the
        // request, so it can be compared against what this walk holds.
        if (ip === 1) invoicesExpected = metaTotal(r.meta);
        invoiceRows.push(...rows);
        if (rows.length < PER_PAGE) break;
      }
      // A SHORT WALK IS AN UNREAD PATIENT, degraded exactly as a failed secondary
      // read is: leave them unenriched, so step 4 skips them and the high-water mark
      // does NOT advance past them, and the next run tries again. The alternative is
      // scoring somebody on a spend figure we know is missing rows — the reactivation
      // equivalent of the balance the collection sweep refuses to quote.
      if (invoicesExpected !== null && invoiceRows.length < invoicesExpected) {
        console.warn(
          `[reactivation] patient ${patient.id}: invoice read held ${invoiceRows.length} of the ` +
            `${invoicesExpected} Dentally says match; leaving them unenriched for the next run ` +
            `rather than scoring them on a partial spend history.`,
        );
        return;
      }
      const appts = summariseAppointments({ appointments: all }, now);
      enriched.set(patient.id, {
        lastVisitAt: appts.lastVisitAt,
        futureBookingExists: appts.futureBookingExists,
        historicSpend: deriveHistoricSpend({ invoices: invoiceRows }),
      });
    } catch {
      // leave unset -> skipped in step 4
    }
  });

  // 4. Classify each enriched patient into a cohort (no Dentally I/O). Advance the
  //    high-water mark only for FULLY-processed (enriched) patients, in page order.
  const targets = [];
  let highWaterMark = updatedAfter ?? null;
  // Patients this run has just seen with a future booking. The enrol pass below
  // reads STORED rows, which can be stale, so this is the freshest evidence we
  // have that a patient no longer needs chasing.
  const rebookedIds = new Set<string>();
  for (const { p, patient } of pending) {
    const data = enriched.get(patient.id);
    if (!data) continue; // failed secondary read: skip, do not advance the mark past them

    const open = openByPatient.get(patient.id) ?? { plan: null, amountOutstanding: 0 };
    const input: ReactivationInput = {
      siteId,
      patient,
      lastVisitAt: data.lastVisitAt,
      futureBookingExists: data.futureBookingExists,
      plan: open.plan,
      amountOutstanding: open.amountOutstanding,
      historicSpend: data.historicSpend,
      lastTouchAt: null,
    };

    const target = toReactivationTarget(input, now, cfg);

    // Stop chasing a patient who has self-served or no longer qualifies, if they are
    // mid-cadence: END the cadence. The LABEL must say why: a future booking is a
    // genuine re-engagement ('converted' — staff read that stat as "booked back in"),
    // while aging past the lapse ceiling / otherwise dropping out is a retirement
    // ('exhausted'). Lumping both under 'converted' inflated the re-engaged number
    // with patients who never booked anything.
    const stoppedQualifying = input.futureBookingExists || !target;
    const targetId = `${siteId}:${patient.id}`;
    if (input.futureBookingExists) rebookedIds.add(targetId);
    if (stoppedQualifying && inCadenceIds.has(targetId)) {
      const settledAs = input.futureBookingExists ? "converted" : "exhausted";
      const cad = await getCadenceByTarget(targetId);
      if (cad && (cad.status === "active" || cad.status === "paused")) {
        await updateCadence(cad.id, { status: settledAs, endedAt: now.toISOString() });
      }
      await setTargetStatus(targetId, settledAs);
      if (settledAs === "converted") converted += 1;
    }

    // Recall owns a patient from due-soon through the grace boundary. While an
    // open recall row exists (due / in_cadence) reactivation must not chase the
    // SAME patient for ANY reason, not just overdue_recall: a long-interval
    // recall only lightly overdue can independently trip the `lapsed` rule
    // (last real visit past the lapse threshold) and, without this, the patient would be
    // contacted by both modules at once. Recall hands off (graduated) past the
    // grace boundary, at which point the key leaves openRecall and reactivation
    // legitimately adopts the patient. Also never (re-)enrol a patient with a
    // future booking.
    if (target && !input.futureBookingExists && !openRecall.has(target.id)) {
      targets.push(target);
    }

    const updated = patientUpdatedAt(p);
    if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
  }

  const ranked = rankTargets(targets, now);
  await upsertTargets(ranked);

  // BACKFILL cursor safety (review-caught): the resume unit is a whole PAGE, but a
  // per-patient enrichment read can fail (caught above), leaving that patient
  // unclassified. Advancing the cursor past that page would skip them for the ENTIRE
  // backfill (the only pass that sees never-updated patients) with no self-heal. So
  // only advance PAST pages whose patients were ALL enriched: rewind to just before the
  // earliest failed page, and only complete when the final page was reached AND nothing
  // was skipped. A transient failure therefore re-pages next run (idempotent upserts)
  // instead of dropping the patient.
  let firstFailedPage: number | null = null;
  if (backfilling) {
    for (const { patient, page: pg } of pending) {
      if (!enriched.has(patient.id) && (firstFailedPage === null || pg < firstFailedPage)) {
        firstFailedPage = pg;
      }
    }
  }
  const safeCursor = firstFailedPage !== null ? firstFailedPage - 1 : lastCompletedPage;
  const backfillComplete = backfilling && reachedEnd && firstFailedPage === null;

  if (backfilling) {
    if (backfillComplete) {
      // Mark done AND seed the incremental watermark in ONE atomic upsert, so a partial
      // write can never leave done=true with an unset mark (which would drop into a
      // capped, un-ordered scan that re-strands patients).
      await setBackfillCursor(siteId, RESOURCE, { page: lastCompletedPage, done: true, highWaterMark: now.toISOString() });
    } else {
      // More pages (or a failed page to retry): persist the safe cursor to resume from.
      await setBackfillCursor(siteId, RESOURCE, { page: safeCursor, done: false });
    }
  } else if (highWaterMark) {
    // Incremental: advance the updated_after mark (only when a record contributed one),
    // so the next run re-fetches rather than skipping when nothing did.
    await setSyncState(siteId, RESOURCE, highWaterMark);
  }

  // -------------------------------------------------------------------------
  // AUTO-ENROL. Exactly the recall defect: the enrol action exists but no screen
  // calls it, so thousands of classified targets sat dormant with no cadence and
  // switching reactivation on sent nothing at all. Bounded, consent-gated, and it
  // never enrols a patient the sweep would then refuse to message.
  //
  // The allowance is computed ONCE per run in POST (kill switch, the owner's
  // daily contact limit, cadences already waiting to send, hard per-run ceiling)
  // and SHARED across sites, so three sites cannot each spend the day's budget.
  //
  // Deliberately LAST: an enrolment write that fails must not cost this run its
  // cursor progress, which is the expensive part of the pass.
  // -------------------------------------------------------------------------
  let enrolled = 0;
  if (allowance.remaining > 0) {
    // A bounded window of the worklist, not the whole lapsed book: with no upper
    // bound on the lapse window a site can hold tens of thousands of dormant rows,
    // and pulling them all into a 300s function to pick at most 25 is waste. The
    // window is ordered most-recently-lapsed first (see listTargets), which is
    // exactly the order we want to spend a squeezed budget in.
    const dormant = await listTargets({ siteIds: [siteId], statuses: ["dormant"], limit: ENROL_WINDOW });
    // One query for the site's cadences rather than a read per target: a target
    // that has ever been enrolled is never enrolled a second time.
    const alreadyEnrolled = new Set((await listCadences([siteId])).map((c) => c.targetId));
    let considered = 0;
    for (const t of dormant) {
      if (allowance.remaining <= 0) break;
      considered += 1;
      if (alreadyEnrolled.has(t.id)) continue;
      // The configured lapse ceiling (unlimited by default), the same gate the enrol
      // action applies: a stored row ages while the sync only re-pulls patients
      // Dentally marks updated, so a stale target can sit past a ceiling the practice
      // has since set. Still refuses a target with no provable visit at all.
      if (!withinLapseWindow(t.lastVisitAt, now, cfg.maxLapseMonths)) continue;
      // Step 1 is an SMS: no consent means a manual call, never a message.
      if (!t.consent.sms) continue;
      // Platform admin status (inactive / do not contact) excludes this patient.
      if (allowance.excludedKeys.has(excludedTargetKey(t.siteId, t.dentallyPatientId))) continue;
      // Recall owns the patient until it hands off, so never chase them twice.
      if (openRecall.has(t.id)) continue;
      // Booked in since: nothing to re-engage.
      if (rebookedIds.has(t.id)) continue;

      await createCadence({ targetId: t.id, siteId, nextDueAt: now.toISOString() });
      await setTargetStatus(t.id, "in_cadence");
      allowance.remaining -= 1;
      enrolled += 1;
    }
    // Observability for the one way the bounded window can misbehave: rows that can
    // never be enrolled (no SMS consent, admin-excluded) stay dormant and sit at the
    // top of a recency-ordered window for ever. If a FULL window yielded nobody, the
    // window has silted up and needs widening, so say so rather than looking idle.
    if (enrolled === 0 && considered >= ENROL_WINDOW) {
      console.warn(
        `[reactivation] site ${siteId}: no enrollable target in the newest ${ENROL_WINDOW} dormant rows; widen ENROL_WINDOW`,
      );
    }
  }

  const mode = backfilling ? (backfillComplete ? "backfill-done" : "backfill") : "incremental";
  return {
    siteId,
    pulled,
    upserted: ranked.length,
    converted,
    enrolled,
    processed,
    remaining,
    mode,
    backfillPage: backfilling ? safeCursor : null,
    // TRUE when the shared Dentally budget refused this run mid-enrichment. The
    // unenriched patients are handled exactly as a failed read, so the backfill
    // cursor rewinds to just before their page: coverage is partial, nobody is lost.
    budgetRefused: budgetRefused || undefined,
  };
}

async function handleWithDentallyPriority(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  // Never overlap with another reactivation sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-reactivation", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      // This sync only READS (listTreatmentPlans / listPatients /
      // getPatientAppointments / getPatientInvoices). Arms the write latch so the
      // key it carries — which is NOT read-only despite its name, see client.ts
      // assertWritable — cannot issue a write from here.
      readOnly: true,
    });
    const cfg = await config("vitality");
    const sites = vitalitySiteIds();
    // TEMPORARY N15-first acceleration for the client handoff: while N15's one-time
    // historical backfill is unfinished, devote the whole run to N15 with a larger
    // (still proven-safe) cap so it completes fastest. The other two sites pause and
    // resume automatically the moment N15's backfill flips to done. This keeps the
    // per-run Dentally load in line with the normal all-three run (one site's plan
    // index + ~900 patients), so it adds no extra rate-limit pressure.
    const FOCUS_SITE = "site-cc"; // N15 Vitality Dental
    const FOCUS_CAP = 900;
    const focusCursor = sites.includes(FOCUS_SITE)
      ? await getBackfillCursor(FOCUS_SITE, RESOURCE)
      : { page: null, done: true };
    let ordered: string[];
    let capFor: number;
    if (!focusCursor.done) {
      ordered = [FOCUS_SITE];
      capFor = FOCUS_CAP;
    } else {
      // Normal steady state: rotate which site goes first each run (by hour), so a
      // budget squeeze can never PERMANENTLY starve whichever site is listed last.
      const offset = sites.length > 0 ? new Date().getUTCHours() % sites.length : 0;
      ordered = [...sites.slice(offset), ...sites.slice(0, offset)];
      capFor = MAX_PATIENTS_PER_RUN;
    }
    // How many cadences this whole run may start. Read once, shared by every site:
    // the daily contact limit counts messages across all three, so a per-site
    // budget would let the run enrol three times the day's allowance. Everything
    // is skipped while the owner has reactivation switched off.
    const now = new Date();
    const systemEnabled = await isSystemEnabled("vitality", "reactivation");
    const [dailyLimit, usedToday, dueCadences] = systemEnabled
      ? await Promise.all([
          getDailyContactLimit("vitality"),
          countContactedToday(now),
          listDueCadences(now.toISOString()),
        ])
      : [0, 0, []];
    const allowance: EnrolAllowance = {
      remaining: enrolmentBudget({
        systemEnabled,
        dailyLimit,
        usedToday,
        // Cadences already due will spend today's budget; enrolling on top of them
        // just piles up messages the sweep cannot serve today.
        pendingDue: dueCadences.length,
        perRunCap: MAX_ENROLMENTS_PER_RUN,
      }),
      excludedKeys: new Set<string>(),
    };
    if (allowance.remaining > 0) {
      allowance.excludedKeys = await loadExcludedTargetKeys();
    }
    const enrolBudget = allowance.remaining;

    // One site's failure must not abort the rest: record the error and move on so a
    // partial failure is observable and self-heals next tick (no all-or-nothing 500).
    const perSite: Array<Record<string, unknown>> = [];
    for (const siteId of ordered) {
      // STOP AT A SITE BOUNDARY WHEN THE BUDGET HAS GONE. A refusal is sticky for
      // this whole run (src/lib/dentally/budget.ts), so the next site could not read
      // a single row: it would spend function time to produce an empty result. The
      // site rotation above means whichever sites are dropped here lead the next run.
      if (dentallyScopeRefused()) {
        console.warn(
          `[sync-reactivation] stopping before site ${siteId}: the shared Dentally budget is spent ` +
            `for background work this hour. The next tick resumes from here.`,
        );
        break;
      }
      try {
        perSite.push(await syncSite(client, siteId, cfg, allowance, capFor));
      } catch (e) {
        perSite.push({ siteId, error: String(e) });
      }
    }
    // budgetRefused is NOT a failure: the run did what it was allowed to do and the
    // next tick continues. Reported so an operator can tell "the practice's hourly
    // Dentally quota ran out" apart from "this sync is broken".
    const refusal = dentallyScopeRefusal();
    return Response.json({
      ok: true,
      budgetRefused: refusal !== null,
      budgetRefusalReason: refusal?.reason ?? null,
      enrolBudget,
      enrolUnspent: allowance.remaining,
      perSite,
    });
  } finally {
    await releaseCronLock("sync-reactivation");
  }
}

// EVERY Dentally read inside this handler is BACKGROUND work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): it is starved first, at 60%
// consumption, so a bulk sweep can never be the reason a practice manager's screen or
// a patient's booking calendar goes blank. A refusal aborts this run; the next tick
// retries. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
