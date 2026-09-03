import { MINING_MIN_AGE } from "./extraction-match";

// ===========================================================================
// THE IMPLANT-INTEREST MINING LIST: the owner's crude proxy, built honestly.
//
// PURE. No I/O. The bounded Dentally reads live in the sweep route; this file
// holds the coverage arithmetic and the sentences the screen must print.
//
// ===========================================================================
// WHAT THE OWNER ASKED FOR, AND WHAT IS ACTUALLY POSSIBLE.
// ===========================================================================
//
// The ask: "patients 18 and over who have had an extraction are people we could
// talk to about implants". As a heuristic for who to have a conversation with,
// that is reasonable and it is the practice's to make.
//
// What Dentally will actually give us, verified by probe rather than assumed:
//
//   /v1/appointments        the ONLY endpoint carrying plain-English procedure
//                           text (`reason`). Practice-wide, but ONLY as a DATE
//                           WINDOW: it takes site_id + on / after / before, and
//                           has no patient filter and no treatment filter.
//   /v1/treatment_plan_items  practice-wide and ~999,000 rows, but it carries NO
//                           treatment name at all — only `treatment_id` and
//                           `nomenclature` (a staff code). A full scan is ~9,900
//                           pages against an hourly budget of 3,600 requests
//                           shared with production, i.e. impossible, and the
//                           reports pager abandons on page one when meta.total
//                           already exceeds the budget.
//   /v1/invoices            practice-wide, but `invoice_items` exist ONLY on the
//                           per-invoice detail route and `include=` is ignored on
//                           the index. Line names would be one GET per invoice
//                           across ~34,000 invoices. Not bounded.
//
// SO THERE IS NO READ THAT ANSWERS "EVERY PATIENT WHO HAS EVER HAD AN
// EXTRACTION". Anybody who tells the practice otherwise has not tried it.
//
// ===========================================================================
// WHAT THIS BUILDS INSTEAD, AND WHY IT IS NOT A FUDGE.
// ===========================================================================
//
// A ROLLING WINDOW that walks BACKWARDS from today, a bounded number of days per
// run, and records exactly how far back it has reached. The list is then a true
// statement — "patients 18 and over with an extraction on record between D1 and
// D2" — rather than a false one, and the window is printed on the screen beside
// the count, not tucked into a tooltip.
//
// That is the complete-or-honest contract applied to a scan that can never be
// complete: it does not wear a complete number's clothes. `coverageSentence`
// below is the sentence, and it is asserted by a test that renders the actual
// screen, because a caveat that lives only in a constant is a caveat nobody reads.
//
// The scan is resumable, so the practice's coverage GROWS every night without any
// single run being expensive. After a month of nightly runs at the shipped bounds
// it reaches back roughly two years, which is the horizon the owner cares about
// anyway.
//
// ===========================================================================
// WHAT THIS LIST IS NOT, AND THE SCREEN SAYS SO.
// ===========================================================================
// It is not a clinical assessment. Somebody who has had a tooth out may be a poor
// implant candidate for a dozen reasons this platform cannot see — bone, medical
// history, smoking, the state of the neighbouring teeth, what they actually want.
// Every one of those is a conversation with a clinician. This is a list of people
// worth ASKING, which is the whole of the owner's request, and MINING_CAVEATS is
// rendered next to it rather than being available on request.
// ===========================================================================

/** One patient the scan turned up. */
export interface MiningCandidate {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  /** Whole years at the time of the scan. Always >= MINING_MIN_AGE. */
  age: number;
  /** ISO. The most recent extraction appointment found in the covered window. */
  lastExtractionAt: string;
  /** The sanitised diary text that produced the match, so a reader can judge it. */
  matchedText: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How much of the past the scan has actually read, per site.
 *
 * `coveredFrom` walks backwards run by run; `coveredTo` is where the scan
 * started (today, on the first run) and does not move, so the window is always a
 * contiguous, provable range rather than a set of holes.
 */
export interface MiningCoverage {
  siteId: string;
  coveredFrom: string; // YYYY-MM-DD, the oldest day read
  coveredTo: string;   // YYYY-MM-DD, the newest day read
  /** Appointments examined across every run. Not a claim about the practice. */
  examined: number;
  /** Distinct patients matched and kept. */
  candidates: number;
  /**
   * Patients matched but EXCLUDED because their date of birth could not be read,
   * or because they are under MINING_MIN_AGE.
   *
   * COUNTED SEPARATELY, and printed. A list that silently dropped people would be
   * a list nobody could reconcile, and "we could not tell how old 41 of them are"
   * is a fact the practice may want to fix in Dentally.
   */
  excludedNoDob: number;
  excludedUnderAge: number;
  /** ISO. When the last run finished. */
  lastRunAt: string;
  /**
   * True when the last run stopped because it hit its own bound rather than
   * because it ran out of book. The screen uses it to say "still reading" instead
   * of implying the window is final.
   */
  moreToRead: boolean;
}

/** How many days one run may walk backwards. Bounded, and small on purpose. */
export const MINING_DAYS_PER_RUN = 30;

/** How far back the scan will EVER go. Beyond this the list stops growing. */
export const MINING_HORIZON_DAYS = 1095; // three years

/** Pages of appointments per day-window, per site. 100 rows a page. */
export const MINING_MAX_PAGES_PER_WINDOW = 12;

/**
 * Distinct patient reads per run.
 *
 * Every candidate costs one GET /v1/patients/:id for the date of birth and the
 * name, and that read is the expensive half of the job. Capped so a run cannot
 * burn the background ceiling: the remaining matches are simply picked up by the
 * next run, because the window does not advance past what was fully resolved.
 */
export const MINING_MAX_PATIENT_READS_PER_RUN = 120;

/**
 * The next window to read, walking backwards from `coveredFrom`, or null when the
 * horizon has been reached.
 *
 * Returns YYYY-MM-DD strings because that is the form /v1/appointments takes.
 */
export function nextWindow(
  coverage: { coveredFrom: string } | null,
  now: Date,
  daysPerRun = MINING_DAYS_PER_RUN,
  horizonDays = MINING_HORIZON_DAYS,
): { from: string; to: string } | null {
  const DAY = 86_400_000;
  const horizon = new Date(now.getTime() - horizonDays * DAY);
  if (!coverage) {
    // First run: the most recent `daysPerRun` days, ending today.
    return { from: dayKey(new Date(now.getTime() - daysPerRun * DAY)), to: dayKey(now) };
  }
  const from = Date.parse(`${coverage.coveredFrom}T00:00:00Z`);
  if (!Number.isFinite(from)) return null;
  if (from <= horizon.getTime()) return null; // the horizon is reached; nothing more to read
  const nextTo = new Date(from - DAY);
  const nextFrom = new Date(Math.max(from - daysPerRun * DAY, horizon.getTime()));
  return { from: dayKey(nextFrom), to: dayKey(nextTo) };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The sentence the screen prints under the count.
 *
 * IT NAMES THE WINDOW, ALWAYS. A count with no window is the false-completeness
 * failure this platform has a rule against: a reader would take "212 patients" as
 * "212 patients in the practice", when it is "212 patients in the fourteen months
 * we have read so far".
 */
export function coverageSentence(coverage: MiningCoverage | null): string {
  if (!coverage) {
    return "This list has not been built yet. Nothing has been read, so this is not a finding that no patient has had an extraction.";
  }
  const range = `${humanDay(coverage.coveredFrom)} to ${humanDay(coverage.coveredTo)}`;
  const tail = coverage.moreToRead
    ? " The scan is still reading further back, so this list will grow."
    : " That is as far back as this list goes.";
  return `Built from appointments between ${range}.${tail}`;
}

/** The exclusions, printed rather than hidden. Empty string when there are none. */
export function exclusionSentence(coverage: MiningCoverage | null): string {
  if (!coverage) return "";
  const parts: string[] = [];
  if (coverage.excludedNoDob > 0) {
    parts.push(
      `${coverage.excludedNoDob} ${coverage.excludedNoDob === 1 ? "patient has" : "patients have"} no date of birth on record, so we could not tell whether they are ${MINING_MIN_AGE} or over`,
    );
  }
  if (coverage.excludedUnderAge > 0) {
    parts.push(
      `${coverage.excludedUnderAge} ${coverage.excludedUnderAge === 1 ? "is" : "are"} under ${MINING_MIN_AGE}`,
    );
  }
  if (parts.length === 0) return "";
  return `Left off this list: ${parts.join("; ")}.`;
}

function humanDay(key: string): string {
  const ms = Date.parse(`${key}T12:00:00Z`);
  if (!Number.isFinite(ms)) return key;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(ms));
}

/**
 * THE CAVEATS, and they are rendered ON THE SCREEN beside the list rather than
 * being available on request.
 *
 * Four sentences, and each one is a different way the list could be misread. The
 * first is the one that matters most: a reader who takes this for a clinical
 * shortlist will ring a patient and say something the practice cannot stand
 * behind.
 */
export const MINING_CAVEATS: readonly string[] = [
  "This is not a clinical assessment. Whether an implant is right for someone depends on their bone, their health, their other teeth and what they actually want, and none of that is here. It is a list of people who might be worth a conversation.",
  "It is built by reading the words the practice typed into the diary. It will miss an extraction recorded only as a code, and it can pick up an appointment where an extraction was discussed rather than done.",
  "It covers a window of time, not the whole history. The dates it covers are printed above, and it does not know about anything before them.",
  "Age is taken from the date of birth on the Dentally record at the moment of the scan. Anyone whose date of birth is missing is left off and counted, not assumed to be an adult.",
];

/** The heading, so the screen and the tests agree on what this list is called. */
export const MINING_TITLE = "People who might want to hear about implants";
