import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getSessionUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { coverageSentence, exclusionSentence, MINING_CAVEATS, MINING_TITLE } from "@/lib/triage/mining";
import { listCandidates, listCoverage } from "@/lib/triage/mining-repository";
import { countInterestByTreatment, listInterest } from "@/lib/triage/repository";
import { isSystemEnabled } from "@/lib/systems/repository";
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
  const [interestRows, interestCounts, candidates, coverage, systemEnabled] = await Promise.all([
    listInterest({ siteIds: scope.siteIds, limit: 400 }).catch(() => null),
    countInterestByTreatment(scope.siteIds).catch(() => null),
    listCandidates({ siteIds: scope.siteIds, limit: 300 }).catch(() => null),
    listCoverage(scope.siteIds).catch(() => null),
    isSystemEnabled(client.id, "pre-visit-triage"),
  ]);

  // The COVERAGE across the sites in scope, merged into one honest window: the
  // widest range every site in scope has actually been read for, which is the
  // NARROWEST claim any of them supports. Claiming the union would say the list
  // covers a period that one of the sites was never scanned over.
  const merged = mergeCoverage(coverage);

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
        interestCounts={interestCounts}
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
        miningTitle={MINING_TITLE}
        miningCoverage={coverageSentence(merged)}
        miningExclusions={exclusionSentence(merged)}
        miningCaveats={[...MINING_CAVEATS]}
        systemEnabled={systemEnabled}
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
 * Null when no site has been scanned at all, which coverageSentence renders as
 * "this list has not been built yet" rather than as an empty list.
 */
function mergeCoverage(rows: MiningCoverage[] | null): MiningCoverage | null {
  if (!rows || rows.length === 0) return null;
  let from = rows[0].coveredFrom;
  let to = rows[0].coveredTo;
  let examined = 0;
  let candidates = 0;
  let excludedNoDob = 0;
  let excludedUnderAge = 0;
  let moreToRead = false;
  let lastRunAt = rows[0].lastRunAt;
  for (const r of rows) {
    if (r.coveredFrom > from) from = r.coveredFrom; // the LATEST start = narrowest
    if (r.coveredTo < to) to = r.coveredTo;         // the EARLIEST end = narrowest
    examined += r.examined;
    candidates += r.candidates;
    excludedNoDob += r.excludedNoDob;
    excludedUnderAge += r.excludedUnderAge;
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
    lastRunAt,
    moreToRead,
  };
}
