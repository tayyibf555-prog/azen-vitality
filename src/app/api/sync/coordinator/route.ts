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
  getBackfillCursor,
  setBackfillCursor,
} from "@/lib/coordinator/repository";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

import { dentallyReadKey } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "coordinator";
const PER_PAGE = 100;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;
// Concurrency for the per-patient treatment-plan reads, matching the recall sync's
// per-patient enrichment. Bounded so a site finishes fast without spiking Dentally.
const PLAN_CONCURRENCY = 8;
// Pages of ONE patient's treatment plans. Live Dentally carries ~1.6 plans per
// patient, so this is only ever reached by a pathological record.
const MAX_PLAN_PAGES_PER_PATIENT = 20;
// Stored OPEN opportunities re-checked per run on top of this run's patient window,
// oldest-checked first. Incremental mode only sees patients whose record changed, and
// completing a plan need not touch the patient record, so without this a settled plan
// could be chased forever. Bounded so the extra reads stay inside the run budget.
const MAX_RECHECK_PATIENTS = 100;

// ===========================================================================
// CALIBRATION: field paths as they exist on LIVE Dentally (verified 2026-07-26
// against api.dentally.co, 84,806 real treatment plans).
//
// The coordinator needs accepted-but-incomplete treatment plans joined to the
// patient (names + consent). Everything about the raw Dentally JSON shape lives
// here.
//   - treatment_plans[] -> id, patient_id, nickname (the label, often null),
//                          private_treatment_value (a STRING such as "80.0"),
//                          completed (boolean), completed_at.
//                          There is NO amount_outstanding / outstanding /
//                          balance field: reading one yields undefined for every
//                          plan, which is what left this module holding zero rows.
//   - patients[]        -> id, names, active, consent (use_sms/use_email/marketing)
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

/**
 * A GBP money field, returned as `null` when it is absent OR unparseable.
 *
 * Live Dentally sends `private_treatment_value` as a STRING ("80.0"), so a plain
 * `typeof v === "number"` read misses it entirely. The null (rather than a 0
 * default) matters: a value we could not read is NOT the same as a plan with
 * nothing left to do, and must never be silently treated as settled.
 */
function pickMoney(o: Raw, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
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

/**
 * Map one raw treatment plan. Returns null when the plan cannot be read at all
 * (no id, or no value we can trust). The caller records those separately so an
 * unreadable plan drops out of the run WITHOUT being mistaken for a settled one.
 */
function mapPlan(tp: Raw): PlanInput | null {
  const id = pickString(tp, "id");
  if (!id) return null;

  const completed = pickBoolean(tp, "completed") ?? false;
  // The plan's money. Live Dentally exposes only the treatment value; the mock
  // (and the older calibration) carried an explicit outstanding figure, which
  // stays authoritative wherever it is present.
  const outstanding = pickMoney(tp, "amount_outstanding", "outstanding", "balance");
  const value = pickMoney(
    tp,
    "private_treatment_value",
    "planned_private_treatment_value",
    "total",
    "value",
    "fee",
  );
  // Live Dentally publishes no partial-completion figure, so for an incomplete
  // plan the WHOLE treatment value is what is still to be done; a completed plan
  // has nothing left. NHS-only plans carry a private value of 0 and therefore
  // fall out as non-opportunities, which is correct.
  const amountOutstanding = outstanding ?? (completed ? 0 : value);
  if (amountOutstanding === null) return null; // unreadable: never assume zero

  return {
    id,
    // Real Dentally plans have no `name`; `nickname` is the (often null) label.
    name: pickString(tp, "nickname", "name", "title", "description") ?? "Treatment plan",
    plannedValue: value ?? outstanding ?? 0,
    amountOutstanding,
    acceptedAt:
      pickString(tp, "accepted_at", "acceptedAt", "start_date", "created_at") ??
      new Date().toISOString(),
    status: pickString(tp, "status", "state") ?? null,
    completed,
    financePresented: pickBoolean(tp, "finance_presented", "financePresented") ?? false,
  };
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

/** Run `fn` over items with a small worker pool (bounds Dentally load + run time). */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** One patient's complete current plan set, as read this run. */
interface PlanScan {
  /** Readable plans, keyed by plan id. */
  byId: Map<string, PlanInput>;
  /** Plan ids we saw but could not read a value for: never retire these. */
  unreadable: Set<string>;
  /**
   * True only when Dentally honoured the patient_id filter, i.e. every row we got
   * back really belongs to this patient. When false the scan is INCOMPLETE by
   * definition (we were served the practice-wide index and stopped after a page),
   * so it may create opportunities but must never retire anything.
   */
  reliable: boolean;
}

/**
 * Every treatment plan belonging to one patient.
 *
 * Per patient rather than a practice-wide scan: live Dentally holds 84,806 plans
 * and IGNORES `site_id` on /v1/treatment_plans (the same trap the old dentally
 * sync hit), so a site-wide scan is both unbounded and un-scoped. The patient_id
 * filter is scoped by construction, and the run is already bounded to at most
 * MAX_PATIENTS_PER_RUN patients.
 *
 * Returns null when the read failed: a failed read must never look like "this
 * patient has no open plans", which would retire live opportunities.
 */
async function fetchPlansForPatient(
  client: DentallyClient,
  dentallySite: string,
  patientId: string,
): Promise<PlanScan | null> {
  const byId = new Map<string, PlanInput>();
  const unreadable = new Set<string>();
  let reliable = true;
  try {
    for (let pp = 1; pp <= MAX_PLAN_PAGES_PER_PATIENT; pp += 1) {
      const res = await client.listTreatmentPlans({
        siteId: dentallySite,
        patientId,
        page: pp,
        perPage: PER_PAGE,
      });
      const rows = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
      let foreign = false;
      for (const raw of rows) {
        const tp = asRecord(raw);
        // Belt-and-braces: only keep rows that really are this patient's. If the
        // source ignored patient_id we must not attribute another patient's plan
        // to this one, and we must not trust the scan for retirement either.
        if (pickString(tp, "patient_id", "patientId") !== patientId) {
          foreign = true;
          continue;
        }
        const id = pickString(tp, "id");
        if (!id) continue;
        const plan = mapPlan(tp);
        if (!plan) {
          unreadable.add(id);
          continue;
        }
        byId.set(plan.id, plan);
      }
      if (foreign) {
        // The filter was not honoured: paging on would walk the whole practice
        // index once per patient. Stop with what matched and flag the scan.
        reliable = false;
        break;
      }
      if (rows.length < PER_PAGE) break;
    }
  } catch {
    return null;
  }
  return { byId, unreadable, reliable };
}

/**
 * Rebuild a PatientInput from an already-stored opportunity, for the re-check pass
 * (those patients are outside this run's patient window, so we hold no fresh
 * Dentally record for them and spending a getPatient call each would double the
 * reads). Name + consent are workflow-visible only; the plan values are refreshed
 * from the live scan, which is the point of the pass.
 */
function patientFromStored(opp: TreatmentOpportunity): PatientInput {
  const parts = opp.patientName.trim().split(/\s+/);
  return {
    id: opp.dentallyPatientId,
    first_name: parts[0] ?? "",
    last_name: parts.slice(1).join(" "),
    use_sms: opp.consent.sms,
    use_email: opp.consent.email,
    marketing: opp.consent.marketing,
  };
}

interface SiteResult {
  siteId: string;
  pulled: number;
  upserted: number;
  retired: number;
  excludedSettled: number;
  processed: number;
  remaining: number;
  /** Patients whose plan read failed this run (retried next tick, never retired). */
  planReadFailures: number;
  /** Plans seen but dropped because their value could not be read. */
  unreadablePlans: number;
  /** Stored open opportunities re-checked on top of this run's patient window. */
  rechecked: number;
  /**
   * True when the backfill made NO forward progress and cannot on the next tick
   * either: page 1 failed, so the saved cursor is 0 and the run restarts where it
   * began. Reported so a permanently stalled site is not mistaken for a quiet one.
   */
  stalled?: boolean;
  /** True when Dentally ignored the patient_id filter: retirement was suppressed. */
  planFilterIgnored: boolean;
  mode: string;
  backfillPage: number | null;
}

async function syncSite(client: DentallyClient, siteId: string): Promise<SiteResult> {
  const now = new Date();
  const dentallyId = dentallySiteId(siteId);

  // Backfill vs incremental (mirrors the recall/reactivation syncs, which hit the
  // exact same trap): Dentally's /v1/patients has NO sort control, so an
  // updated_after high-water mark + a per-run cap STRANDS almost the whole base on
  // a from-scratch pass: the first run's mark jumps to the newest updated_at among
  // its 300 patients and every older-updated patient is filtered out forever.
  // Until the one-time full pass finishes we page EVERY patient by page number
  // (cursor in sync_state.backfill_page/backfill_done); after that we switch to
  // the updated_after mark, which then only ever sees the small changed set.
  const cursor = await getBackfillCursor(siteId, RESOURCE);
  const backfilling = !cursor.done;
  // `cursor.page != null`, NOT a truthiness test: a saved cursor of 0 means "page 1
  // failed, start again there", and treating 0 as absent made that indistinguishable
  // from "no cursor yet". Both resume at page 1, so this is a clarity fix rather than
  // a behaviour change, but the zero-progress guard below depends on the distinction.
  const startPage = backfilling && cursor.page != null ? cursor.page + 1 : 1;
  const mainState = backfilling ? null : await getSyncState(siteId, RESOURCE);
  const updatedAfter = backfilling ? undefined : (mainState?.highWaterMark ?? undefined);

  // 1. Page patients, collecting raw records with NO per-patient I/O yet. BACKFILL
  //    takes WHOLE pages (the resume unit is a page); INCREMENTAL caps mid-page.
  //    Both bound the run, so the plan reads below can never become unbounded.
  //
  //    Inactive in Dentally (deceased, moved away, left the practice): NEVER an
  //    opportunity, because chasing a deceased patient's unpaid plan is the worst message
  //    this system could send. Kept in `pending` (not dropped) so any
  //    PREVIOUSLY-stored open opportunity for them is settled below.
  //
  //    NOTE: the live patient record has NO `archived` field (only
  //    `archived_reason`), so the `archived === true` test this code used to carry
  //    could never fire against real Dentally. `active === false` is the real
  //    safeguard and is the one kept.
  const pending: Array<{ p: Raw; patient: PatientInput; page: number; excluded: boolean }> = [];
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let lastCompletedPage = startPage - 1;
  let reachedEnd = false;

  for (let page = startPage; ; page += 1) {
    const res = await client.listPatients({ siteId: dentallyId, updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;

      // Incremental cap reached: stop before processing this patient and leave the
      // mark at the last fully-processed record so the next tick resumes from here.
      if (!backfilling && processed >= MAX_PATIENTS_PER_RUN) {
        remaining += 1;
        continue;
      }

      pending.push({ p, patient, page, excluded: p.active === false });
      processed += 1;
    }

    lastCompletedPage = page;
    if (rawPatients.length < PER_PAGE) {
      reachedEnd = true;
      break;
    }
    if (processed >= MAX_PATIENTS_PER_RUN) break; // resume from this boundary next run
  }

  // 2. The site's stored OPEN opportunities. Needed both to settle excluded
  //    patients and to drive the bounded re-check pass.
  const stored = await listOpportunities({
    siteIds: [siteId],
    statuses: ["accepted", "in_progress", "stalled"],
  });

  const windowPatientIds = new Set(pending.map((x) => x.patient.id));
  // Re-check set: patients who hold an open opportunity but are NOT in this run's
  // patient window, oldest-checked first so every one comes round in turn.
  const recheckByPatient = new Map<string, TreatmentOpportunity>();
  for (const opp of [...stored].sort((a, b) =>
    a.updatedFromDentallyAt < b.updatedFromDentallyAt ? -1 : a.updatedFromDentallyAt > b.updatedFromDentallyAt ? 1 : 0,
  )) {
    if (windowPatientIds.has(opp.dentallyPatientId)) continue;
    if (recheckByPatient.has(opp.dentallyPatientId)) continue;
    recheckByPatient.set(opp.dentallyPatientId, opp);
    if (recheckByPatient.size >= MAX_RECHECK_PATIENTS) break;
  }

  // 3. Read each patient's plans with bounded concurrency. A failed read leaves the
  //    patient unscanned: no opportunity, no retirement, retried next run.
  const scanByPatient = new Map<string, PlanScan>();
  // Patients whose plan picture is NOT trustworthy this run: the read failed, or the
  // source ignored patient_id so we were served the practice-wide index. The cursor
  // must not advance past them (see step 7) or they are skipped until Dentally
  // happens to re-stamp their record, which for the coordinator could be never.
  const scanFailed = new Set<string>();
  let planReadFailures = 0;
  let planFilterIgnored = false;
  // Deduped: pagination drift can serve the same patient on two pages, and one
  // Dentally read per patient per run is the whole point of doing it this way.
  const toScan = [
    ...new Set([
      ...pending.filter((x) => !x.excluded).map((x) => x.patient.id),
      ...recheckByPatient.keys(),
    ]),
  ];
  await mapWithConcurrency(toScan, PLAN_CONCURRENCY, async (patientId) => {
    const scan = await fetchPlansForPatient(client, dentallyId, patientId);
    if (!scan) {
      planReadFailures += 1;
      scanFailed.add(patientId);
      return;
    }
    if (!scan.reliable) {
      planFilterIgnored = true;
      scanFailed.add(patientId);
    }
    scanByPatient.set(patientId, scan);
  });
  if (planFilterIgnored) {
    console.error(
      `[sync-coordinator] site ${siteId}: Dentally ignored the patient_id filter on /v1/treatment_plans; ` +
        `plan scans are incomplete this run, so NO opportunity was retired. Investigate before trusting the worklist.`,
    );
  }

  // 4. Build opportunities. One per patient, the highest-value open plan, which
  //    keeps the worklist a ranked shortlist rather than one row per plan.
  const opportunities = [];
  let unreadablePlans = 0;
  const excludedPatientIds = new Set<string>();
  for (const { patient, excluded } of pending) {
    if (excluded) {
      excludedPatientIds.add(patient.id);
      continue;
    }
    const scan = scanByPatient.get(patient.id);
    if (!scan) continue;
    unreadablePlans += scan.unreadable.size;
    const plan = bestOpenPlan(scan);
    if (!plan) continue;
    const input: CoordinatorInput = { siteId, patient, plan, lastTouchAt: null };
    const opportunity = toTreatmentOpportunity(input, now);
    if (opportunity) opportunities.push(opportunity);
  }
  // Re-checked patients: refresh their plan values off the same scan, reusing the
  // stored row's name + consent (their Dentally record is outside this window).
  for (const [patientId, opp] of recheckByPatient) {
    const scan = scanByPatient.get(patientId);
    if (!scan) continue;
    unreadablePlans += scan.unreadable.size;
    const plan = scan.byId.get(opp.dentallyPlanId);
    if (!plan) continue;
    const input: CoordinatorInput = {
      siteId,
      patient: patientFromStored(opp),
      plan,
      lastTouchAt: opp.lastTouchAt,
    };
    const refreshed = toTreatmentOpportunity(input, now);
    if (refreshed) opportunities.push(refreshed);
  }

  const ranked = rankOpportunities(opportunities, now);
  await upsertOpportunities(ranked);

  // 5. Settle open opportunities for inactive patients seen this run: the exclusion
  //    is patient-flag based, so it holds regardless of what the plan reads did.
  let excludedSettled = 0;
  for (const opp of stored) {
    if (excludedPatientIds.has(opp.dentallyPatientId)) {
      await setOpportunityStatus(opp.id, "completed");
      excludedSettled += 1;
    }
  }

  // 6. Retire settled opportunities. For every patient we scanned this run we hold
  //    their COMPLETE current plan set, so an opportunity whose plan is now
  //    completed, gone or terminal can be closed with confidence. Patients we did
  //    not scan (outside the window, failed read, or an unreliable scan) are left
  //    exactly as they are: a late retire is recoverable, a wrong one is not.
  const TERMINAL = ["completed", "declined", "rejected", "cancelled"];
  let retired = 0;
  for (const opp of stored) {
    if (excludedPatientIds.has(opp.dentallyPatientId)) continue; // settled above
    const scan = scanByPatient.get(opp.dentallyPatientId);
    if (!scan || !scan.reliable) continue;
    if (scan.unreadable.has(opp.dentallyPlanId)) continue; // value unreadable: do not judge it
    const plan = scan.byId.get(opp.dentallyPlanId);
    const stillOpen =
      plan !== undefined &&
      plan.completed !== true &&
      plan.amountOutstanding > 0 &&
      !TERMINAL.includes((plan.status ?? "").toLowerCase());
    if (!stillOpen) {
      await setOpportunityStatus(opp.id, "completed");
      retired += 1;
    }
  }

  // 7. Persist the cursor, and NEVER advance it past a patient whose plan read did
  //    not come back cleanly. The patient feed is unordered, so a mark that steps
  //    over a failed patient loses them until Dentally re-stamps their record, which
  //    for a treatment plan may be never. Recall protects against exactly this; the
  //    coordinator now does too.
  //
  //    Incremental: cap the mark just below the earliest failed patient's updated_at.
  //    Backfill: rewind to just before the earliest page holding a failed patient,
  //    and only declare the pass done when the final page was reached with nothing
  //    outstanding (done and the incremental watermark are set in ONE atomic upsert).
  //    Incremental also leaves the prior mark UNCHANGED when no record contributed
  //    one, so the next run re-fetches rather than skipping.
  let highWaterMark = updatedAfter ?? null;
  let minFailedUpdated: string | null = null;
  let firstFailedPage: number | null = null;
  for (const { p, patient, page: pg } of pending) {
    const updated = patientUpdatedAt(p);
    if (scanFailed.has(patient.id)) {
      if (updated && (!minFailedUpdated || updated < minFailedUpdated)) minFailedUpdated = updated;
      if (firstFailedPage === null || pg < firstFailedPage) firstFailedPage = pg;
      continue;
    }
    if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
  }
  if (!backfilling && minFailedUpdated && highWaterMark && highWaterMark >= minFailedUpdated) {
    const capped = new Date(new Date(minFailedUpdated).getTime() - 1000).toISOString();
    highWaterMark = updatedAfter && capped < updatedAfter ? updatedAfter : capped;
  }

  const safeCursor = firstFailedPage !== null ? firstFailedPage - 1 : lastCompletedPage;
  const backfillComplete = backfilling && reachedEnd && firstFailedPage === null;

  // ZERO-PROGRESS GUARD. If the very first page fails, safeCursor is 0, the next run
  // starts at page 1 again, and the backfill re-scans the same page forever making no
  // progress at all. The likeliest cause is the plan source ignoring the patient_id
  // filter (planFilterIgnored), which fails EVERY patient on EVERY page, so the stall
  // is total and permanent rather than a transient bad page. That must never be
  // silent: a run that scanned nothing and advanced nothing looks identical in the
  // cron history to a healthy no-op. Surface it so the site is reported as failed.
  const noForwardProgress = backfilling && firstFailedPage !== null && safeCursor <= 0 && startPage === 1;
  if (noForwardProgress) {
    console.error(
      `[sync/coordinator] ${siteId}: backfill made NO forward progress, page 1 failed and the cursor cannot advance` +
        (planFilterIgnored
          ? ". The plan source ignored the patient_id filter, so every patient on every page fails. This stalls permanently until the source honours it."
          : ". Every patient on the first page failed to scan."),
    );
  }
  if (backfilling) {
    if (backfillComplete) {
      await setBackfillCursor(siteId, RESOURCE, { page: lastCompletedPage, done: true, highWaterMark: now.toISOString() });
    } else {
      await setBackfillCursor(siteId, RESOURCE, { page: safeCursor, done: false });
    }
  } else if (highWaterMark && highWaterMark !== (updatedAfter ?? null)) {
    await setSyncState(siteId, RESOURCE, highWaterMark);
  }

  const mode = backfilling ? (backfillComplete ? "backfill-done" : "backfill") : "incremental";
  return {
    siteId,
    pulled,
    upserted: ranked.length,
    retired,
    excludedSettled,
    processed,
    remaining,
    planReadFailures,
    unreadablePlans,
    rechecked: recheckByPatient.size,
    planFilterIgnored,
    mode,
    backfillPage: backfilling ? safeCursor : null,
    // Reported per site so a permanently stalled backfill is distinguishable from a
    // healthy quiet run, which is exactly the confusion C4 set out to remove.
    stalled: noForwardProgress || undefined,
  };
}

/** The patient's highest-value plan that still has work outstanding, if any. */
function bestOpenPlan(scan: PlanScan): PlanInput | null {
  let best: PlanInput | null = null;
  for (const plan of scan.byId.values()) {
    if (plan.completed === true) continue;
    if (!(plan.amountOutstanding > 0)) continue;
    if (!best || plan.amountOutstanding > best.amountOutstanding) best = plan;
  }
  return best;
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
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
    const failedSites: string[] = [];
    for (const siteId of vitalitySiteIds()) {
      try {
        const result = await syncSite(client, siteId);
        perSite.push({ ...result });
        // A stalled backfill is a failure even though nothing threw: the site made no
        // forward progress and will make none on the next tick either. Counting it as
        // a failed site is the whole point of C4, otherwise it reads as a healthy run.
        if (result.stalled) failedSites.push(siteId);
      } catch (e) {
        // A site that fails on every tick used to be invisible: the run still
        // answered ok:true, so the cron history looked green for days. Name the
        // failure in the body AND in the log.
        console.error(`[sync-coordinator] site ${siteId} failed`, e);
        perSite.push({ siteId, error: String(e) });
        failedSites.push(siteId);
      }
    }
    // Deliberately still HTTP 200 with ok:false, not a 5xx: the caller is
    // public.trigger_app_cron() from pg_cron, which fires the request from
    // Postgres and records the SQL result (not the HTTP status) in
    // cron.job_run_details, so a non-200 would be swallowed exactly where an
    // operator looks. ok:false + failedSites is the signal that actually surfaces.
    return Response.json({ ok: failedSites.length === 0, failedSites, perSite });
  } finally {
    await releaseCronLock("sync-coordinator");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
