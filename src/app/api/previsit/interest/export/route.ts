import { requireApproverRole, requireClientAccess, requireModuleApiAccess, requireUser } from "@/lib/auth/guard";
import { getClient, getSite } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { isSystemEnabled } from "@/lib/systems/repository";
import { INTEREST_TREATMENTS, isKnownInterestKey } from "@/lib/triage/bank";
import { listInterest } from "@/lib/triage/repository";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import type { InterestTreatmentKey } from "@/lib/triage/types";

// ===========================================================================
// THE INTEREST LIST, AS A FILE THE PRACTICE CAN ACT ON (ruling W3/10).
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
// HONEST NUMBERS (charter §0/5, ruling W3/11).
// ---------------------------------------------------------------------------
// PostgREST's own max-rows is 1,000: past it a select returns a CLIPPED page with
// `error: null`, so a truncated read is indistinguishable from a complete one in
// the returned shape — the trap this tree has documented four times. So the read
// asks for exactly `MAX_ROWS + 1` = 1,000, which is at or below that ceiling
// either way, and a full response means the bound bit whichever bound it was. The
// file then says "at least N people" in its first line and names the cause. A
// campaign sized off a floor wearing a total's clothes is the harm; a file that
// says so is not.
//
// NO DENTALLY READ. Names and ids are the ones the patient's own submission
// stored, so an export costs one database query and nothing on the practice's
// shared API budget.
// ===========================================================================

export const dynamic = "force-dynamic";

/**
 * Rows exported. One BELOW PostgREST's 1,000-row ceiling so the over-fetch that
 * proves truncation cannot itself be clipped into looking complete.
 *
 * A practice past this in one treatment needs the paged export named in the
 * ledger, not a bigger number here.
 */
const MAX_ROWS = 999;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * RFC4180 quoting, plus the spreadsheet guard.
 *
 * The quoting is the house style from src/lib/charting/export-csv.ts: quote when
 * the value holds a comma, a quote or a line break, and double any quote inside.
 *
 * THE GUARD IS THE HALF THAT IS NOT FUSSINESS. A cell beginning `=`, `+`, `-`,
 * `@` or a control character is a FORMULA to Excel, Numbers and Sheets, and every
 * value in this file is text somebody else typed — the patient name comes off the
 * Dentally record, which is data and never instructions (charter §0/8). A leading
 * apostrophe is the standard mitigation: the spreadsheet shows the text and runs
 * nothing, and only a cell that would otherwise execute is touched, so an ordinary
 * name is untouched. Written to match `csvCell` in
 * src/components/client/previsit/previsit-workspace.tsx byte for byte, so the two
 * doors onto this list cannot disagree about what is safe to put in a file.
 */
function cell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const COLUMNS = ["Patient name", "Dentally patient ID", "Site", "Treatment", "Said yes on"] as const;

/** Safe on every filesystem, and stamped so two exports are distinguishable. */
function filename(treatment: string, at: Date): string {
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `interest-${treatment.replace(/[^a-zA-Z0-9._-]/g, "-")}-${stamp}.csv`;
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
  // pattern: `listInterest` matches it with `eq` on the stored key (ruling W3/12
  // is about the other shape, and this one never had it).
  const raw = url.searchParams.get("treatment") ?? "";
  if (raw !== "" && !isKnownInterestKey(raw)) return bad("Unknown treatment", 404);
  const treatment = raw === "" ? null : (raw as InterestTreatmentKey);
  const label = treatment
    ? INTEREST_TREATMENTS.find((t) => t.key === treatment)?.label ?? treatment
    : "All treatments";

  if (!(await isSystemEnabled(client.id, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({
      ok: false,
      skipped: "system off",
      message: "Pre-visit questions is switched off, so these lists cannot be exported.",
    });
  }

  // SCOPED TO THE SELECTED SITE, exactly as the screen the button sits on is:
  // a practice looking at N15 exports N15's list, not the group's.
  const scope = await getViewScope(client.id);

  let rows;
  try {
    rows = await listInterest({
      siteIds: scope.siteIds,
      ...(treatment ? { treatment } : {}),
      answer: "yes",
      limit: MAX_ROWS + 1,
    });
  } catch (err) {
    console.error("[previsit/interest/export] read failed", err);
    return bad("This list could not be read just now.", 500);
  }

  const capped = rows.length > MAX_ROWS;
  const kept = rows.slice(0, MAX_ROWS);

  // ONE ROW PER PERSON PER TREATMENT. A patient who filled the form in before two
  // appointments and said yes to whitening both times is ONE person to ring, and a
  // file with them in twice is a file somebody works twice. The list arrives newest
  // first, so the row kept is their most recent yes — the one worth quoting.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of kept) {
    // "|" cannot occur in either half: treatment keys come from the closed
    // INTEREST_TREATMENTS set and a Dentally patient id is a number.
    const dedupeKey = `${r.treatment}|${r.dentallyPatientId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(
      [
        cell(r.patientName),
        cell(r.dentallyPatientId),
        cell(getSite(r.siteId)?.name ?? r.siteId),
        cell(INTEREST_TREATMENTS.find((t) => t.key === r.treatment)?.label ?? r.treatment),
        cell(r.createdAt),
      ].join(","),
    );
  }

  const now = new Date();
  // THE STAMP IS THE FIRST ROW, and it carries the count in words rather than as
  // a bare figure. An exported list with no date claims the present tense for
  // ever, and a capped one that printed "999" would be read as "999 people".
  const people = capped ? `at least ${lines.length}` : String(lines.length);
  const header = [
    cell("Interest list"),
    cell(label),
    cell("Sites"),
    cell(scope.label),
    cell("Exported"),
    cell(now.toISOString()),
    cell("People"),
    cell(people),
    cell(
      capped
        ? "This file holds the most recent people who said yes and there are more behind them."
        : "This is the whole list.",
    ),
  ].join(",");

  // An EMPTY list still produces both header rows rather than an empty file: an
  // empty file is indistinguishable from a failed export.
  const csv = `﻿${[header, COLUMNS.map((c) => cell(c)).join(","), ...lines].join("\r\n")}\r\n`;

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename(treatment ?? "all", now)}"`,
      // Named patients. Never held by a shared cache, and never re-served from a
      // back button after a sign-out.
      "cache-control": "no-store",
      // For the panel: it can print the same honest sentence beside the button
      // without parsing the file.
      "x-interest-people": people,
    },
  });
}
