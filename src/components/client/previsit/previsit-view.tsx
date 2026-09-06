import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getSessionUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { coverageSentence, exclusionSentence, MINING_CAVEATS, MINING_TITLE } from "@/lib/triage/mining";
import { listCandidates, listCoverage } from "@/lib/triage/mining-repository";
import { countInterestByTreatmentDetailed, listInterest } from "@/lib/triage/repository";
import { isSystemEnabled } from "@/lib/systems/repository";
import { slugsWithNoScheduledJob } from "@/lib/agent-wiring/scheduler";
import { PreVisitWorkspace } from "./previsit-workspace";
import type { MiningCoverage } from "@/lib/triage/mining";

// The Pre-visit questions module (internal staff view).
//
// A SERVER component. Everything except the bank editor is read here and passed
// down as plain data: the interest lists and the mining list are database reads
// with no Dentally call in them, so there is nothing for a client fetch to buy
// and one less authed route to guard. The BANK EDITOR is different — it saves —
// so it talks to /api/previsit/bank, which is owner-only.
//
// WHO SEES WHAT. The page is owner + agency + practice manager (the nav item's
// `roles`, enforced by requireModuleAccess on the page). Inside it, the question
// banks are OWNER-ONLY, resolved from the session here and enforced again by the
// API route: editing them changes what every patient in the practice is asked
// before their appointment, and the short list exists for a contractual reason
// the practice owner is accountable for. The manager gets the interest lists,
// which are her job.
//
// SCOPED TO THE SELECTED SITE, like every other display surface: getViewScope
// resolves the site switcher's cookie, so a practice looking at N15 sees N15's
// lists. Background jobs stay all-sites.
//
// BOTH LISTS ARE BOUNDED, AND THE SCREEN SAYS SO WHEN THE BOUND BITES. Neither
// repository read returns a "there are more" flag, so this page proves it the
// way the Dentally sync ledger does: it asks for ONE ROW MORE than it means to
// show, and a page that comes back over-full is a page with more behind it. A
// full page and a full page plus one look identical otherwise, which is how a
// coordinator ends up working a truncated outreach list to "completion" while
// the patients past the bound are invisible. `more` travels to the panels and is
// printed beside the list (charter §0/5, ruling W3/11).
//
// AND SO ARE THE COUNTS ABOVE THE LIST — ON A DATABASE THAT HAS NOT HAD 0101.
// `countInterestByTreatmentDetailed` has two paths and the comment here used to
// describe only the second. Where migration 0101 is applied (the live database,
// 5 Sep) it asks Postgres for `interest_counts_by_treatment(text[])`, which does
// the `count(distinct …)` where the rows live: EXACT at any scale, `capped`
// always false, and not one interest row paged into this process. Only where the
// function is missing does it fall back to the bounded keyset scan that says, in
// `capped`, whether it reached the end. Both answers are honest; what differs is
// whether a ceiling exists to hit.
//
// EITHER WAY `capped` IS THE WORD THIS PAGE NEEDS, and it is why the bare wrapper
// this page used to call had to go: a `Record<string, number>` cannot say "at
// least", so it THREW on a capped scan and the whole grid collapsed to "The
// totals could not be read." A practice past twenty thousand yeses would lose
// every headline figure it has, to protect it from a floor it could simply have
// been told was a floor. `capped` travels down instead and each figure renders as
// "at least N", the same sentence Home's Operating system band already prints for
// a capped read (charter §0/5, ruling W3/11).

/**
 * How many rows each list SHOWS. One more than this is asked for, so truncation
 * is proven rather than guessed (see the header).
 *
 * They are plain module constants rather than props because this is a server
 * module: a "use client" module may hand a server component components and
 * nothing else (rsc-value-import.test.ts), so the numbers cannot live beside the
 * panels that render them.
 */
const INTEREST_PAGE = 400;
const MINING_PAGE = 300;

export async function PreVisitTriageView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Pre-visit questions" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);
  const user = await getSessionUser();
  // A null user is the UNENFORCED pilot (no service-role key, so no sessions), and
  // it resolves to owner-level here to match every other guard in this codebase:
  // requireUser, requireOwnerRole and requireModuleApiAccess are all no-ops with
  // enforcement off, so a panel that alone stayed shut would make the local build
  // look broken rather than safe. The API route enforces it for real either way.
  const isOwner = user === null || user.role === "client_owner" || user.role === "agency_admin";

  // The SWITCH is read alongside the lists, because on day one it is the whole
  // explanation for why all three panels are empty: the system ships OFF and has
  // therefore never asked anybody anything. `isSystemEnabled` is the read helper
  // that already defaults a default-off system to off on a read failure, so an
  // unreadable toggle shows the onboarding line rather than hiding it.
  const [interestRead, interestSummary, candidateRead, coverage, systemEnabled] = await Promise.all([
    listInterest({ siteIds: scope.siteIds, limit: INTEREST_PAGE + 1 }).catch(() => null),
    countInterestByTreatmentDetailed(scope.siteIds).catch(() => null),
    listCandidates({ siteIds: scope.siteIds, limit: MINING_PAGE + 1 }).catch(() => null),
    listCoverage(scope.siteIds).catch(() => null),
    isSystemEnabled(client.id, "pre-visit-triage"),
  ]);

  // The over-fetched row is never shown; it exists only to answer "is there
  // more?". A null read stays null — that is a failed read, not an empty list.
  const interestRows = interestRead ? interestRead.slice(0, INTEREST_PAGE) : null;
  const interestMore = interestRead !== null && interestRead.length > INTEREST_PAGE;
  const candidates = candidateRead ? candidateRead.slice(0, MINING_PAGE) : null;
  const miningMore = candidateRead !== null && candidateRead.length > MINING_PAGE;

  // The COVERAGE across the sites in scope, merged into one honest window: the
  // widest range every site in scope has actually been read for, which is the
  // NARROWEST claim any of them supports. Claiming the union would say the list
  // covers a period that one of the sites was never scanned over.
  //
  // THE SCOPE GOES IN WITH IT, and that is the whole of the wave-3 fix here. The
  // merge used to narrow over the rows the read RETURNED, so a site with no scan
  // row at all — never opened, not one day of book read — contributed nothing to
  // the intersection instead of collapsing it, and the surviving site's window
  // was printed as the whole list's provenance.
  const merged = mergeCoverage(coverage, scope.siteIds);
  const unscanned = unscannedSites(coverage, scope.siteIds);

  return (
    <>
      <PageHeader
        title="Pre-visit questions"
        description={`A short questionnaire the patient answers on their phone before their appointment. Their answers appear on the patient record for the clinician, and every treatment they ask to hear about lands on a list here. Showing ${scope.label}.`}
      />
      <PreVisitWorkspace
        clientSlug={clientSlug}
        isOwner={isOwner}
        treatments={[...INTEREST_TREATMENTS]}
        interest={
          interestRows
            ? interestRows.map((r) => ({
                id: r.id,
                patientId: r.dentallyPatientId,
                patientName: r.patientName,
                treatment: r.treatment,
                createdAt: r.createdAt,
              }))
            : null
        }
        interestCounts={interestSummary ? interestSummary.counts : null}
        // A FAILED read is still null; a CAPPED one is a set of floors, and the
        // difference is the whole point of the Detailed variant. `false` when the
        // read failed, because there is then no figure to qualify.
        interestCountsCapped={interestSummary !== null && interestSummary.capped}
        interestMore={interestMore}
        interestPageSize={INTEREST_PAGE}
        mining={
          candidates
            ? candidates.map((c) => ({
                id: c.id,
                patientId: c.dentallyPatientId,
                patientName: c.patientName,
                age: c.age,
                lastExtractionAt: c.lastExtractionAt,
                matchedText: c.matchedText,
              }))
            : null
        }
        miningMore={miningMore}
        miningPageSize={MINING_PAGE}
        miningTitle={MINING_TITLE}
        miningCoverage={coverageLine(coverage, merged, unscanned, scope.siteIds.length)}
        miningExclusions={exclusionSentence(merged, unscanned === null ? undefined : { unscannedSites: unscanned.length })}
        miningCaveats={[...MINING_CAVEATS]}
        systemEnabled={systemEnabled}
        // REGISTRATION TRUTH TRAVELS WITH THE SWITCH (rulings W3/7, W3/31).
        //
        // Read here rather than in the workspace: the scheduler is a plain
        // server module and the workspace is "use client", so this is the seam
        // the fact has to cross. It is a read of a module, not of the database —
        // src/lib/agent-wiring/scheduler.ts holds what `cron.job` contained on 4
        // September 2026 and is pinned against §2 of the runbook — so the day
        // somebody registers the job, the sentence leaves the page with the same
        // two-line edit that clears it from System controls and Home.
        noScheduledJob={slugsWithNoScheduledJob().includes("pre-visit-triage")}
      />
    </>
  );
}

/**
 * One coverage claim across several sites: the NARROWEST window every site
 * supports.
 *
 * The union would be a lie by rounding — "built from appointments between March
 * and today" when one of the three sites has only been read back to August. The
 * intersection is the only range that is true of the whole list, and `moreToRead`
 * is true if ANY site still has book to walk.
 *
 * A SITE IN SCOPE WITH NO ROW COLLAPSES THE CLAIM RATHER THAN BEING ABSENT FROM
 * IT. `listCoverage` returns a row per site the scan has TOUCHED, so a site it
 * has never opened is simply missing from the array — and an intersection taken
 * over the rows that came back narrows nothing for it. That is how "built from
 * appointments between 6 August and 4 September" ends up printed over a
 * three-site scope where two sites have not had one day of book read, which the
 * sweep produces on its very first run: it walks the sites in order and breaks
 * out of the site loop the moment it spends its patient-read budget, so the
 * flagship consumes the budget and the other two get no row at all.
 *
 * `moreToRead` is therefore forced TRUE while any site in scope is unscanned:
 * there is more to read, a whole site of it, and the alternative tail — "that is
 * as far back as this list goes" — would be a completeness claim over a site
 * nobody has looked at. `coverageLine` below says the same thing in words.
 *
 * Null when no site in scope has been scanned at all, which coverageSentence
 * renders as "this list has not been built yet" rather than as an empty list.
 */
function mergeCoverage(rows: MiningCoverage[] | null, siteIds: string[]): MiningCoverage | null {
  if (!rows || rows.length === 0) return null;
  const scannedInScope = new Set(rows.map((r) => r.siteId));
  const anyUnscanned = siteIds.some((id) => !scannedInScope.has(id));
  let from = rows[0].coveredFrom;
  let to = rows[0].coveredTo;
  let examined = 0;
  let candidates = 0;
  let excludedNoDob = 0;
  let excludedUnderAge = 0;
  // NULL PROPAGATES. The column arrives in migration 0101 and migrations here are
  // applied by hand, so a row read from a database without it reports null — "we
  // do not know" — and a sum that turned that into 0 would print a claim over a
  // scan whose unreadable patients were never recorded. One unknown row makes the
  // merged figure unknown, which is the direction the sentence is silent in.
  let excludedUnreadable: number | null = 0;
  let moreToRead = false;
  let lastRunAt = rows[0].lastRunAt;
  for (const r of rows) {
    if (r.coveredFrom > from) from = r.coveredFrom; // the LATEST start = narrowest
    if (r.coveredTo < to) to = r.coveredTo;         // the EARLIEST end = narrowest
    examined += r.examined;
    candidates += r.candidates;
    excludedNoDob += r.excludedNoDob;
    excludedUnderAge += r.excludedUnderAge;
    excludedUnreadable =
      excludedUnreadable === null || r.excludedUnreadable === null
        ? null
        : excludedUnreadable + r.excludedUnreadable;
    moreToRead = moreToRead || r.moreToRead;
    if (r.lastRunAt > lastRunAt) lastRunAt = r.lastRunAt;
  }
  return {
    siteId: rows.length === 1 ? rows[0].siteId : "",
    coveredFrom: from,
    coveredTo: to,
    examined,
    candidates,
    excludedNoDob,
    excludedUnderAge,
    excludedUnreadable,
    lastRunAt,
    moreToRead: moreToRead || anyUnscanned,
  };
}

/**
 * The sites in scope the scan has never opened.
 *
 * NULL means the coverage read FAILED, which is a different fact from "none":
 * an empty array says every site in scope has a scan row, and null says we could
 * not find out. The caller keeps them apart.
 */
function unscannedSites(rows: MiningCoverage[] | null, siteIds: string[]): string[] | null {
  if (rows === null) return null;
  const scanned = new Set(rows.map((r) => r.siteId));
  return siteIds.filter((id) => !scanned.has(id));
}

/**
 * The provenance sentence printed above the implant list.
 *
 * THREE STATES, because there are three different facts to state and the screen
 * used to have one sentence for all of them:
 *
 *   read failed     we could not read the scan's own record. Say so. A window
 *                   claimed off a failed read is a claim nothing supports, and
 *                   "this list has not been built yet" would be a second wrong
 *                   statement about the same thing.
 *   sites missing   the window is true of the sites that HAVE been scanned and
 *                   of no others, so it is printed with the gap named. The
 *                   names on the list are real either way; what is not real is
 *                   reading the window as the group's.
 *   complete scope  the ordinary sentence.
 *
 * Sites are counted, never named: this line sits under a page header that
 * already says which sites are in view, and a list of site ids is not a
 * sentence anybody reads (charter §0/5, ruling W3/11).
 */
function coverageLine(
  rows: MiningCoverage[] | null,
  merged: MiningCoverage | null,
  unscanned: string[] | null,
  siteCount: number,
): string {
  if (rows === null || unscanned === null) {
    return (
      "The dates this list covers could not be read just now, so none are claimed for it. That is a " +
      "failure to read the scan's own record, not a finding that nothing has been scanned."
    );
  }
  const base = coverageSentence(merged);
  if (merged === null || unscanned.length === 0) return base;
  const missing = unscanned.length;
  const done = siteCount - missing;
  return (
    `${base} Those dates are the window for the ${done === 1 ? "one site" : `${done} sites`} the scan has ` +
    `reached: ${missing === 1 ? "one other site" : `${missing} other sites`} in view ${missing === 1 ? "has" : "have"} ` +
    `not been scanned at all, so no appointment there has been read and nobody from ${missing === 1 ? "it" : "them"} ` +
    `can be on this list yet.`
  );
}
