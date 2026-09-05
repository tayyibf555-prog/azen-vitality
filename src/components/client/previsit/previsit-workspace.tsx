"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCopy, ClipboardList, Download, RefreshCw, Sparkles, Users } from "lucide-react";
import { DataTable, EmptyState, SectionCard, Tabs, type Column, type TabItem } from "@/components/primitives";
import { londonDateLabel } from "@/lib/time/london";
import type { InterestTreatment, InterestTreatmentKey } from "@/lib/triage/types";
// One first step, shared with Home's Operating system band. See
// src/lib/systems/first-steps.ts.
import { firstStepFor } from "@/lib/systems/first-steps";
import { BankEditor } from "./bank-editor";

// The module's three panels, behind tabs so the screen stays one viewport.
//
// A CLIENT component because Tabs is one (it holds the active key) and because
// the bank editor saves. Every piece of data arrives as a plain prop, resolved on
// the server: nothing here fetches the lists, so there is no authed route to guard
// for a read that a server component already did.
//
// NULL vs EMPTY IS LOAD-BEARING IN ALL THREE PANELS. `null` means the read
// FAILED and says so; `[]` means the read succeeded and found nothing. An empty
// list rendered for a failed read would tell a practice that nobody is interested
// in whitening when the truth is that we could not look.
//
// AND SO IS `more`. Both lists are bounded reads, and the server proves
// truncation by asking for one row more than it shows. When it comes back
// over-full the panel says so IN WORDS beside the list — because the row count
// on the tab badge and the "Showing 25 of 400" under the table would otherwise
// both print the BOUND as if it were the total, and a coordinator working the
// list to the end would believe they had contacted everybody.
//
// `more` defaults to false and is stated by the caller, never inferred here: a
// panel handed a full page has no way of telling a full page from a full page
// plus one, which is the whole reason the server over-fetches.
//
// ===========================================================================
// THE INTEREST LISTS ARE TARGETABLE (ruling W3/10).
// ===========================================================================
// The tick-grid exists so the practice can run the whitening campaign, and for
// two waves it could only be LOOKED at: no export, no copy, no campaign filter
// (`OutreachFilters` selects on Dentally's own patient base and has no interest
// predicate), and the co-pilot's `interest_lists` tool is a read whose own
// prompt line says you cannot send to these people from there. Three hundred
// people who asked to hear about implants, and the only way out of the platform
// was to retype them off a 25-row table.
//
// So each treatment carries a CSV download and a copy-as-audience, plus one for
// the whole list. Three things about them are deliberate:
//
//   ROLE. There is no role check here because there is no role to check: the
//   module's nav entry is `[...OWNER_ROLES, "client_coordinator"]` and
//   requireModuleAccess enforces it on the page, so everybody who can see this
//   panel is the owner, the agency or the practice manager — exactly the set
//   W3/10 names. The export is built from rows already rendered to that reader;
//   it opens no route and reads nothing new, so there is no second door to
//   guard (and none to forget to guard).
//
//   HONESTY. The page's read is bounded at 400 rows, and a CSV cut at 400 with
//   nothing said would be exactly the defect W3/11 has just been spent fixing
//   on screen. So the file carries its own provenance rows — when it was taken,
//   which sites it covers, and how many of the treatment's people are in it out
//   of how many exist — and the button says the same thing beside itself.
//
//   ONE ROW PER PERSON. An audience is people, not answers: a patient who said
//   yes to whitening before two appointments is one name to ring. The counts
//   grid already counts distinct patients, so the file matches the figure above
//   it rather than quietly exceeding it.
//
// ===========================================================================
// THE COUNTS ABOVE THE GRID CAN BE FLOORS, AND THEY SAY SO (ruling W3/11).
// ===========================================================================
// `countInterestByTreatmentDetailed` walks a bounded number of interest rows and
// reports `capped` when it stopped short of the end. A capped figure is a FLOOR:
// there are at least that many people interested in whitening, and possibly
// more. `interestCountsCapped` carries that word down here, and every place a
// figure is printed — the headline number, the "N of T" line beside the export
// buttons, the CSV's own completeness row — is qualified by it.
//
// It replaces a worse behaviour, not a missing one. The page used to call the
// bare `countInterestByTreatment` wrapper, which THROWS on a capped scan because
// a `Record<string, number>` has nowhere to put "at least"; the page's
// `.catch(() => null)` then turned every headline figure into "The totals could
// not be read." A practice with more yeses than one scan reads would lose the
// whole grid rather than be told the grid is a floor.
//
// ===========================================================================
// THE OWNER'S DOOR ONTO THE IMPLANT SCAN (rulings W3/8, W3/21, W3/27).
// ===========================================================================
// "A feature with no caller is not shipped." The implant-candidate scan, its
// caveats, its coverage bookkeeping and its panel were all built, and for two
// waves NOTHING started it: its cron is not registered (runbook §2 carries the
// SQL) and no screen could reach the owner-only endpoint that exists for it. The
// panel read "Nobody on this list yet" permanently, on a feature the practice
// owner asked for by name. `MiningRunButton` below is the missing half.
//
// THREE THINGS ABOUT IT ARE DELIBERATE:
//
//   OWNER-ONLY IN THE UI TOO. This page is owner + practice manager, and
//   POST /api/previsit/mining-run answers the manager with a 403 — starting a
//   scan spends the practice's shared Dentally budget on historical book, so it
//   sits with the role that edits the question banks. A control that refuses the
//   person looking at it is worse than no control, so the manager is not shown
//   one (`canBuild`). The route is the real lock either way.
//
//   FAIL-CLOSED UNDER THE SWITCH (W3/21). The scan reads real patient history,
//   so it is halted by `pre-visit-triage` exactly like the sends are — it is not
//   on the closed list of preparation surfaces the switch spares (W2-C/4). The
//   button is disabled while the module is off and says the route's own sentence
//   for that state, so the screen and the endpoint agree word for word.
//
//   THE ROUTE'S SENTENCE, VERBATIM. Every outcome — the days read and people
//   added, a run already in progress on the shared lease, a background-priority
//   refusal, the switch — arrives as a `message` written for the owner. It is
//   printed as it came rather than re-worded here, because a second copy of
//   those sentences is a copy that drifts from the one the run actually took.

export interface InterestRow {
  id: string;
  patientId: string;
  patientName: string;
  treatment: string;
  createdAt: string;
}

export interface MiningRow {
  id: string;
  patientId: string;
  patientName: string;
  age: number;
  lastExtractionAt: string;
  matchedText: string;
}

export function PreVisitWorkspace({
  clientSlug,
  isOwner,
  treatments,
  interest,
  interestCounts,
  interestCountsCapped = false,
  interestMore = false,
  interestPageSize,
  mining,
  miningMore = false,
  miningPageSize,
  miningTitle,
  miningCoverage,
  miningExclusions,
  miningCaveats,
  scopeLabel,
  systemEnabled,
  initialTab,
}: {
  clientSlug: string;
  isOwner: boolean;
  treatments: InterestTreatment[];
  interest: InterestRow[] | null;
  interestCounts: Record<string, number> | null;
  /**
   * True when the counts scan stopped short of the end of the table, so every
   * figure in `interestCounts` is a FLOOR and is rendered as "at least N".
   * Defaults to false and is stated by the caller, never inferred: a grid handed
   * a set of numbers has no way of telling a total from a floor.
   */
  interestCountsCapped?: boolean;
  /** True when the server proved there are interest rows beyond this page. */
  interestMore?: boolean;
  /** How many rows this page holds, so the sentence can name the bound. */
  interestPageSize?: number;
  mining: MiningRow[] | null;
  /** True when the server proved there are candidates beyond this page. */
  miningMore?: boolean;
  miningPageSize?: number;
  miningTitle: string;
  miningCoverage: string;
  miningExclusions: string;
  miningCaveats: string[];
  /**
   * Which sites the lists were read for, in the words the top bar uses. It goes
   * into the exported file's provenance row: a CSV of names with no statement of
   * which practices it covers is a list somebody will merge with another one.
   */
  scopeLabel?: string;
  /** Whether the pre-visit system is switched on. It ships OFF. */
  systemEnabled: boolean;
  /**
   * Which tab opens first. The product never sets it; TESTS do, and that is the
   * whole reason it exists — `Tabs` mounts only the ACTIVE panel, so the implant
   * panel and everything wired into it (the owner's build action) is never in
   * the markup of a default render, and a claim about the workspace passing its
   * props down would be unassertable. The equipment workspace carries the same
   * prop for the same reason.
   */
  initialTab?: string;
}) {
  const tabs: TabItem[] = [
    {
      key: "interest",
      label: "Interest lists",
      icon: Users,
      // A BADGE IS A COUNT, AND A TRUNCATED COUNT WEARS ITS SIGN. `400` on a tab
      // reads as "there are four hundred"; `400+` does not.
      badge: interest ? countBadge(interest.length, interestMore) : undefined,
      content: (
        <InterestPanel
          treatments={treatments}
          rows={interest}
          counts={interestCounts}
          countsCapped={interestCountsCapped}
          more={interestMore}
          pageSize={interestPageSize}
          scopeLabel={scopeLabel}
        />
      ),
    },
    {
      key: "mining",
      label: "Implants",
      icon: Sparkles,
      badge: mining ? countBadge(mining.length, miningMore) : undefined,
      content: (
        <MiningPanel
          title={miningTitle}
          rows={mining}
          coverage={miningCoverage}
          exclusions={miningExclusions}
          caveats={miningCaveats}
          more={miningMore}
          pageSize={miningPageSize}
          // THE OWNER'S DOOR ONTO THE SCAN (W3/8). Only the owner is offered it,
          // and only the switch decides whether it runs — see the header.
          clientSlug={clientSlug}
          canBuild={isOwner}
          systemEnabled={systemEnabled}
        />
      ),
    },
  ];

  // The bank editor is OWNER-ONLY, and it is not rendered at all for a manager
  // rather than rendered disabled. A disabled editor invites somebody to ask for
  // it to be enabled; an absent one says the questions are not theirs to change.
  // The API route refuses her either way, which is the real lock.
  if (isOwner) {
    tabs.unshift({
      key: "questions",
      label: "Question lists",
      icon: ClipboardList,
      content: <BankEditor clientSlug={clientSlug} />,
    });
  }

  return (
    <div className="space-y-4">
      {/* THE ONBOARDING STATE, and it is the whole module's, not one panel's.
          Pre-visit questions ships switched OFF — twice over, by the catalog
          and by its migration — so on every practice, on day one, all three
          panels below are correctly empty and none of them explains why. The
          empty panels were honest and useless: they said nobody had answered,
          which is true of a system that has never asked anybody.

          It is drawn ABOVE the tabs rather than inside one, because the first
          step spans them: read the question lists, then switch on, and the
          interest lists fill themselves. The sentence is the shared one, so
          Home's Operating system band asks for exactly the same thing. */}
      {!systemEnabled ? (
        <p className="rounded-[10px] border border-line bg-card-muted/60 px-4 py-3 text-[12.5px] leading-relaxed text-navy">
          <span className="font-semibold">Pre-visit questions is switched off.</span>{" "}
          {firstStepFor("pre-visit-triage")?.step} The practice owner switches it on in System controls.
        </p>
      ) : null}
      <Tabs tabs={tabs} defaultKey={initialTab} />
    </div>
  );
}

/** A tab badge: `400+` when the list was cut, plain when it was not. */
function countBadge(shown: number, more: boolean): string {
  return more ? `${shown}+` : String(shown);
}

/**
 * The sentence a cut list carries, in the words a practice reads.
 *
 * It says three things a bare row count cannot: that the list is CUT, roughly
 * where, and what to do about it. `pageSize` is the caller's bound; when it is
 * not supplied the row count on screen is the same number, so the sentence still
 * names the right figure.
 *
 * NOT EXPORTED — this is a "use client" module, and a server file importing a
 * value out of one gets a client-reference proxy (rsc-value-import.test.ts). The
 * sentence is asserted on the rendered markup instead.
 */
function truncatedSentence(shown: number, pageSize: number | undefined, noun: string): string {
  const bound = pageSize ?? shown;
  return (
    `This list is cut at ${bound.toLocaleString("en-GB")} ${noun}. There are more than that — the count ` +
    `above is a floor, not a total, and the ${noun} past the cut are not on this page.`
  );
}

/**
 * One person per treatment, newest answer first.
 *
 * The rows arrive newest-first, so the first sighting of a patient is their most
 * recent answer and the rest are the same person asking again. An audience with
 * a name in it twice is an audience somebody rings twice.
 */
export function audienceRows(rows: InterestRow[], treatment: string | null): InterestRow[] {
  const seen = new Set<string>();
  const out: InterestRow[] = [];
  for (const r of rows) {
    if (treatment !== null && r.treatment !== treatment) continue;
    const key = `${r.treatment}::${r.patientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * RFC4180 quoting, plus the spreadsheet guard.
 *
 * A cell that starts with `=`, `+`, `-`, `@` or a control character is a FORMULA
 * to Excel, Numbers and Sheets, and every value in this file is text somebody
 * else typed — a patient name comes off the Dentally record. The leading
 * apostrophe is the standard mitigation: the spreadsheet shows the text and runs
 * nothing. It is added only to a cell that would otherwise be executed, so an
 * ordinary name is untouched.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const INTEREST_CSV_COLUMNS = ["Patient", "Dentally patient ID", "Asked about", "When they asked"] as const;

/**
 * The interest list as a CSV a practice can open, filter and hand to whoever
 * runs the campaign.
 *
 * IT STATES WHAT IT IS BEFORE IT STATES WHO IS IN IT. Three provenance rows come
 * first — what the list is, when it was taken and for which sites, and whether
 * it is the whole of that treatment's list — because a spreadsheet of patient
 * names outlives the screen it came off. The completeness row is the one that
 * matters: this page reads a bounded number of answers, so a treatment with more
 * people than the page holds produces a file that is a SAMPLE, and it says so in
 * the file rather than only next to the button that made it.
 *
 * A UTF-8 BOM and CRLF endings, for the same reason `src/lib/charting/
 * export-csv.ts` uses them: Excel mangles an accented name without them.
 */
export function interestCsv(input: {
  rows: InterestRow[];
  labelFor: (treatment: string) => string;
  heading: string;
  takenAt: string;
  scopeLabel?: string;
  /** Distinct people on this list in total, when the page knows it. */
  total?: number;
  /** True when the page's own read was cut, so even an unknown total is short. */
  pageCut?: boolean;
}): string {
  const lines: string[] = [
    [csvCell("Interest list"), csvCell(input.heading)].join(","),
    [
      csvCell("Taken from the platform on"),
      csvCell(input.takenAt),
      csvCell(input.scopeLabel ? `Sites: ${input.scopeLabel}` : ""),
    ].join(","),
    [
      csvCell("This file holds"),
      csvCell(completenessNote(input.rows.length, input.total, input.pageCut === true)),
    ].join(","),
    INTEREST_CSV_COLUMNS.map((c) => csvCell(c)).join(","),
  ];
  for (const r of input.rows) {
    lines.push(
      [
        csvCell(r.patientName || ""),
        csvCell(r.patientId),
        csvCell(input.labelFor(r.treatment)),
        csvCell(londonDateLabel(r.createdAt)),
      ].join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * WHAT A FILE MAY CLAIM ABOUT ITSELF WHEN THE GRID ABOVE IT HOLDS FLOORS.
 *
 * `completenessNote` reads `total` as the truth about the list — "all 118 people
 * on this list" — so a CAPPED count handed to it prints false completeness into
 * a spreadsheet that outlives the screen it came off. The floor is withheld and
 * `pageCut` forced instead, which is the sentence for "there are more than this
 * and we cannot say how many more" (charter §0/5, ruling W3/11).
 *
 * Exported because it is the honesty rule itself, not a detail of the button
 * that calls it: a click cannot be driven in this suite's renderer, so the rule
 * is asserted here and the panel is asserted to use it.
 */
export function csvCompleteness(
  total: number | undefined,
  capped: boolean,
  pageCut: boolean,
): { total: number | undefined; pageCut: boolean } {
  return capped ? { total: undefined, pageCut: true } : { total, pageCut };
}

/**
 * "all 118 people" / "30 of the 118 people on this list — the rest are past…".
 *
 * THE THIRD CASE IS THE ONE THAT MATTERS: a page whose own read was cut but
 * whose totals could not be read knows the file is short without knowing by how
 * much. "all 400 people" would be the false-completeness failure this whole file
 * exists to avoid, so an unknown total plus a cut page says so in words.
 */
function completenessNote(exported: number, total: number | undefined, pageCut: boolean): string {
  const people = (n: number) => `${n.toLocaleString("en-GB")} ${n === 1 ? "person" : "people"}`;
  if (total !== undefined && total > exported) {
    return (
      `${people(exported)} of the ${total.toLocaleString("en-GB")} on this list. The rest are older than the ` +
      `answers this page reads in one go, so this file is a sample and not the whole list.`
    );
  }
  if (total === undefined && pageCut) {
    return (
      `the ${people(exported)} this page could read. There are more answers than it holds in one go, so this ` +
      `file is a sample and not the whole list.`
    );
  }
  return `all ${people(exported)} on this list`;
}

/** Distinct, safe on every filesystem, and stamped so two exports are told apart. */
export function interestExportFilename(treatment: string | null, takenAt: Date): string {
  const iso = takenAt.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  const safe = (treatment ?? "all").replace(/[^a-zA-Z0-9._-]/g, "-");
  return `interest-${safe}-${stamp}.csv`;
}

/**
 * The clipboard form: patient id and name, tab separated, one per line.
 *
 * TWO COLUMNS AND NO HEADER, because this is the thing that gets pasted into
 * somebody else's tool — a spreadsheet, an ad platform's audience box, a message
 * to the coordinator. The Dentally id leads because it is the half that is
 * unique; the name is there so a person can see whose list this is.
 */
export function interestClipboardText(rows: InterestRow[]): string {
  return rows.map((r) => `${r.patientId}\t${r.patientName || ""}`).join("\n");
}

/**
 * A count that may be a floor, in the words a practice reads.
 *
 * The same rendering Home's Operating system band uses for a capped read: "at
 * least 20,000" rather than "20,000", because the second one is a number a
 * campaign gets sized on.
 */
function countLabel(value: number, capped: boolean): string {
  const figure = value.toLocaleString("en-GB");
  return capped ? `at least ${figure}` : figure;
}

export function InterestPanel({
  treatments,
  rows,
  counts,
  countsCapped = false,
  more = false,
  pageSize,
  scopeLabel,
}: {
  treatments: InterestTreatment[];
  rows: InterestRow[] | null;
  counts: Record<string, number> | null;
  /** True when every figure in `counts` is a floor rather than a total. */
  countsCapped?: boolean;
  more?: boolean;
  pageSize?: number;
  scopeLabel?: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const labelByKey = new Map<string, string>(treatments.map((t) => [t.key as string, t.label]));
  const labelFor = (key: string) => labelByKey.get(key) ?? key;

  if (rows === null) {
    return (
      <SectionCard title="Interest lists">
        <p className="text-[13px] text-status-red">
          These lists could not be read. That is a failure to read them, not a finding that nobody is
          interested.
        </p>
      </SectionCard>
    );
  }

  const columns: Column<InterestRow>[] = [
    { key: "patientName", header: "Patient", cell: (r) => r.patientName || r.patientId },
    {
      key: "treatment",
      header: "Asked about",
      cell: (r) => labelFor(r.treatment),
    },
    { key: "createdAt", header: "When", cell: (r) => londonDateLabel(r.createdAt) },
  ];

  /** One treatment's people, or everybody's when `treatment` is null. */
  const audienceFor = (treatment: string | null) => audienceRows(rows, treatment);

  // THE WHOLE LIST'S TOTAL, and it is the sum of the per-treatment counts rather
  // than a count of people: a row of the all-treatments export is one PERSON PER
  // TREATMENT (somebody interested in two things belongs on two lists), which is
  // exactly what those counts add up to. Undefined when the totals could not be
  // read, and `pageCut` then carries the honesty on its own.
  const everyoneTotal =
    counts === null ? undefined : Object.values(counts).reduce((n, v) => n + v, 0);

  const download = (treatment: string | null, heading: string, total: number | undefined) => {
    const takenAt = new Date();
    const people = audienceFor(treatment);
    // A CAPPED FIGURE IS NOT A TOTAL, AND THE FILE IS NOT HANDED ONE.
    const claim = csvCompleteness(total, countsCapped, more);
    const csv = interestCsv({
      rows: people,
      labelFor,
      heading,
      takenAt: londonDateLabel(takenAt.toISOString()),
      scopeLabel,
      total: claim.total,
      pageCut: claim.pageCut,
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = interestExportFilename(treatment, takenAt);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice(`${heading}: ${people.length} ${people.length === 1 ? "person" : "people"} downloaded.`);
  };

  const copy = async (treatment: string | null, heading: string) => {
    const people = audienceFor(treatment);
    if (people.length === 0) return;
    try {
      // The clipboard needs a secure context and a permission; when it is not
      // there the copy simply did not happen, and the panel says so rather than
      // leaving somebody to paste the last thing they copied into a campaign.
      await navigator.clipboard.writeText(interestClipboardText(people));
      setNotice(`${heading}: ${people.length} ${people.length === 1 ? "person" : "people"} copied. Paste into your campaign or a spreadsheet.`);
    } catch {
      setNotice("That list could not be copied. Use the CSV instead.");
    }
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="Who asked to hear more"
        description="Every patient who said yes on a pre-visit form. The count is people, not answers: a patient who said yes twice is one person."
        actions={
          rows.length > 0 ? (
            <button
              type="button"
              onClick={() => download(null, "Everyone who asked to hear more", everyoneTotal)}
              className="pressable inline-flex items-center gap-1.5 rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-navy"
            >
              <Download size={14} />
              Export everyone
            </button>
          ) : undefined
        }
      >
        {counts === null ? (
          <p className="text-[13px] text-status-red">The totals could not be read.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {treatments.map((t) => {
              const total = counts[t.key as InterestTreatmentKey] ?? 0;
              const onPage = audienceFor(t.key as string).length;
              return (
                <li key={t.key} className="rounded-xl border border-line bg-card px-4 py-3">
                  <p className="text-[12.5px] font-medium text-muted">{t.label}</p>
                  {/* A CAPPED READ IS A FLOOR, and it wears its sign. "20,000"
                      is a number somebody sizes a campaign on; "at least 20,000"
                      is the same read told honestly (ruling W3/11). */}
                  <p className="mt-0.5 text-[22px] font-bold tabular-nums text-navy">
                    {countLabel(total, countsCapped)}
                  </p>
                  {/* THE TWO WAYS OUT OF THE PLATFORM (ruling W3/10). A list that
                      can only be read is a list somebody retypes. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={onPage === 0}
                      onClick={() => download(t.key as string, t.label, total)}
                      aria-label={`Download the ${t.label} list as a CSV`}
                      className="pressable inline-flex items-center gap-1 rounded-[6px] border border-line px-2 py-1 text-[11.5px] font-medium text-navy disabled:opacity-40"
                    >
                      <Download size={12} />
                      CSV
                    </button>
                    <button
                      type="button"
                      disabled={onPage === 0}
                      onClick={() => void copy(t.key as string, t.label)}
                      aria-label={`Copy the ${t.label} list as an audience`}
                      className="pressable inline-flex items-center gap-1 rounded-[6px] border border-line px-2 py-1 text-[11.5px] font-medium text-navy disabled:opacity-40"
                    >
                      <ClipboardCopy size={12} />
                      Copy
                    </button>
                    {/* THE FILE SAYS THIS TOO, and so does the button, because the
                        person who exports and the person who opens the file are
                        not always the same person. */}
                    {onPage < total || countsCapped ? (
                      <span className="text-[11px] leading-tight text-status-amber">
                        {onPage} of {countLabel(total, countsCapped)} — the rest are past this page
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {notice ? (
          <p role="status" className="mt-3 text-[12px] text-muted">
            {notice}
          </p>
        ) : null}
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          A file holds one row per person — name, their Dentally patient number, what they asked about and when.
          Copy puts the same people on the clipboard to paste into a campaign or a spreadsheet.
        </p>
      </SectionCard>

      <SectionCard title="Most recent first">
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={Users}
            title="Nobody has asked to hear more yet"
            description="Yeses from the pre-visit form land here as soon as patients start filling it in."
          />
        ) : (
          <>
            <DataTable rows={rows} columns={columns} getRowKey={(r) => r.id} maxRows={25} />
            {/* BENEATH the table, where "Showing 25 of 400" is — because that
                footer prints the BOUND as though it were the total, and this is
                the line that takes the claim back. */}
            {more ? (
              <p className="mt-2 text-[12px] leading-relaxed text-status-amber">
                {truncatedSentence(rows.length, pageSize, "patients")}
              </p>
            ) : null}
          </>
        )}
      </SectionCard>
    </div>
  );
}

/** What POST /api/previsit/mining-run answers with, in every state it has. */
export interface MiningRunResponse {
  ok?: boolean;
  /** "system off" or "another run in progress" — the run did nothing. */
  skipped?: string;
  /** The sentence the route wrote for the owner. Printed verbatim. */
  message?: string;
  error?: string;
}

/**
 * WHAT THE OWNER IS TOLD, AND WHETHER THE PAGE BEHIND THE BUTTON CHANGED.
 *
 * Pulled out of the click handler because it IS the behaviour: the renderer this
 * module is tested with produces markup, not events, so a rule living inside
 * `onClick` is a rule nothing can go red over. Two decisions, both of them ones
 * this module has been wrong about before:
 *
 *   THE MESSAGE IS THE ROUTE'S OWN. Every state the endpoint has — the days read
 *   and people added, "already being built", the background limit spent, the
 *   switch — comes back as a sentence written for the practice owner. Rewriting
 *   them in the browser would be a second copy that drifts from the run that
 *   actually happened. The status-code fallback is only for the states the route
 *   does not write one for: a 403 for the practice manager, a 404, a proxy.
 *
 *   ONLY A RUN THAT READ SOMETHING REFRESHES THE PAGE. A skipped run — the
 *   switch, or the lease already held by the nightly sweep — left the list
 *   exactly as it was, and re-rendering it would suggest a scan had just moved
 *   it on. `ok: true` with a `skipped` is a SUCCESSFUL REFUSAL, which is the one
 *   shape a naive `res.ok` check gets wrong.
 */
export function miningRunOutcome(
  res: { ok: boolean; status: number },
  data: MiningRunResponse,
): { message: string; refresh: boolean } {
  return {
    message: data.message ?? data.error ?? `The list could not be built just now (${res.status}).`,
    refresh: res.ok && data.ok === true && data.skipped === undefined,
  };
}

/**
 * THE OWNER'S "BUILD / REFRESH CANDIDATES" ACTION (rulings W3/8, W3/21, W3/27).
 *
 * One POST to /api/previsit/mining-run, which is the same engine the nightly
 * sweep runs and takes the same lease, so a click during a scheduled run is
 * ANSWERED rather than doubling the practice's Dentally reads.
 *
 * IT PRINTS THE ROUTE'S OWN SENTENCE. Every outcome the endpoint has — days read
 * and people added, "already being built", the daily background limit spent, the
 * switch — arrives as a `message` written for the owner, and it is rendered
 * verbatim. Re-wording them here would be a second copy of sentences that must
 * describe the run that actually happened.
 *
 * WHAT IT DOES NOT DO IS PRETEND. The scan is bounded (30 days of book and 120
 * patient reads a run) and resumable, so one click is a step and not a finish;
 * the message says how far it got, and the coverage sentence above the list —
 * refreshed with the route below — says what the list now covers. A spinner that
 * ended in silence would leave "Nobody on this list yet" on screen with no way
 * to tell a failed run from a run that found nobody.
 *
 * `router.refresh()` RATHER THAN A RELOAD, because the message is the only
 * record of what the run did: a refresh re-renders the server component (the
 * coverage sentence, the list, the tab badge) while this component keeps its
 * state, and a reload would throw the report away as it arrived.
 */
export function MiningRunButton({
  clientSlug,
  systemEnabled,
}: {
  clientSlug: string;
  /** The `pre-visit-triage` switch. The action is fail-closed under it (W3/21). */
  systemEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/previsit/mining-run?client=${encodeURIComponent(clientSlug)}`, {
        method: "POST",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as MiningRunResponse;
      const outcome = miningRunOutcome(res, data);
      setMessage(outcome.message);
      if (outcome.refresh) router.refresh();
    } catch {
      setMessage(
        "We could not reach the server, so nothing was built. Nothing is lost — the scan picks up where it left off.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-line bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
          This list is built by reading the appointment book backwards, a window at a time. Each run
          reads a little further back and adds anyone it finds; it messages nobody.
        </p>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !systemEnabled}
          className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-navy disabled:opacity-40"
        >
          <RefreshCw size={14} />
          {busy ? "Building the list…" : "Build / refresh candidates"}
        </button>
      </div>
      {/* FAIL-CLOSED, IN THE ROUTE'S OWN WORDS (W3/21). The endpoint refuses
          while the module is off; saying so here, rather than letting the owner
          press a button that comes back with a refusal, is the same fact stated
          one step earlier. */}
      {!systemEnabled ? (
        <p className="mt-2 text-[12px] leading-relaxed text-status-amber">
          Pre-visit questions is switched off, so the list is not being built.
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mt-2 text-[12px] leading-relaxed text-muted">
          Reading the appointment book. This can take a few minutes — leave this page open.
        </p>
      ) : null}
      {message !== null && !busy ? (
        <p role="status" className="mt-2 text-[12px] leading-relaxed text-navy">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * EXPORTED so its caveats can be asserted on the RENDERED SCREEN rather than on
 * the constant they come from.
 *
 * The Tabs primitive mounts only the ACTIVE panel, so a test that renders the
 * whole workspace never reaches this one — which meant a "the caveats are on the
 * screen" test could pass while the screen rendered none of them. Mutation
 * testing found exactly that. Rendering this component directly is what makes the
 * claim true.
 */
export function MiningPanel({
  title,
  rows,
  coverage,
  exclusions,
  caveats,
  more = false,
  pageSize,
  clientSlug,
  canBuild = false,
  systemEnabled = false,
}: {
  title: string;
  rows: MiningRow[] | null;
  coverage: string;
  exclusions: string;
  caveats: string[];
  /** True when the server proved there are candidates beyond this page. */
  more?: boolean;
  pageSize?: number;
  /** Needed by the build action; without it there is no practice to build for. */
  clientSlug?: string;
  /**
   * Whether this reader may START a scan — the OWNER, not the practice manager
   * the rest of this page is also for. Defaults to false so a caller that says
   * nothing gets no control, which is the fail direction this module keeps.
   */
  canBuild?: boolean;
  /** The `pre-visit-triage` switch, which the action is fail-closed under. */
  systemEnabled?: boolean;
}) {
  const columns: Column<MiningRow>[] = [
    { key: "patientName", header: "Patient", cell: (r) => r.patientName || r.patientId },
    { key: "age", header: "Age", cell: (r) => String(r.age), align: "right" },
    { key: "lastExtractionAt", header: "Extraction on record", cell: (r) => londonDateLabel(r.lastExtractionAt) },
    { key: "matchedText", header: "What the diary said", cell: (r) => r.matchedText || "—" },
  ];

  return (
    <SectionCard title={title} description={coverage}>
      {/* THE OWNER'S DOOR ONTO THE SCAN, above the caveats and therefore above
          the names: the reader who can start it is the reader who most needs to
          know why the list looks the way it does. The manager sees none of it. */}
      {canBuild && clientSlug ? (
        <MiningRunButton clientSlug={clientSlug} systemEnabled={systemEnabled} />
      ) : null}
      {/*
        THE CAVEATS ARE ON THE SCREEN, above the list, not behind a tooltip and not
        in a help page. This list is a regex over free text that somebody could
        mistake for a clinical shortlist, and the difference between those two
        readings is a phone call the practice cannot stand behind. So they are read
        BEFORE the names, every time, by everyone.
      */}
      <ul className="mb-4 space-y-1.5 rounded-xl border border-line bg-card-muted/40 px-4 py-3">
        {caveats.map((c) => (
          <li key={c} className="text-[12.5px] leading-[1.55] text-muted">
            {c}
          </li>
        ))}
      </ul>
      {exclusions ? <p className="mb-4 text-[12.5px] text-muted">{exclusions}</p> : null}

      {rows === null ? (
        <p className="text-[13px] text-status-red">
          This list could not be read. That is a failure to read it, not a finding that there is nobody on it.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={Sparkles}
          title="Nobody on this list yet"
          description="The scan reads the appointment book a window at a time and adds anyone it finds. The dates it has covered so far are above."
        />
      ) : (
        <>
          <DataTable rows={rows} columns={columns} getRowKey={(r) => r.id} maxRows={25} />
          {/* THE COVERAGE SENTENCE ABOVE IS ABOUT THE SCAN, NOT THE LIST. "The
              scan is still reading further back, so this list will grow" reads
              as the only reason a name might be missing — and once the scan has
              finished it becomes "that is as far back as this list goes" above a
              list silently cut at its bound. So the cut says so in its own
              words, here, next to the names. */}
          {more ? (
            <p className="mt-2 text-[12px] leading-relaxed text-status-amber">
              {truncatedSentence(rows.length, pageSize, "patients")}
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
