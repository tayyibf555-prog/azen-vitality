import { dentallyScopeRefused } from "@/lib/dentally/budget";
import { DentallyClient, DentallyError } from "@/lib/dentally/client";
import { normaliseAppointmentState, isAttendedState } from "@/lib/dentally/appointment-state";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { MINING_MIN_AGE, ageAt, matchExtraction, sanitiseFreeText } from "@/lib/triage/extraction-match";
import {
  MINING_MAX_PAGES_PER_WINDOW,
  MINING_MAX_PATIENT_READS_PER_RUN,
  nextWindow,
} from "@/lib/triage/mining";
import { getCoverage, recordScanRun, upsertCandidate } from "@/lib/triage/mining-repository";

// ===========================================================================
// THE IMPLANT-INTEREST MINING ENGINE. Read-only, bounded, resumable, honest.
//
// It walks BACKWARDS through the appointment book, ONE DAY AT A TIME, looks for
// extraction text, resolves each distinct patient once for a date of birth, and
// records both the candidates AND how far back it has read.
//
// Shared by two doors (the scheduler's and the owner's "Build candidates"
// button), which is why it lives beside them rather than inside either: a second
// copy of a bounded, budgeted Dentally scan is a second copy of every bound.
//
// ---------------------------------------------------------------------------
// WHY BACKWARDS THROUGH THE DIARY RATHER THAN A PATIENT SCAN.
// ---------------------------------------------------------------------------
// Established by probe, not assumed. There is no Dentally read that answers "every
// patient who has ever had an extraction":
//
//   /v1/appointments          the ONLY endpoint carrying plain-English procedure
//                             text (`reason`). Practice-wide but DATE-WINDOWED:
//                             site_id + on / after / before, no patient filter.
//   /v1/treatment_plan_items  practice-wide, ~999,000 rows, and it carries NO
//                             treatment name at all — only treatment_id and a
//                             staff `nomenclature` code. A full scan is ~9,900
//                             pages against an hourly budget of 3,600 shared with
//                             production; the reports pager abandons on page one
//                             when meta.total already exceeds the budget.
//   /v1/invoices              line items exist ONLY on the per-invoice detail
//                             route and `include=` is ignored on the index. One
//                             GET per invoice across ~34,000 invoices.
//
// So the window is the only bounded read that answers the question at all, and
// this job's honesty comes from RECORDING THE WINDOW rather than from pretending
// it read everything. `previsit_mining_scan` holds the covered range and the
// screen prints it beside the count.
//
// ===========================================================================
// WHY A DAY AT A TIME, AND WHAT IT FIXED (wave-3 review, 4 Sep 2026).
// ===========================================================================
// The first cut read the whole 30-day window in one paged query and then decided,
// ONCE, whether to advance the coverage row. Two defects fell out of that, in
// opposite directions, and both are gone here:
//
//   IT CLAIMED DAYS IT HAD NEVER READ. `clean` accounted for the PATIENT reads
//   and the shared budget, and not at all for whether the appointment pages had
//   actually exhausted the window. A page that threw (`break`) or a window that
//   ran past MINING_MAX_PAGES_PER_WINDOW with every page full both left the loop
//   with hits found and coverage advanced over the ~1,100 appointments never
//   read. The screen then printed "Built from appointments between D1 and D2" —
//   a completeness claim about a range that was mostly never opened. Any site
//   averaging more than forty appointments a day hit that every single night.
//
//   IT COULD NEVER RECORD ANYTHING AT ALL. One patient whose read failed — a
//   merged record, a blank name — or more matched patients in the window than
//   MINING_MAX_PATIENT_READS_PER_RUN, and `resolvedAll` was false, so the ONE
//   call to recordScanRun never happened. previsit_mining_scan stayed EMPTY,
//   while `upsertCandidate` had already written the names it did resolve. The
//   screen then printed "This list has not been built yet. Nothing has been
//   read" directly above a table of named patients, and, because the coverage
//   row never appeared, `nextWindow(null, now)` handed back the same 30 days
//   every night for ever: the list could not grow past its first window.
//
// A DAY IS THE UNIT OF TRUTH. Reading one day at a time (`on=`, exact — the
// range form pads both edges by a day) means every day the run attempts is
// either fully read or not claimed at all, and a busy site simply covers fewer
// days per run instead of silently losing the tail of every window. Coverage
// advances day by day, so progress is real even when the run stops early.
//
// THE INVARIANT THAT MAKES THE SCREEN HONEST: a candidate row is written only
// for a day that has been fully read AND fully resolved, and its coverage is
// committed in the same breath. So "candidates exist" implies "a coverage row
// exists", and coverageSentence(null) — "Nothing has been read" — can only ever
// be printed above an EMPTY list. That is the complete-or-honest contract
// (charter §0/5) applied to a scan that can never be complete.
//
// ---------------------------------------------------------------------------
// THE BOUNDS.
// ---------------------------------------------------------------------------
//   MINING_DAYS_PER_RUN              30 days of book per run (via nextWindow)
//   MINING_MAX_PAGES_PER_WINDOW      12 pages x 100 rows, now per DAY per site
//   MINING_MAX_PATIENT_READS_PER_RUN 120 distinct getPatient calls per RUN,
//                                    SPLIT EVENLY BETWEEN THE MAPPED SITES
//
// The patient reads are the expensive half, and they are the run's ceiling. When
// a day cannot be finished within them the day is not claimed, the site stops
// there, and the NEXT run starts from the last day that was — which is the
// resumability the old shape only claimed to have.
//
// ---------------------------------------------------------------------------
// WHY THE READS ARE SPLIT PER SITE (ruling W3/25, 5 Sep 2026).
// ---------------------------------------------------------------------------
// They used to be one pot of 120 spent in SITES order, and the site loop broke
// out the moment the pot was empty. The flagship is first in that order and is
// the busiest, so on any night it had 120 patients-worth of extractions in its
// window it consumed the whole run and the other two sites were never opened —
// not "read a little": never opened at all, night after night, with no coverage
// row to say so. A practice with three sites would have watched two of them stay
// permanently at "Nothing has been read".
//
// So each mapped site gets its own even share of the run's reads, and a site
// that exhausts ITS share stops that site rather than the run: the loop moves on
// to the next one. An unused share does NOT roll over — that would restore the
// starvation by the back door — so a quiet run may spend fewer than 120 reads,
// which is the correct trade for a list that grows everywhere instead of in one
// place. The per-run ceiling still holds: shares are cut from the same 120 and a
// site's allowance is clamped to whatever is left of it.
//
// The distinct-patient cache is still shared across sites, so a patient seen at
// two sites is READ once and charged to whichever site reached them first.
// ===========================================================================

const PER_PAGE = 100;
const DAY_MS = 86_400_000;

/**
 * The cron lease both doors take.
 *
 * Named here so the scheduler's run and the owner's button cannot take two
 * different leases and scan the same book twice. The routes still write the
 * literal — src/lib/sweep-leases.area-b.test.ts reads the lease name and
 * duration STATICALLY, and a lease behind a variable is one it cannot prove
 * outlives maxDuration — so this constant is what their tests assert the
 * literal against, which catches the drift at runtime instead.
 */
export const MINING_LOCK = "sweep-previsit-mining";

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}

function pickString(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** YYYY-MM-DD, one day earlier. */
function previousDay(key: string): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * WHY A RUN STOPPED. Reported per site, because "we covered four days" means one
 * thing when the book ran out and another when the practice's own quota did.
 */
export type MiningStop =
  | "complete"
  | "horizon"
  | "patient-budget"
  | "dentally-budget"
  | "appointment-read-failed"
  | "patient-read-failed"
  | "day-too-large";

export interface MiningSiteReport {
  siteId: string;
  window: { from: string; to: string } | null;
  /** Days attempted, and of those, days fully read AND fully resolved. */
  daysAttempted: number;
  daysCovered: number;
  examined: number;
  matched: number;
  candidates: number;
  excludedNoDob: number;
  excludedUnderAge: number;
  /**
   * Patients matched but PERMANENTLY unreadable — the record is gone (404/410)
   * or carries no usable name. Counted apart from `excludedNoDob` on purpose: a
   * patient we could not READ is not the same as a patient with no date of birth
   * (that distinction is the module's own, and it is kept). They do not block the
   * day, because a merged record fails identically every night and a scan that
   * waits for it never moves again.
   */
  unreadable: number;
  /** The oldest day this run could honestly claim, or null when it claimed none. */
  coveredFrom: string | null;
  stoppedBy: MiningStop;
}

export interface MiningRunReport {
  patientReads: number;
  budgetRefused: boolean;
  sites: MiningSiteReport[];
}

/** What one patient read actually told us. */
type PatientVerdict =
  | { kind: "ok"; name: string; dateOfBirth: string | null }
  /** Gone for good: Dentally 404/410 (deleted or merged), or no usable name. */
  | { kind: "permanent" }
  /** A timeout, a 5xx, a 429 — worth another night. */
  | { kind: "transient" };

async function readPatient(client: DentallyClient, patientId: string): Promise<PatientVerdict> {
  try {
    const res = await client.getPatient(patientId);
    const p = asRecord(res.patient);
    const first = pickString(p, "first_name", "firstName") ?? "";
    const last = pickString(p, "last_name", "lastName") ?? "";
    const name = `${first} ${last}`.trim() || pickString(p, "name") || "";
    // A read that SUCCEEDED and produced no usable name is not a failure to
    // retry: it will read the same tomorrow. It is a patient we cannot put on a
    // list, counted and moved past.
    if (name === "") return { kind: "permanent" };
    return { kind: "ok", name, dateOfBirth: pickString(p, "date_of_birth", "dateOfBirth") ?? null };
  } catch (err) {
    // The same judgement the shared drain makes about a recipient it cannot
    // resolve: 404/410 is a deleted or merged record and is PERMANENT, so it must
    // not sit at the head of the queue poisoning every future run. Everything
    // else is transient and the day is left for the next run.
    if (err instanceof DentallyError && (err.status === 404 || err.status === 410)) {
      console.warn(`[previsit/mining] patient ${patientId} is gone (Dentally ${err.status}); counted, not retried`);
      return { kind: "permanent" };
    }
    console.warn(`[previsit/mining] could not read patient ${patientId}; leaving the day for the next run`, err);
    return { kind: "transient" };
  }
}

interface Hit {
  patientId: string;
  at: string;
  matchedText: string;
}

interface DayResult {
  examined: number;
  matched: number;
  candidates: Array<{ patientId: string; name: string; age: number; at: string; matchedText: string }>;
  excludedNoDob: number;
  excludedUnderAge: number;
  unreadable: number;
}

type DayOutcome = ({ ok: true } & DayResult) | { ok: false; reason: MiningStop; examined: number };

/**
 * One site, one day: read it completely, resolve everybody it matched, or say
 * why not.
 *
 * NOTHING IS WRITTEN HERE. The candidates are returned for the caller to commit
 * alongside the coverage claim, which is what keeps "a name on the screen" and
 * "a day we have read" from ever coming apart.
 */
async function scanDay(
  client: DentallyClient,
  siteId: string,
  day: string,
  ctx: {
    now: Date;
    /** Per-run distinct-patient cache, shared across days and sites. */
    seen: Map<string, PatientVerdict>;
    /** site:patient keys already counted this run, so a patient with two
     *  extractions in the window is not counted twice. */
    accounted: Set<string>;
    /** Mutable read counter for the whole run. */
    reads: { count: number };
    /**
     * The run-total this SITE may take the counter to. Cut from the run's own
     * ceiling (ruling W3/25) so one busy site cannot spend another's share; the
     * counter itself stays run-wide, because a patient read once is read once.
     */
    readCeiling: number;
  },
): Promise<DayOutcome> {
  let examined = 0;
  const hits = new Map<string, Hit>();

  for (let page = 1; page <= MINING_MAX_PAGES_PER_WINDOW; page += 1) {
    if (dentallyScopeRefused()) return { ok: false, reason: "dentally-budget", examined };
    let rows: unknown[] = [];
    try {
      // fromDate === toDate, so the client sends `on=` — an EXACT single day.
      // The range form pads each edge by a day, which would put appointments
      // outside the claimed window into a window we then call covered.
      const res = await client.listAppointments({
        siteId: dentallySiteId(siteId),
        fromDate: day,
        toDate: day,
        page,
        perPage: PER_PAGE,
      });
      rows = res.appointments ?? [];
    } catch (err) {
      console.warn(`[previsit/mining] appointment read failed ${siteId} ${day} p${page}`, err);
      return { ok: false, reason: "appointment-read-failed", examined };
    }
    for (const raw of rows) {
      examined += 1;
      const a = asRecord(raw);
      const patientId = pickString(a, "patient_id", "patientId");
      const start = pickString(a, "start_time", "start", "date");
      if (!patientId || !start) continue;
      // The patient must actually have TURNED UP. A booked-but-cancelled or
      // did-not-attend extraction is not an extraction, and the matcher's own
      // veto is only the belt to this braces.
      const state = normaliseAppointmentState(pickString(a, "state", "status"), "");
      if (!isAttendedState(state)) continue;
      if (ctx.accounted.has(`${siteId}:${patientId}`)) continue; // counted on a newer day already
      const hit = matchExtraction({
        reason: pickString(a, "reason") ?? null,
        treatment: pickString(a, "treatment", "treatment_name") ?? null,
      });
      if (!hit) continue;
      // Keep the MOST RECENT extraction per patient inside this day.
      const prev = hits.get(patientId);
      if (!prev || prev.at < start) {
        hits.set(patientId, { patientId, at: start, matchedText: sanitiseFreeText(hit.source) });
      }
    }
    if (rows.length < PER_PAGE) break;
    if (page === MINING_MAX_PAGES_PER_WINDOW) {
      // 1,200 appointments in ONE day at ONE site. Not a day we can claim to
      // have read, and not a day worth guessing about either.
      console.warn(`[previsit/mining] ${siteId} ${day} exceeds ${MINING_MAX_PAGES_PER_WINDOW} pages; not claimed`);
      return { ok: false, reason: "day-too-large", examined };
    }
  }

  const result: DayResult = {
    examined,
    matched: hits.size,
    candidates: [],
    excludedNoDob: 0,
    excludedUnderAge: 0,
    unreadable: 0,
  };

  for (const hit of hits.values()) {
    let verdict = ctx.seen.get(hit.patientId);
    if (!verdict) {
      if (ctx.reads.count >= ctx.readCeiling) {
        return { ok: false, reason: "patient-budget", examined };
      }
      if (dentallyScopeRefused()) return { ok: false, reason: "dentally-budget", examined };
      ctx.reads.count += 1;
      verdict = await readPatient(client, hit.patientId);
      // A transient failure is not cached: the next run must try again.
      if (verdict.kind !== "transient") ctx.seen.set(hit.patientId, verdict);
    }
    if (verdict.kind === "transient") return { ok: false, reason: "patient-read-failed", examined };

    ctx.accounted.add(`${siteId}:${hit.patientId}`);
    if (verdict.kind === "permanent") {
      result.unreadable += 1;
      continue;
    }
    const age = ageAt(verdict.dateOfBirth, ctx.now);
    if (age === null) {
      result.excludedNoDob += 1;
      continue;
    }
    if (age < MINING_MIN_AGE) {
      result.excludedUnderAge += 1;
      continue;
    }
    result.candidates.push({
      patientId: hit.patientId,
      name: verdict.name,
      age,
      at: hit.at,
      matchedText: hit.matchedText,
    });
  }

  return { ok: true, ...result };
}

/**
 * One whole run: every site of the practice, one window each, a day at a time.
 *
 * The caller owns the cron lease, the kill switch and the priority scope; this
 * owns the bounds and the honesty.
 */
export async function runMiningSweep(args: {
  clientId: string;
  client: DentallyClient;
  now: Date;
}): Promise<MiningRunReport> {
  const { clientId, client, now } = args;
  const reads = { count: 0 };
  const seen = new Map<string, PatientVerdict>();
  const accounted = new Set<string>();
  const sites: MiningSiteReport[] = [];

  const mapped = SITES.filter((s) => s.clientId === clientId);
  // THE EVEN SHARE (ruling W3/25). `Math.max(1, ...)` so a practice with more
  // sites than reads still gives every one of them a read rather than a share of
  // zero, which would report every site as budget-stopped having read nobody.
  const perSite = Math.max(1, Math.floor(MINING_MAX_PATIENT_READS_PER_RUN / Math.max(1, mapped.length)));

  for (const site of mapped) {
    if (dentallyScopeRefused() || reads.count >= MINING_MAX_PATIENT_READS_PER_RUN) break;

    // This site's ceiling, expressed as a run-total: its own share on top of
    // whatever the run has already spent, clamped to the run's ceiling. An
    // earlier site that under-spent does NOT hand its remainder on — that is the
    // starvation this ruling exists to end — so the run may finish under 120.
    const readCeiling = Math.min(MINING_MAX_PATIENT_READS_PER_RUN, reads.count + perSite);

    const coverage = await getCoverage(site.id);
    const window = nextWindow(coverage, now);
    const report: MiningSiteReport = {
      siteId: site.id,
      window,
      daysAttempted: 0,
      daysCovered: 0,
      examined: 0,
      matched: 0,
      candidates: 0,
      excludedNoDob: 0,
      excludedUnderAge: 0,
      unreadable: 0,
      coveredFrom: null,
      stoppedBy: "complete",
    };
    if (!window) {
      report.stoppedBy = "horizon";
      sites.push(report);
      continue;
    }

    // Counters for days claimed but NOT yet written to the coverage row. They
    // are committed with the claim, never before it: an exclusion counted for a
    // day we did not claim would be counted again when that day is re-read.
    let pending = { examined: 0, candidates: 0, excludedNoDob: 0, excludedUnderAge: 0, excludedUnreadable: 0 };
    let claimed: string | null = null;
    let committed: string | null = null;

    /** Commit everything claimed so far. A claim that has not moved is a no-op:
     *  re-writing the same row would add nothing and stamp last_run_at twice. */
    const commit = async (): Promise<void> => {
      if (!claimed || claimed === committed) return;
      await recordScanRun({
        siteId: site.id,
        coveredFrom: claimed,
        // The newest day read. Only ever moves forwards, in the repository.
        coveredTo: coverage ? coverage.coveredTo : window.to,
        examined: pending.examined,
        candidates: pending.candidates,
        excludedNoDob: pending.excludedNoDob,
        excludedUnderAge: pending.excludedUnderAge,
        // The third exclusion, carried the same way as the other two: counted per
        // day and committed with the claim, so a patient we could not look up on
        // a day we did not claim is counted when that day is re-read, not twice.
        excludedUnreadable: pending.excludedUnreadable,
        // There is more to read while any of this window is unread, and after
        // that while the horizon is still ahead of us.
        moreToRead: claimed !== window.from || nextWindow({ coveredFrom: claimed }, now) !== null,
        now: now.toISOString(),
      });
      committed = claimed;
      pending = { examined: 0, candidates: 0, excludedNoDob: 0, excludedUnderAge: 0, excludedUnreadable: 0 };
    };

    // NEWEST DAY FIRST, so what is claimed is always a contiguous range ending at
    // the day the previous run reached. A gappy coverage row could not be printed
    // as a sentence anybody could act on.
    let day = window.to;
    while (day >= window.from) {
      report.daysAttempted += 1;
      const outcome = await scanDay(client, site.id, day, { now, seen, accounted, reads, readCeiling });
      report.examined += outcome.examined;
      if (!outcome.ok) {
        report.stoppedBy = outcome.reason;
        break;
      }
      report.matched += outcome.matched;
      report.unreadable += outcome.unreadable;
      pending.excludedUnreadable += outcome.unreadable;
      pending.examined += outcome.examined;
      pending.excludedNoDob += outcome.excludedNoDob;
      pending.excludedUnderAge += outcome.excludedUnderAge;
      report.excludedNoDob += outcome.excludedNoDob;
      report.excludedUnderAge += outcome.excludedUnderAge;

      // THE ORDER IS THE INVARIANT: the day is fully read and fully resolved, so
      // its candidates may be written — and its coverage is committed in the same
      // breath, so a run killed at maxDuration can leave a name on the screen
      // with no window printed beside it for at most one interrupted day.
      let newCandidates = 0;
      for (const c of outcome.candidates) {
        const isNew = await upsertCandidate({
          siteId: site.id,
          dentallyPatientId: c.patientId,
          patientName: c.name,
          age: c.age,
          lastExtractionAt: c.at,
          matchedText: c.matchedText,
        });
        if (isNew) newCandidates += 1;
      }
      report.candidates += newCandidates;
      pending.candidates += newCandidates;
      claimed = day;
      report.daysCovered += 1;
      report.coveredFrom = day;
      if (outcome.candidates.length > 0) await commit();

      day = previousDay(day);
    }
    // Whatever is left: days that were covered but produced nobody.
    await commit();

    sites.push(report);
    // ONLY the shared Dentally refusal stops the RUN. `patient-budget` now means
    // "this site spent its own share", which is a reason to move to the next site
    // rather than to end the night — the whole of ruling W3/25. The run-total
    // guard at the top of the loop is what still holds the 120.
    if (report.stoppedBy === "dentally-budget") break;
  }

  return { patientReads: reads.count, budgetRefused: dentallyScopeRefused(), sites };
}
