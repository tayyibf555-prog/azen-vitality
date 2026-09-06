import { requireApproverRole, requireClientAccess, requireModuleApiAccess, requireUser } from "@/lib/auth/guard";
import { getClient, getSite } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { isSystemEnabled } from "@/lib/systems/repository";
import { INTEREST_TREATMENTS, isKnownInterestKey } from "@/lib/triage/bank";
import {
  interestAudience,
  interestAudienceText,
  interestCsvDocument,
  interestExportFilename,
  interestPeopleLabel,
  type InterestExportRow,
} from "@/lib/triage/interest-csv";
import { listInterestToCompletion } from "@/lib/triage/repository";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import type { InterestTreatmentKey } from "@/lib/triage/types";

// ===========================================================================
// THE INTEREST LIST, AS A FILE THE PRACTICE CAN ACT ON (rulings W3/10, W3/29).
//
// Every "yes" on the pre-visit form lands on a per-treatment list, and until this
// route existed NOTHING could target one. The outreach segment builder pages
// Dentally and never reads treatment_interest; its `treatmentContains` matches
// PAST APPOINTMENT REASON TEXT, which is the inverse population — people who have
// already had the treatment, not people who asked to hear about it. The Meta
// audience field is free text. So the practice could see the list on screen and
// had no way whatsoever to work it. W3/10's minimum is exactly this: an
// owner + practice-manager export, per treatment.
//
// AND IT IS THE ONLY ONE (W3/29). The screen used to build its own CSV in the
// browser out of the 400 rows the page had rendered, so the same list left the
// platform in two shapes with two different provenance rows and two different
// completeness sentences. The client-side path is retired; the Download and the
// Copy-as-audience controls on the pre-visit screen both call this route, and the
// formatting lives in one module (src/lib/triage/interest-csv.ts).
//
// ---------------------------------------------------------------------------
// WHO. Owner, agency and the practice manager — the module page's own roles.
// ---------------------------------------------------------------------------
// `requireModuleApiAccess("pre-visit-triage")` refuses the clinician and the staff
// role (neither slug list holds it), and `requireApproverRole` refuses the same
// two. Both are here anyway, and the redundancy is the point rather than an
// oversight: the module's roles and APPROVER_ROLES are the same set TODAY and can
// drift apart tomorrow — the day pre-visit widens to the clinician so he can read
// the pre-visit SUMMARY on the record, the module gate alone would hand him the
// whole practice's marketing list as a file. The manager IS an intended user —
// working the interest lists is her job — which is why this is the approver guard
// and not `requireOwnerRole` as the mining scan next door uses.
//
// AND THE SITES ARE THE CALLER'S OWN. The scope is intersected with the verified
// session's `siteIds`, the way every other display route does it
// (inbox/threads, inbox/reply, reviews/today). It is a no-op today — a session's
// siteIds are every site of its client — and it is here because this is a FILE OF
// NAMED PATIENTS: the day a per-site login exists, a route that scoped by the
// cookie alone would hand a Romford Road coordinator the N15 list by flipping a
// switcher. One line, ahead of the need.
//
// ---------------------------------------------------------------------------
// SWITCH-GATED, DELIBERATELY.
// ---------------------------------------------------------------------------
// Ruling W2-C/4 named the surfaces the pre-visit kill switch does NOT halt — the
// bank editor, /api/previsit/bank and the module page — as a CLOSED list of
// three, and W3/21 restated that the list stays closed when it gated the mining
// button on the same page. Not on the named list means gated. An owner who has
// switched the module off has stopped the practice asking these questions; taking
// a marketing file of the answers out of it afterwards is not preparation, and
// this is the direction that costs a click rather than the one that costs a
// stop-with-residue. `isSystemEnabled` is the read helper that already resolves a
// default-off slug's absent row — and an unreadable toggle — to OFF.
//
// ---------------------------------------------------------------------------
// HONEST NUMBERS (charter §0/5, ruling W3/11, ruling W3/29).
// ---------------------------------------------------------------------------
// The read WALKS THE TABLE TO ITS END with a keyset cursor
// (`listInterestToCompletion`) rather than asking for one page and hoping. A
// single bounded select is the trap this tree has documented five times:
// PostgREST clips at its max-rows and returns `error: null`, so a truncated read
// is indistinguishable from a complete one in the returned shape — and a campaign
// sized off a floor wearing a total's clothes is the harm. Past the walk's own
// 20,000-row ceiling the file says "at least N people" in its first line and
// names the cause.
//
// IT IS EACH SURFACE'S OWN HONESTY, NOT A SHARED CEILING. An earlier draft of
// this header — and of listInterestToCompletion's — said the walk was bounded by
// "the same ceiling as the counts grid on the screen above, so the file and the
// grid cannot disagree". That has not been true since migration 0101 landed:
// `countInterestByTreatmentDetailed` now answers the grid from
// `interest_counts_by_treatment(text[])` in Postgres, exact at any scale with
// `capped` always false, and only falls back to the shared 20,000-row keyset walk
// on a database where 0101 is not applied. The export has no such short-circuit —
// it needs the ROWS, not a tally — so past 20,000 the grid prints an exact total
// while the file beside it says "at least N". Both sentences are true of what
// their own read did, which is the property that matters; what is NOT available
// is inferring one surface's behaviour from the other's. (The claim was already
// loose before 0101 for a single-treatment export: the count scan spends its
// ceiling across every treatment at once, this walk spends it on the one asked
// for.) Change the constant here and you have changed THIS file's floor only.
//
// AND A PERSON IS COUNTED ONCE, WHATEVER THEY TICKED. `interestAudience` keys on
// `${treatmentLabel}|${dentallyPatientId}` — one row per person PER TREATMENT —
// which is what the FILE wants, because its Treatment column is the point. It is
// not what a count of PEOPLE wants on the all-treatments export: the tick grid
// submits an answer for every treatment at once (previsit-form.tsx), so one
// patient routinely produces three or four `yes` rows, and `people.length` there
// counts person-treatment PAIRS. Printed as "People" it equals the SUM of the
// per-treatment cells in the grid two inches above the button, each of which is
// `count(distinct ti.dentally_patient_id)` (migration 0101) — so the file
// contradicted the screen, and the card the button sits in promises in writing
// that "a patient who said yes twice is one person". The count below is therefore
// off DISTINCT PATIENTS, and so is the paste; only the CSV's row shape keeps the
// per-treatment key. The co-pilot's `interest_lists` made the same correction for
// the same reason (src/lib/copilot/tools.ts).
//
// NO DENTALLY READ. Names and ids are the ones the patient's own submission
// stored, so an export costs database queries and nothing on the practice's
// shared API budget.
// ===========================================================================

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * ONE ROW PER PERSON, keeping their most recent yes — the count, and the paste.
 *
 * This is `interestAudience`'s key with the TREATMENT DROPPED rather than held
 * fixed. Per treatment the two agree exactly and this is a no-op; across every
 * treatment they do not, and this is the half that may be called "people". A
 * pasted audience with the same Dentally id on three lines is one person uploaded
 * three times, which is the harm on the paste; a figure that counts them three
 * times is the harm on the number. The list arrives newest first, so the row kept
 * is their most recent yes, matching the shared formatter's own rule.
 */
function uniqueByPatient(rows: InterestExportRow[]): InterestExportRow[] {
  const seen = new Set<string>();
  const out: InterestExportRow[] = [];
  for (const r of rows) {
    if (seen.has(r.dentallyPatientId)) continue;
    seen.add(r.dentallyPatientId);
    out.push(r);
  }
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown practice", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const moduleDenied = requireModuleApiAccess(auth, "pre-visit-triage");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  // The treatment, from the CLOSED set the form offers. Not interpolated into any
  // pattern: the repository matches it with `eq` on the stored key (ruling W3/12
  // is about the other shape, and this one never had it).
  const raw = url.searchParams.get("treatment") ?? "";
  if (raw !== "" && !isKnownInterestKey(raw)) return bad("Unknown treatment", 404);
  const treatment = raw === "" ? null : (raw as InterestTreatmentKey);
  const label = treatment
    ? INTEREST_TREATMENTS.find((t) => t.key === treatment)?.label ?? treatment
    : "All treatments";

  // TWO SHAPES OF THE SAME LIST, and an unknown one is refused rather than
  // silently served as a CSV: a caller asking for a format we do not have is a
  // caller who would paste a spreadsheet into an audience box.
  const format = url.searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "audience") return bad("Unknown format", 404);

  if (!(await isSystemEnabled(client.id, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({
      ok: false,
      skipped: "system off",
      message: "Pre-visit questions is switched off, so these lists cannot be exported.",
    });
  }

  // SCOPED TO THE SELECTED SITE, exactly as the screen the button sits on is:
  // a practice looking at N15 exports N15's list, not the group's. Then narrowed
  // to the sites this session actually holds — see the header.
  const scope = await getViewScope(client.id);
  const siteIds = auth ? scope.siteIds.filter((id) => auth.siteIds.includes(id)) : scope.siteIds;

  let walk;
  try {
    walk = await listInterestToCompletion({
      siteIds,
      ...(treatment ? { treatment } : {}),
      answer: "yes",
    });
  } catch (err) {
    console.error("[previsit/interest/export] read failed", err);
    return bad("This list could not be read just now.", 500);
  }

  const rows: InterestExportRow[] = walk.rows.map((r) => ({
    patientName: r.patientName,
    dentallyPatientId: r.dentallyPatientId,
    siteName: getSite(r.siteId)?.name ?? r.siteId,
    treatmentLabel: INTEREST_TREATMENTS.find((t) => t.key === r.treatment)?.label ?? r.treatment,
    createdAt: r.createdAt,
  }));
  // The FILE's rows: one per person per treatment, because the Treatment column is
  // what makes the file workable. The PEOPLE: distinct patients, because that is
  // what the word means. See the header.
  const people = interestAudience(rows);
  const audience = uniqueByPatient(rows);
  const now = new Date();
  // The count the screen prints beside the button and the count the paste holds
  // are the SAME NUMBER, produced once. "142", or "at least 20,000".
  const peopleLabel = interestPeopleLabel(audience.length, walk.capped);

  const headers: Record<string, string> = {
    // Named patients. Never held by a shared cache, and never re-served from a
    // back button after a sign-out.
    "cache-control": "no-store",
    // For the panel: it can print the same honest sentence beside the button
    // without parsing the file.
    "x-interest-people": peopleLabel,
  };

  if (format === "audience") {
    return new Response(interestAudienceText(audience), {
      status: 200,
      headers: {
        ...headers,
        // NOT an attachment: this one is pasted, not saved.
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response(
    interestCsvDocument({
      listLabel: label,
      scopeLabel: scope.label,
      exportedAt: now,
      rows: people,
      capped: walk.capped,
    }),
    {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${interestExportFilename(treatment, now)}"`,
      },
    },
  );
}
