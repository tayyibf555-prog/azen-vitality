"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCopy, ClipboardList, Download, RefreshCw, Sparkles, Users } from "lucide-react";
import { DataTable, EmptyState, SectionCard, Tabs, type Column, type TabItem } from "@/components/primitives";
import { londonDateLabel } from "@/lib/time/london";
import type { InterestTreatment, InterestTreatmentKey } from "@/lib/triage/types";
// The export's one formatter, shared with the route that serves it (W3/29).
import { interestExportFilename } from "@/lib/triage/interest-csv";
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
// THE INTEREST LISTS ARE TARGETABLE (rulings W3/10, W3/29).
// ===========================================================================
// The tick-grid exists so the practice can run the whitening campaign, and for
// two waves it could only be LOOKED at: no export, no copy, no campaign filter
// (`OutreachFilters` selects on Dentally's own patient base and has no interest
// predicate), and the co-pilot's `interest_lists` tool is a read whose own
// prompt line says you cannot send to these people from there. Three hundred
// people who asked to hear about implants, and the only way out of the platform
// was to retype them off a 25-row table.
//
// So each treatment carries a Download and a Copy-as-audience, plus one for the
// whole list. BOTH CALL THE SERVER (ruling W3/29), and that is the change this
// panel has just been through:
//
//   ONE EXPORT, NOT TWO. This panel used to build its own CSV in the browser out
//   of the rows the page had rendered, while GET /api/previsit/interest/export
//   built a different one out of its own read — two shapes of the same list, with
//   different columns and different completeness sentences, and no way for a
//   practice to tell which file it had. The browser copy is gone; the controls
//   fetch the route, and every rule about what a file may claim lives once, in
//   src/lib/triage/interest-csv.ts.
//
//   AND THE FILE IS THE WHOLE LIST. The page's own read is bounded at 400 rows,
//   so the retired export was a sample of a sample: a treatment whose people were
//   all older than those 400 rows exported NOBODY, and its button was disabled.
//   The route walks the table to its end with a keyset cursor, so the file holds
//   everyone up to a 20,000-row ceiling and says "at least N" past it. The panel
//   prints the route's own count (the `x-interest-people` header) beside the
//   control, in the same words the file's first row uses.
//
//   IT IS A GUARDED DOOR. The route runs requireModuleApiAccess("pre-visit-
//   triage") AND requireApproverRole AND the client check, and it is halted by
//   the pre-visit switch (W2-C/4's exempt list is the closed three, and this is
//   not one of them). When the module is off it answers 200 with a JSON refusal
//   rather than a file, and the sentence it wrote is printed here verbatim —
//   which is why these handlers read the content type before they read a body.
//
//   ONE ROW PER PERSON. An audience is people, not answers: a patient who said
//   yes to whitening before two appointments is one name to ring. The route
//   de-duplicates, so the file matches the counts grid above it rather than
//   quietly exceeding it.
//
// ===========================================================================
// THE COUNTS ABOVE THE GRID CAN BE FLOORS, AND THEY SAY SO (ruling W3/11).
// ===========================================================================
// `countInterestByTreatmentDetailed` reports `capped` when the figure it hands
// over is a FLOOR: there are at least that many people interested in whitening,
// and possibly more. `interestCountsCapped` carries that word down here, and
// every place a figure is printed — the headline number, the "N of T" line beside
// the export buttons, the CSV's own completeness row — is qualified by it.
//
// THE GRID AND THE FILE ARE EACH HONEST ABOUT THEIR OWN READ, AND THEY NO LONGER
// SHARE A CEILING. This paragraph used to say the counts "walk a bounded number
// of interest rows", which stopped being the whole truth at migration 0101: on a
// database with it applied the grid comes from `interest_counts_by_treatment` in
// Postgres — exact at any scale, `capped` always false — and only falls back to
// the 20,000-row keyset walk where the function is missing. The export beside it
// has no such short-circuit, because it needs the ROWS and not a tally, so past
// twenty thousand THIS SCREEN can show an exact headline above a file whose first
// line says "at least N people". That is two true sentences, not a broken pair,
// and it is deliberate: a partial count is worthless (a floor printed as a
// headline is the failure this module is written around) while a partial export
// is the most recent N people, a list somebody can work. What must never appear
// is a bare figure with no such line. Pinned in src/lib/triage/repository.test.ts
// by "an exact grid above a capped file is two honest numbers, not one broken
// pair", so neither half can drift back into promising the other's behaviour.
//
// AND A CAPPED ZERO CLOSES NOTHING. A floor of zero is the one figure in the
// grid that is not a figure: the scan stopped before it reached those people, so
// "at least 0" reads like a finding while proving nothing. The card prints "Not
// counted" instead, and — this is the half that mattered — its Download and Copy
// stay LIVE. They used to be disabled by a rule that read `counts[t] ?? 0 === 0`
// without asking whether the count had finished, which shut the only door a list
// leaves by (W3/29) on exactly the practice whose people are past the ceiling.
// The route behind those controls has no ceiling; it walks the table to its end.
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
  systemEnabled,
  noScheduledJob = false,
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
  /** Whether the pre-visit system is switched on. It ships OFF. */
  systemEnabled: boolean;
  /**
   * Whether this module's sweeps have a scheduled job at all (ruling W3/7).
   *
   * TRUE means no questionnaire can reach a patient however the switch is set:
   * /api/previsit/sweep is the only thing that mints a link, and the scheduler
   * has never heard of it (src/lib/agent-wiring/scheduler.ts, the tree's record
   * of a read of `cron.job`). Stated by the server component rather than read
   * here, because this is a "use client" module and the scheduler is a server
   * module — and because the fact is a deployment's, not a render's.
   *
   * THE STATE THIS EXISTS FOR IS THE SWITCHED-ON ONE. While the module is off,
   * the banner below carries the shared first step, which says the same thing in
   * its last clause. The moment the owner acts on that step and switches on, the
   * banner disappears with it and the page used to go silent about the cron —
   * leaving two empty lists whose own copy promises arrivals ("as soon as
   * patients start filling it in") that nothing can deliver.
   */
  noScheduledJob?: boolean;
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
          clientSlug={clientSlug}
          treatments={treatments}
          rows={interest}
          counts={interestCounts}
          countsCapped={interestCountsCapped}
          more={interestMore}
          pageSize={interestPageSize}
          noScheduledJob={noScheduledJob}
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
      {/* AND THE SWITCHED-ON STATE KEEPS THE FACT THE OFF ONE CARRIED.
          The banner above is the ONLY place this page mentions the missing cron,
          and it is drawn under `!systemEnabled` — so an owner who reads the first
          step, does what it asks and comes back finds the warning gone, two lists
          reading 0, and copy that promises arrivals. Nothing arrives: the sweep
          that mints a link has never been registered with the scheduler (W3/7,
          W3/31), so the fact has to survive the act it prompted.

          THE SAME FACT, IN THIS SCREEN'S OWN WORDS - not the same sentence, and
          the difference is deliberate. System controls opens "Switched on, but
          it has not started" (runbook §4 quotes that clause as the ROW's tell
          and runbook.test.ts pins the quote); Home's tile is shorter again
          because it truncates. What the three share is the DERIVATION: all of
          them take the flag from `slugsWithNoScheduledJob()` (W3/31, the single
          home of registration truth), so registering the cron clears all three
          in one edit with no copy to chase. Do not "unify" these strings on the
          strength of this comment: registration-truth-on-the-page.test.ts pins
          the derivation, not a string equality, and nothing here claims one. */}
      {systemEnabled && noScheduledJob ? (
        <p className="rounded-[10px] border border-status-amber/40 bg-status-amber/10 px-4 py-3 text-[12.5px] leading-relaxed text-navy">
          <span className="font-semibold">Switched on, but nothing is being sent yet.</span> The
          scheduled job that sends this questionnaire has never been registered, so no patient is asked
          anything and no answers can arrive. Ask the agency to register it. Building the
          implant-candidate list by hand still works in the meantime: use the practice owner&rsquo;s Build /
          refresh candidates button on the Implants tab, which messages nobody.
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
 * WHERE THE EXPORT LIVES (ruling W3/29).
 *
 * One guarded route, two shapes of the same list: `csv` is the file, `audience`
 * is the tab-separated paste. Built here rather than inline so the query the
 * panel sends is one testable string — the treatment key is a closed-set value
 * and the practice slug comes off the page, and both are encoded anyway.
 */
export function interestExportUrl(
  clientSlug: string,
  treatment: string | null,
  format: "csv" | "audience",
): string {
  const params = new URLSearchParams({ client: clientSlug });
  if (treatment !== null) params.set("treatment", treatment);
  if (format !== "csv") params.set("format", format);
  return `/api/previsit/interest/export?${params.toString()}`;
}

/** The shape the route answers with when it did NOT produce a list. */
export interface InterestExportRefusal {
  ok?: boolean;
  /** "system off" — the module is switched off, so no list is exported. */
  skipped?: string;
  /** The sentence the route wrote for the practice. Printed verbatim. */
  message?: string;
  error?: string;
}

/**
 * WHAT THE READER IS TOLD WHEN NO FILE ARRIVED.
 *
 * The route's own sentence, not a second copy of it: the switch refusal is
 * written for the practice ("Pre-visit questions is switched off, so these lists
 * cannot be exported.") and re-wording it here would be a copy that drifts from
 * the door that actually refused. The status-code fallback is only for the states
 * the route does not write a sentence for — a 403, a 404, a proxy in between.
 *
 * Pulled out of the click handler because it IS the behaviour: this suite renders
 * markup rather than driving events, so a rule living inside `onClick` is a rule
 * nothing can go red over. Same shape, and same reason, as `miningRunOutcome`.
 */
export function interestExportRefusal(
  res: { status: number },
  data: InterestExportRefusal,
): string {
  return data.message ?? data.error ?? `That list could not be exported just now (${res.status}).`;
}

/**
 * The line printed after a list HAS left the platform.
 *
 * `people` is the route's own `x-interest-people` header — "142", or "at least
 * 20,000" when the walk stopped at its ceiling — so the panel prints the same
 * words the file's first row does rather than counting anything itself. Null
 * means the header was missing (a proxy stripped it): the file is still fine, so
 * the sentence simply drops the figure rather than inventing one.
 */
export function interestExportNotice(
  heading: string,
  people: string | null,
  action: "downloaded" | "copied",
): string {
  const tail = action === "copied" ? " Paste into your campaign or a spreadsheet." : "";
  if (people === null) return `${heading}: ${action}.${tail}`;
  const noun = people === "1" ? "person" : "people";
  return `${heading}: ${people} ${noun} ${action}.${tail}`;
}

/**
 * The name the browser saves the file under: THE ROUTE'S OWN, when it sent one.
 *
 * The route stamps the minute in the filename so two exports of the same list are
 * told apart, and re-deriving it here would be a second clock. The fallback is
 * the same shared builder the route uses, so the shape cannot drift either way.
 */
export function interestDownloadFilename(disposition: string | null, treatment: string | null): string {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match ? match[1]! : interestExportFilename(treatment, new Date());
}

/**
 * A count that may be a floor, in the words a practice reads.
 *
 * The same rendering Home's Operating system band uses for a capped read: "at
 * least 20,000" rather than "20,000", because the second one is a number a
 * campaign gets sized on.
 *
 * AND A CAPPED ZERO IS NOT A ZERO (ruling W3/11, charter §0/5). A scan that
 * stopped early did not FIND nobody interested in veneers; it never reached
 * them. "at least 0" is the one figure in this grid that proves nothing while
 * reading like a finding — and the finding it reads like is the one a
 * coordinator acts on by NOT running the campaign. So an uncounted treatment
 * gets a word instead of a number, exactly as Home's Operating system band
 * settles the same case ("None held back in the most recent N writes" rather
 * than "Nothing held back" — src/lib/home/os-band.ts, "A ZERO OFF A CAPPED
 * READ IS NOT A ZERO").
 */
function countLabel(value: number, capped: boolean): string {
  const figure = value.toLocaleString("en-GB");
  if (capped && value === 0) return "Not counted";
  return capped ? `at least ${figure}` : figure;
}

export function InterestPanel({
  clientSlug,
  treatments,
  rows,
  counts,
  countsCapped = false,
  more = false,
  pageSize,
  noScheduledJob = false,
}: {
  /** Which practice the export route is asked for. Without it there is no door. */
  clientSlug: string;
  treatments: InterestTreatment[];
  rows: InterestRow[] | null;
  counts: Record<string, number> | null;
  /** True when every figure in `counts` is a floor rather than a total. */
  countsCapped?: boolean;
  more?: boolean;
  pageSize?: number;
  /**
   * True when no scheduled job exists to send the form (see PreVisitWorkspace).
   * It changes ONE sentence — the empty state's — because "as soon as patients
   * start filling it in" is a promise, and on this deployment it is one nothing
   * can keep.
   */
  noScheduledJob?: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  /**
   * ONE FETCH PER CONTROL (ruling W3/29).
   *
   * The route is the only export. It reads the whole table for the sites in view,
   * de-duplicates to one row per person, and answers in one of three shapes:
   *
   *   text/csv         the file. Saved through a Blob rather than followed as a
   *                    link — a plain <a href> would ALSO save the JSON refusal
   *                    below, under a .csv name, and hand somebody a "file" whose
   *                    contents are `{"ok":false,...}`.
   *   text/plain       the audience, straight onto the clipboard.
   *   application/json the refusal: the module is switched off, or the read
   *                    failed. Its own sentence is printed.
   *
   * `x-interest-people` carries the count in the same words the file's first row
   * uses, so the panel never counts anything itself.
   */
  async function run(treatment: string | null, heading: string, mode: "download" | "copy") {
    const key = `${mode}:${treatment ?? "all"}`;
    setBusy(key);
    setNotice(null);
    try {
      const res = await fetch(interestExportUrl(clientSlug, treatment, mode === "copy" ? "audience" : "csv"), {
        cache: "no-store",
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("application/json")) {
        const data = (await res.json().catch(() => ({}))) as InterestExportRefusal;
        setNotice(interestExportRefusal(res, data));
        return;
      }
      const people = res.headers.get("x-interest-people");
      if (mode === "copy") {
        const text = await res.text();
        try {
          // The clipboard needs a secure context and a permission; when it is not
          // there the copy simply did not happen. It is caught HERE rather than
          // by the outer catch because the two failures are different facts: the
          // list was read fine and only the paste failed, and telling somebody
          // "nothing left the platform" would send them looking for the wrong
          // problem — while saying nothing would leave them pasting the last
          // thing they copied into a campaign.
          await navigator.clipboard.writeText(text);
        } catch {
          setNotice("That list could not be copied. Download it instead.");
          return;
        }
        setNotice(interestExportNotice(heading, people, "copied"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = interestDownloadFilename(res.headers.get("content-disposition"), treatment);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(interestExportNotice(heading, people, "downloaded"));
    } catch {
      setNotice("That list could not be exported just now. Nothing has left the platform.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * WHETHER THERE IS ANYTHING TO EXPORT, decided on the COUNTS and not on this
   * page's rows.
   *
   * The old rule disabled a treatment's controls when none of its people were on
   * the 400-row page — which disabled the button for a treatment whose yeses are
   * simply older than that page, i.e. exactly the practice that most needs the
   * file. The counts grid knows how many people there are; when it could not be
   * read (`counts === null`) nothing is disabled, because "we could not count
   * them" is not "there are none".
   *
   * AND A CAPPED SCAN IS A COUNT THAT COULD NOT BE COMPLETED, so it closes no
   * door either (ruling W3/11, charter §0/5). `capped` means every figure here
   * is a floor: a treatment whose people all sit past the scan's ceiling comes
   * back as an absent key — `?? 0` — and the old rule read that as proof of
   * nobody and greyed out the ONLY way a list leaves the platform (W3/29), under
   * a headline that admitted in the same breath it had proved nothing. The
   * route behind these controls has no such ceiling: it walks the table to its
   * end, so it can reach exactly the people this scan did not.
   */
  const nothingToExport = (treatment: string | null) => {
    if (counts === null || countsCapped) return false;
    if (treatment === null) return Object.values(counts).every((n) => n === 0);
    return (counts[treatment] ?? 0) === 0;
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="Who asked to hear more"
        description="Every patient who said yes on a pre-visit form. The count is people, not answers: a patient who said yes twice is one person."
        actions={
          // OFFERED UNLESS WE KNOW THERE IS NOBODY. It used to be conditional on
          // this page holding rows, which hid the control from a practice whose
          // yeses are simply older than the 400 the page reads — the file is the
          // server's now, and it can reach them.
          !nothingToExport(null) ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run(null, "Everyone who asked to hear more", "download")}
              className="pressable inline-flex items-center gap-1.5 rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-navy disabled:opacity-40"
            >
              <Download size={14} />
              {busy === "download:all" ? "Building the file…" : "Export everyone"}
            </button>
          ) : undefined
        }
      >
        {counts === null ? (
          <p className="text-[13px] text-status-red">The totals could not be read.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {treatments.map((t) => {
              const key = t.key as string;
              const total = counts[t.key as InterestTreatmentKey] ?? 0;
              const none = nothingToExport(key);
              // A ZERO OFF A CAPPED SCAN IS AN ABSENCE OF A COUNT, not a count
              // of nobody — see `countLabel`. It is the one card that prints no
              // figure at all, and its export controls stay live.
              const uncounted = countsCapped && total === 0;
              return (
                <li key={t.key} className="rounded-xl border border-line bg-card px-4 py-3">
                  <p className="text-[12.5px] font-medium text-muted">{t.label}</p>
                  {/* A CAPPED READ IS A FLOOR, and it wears its sign. "20,000"
                      is a number somebody sizes a campaign on; "at least 20,000"
                      is the same read told honestly (ruling W3/11). A capped
                      ZERO is not a floor at all, so it gets a word rather than
                      a number, and the two doors under it stay open. */}
                  <p
                    className={
                      uncounted
                        ? "mt-0.5 text-[15px] font-semibold leading-snug text-muted"
                        : "mt-0.5 text-[22px] font-bold tabular-nums text-navy"
                    }
                  >
                    {countLabel(total, countsCapped)}
                  </p>
                  {uncounted ? (
                    <p className="mt-1 text-[11.5px] leading-snug text-muted">
                      The count stopped before the end of the list, so this is not a zero. Export it to see
                      who is on it.
                    </p>
                  ) : null}
                  {/* THE TWO WAYS OUT OF THE PLATFORM (rulings W3/10, W3/29).
                      Both are the server's, so what leaves is the whole list and
                      not the part of it this page happens to be showing. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy !== null || none}
                      onClick={() => void run(key, t.label, "download")}
                      aria-label={`Download the ${t.label} list as a CSV`}
                      className="pressable inline-flex items-center gap-1 rounded-[6px] border border-line px-2 py-1 text-[11.5px] font-medium text-navy disabled:opacity-40"
                    >
                      <Download size={12} />
                      {busy === `download:${key}` ? "…" : "CSV"}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null || none}
                      onClick={() => void run(key, t.label, "copy")}
                      aria-label={`Copy the ${t.label} list as an audience`}
                      className="pressable inline-flex items-center gap-1 rounded-[6px] border border-line px-2 py-1 text-[11.5px] font-medium text-navy disabled:opacity-40"
                    >
                      <ClipboardCopy size={12} />
                      {busy === `copy:${key}` ? "…" : "Copy"}
                    </button>
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
          Copy puts the same people on the clipboard to paste into a campaign or a spreadsheet. Both are read
          fresh when you press them, so they hold everyone on the list and not only the answers shown below.
        </p>
      </SectionCard>

      <SectionCard title="Most recent first">
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={Users}
            title="Nobody has asked to hear more yet"
            description={
              noScheduledJob
                ? "Yeses from the pre-visit form land here — but no form has been sent to anybody yet, and none can be until this system's scheduled job is registered."
                : "Yeses from the pre-visit form land here as soon as patients start filling it in."
            }
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
