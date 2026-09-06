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
   *
   * A CEILING ON PEOPLE, NOT A HEADCOUNT, and `exclusionSentence` says so on the
   * screen. `candidates` above really is distinct patients — `upsertCandidate`
   * returns false for anybody already on the register, so a second run cannot
   * count them twice. These three have no register: the sweep de-duplicates them
   * only within one run (`ctx.accounted` is created fresh in `runMiningSweep`),
   * and successive runs cover DISJOINT older windows, so a patient with
   * extractions in two of those windows is resolved and counted again. The
   * inflating cases are the persistent ones — a missing date of birth and a merged
   * record fail identically every night — so the drift is one-directional and
   * lands on exactly the patients the owner is being asked to go and fix.
   *
   * THE REAL FIX IS A REGISTER, not a smaller number: an excluded patient recorded
   * by `${siteId}:${patientId}` the way a candidate is, counted only on first
   * insert, and still re-read each run so a date of birth filled in later can
   * still promote them onto the list. Until that exists the sentence names the
   * ceiling rather than claiming a headcount (charter §0/5, ruling W3/11).
   */
  excludedNoDob: number;
  excludedUnderAge: number;
  /**
   * Patients the scan matched but could not look up AT ALL — Dentally answered
   * 404/410 for a merged or deleted record, or the record came back with no
   * usable name. The third way somebody is left off, and the one that had
   * nowhere to live until migration 0101. A ceiling on people for the same reason
   * as the two above.
   *
   * NULL MEANS "WE DO NOT KNOW", NOT "NONE". Migrations here are applied by hand,
   * so this code runs against databases with and without the column; the
   * repository reports null on the ones without it and the sentence below leaves
   * the clause out rather than printing a zero that would be a claim.
   */
  excludedUnreadable: number | null;
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
 * burn the background ceiling.
 *
 * THE CAP ONLY MAKES PROGRESS BECAUSE COVERAGE IS CLAIMED A DAY AT A TIME. The
 * matches this budget leaves unresolved are picked up by the next run — but that
 * is a property of the DAY loop, not of the cap, and the distinction is the
 * difference between a scan that advances and one that does not. Under the old
 * whole-window shape a run that spent its budget claimed nothing at all, so the
 * next night re-read the same newest days, spent the same 120 reads on the same
 * patients, and claimed nothing again: coverage never moved. The sweep now
 * commits each day as it is fully read AND fully resolved
 * (`src/app/api/previsit/_mining.ts`, the commit-with-the-claim invariant), so a
 * budget-stopped run still banks every day it finished, and the next run resumes
 * at the first day it did not.
 *
 * Which is also why this number can stay small: the run budget bounds the night,
 * the day-by-day claim guarantees the month.
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

/**
 * How much of the group the exclusion figures actually cover.
 *
 * `unscannedSites` is how many sites IN VIEW have no scan row at all — the number
 * `unscannedSites()` in the pre-visit view already computes for the coverage line.
 * Omitting it does not mean "none": it means the caller did not say, which is the
 * conservative case and is qualified as such.
 */
export interface MiningScope {
  unscannedSites: number;
}

/**
 * The exclusions, printed rather than hidden. Empty string when there are none.
 *
 * THE FIGURES ARE SUMMED OVER THE SITES THAT HAVE A SCAN ROW, WHICH IS NOT
 * ALWAYS THE SITES ON SCREEN. `mergeCoverage` adds up the rows the scan has
 * touched, and a site in view that has never been opened contributes nothing to
 * them — so on a three-site scope where the sweep has only reached the flagship
 * (which is exactly what its first run produces: it spends the patient-read
 * budget and moves on), "41 patients have no date of birth on record" is a figure
 * about one site printed under a header naming three. It is a floor, and a bare
 * figure is the false-completeness failure this module has a rule against
 * (charter §0/5, ruling W3/11) — the same hole `coverageLine` was fixed for, in
 * the sentence directly above this one.
 *
 * So the count is qualified whenever it cannot be shown to cover the whole scope:
 *
 *   scope omitted            the caller did not say, so it is not claimed. The
 *                            figures are named as covering the sites the scan has
 *                            reached, which is true in every case.
 *   scope with a gap         the gap is stated in the same words the coverage
 *                            line uses — sites are counted, never named.
 *   scope with no gap        the plain sentence. Every site in view has a row, so
 *                            the figures cover the window the line above names.
 *
 * THE THIRD CLAUSE IS PRINTED ONLY WHEN IT IS KNOWN. A patient the scan could
 * not read AT ALL (Dentally 404/410, or a record with no usable name) is counted
 * by the sweep — `MiningSiteReport.unreadable` in src/app/api/previsit/_mining.ts
 * — and persisted in `previsit_mining_scan.excluded_unreadable` from migration
 * 0101. Before that migration is applied the repository reports the field as
 * NULL and this sentence simply does not mention it, because "0 patients could
 * not be looked up" over a scan that failed to read a dozen of them is a false
 * statement where silence is a true one.
 *
 * AND THE FIGURES ARE CEILINGS, WHICH THE SENTENCE NOW SAYS. `candidates` is a
 * headcount — the register refuses a patient it already holds — and these three
 * are not: the sweep de-duplicates them within ONE run and each later run covers
 * an older, disjoint window, so a patient with extractions in two of them is
 * counted in both. Printing one de-duplicated figure beside three that are not,
 * all in the words "N patients", is the false-completeness failure with the
 * direction reversed, on the screen whose stated purpose is that the list can be
 * reconciled against the practice's own numbers.
 *
 * SO: "up to N", and one sentence naming the unit — but ONLY where a ceiling is
 * a real qualification. A figure of one IS one person (a ceiling of one with at
 * least one occurrence leaves nothing to doubt), so it is printed plainly, and
 * the explanation is printed only when some figure is above one and could
 * therefore be inflated. A qualifier attached to a number that cannot be wrong is
 * its own small dishonesty, the same reason the scope clause is omitted when
 * there is no gap.
 */
export function exclusionSentence(coverage: MiningCoverage | null, scope?: MiningScope): string {
  if (!coverage) return "";
  const parts: string[] = [];
  if (coverage.excludedNoDob > 0) {
    parts.push(
      `${upTo(coverage.excludedNoDob)}${coverage.excludedNoDob} ${coverage.excludedNoDob === 1 ? "patient has" : "patients have"} no date of birth on record, so we could not tell whether they are ${MINING_MIN_AGE} or over`,
    );
  }
  if (coverage.excludedUnderAge > 0) {
    parts.push(
      `${upTo(coverage.excludedUnderAge)}${coverage.excludedUnderAge} ${coverage.excludedUnderAge === 1 ? "is" : "are"} under ${MINING_MIN_AGE}`,
    );
  }
  if (coverage.excludedUnreadable !== null && coverage.excludedUnreadable > 0) {
    parts.push(
      `${upTo(coverage.excludedUnreadable)}${coverage.excludedUnreadable} ${coverage.excludedUnreadable === 1 ? "patient could" : "patients could"} not be looked up at all, so we could not tell either way`,
    );
  }
  if (parts.length === 0) return "";
  const body = `Left off this list: ${parts.join("; ")}.${countedPerRun(coverage)}`;
  if (scope && scope.unscannedSites <= 0) return body;
  if (!scope) {
    // Deliberately says "so far" and NOT "not every site in view": the caller has
    // not told us whether there is a gap, so a sentence that asserted one would be
    // false in exactly the case where there is none. This qualifies, it does not
    // claim.
    return `${body} That is a count over the sites the scan has reached so far.`;
  }
  const missing = scope.unscannedSites;
  return (
    `${body} That is a count over the sites the scan has reached: ` +
    `${missing === 1 ? "one other site" : `${missing} other sites`} in view ` +
    `${missing === 1 ? "has" : "have"} not been scanned, so nobody there has been counted either way.`
  );
}

/**
 * "up to ", or nothing at all for a figure that cannot be inflated.
 *
 * One occurrence is one person: the count is a ceiling AND it is at least one, so
 * for a figure of one the two meet and there is nothing to qualify.
 */
function upTo(n: number): string {
  return n === 1 ? "" : "up to ";
}

/** The clause that names the unit, printed only where a figure could be inflated. */
function countedPerRun(coverage: MiningCoverage): string {
  const figures = [coverage.excludedNoDob, coverage.excludedUnderAge, coverage.excludedUnreadable ?? 0];
  if (!figures.some((n) => n > 1)) return "";
  return (
    " Each run counts these again, so somebody with extractions in two of the periods" +
    " we have read is in them twice: the number of people is this or fewer."
  );
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
 *
 * THE THIRD ONE NAMES BOTH EDGES OF THE WINDOW, and it used to name only the
 * older of them ("it does not know about anything before them"), which pointed
 * a reader away from the gap that actually grows. The window walks BACKWARDS:
 * `nextWindow` only ever returns days older than `coveredFrom`, and `coveredTo`
 * is written once — `src/app/api/previsit/_mining.ts` passes the stored value
 * back on every later run, and `recordScanRun` only ever takes the maximum — so
 * the newest edge freezes on the day the scan first ran. An extraction done
 * since that day can never reach the list, and that gap is one day longer every
 * day, which the gap behind the window is not: the scan closes that one nightly
 * and stops at the three-year horizon.
 *
 * `coverageSentence` directly above the names does print the true, visibly
 * stale end date, so no figure here wears complete clothes. What was missing was
 * the sentence saying what that date MEANS, and a coordinator sizing a campaign
 * six months later had been told in writing that the only gap was history
 * (charter §0/5, rulings W3/9 and W3/11).
 */
export const MINING_CAVEATS: readonly string[] = [
  "This is not a clinical assessment. Whether an implant is right for someone depends on their bone, their health, their other teeth and what they actually want, and none of that is here. It is a list of people who might be worth a conversation.",
  "It is built by reading the words the practice typed into the diary. It will miss an extraction recorded only as a code, and it can pick up an appointment where an extraction was discussed rather than done.",
  "It covers a window of time, not the whole history. The dates it covers are printed above: it knows nothing before the earlier one, and nothing since the later one, which is the day the scan first ran and does not move. An extraction done since then is not on this list.",
  "Age is taken from the date of birth on the Dentally record at the moment of the scan. Anyone whose date of birth is missing is left off and counted, not assumed to be an adult.",
];

/**
 * What the run READ, counted in the only unit the figure is true in.
 *
 * Each site walks its own window, so the run's days are days-at-a-site and never
 * days of one shared diary. One site (or none) reads exactly as it always did;
 * more than one says how many sites the figure is per, and says "up to" as soon
 * as they differ. `people` stays a sum because a candidate is a distinct patient
 * banked once by the whole run, which is a total and not a per-site figure.
 */
function daysReadClause(sites: ReadonlyArray<{ daysCovered: number }>): string {
  const perSite = sites.map((s) => s.daysCovered);
  const most = perSite.length > 0 ? Math.max(...perSite) : 0;
  const least = perSite.length > 0 ? Math.min(...perSite) : 0;
  const unit = most === 1 ? "day" : "days";
  if (perSite.length <= 1) return `Read ${most} more ${unit} of the diary`;
  if (least === most) return `Read ${most} more ${unit} of the diary at each of ${perSite.length} sites`;
  return `Read up to ${most} more ${unit} of the diary at each of ${perSite.length} sites`;
}

/**
 * WHAT ONE RUN OF THE SCAN ACTUALLY DID, in the words the owner reads.
 *
 * The owner's "Build / refresh candidates" button prints this verbatim (W3/8 gave
 * the scan a caller; the button never re-words the sentence, so there is only one
 * account of what happened). It lives here, pure and beside the coverage
 * sentences, rather than inside the route: a rule inside a handler is a rule the
 * screen cannot go red over.
 *
 * THE FIRST SENTENCE IS WHAT WAS READ, and it never claims a day the scan did not
 * finish — coverage is claimed a day at a time, so `daysCovered` is days fully
 * read AND fully resolved.
 *
 * IT IS ALSO PER SITE, WHICH IS WHY IT IS NOT A SUM. `daysCovered` is a count of
 * that ONE site's days: `runMiningSweep` walks every mapped site over its own
 * window of at most MINING_DAYS_PER_RUN, so a three-site practice whose sites
 * move in lockstep — the ordinary case, because they all start from the same
 * empty coverage — advances the calendar by thirty days and has ninety site-days
 * of work to show for it. Adding them up printed "Read 90 more days of the diary"
 * directly above a coverage line whose window had moved thirty, on the same card,
 * in the same panel: two numbers describing one run in units that differ by the
 * number of sites, and the bigger one wearing the word "the diary" in the
 * singular. An owner reading it would put the three-year horizon twelve clicks
 * away when it is thirty-six. That is the false-completeness failure this module
 * has a rule against (charter §0/5, ruling W3/11) — the same one `coverageSentence`
 * and `exclusionSentence` are each written around — so the clause names the unit
 * it is counting in: days at a site, and how many sites.
 *
 * When the sites did NOT move in step (one spent its even share of the reads,
 * another was already at the horizon) the figure is the largest any single site
 * managed and is said as "up to", because a bound is a true statement about all
 * of them and an average is a statement about none.
 *
 * THE SECOND EXISTS BECAUSE OF RULING W3/25. The run's patient-read budget is
 * split EVENLY across the sites in scope so no site can starve another, and a
 * site that spends its own share stops with `patient-budget` while its
 * neighbours carry on to the end of their book. That is a good outcome and an
 * invisible one: the totals look identical to a run that simply found less, so a
 * practice watching a multi-site scan would see the list stop growing with no
 * word of why. Said plainly, it is a progress report; unsaid, it is a mystery.
 *
 * THE THIRD IS THE OTHER HALF OF W3/25: patients counted in their own bucket AND
 * SHOWN AS SUCH. A matched patient whose Dentally record is gone (404/410) or
 * carries no usable name is on neither the list nor the "no date of birth" line,
 * and the difference between "nobody was found" and "four people could not be
 * looked up" is the difference between a quiet list and a data problem the
 * practice can fix. It is stated here whatever the database's shape, because the
 * run report holds the figure even where `previsit_mining_scan` cannot yet
 * persist it (migration 0101).
 */
export function miningRunSentence(report: {
  budgetRefused: boolean;
  sites: ReadonlyArray<{
    daysCovered: number;
    candidates: number;
    unreadable?: number;
    stoppedBy?: string | null;
  }>;
}): string {
  const people = report.sites.reduce((n, s) => n + s.candidates, 0);
  const read = daysReadClause(report.sites);
  const parts: string[] = [
    report.budgetRefused
      ? `${read} and stopped there: the practice's daily limit with the practice management system is spent for background work this hour. Try again later; nothing is lost.`
      : `${read} and added ${people} ${people === 1 ? "person" : "people"}.`,
  ];

  const shared = report.sites.filter((s) => s.stoppedBy === "patient-budget").length;
  if (shared > 0) {
    parts.push(
      shared === 1
        ? "One site reached its share of this run's patient reads and stopped there; the next run picks it up where it left off."
        : `${shared} sites reached their share of this run's patient reads and stopped there; the next run picks them up where they left off.`,
    );
  }

  const unreadable = report.sites.reduce((n, s) => n + (s.unreadable ?? 0), 0);
  if (unreadable > 0) {
    parts.push(
      unreadable === 1
        ? "1 patient could not be looked up at all, so they are counted separately rather than left off quietly."
        : `${unreadable} patients could not be looked up at all, so they are counted separately rather than left off quietly.`,
    );
  }

  return parts.join(" ");
}

/** The heading, so the screen and the tests agree on what this list is called. */
export const MINING_TITLE = "People who might want to hear about implants";
