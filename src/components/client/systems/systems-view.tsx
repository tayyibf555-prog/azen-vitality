"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Power } from "lucide-react";
import { PageHeader, SectionCard, StatCard, Tabs } from "@/components/primitives";
import { SyncStatusView } from "./sync-status-view";
import { CLIENT_NAV, NAV_SWITCH_EXEMPT_SLUGS } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Owner-only master control panel: one on/off switch per automated system. OFF
// halts the WORK — the server refuses that system's sends, agent replies and
// public intake, and it writes nothing to Dentally. It does NOT halt every
// sweep (see `killSwitchSummary` below: /api/outreach/sweep runs its
// build-continuation pass ungated, ahead of the send gate, by design), and it
// is NOT true that every module then disappears: `NAV_SWITCH_EXEMPT_SLUGS`
// keeps the preparation screens in the sidebar while their own switch is off
// (W1-D, W2-C/4), and a row's own sentence names anything else that survives
// (post-op replies are still triaged; outreach list-BUILDING deliberately
// continues before the send gate).
// `killSwitchSummary()` below is that truth in the owner's words, derived
// from the exempt set rather than restated beside it. Reads/writes /api/systems,
// which is owner-gated. Optimistic toggles with revert-on-failure.
//
// SECOND TAB: DENTALLY SYNC. The switches on the first tab decide what each
// system is allowed to DO; the second says what any of it actually reaches the
// practice's Dentally account, which is the other half of the same question and
// the one an owner asks first. It lives here rather than on a module of its own
// because both trees render this component — /c/[client]/controls for the
// practice owner and /owner/[client]/controls for the agency — while the owner
// tree resolves a single dynamic module segment and cannot route a nested page.
// (/c/[client]/controls/sync is the deep link, and renders the same view.)
//
// Tabs mounts only the ACTIVE panel, so the sync read costs nothing until
// somebody opens it.

export interface SystemRow {
  slug: string;
  label: string;
  group: string;
  halts: string;
  /**
   * What switching it ON starts. Comes from /api/systems, which reads it from
   * src/lib/systems/vocabulary.ts — by reference from the agent roster for every
   * system that is an agent, so it cannot drift from the switch-on runbook.
   * Null only for a system with no sentence written, which a test forbids.
   */
  starts: string | null;
  /** What has to be in place before that first tick can work. */
  needsFirst: string[];
  /**
   * THE ONE THING TO DO FIRST, and this panel is the only screen that can print
   * it for the Dentally master lever.
   *
   * The sentence is written once in src/lib/systems/first-steps.ts and printed
   * everywhere: the equipment, IT desk and pre-visit workspaces print their own
   * in their empty state, and Home's Operating system band prints one under a
   * switched-off tile. The write-back lever is the one surface neither of those
   * reaches — it has no module page of its own, and its band tile is the one
   * tile that counts WHILE OFF (os-band.ts), so that tile always resolves to a
   * figure or a fact and never to the off state that carries a first step. The
   * sentence was therefore written, serialised by /api/systems, and read by
   * nobody. It is read here.
   *
   * Null for a system with no sentence written, which is most of them.
   */
  firstStep: string | null;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Render groups in this order; anything unexpected falls to the end.
//
// "Dentally" is LAST and is a group of one: the master lever over everything
// this platform writes back to the practice's book. It is drawn after the
// systems it governs, immediately above the Dentally sync tab's own subject
// matter, rather than buried in Operations between Compliance and the IT desk.
export const GROUP_ORDER = [
  "Patient lifecycle",
  "Acquisition",
  "Conversational agents",
  "Operations",
  "Dentally",
];

/**
 * The systems whose sweep the SCHEDULER DOES NOT HOLD.
 *
 * ---------------------------------------------------------------------------
 * WHY A SWITCHED-ON ROW NEEDS THIS (wave-3 review, 4 September 2026).
 * ---------------------------------------------------------------------------
 * "Needs first" is rendered only while a system is OFF, which is right for a
 * prerequisite an owner arranges before switching on — an env var, an account, a
 * phone number. It is exactly wrong for the one prerequisite that is not about
 * being ready: five of these sweeps have no cron job at all, so the switch
 * starts nothing, and the only sentence on any screen that said so DISAPPEARED
 * at the moment the owner acted on it.
 *
 * The path was: the platform's own first step says "read the two question lists,
 * then switch the system on"; he does; and from that second the control panel
 * says "Running.", the module page's banner vanishes, and Home's tile prints
 * "0 sent, awaiting an answer" — a bare, complete-looking nought for a sweep
 * that cannot ever run. Ruling W3/7 puts registration truth on this screen, and
 * the state where it matters is ON.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST IS HERE, AND WHAT KEEPS IT TRUE.
 * ---------------------------------------------------------------------------
 * Registration truth lives in the scheduler, and the tree's record of it is
 * §2 of docs/runbooks/agent-switch-on.md (pinned row-for-row against
 * `SCHEDULER` in src/lib/agent-wiring/runbook.test.ts, which is a read of
 * `cron.job` on the production project). Neither is reachable from a browser
 * bundle: the runbook is a file, the roster carries repo-relative source paths,
 * and /api/systems does not send it. So the slugs are named here and
 * cron-registration.test.ts derives the same set from the runbook's table by
 * mapping each unregistered ROUTE through the agent roster's `trigger` — this
 * list going stale is a red test, in both directions, the day a job is
 * registered or a new sweep ships without one.
 *
 * A `needsFirst` string is deliberately NOT used to detect this: two of the
 * roster's cron sentences say "NOT applied" for jobs that have been firing in
 * production for months (the runbook says so in as many words), so a screen that
 * read the prose would tell an owner a working system cannot run.
 */
export const SWEEPS_WITH_NO_CRON_JOB: readonly string[] = [
  "treatment-closer",
  "balance-reminders",
  "postop-checkin",
  // Covers BOTH pre-visit jobs: the questionnaire sweep and the implant scan.
  "pre-visit-triage",
];

/**
 * What a switched-on system with no scheduled job says about itself, or null.
 *
 * Null while the system is OFF, because the row is already carrying the same
 * fact under "Needs first" — the roster's own words, with the job name in them.
 *
 * ONE SENTENCE FOR FOUR SLUGS WAS TRUE FOR THREE OF THEM. "nothing runs …
 * this system is on in name only" is exactly right for the closer, balance
 * reminders and the post-op check-in: those three have one sweep each, it is
 * unregistered, and the switch therefore starts nothing at all.
 *
 * It is FALSE for `pre-visit-triage`, and false in the direction that costs the
 * owner the thing he asked for by name. Rulings W3/8, W3/21 and W3/27 landed
 * after this copy was written: the owner-only "Build / refresh candidates"
 * button on the pre-visit page is `disabled` while the system is off and
 * POST /api/previsit/mining-run refuses under the same switch, so switching
 * this system ON is the only way to run the implant scan by hand. An owner who
 * reads "on in name only" switches it back off — into the one state in which
 * the button he came for cannot be pressed. The runbook's pre-visit section
 * says the opposite of the old sentence in as many words ("It can be built by
 * hand in the meantime"), and ruling W3/9 settles which of the two moves: copy
 * matches code, never the reverse.
 *
 * The opening clause is shared deliberately. §4 of the runbook quotes it
 * ("Switched on, but it has not started") as the row's tell for an unregistered
 * job, and runbook.test.ts pins that quote; the correction is to the tail, which
 * is where the over-claim was.
 */
const REGISTRATION_WARNING_BY_SLUG: Record<string, string> = {
  // IT CLAIMS ONE JOB, NOT TWO, because one job is what this list can vouch for.
  // `SWEEPS_WITH_NO_CRON_JOB` carries SLUGS, and the slug reaches it through the
  // agent whose trigger is /api/previsit/sweep — the questionnaire sweep. The
  // implant scan is a second, separately registrable job (app-sweep-previsit-
  // mining) that this screen cannot see the state of, so the sentence asks for it
  // to be checked rather than asserting it is missing: a count here would be copy
  // that a later registration silently falsifies.
  "pre-visit-triage":
    "Switched on, but it has not started: the scheduled job that sends this questionnaire has never been " +
    "registered, so no patient is asked anything. Ask the agency to register it — and to check the implant " +
    "scan's own job while they are there. Switching on is not nothing in the meantime: it is what lets an owner " +
    "build the implant-candidate list by hand with Build / refresh candidates on the pre-visit page, which reads " +
    "patient history and messages nobody.",
};

const REGISTRATION_WARNING_DEFAULT =
  "Switched on, but it has not started: its scheduled job has never been registered, so nothing runs and " +
  "nothing is sent. Ask the agency to register it — until then this system is on in name only.";

export function registrationWarning(row: Pick<SystemRow, "enabled" | "slug">): string | null {
  if (!row.enabled) return null;
  if (!SWEEPS_WITH_NO_CRON_JOB.includes(row.slug)) return null;
  return REGISTRATION_WARNING_BY_SLUG[row.slug] ?? REGISTRATION_WARNING_DEFAULT;
}

/**
 * The three figures above the panel: running, not started, switched off.
 *
 * SWITCHED ON IS NOT RUNNING, AND THE TWO OWNER SCREENS HAD STOPPED AGREEING.
 * Home's Automations tile already subtracts the switches whose sweep the
 * scheduler has never heard of (src/lib/home/os-band.ts, ruling W3/31): with
 * `pre-visit-triage` on it reads "2 of 30 running, 1 not started". This card
 * counted every enabled row and read "3 of 30" for the same practice at the same
 * moment — two owner-facing figures, both labelled running, differing by the
 * exact system the owner had just toggled. One of them had to be wrong, and it
 * was this one: the row directly below it already says so in words ("Switched
 * on, but it has not started", `registrationWarning` above), so the headline was
 * contradicting its own panel — the charter's honest-numbers rule (§0/5) applied
 * to the smallest number on the screen.
 *
 * IT USES THE SAME SET AS HOME. `SWEEPS_WITH_NO_CRON_JOB` is held equal to
 * `slugsWithNoScheduledJob()` by cron-registration.test.ts, which is the module
 * Home reads directly, so the two screens move together the day a job is
 * registered rather than needing to be corrected twice.
 *
 * THE DENOMINATOR DOES NOT MOVE, and a stalled system is NOT folded into
 * `off`: the owner switched it on, and a figure that quietly relabelled his
 * action would read as the switch not having taken. It is returned separately so
 * the panel can give it its own card, shown only when there is one to show.
 *
 * Pulled out of the component because SystemsView fetches its rows in an effect —
 * a test that rendered the view would get the loading state and nothing else,
 * which is how a headline can be wrong on every real screen with no assertion
 * going red. Same reason `SystemRowLine` and `registrationWarning` are exported.
 */
export function systemHeadlineCounts(rows: readonly Pick<SystemRow, "enabled" | "slug">[]): {
  total: number;
  running: number;
  stalled: number;
  off: number;
} {
  const total = rows.length;
  const enabled = rows.filter((r) => r.enabled).length;
  const stalled = rows.filter((r) => r.enabled && SWEEPS_WITH_NO_CRON_JOB.includes(r.slug)).length;
  return { total, running: enabled - stalled, stalled, off: total - enabled };
}

/**
 * WHAT "OFF" ACTUALLY MEANS, on the one screen that decides it.
 *
 * THE OVER-CLAIM this replaces. The panel opened with "Turning one off is a full
 * kill switch: it hides the module and stops all of its work, so nothing sends
 * and nothing is written to Dentally until you switch it back on." Two of those
 * clauses are false, and the screen itself is the proof:
 *
 *   - "it hides the module" is false for every slug in NAV_SWITCH_EXEMPT_SLUGS.
 *     Those four (Campaigns, Equipment, IT desk, Pre-visit questions) are kept in
 *     the sidebar by `categoriesForRole` precisely so the owner can review and
 *     prepare them BEFORE arming them (rulings W1-D and W2-C/4). An owner who
 *     switches Pre-visit questions off, still sees it in his sidebar and can
 *     still open it reasonably concludes the switch did not take.
 *   - "stops all of its work" is false for at least two rows this panel prints.
 *     /api/outreach/sweep runs its build-continuation pass UNGATED, ahead of the
 *     send gate, by design ("Building a list is not sending"); the post-op
 *     check-in row says in its own `halts` sentence that replies are still
 *     triaged and escalated to a person.
 *
 * W3/9 settles which side moves: copy matches code, never the reverse. So the
 * paragraph claims only the two things that ARE universally true — the work
 * stops, and nothing reaches Dentally — and then names the exceptions instead of
 * papering over them. It DERIVES the still-reachable list from
 * NAV_SWITCH_EXEMPT_SLUGS rather than restating it in prose, so widening that
 * set rewrites this sentence in the same edit (kill-switch-copy.test.ts pins
 * that join, and goes red if a slug is exempted without appearing here).
 *
 * THE REPLACEMENT KEPT ONE WORD OF THE OVER-CLAIM, AND THAT WORD IS "SWEEPS"
 * (wave-3d review, 6 September 2026). "its sweeps, sends, agent replies and
 * public forms stop" is the same false claim as "stops all of its work", made
 * about the same row: /api/outreach/sweep runs `continueBuilds()` and its
 * Dentally reads BEFORE `isSystemEnabledForSend(CLIENT_ID, "outreach")`, on every
 * ten-minute tick, so the outreach SWEEP does not stop and this sentence said
 * every system's does. src/lib/systems/catalog.test.ts already derives from that
 * call order that the outreach ROW may not say its sweep halts; the panel-wide
 * paragraph was asserting the opposite, and kill-switch-copy.test.ts had pinned
 * the clause as one of "the two things that ARE true of every system" — two
 * green tests contradicting each other. The word is gone; the send, agent-reply,
 * public-form and Dentally-write halves are true of every row and stay. The
 * carry-on class is named in general terms rather than by system, because naming
 * "Segment outreach" here would be the prose-restating-code shape this whole
 * paragraph exists to avoid — and the same derivation that made the claim false
 * now guards the sentence.
 *
 * The exceptions matter more than they look: this paragraph is the ONLY thing on
 * screen describing the off state. `systemRowSentence` prints `starts`, not
 * `halts`, for a row that is off, so the corrective sentence a few pixels below
 * is invisible in exactly the state the reader is asking about — which is why
 * the last sentence says WHEN the row's own line spells the exception out.
 */
export function killSwitchSummary(): string {
  const labels = CLIENT_NAV.flatMap((g) => g.items)
    .filter((i) => NAV_SWITCH_EXEMPT_SLUGS.has(i.slug))
    .map((i) => i.label);
  const named =
    labels.length === 0
      ? ""
      : labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const reachable = named
    ? ` Most modules disappear from your sidebar while they are off; ${named} stay ` +
      "reachable so you can review and prepare them before switching on."
    : "";
  return (
    "Turning one off halts that system's work: its sends, agent replies and public forms stop, " +
    "and it writes nothing to Dentally, until you switch it back on." +
    reachable +
    " A few background passes are deliberately outside the switch — preparing work is not sending it — " +
    "and each system's own line spells its exceptions out while it is running."
  );
}

/**
 * The one line under a system's name.
 *
 * EXTRACTED SO IT CAN BE TESTED, because the rule it encodes is the whole point
 * of the change and it used to be the wrong way round: an OFF row printed what
 * would stop if you switched it off — a fact about the state it is already in —
 * and an ON row printed nothing but "Running.". Each row now answers the
 * question its own state raises.
 *
 * The `?? halts` fallback covers a system with no switch-on sentence written.
 * vocabulary.test.ts forbids that case, so the fallback is a belt on a screen
 * rather than a licence to skip the sentence.
 */
export function systemRowSentence(row: Pick<SystemRow, "enabled" | "halts" | "starts">): string {
  return row.enabled ? `Running. ${row.halts}` : row.starts ?? row.halts;
}

/** One request, as a value. Pure of React, so the effect below stays readable. */
async function fetchSystems(
  clientSlug: string,
): Promise<{ systems: SystemRow[] } | { error: string }> {
  try {
    const res = await fetch(`/api/systems?client=${encodeURIComponent(clientSlug)}`);
    const json = (await res.json()) as { ok?: boolean; systems?: SystemRow[]; error?: string };
    if (!res.ok || !json.ok || !Array.isArray(json.systems)) {
      throw new Error(json.error ?? "Could not load system controls");
    }
    return { systems: json.systems };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load system controls" };
  }
}

export function SystemsView({ clientSlug }: { clientSlug: string }) {
  // THE ROUTER IS HELD FOR ONE REASON: a flipped switch has to reach the SERVER-
  // RENDERED screens that read it. See `toggle` below.
  const router = useRouter();
  const [rows, setRows] = useState<SystemRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<string | null>(null);
  // Bumping this re-runs the effect: "Try again" asks for the same request the
  // mount made, rather than a second copy of it living beside the effect.
  const [reloadKey, setReloadKey] = useState(0);

  // THE FETCH IS OWNED BY THE EFFECT, not called from it — the same shape the
  // Dentally sync panel next door now uses.
  //
  // `void load()` in an effect body tripped react-hooks/set-state-in-effect (a
  // stale-closure and cascading-render hazard the rule is right about). Running
  // the request inside the effect, with its own `cancelled` flag, keeps every
  // setState behind an await AND fixes the bug the pattern actually has: an
  // agency admin switching practice mid-flight could otherwise let the previous
  // practice's switches land on the new practice's panel — and this panel's
  // toggles write straight to /api/systems, so a row acted on there would be a
  // kill switch flipped for the wrong client.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchSystems(clientSlug);
      if (cancelled) return;
      if ("error" in next) setLoadError(next.error);
      else {
        setLoadError(null);
        setRows(next.systems);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientSlug, reloadKey]);

  async function toggle(slug: string, next: boolean) {
    if (busy.has(slug)) return;
    setRowError(null);
    setBusy((b) => new Set(b).add(slug));
    // Optimistic: flip locally, revert if the write fails.
    setRows((rs) => rs?.map((r) => (r.slug === slug ? { ...r, enabled: next } : r)) ?? rs);
    let wrote = false;
    try {
      const res = await fetch("/api/systems", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, slug, enabled: next }),
      });
      if (!res.ok) throw new Error("write failed");
      wrote = true;
    } catch {
      setRows((rs) => rs?.map((r) => (r.slug === slug ? { ...r, enabled: !next } : r)) ?? rs);
      setRowError("Could not update that system. Please try again.");
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(slug);
        return n;
      });
    }
    // -----------------------------------------------------------------------
    // AND THE REST OF THE APP IS TOLD (Next 16 client router cache).
    //
    // The optimistic flip above updates THIS panel and nothing else, and this is
    // the write in the tree with the widest SERVER-rendered blast radius.
    // `system_toggle` is read on the server by the sidebar (`getDisabledSlugs`
    // in src/app/c/[client]/layout.tsx), by Home's Operating system band
    // (`readOsBand`/`getSystemStates` — the Off pill, the empty/figure states and
    // the "N of M running" cell) and by the module banners that say whether a
    // system is armed.
    //
    // next.config.ts sets `experimental.staleTimes = { dynamic: 30, static: 120 }`,
    // so a route the owner has already visited is restored from the client router
    // cache on the next <Link> navigation WITHOUT re-rendering on the server. A
    // plain `fetch` to a Route Handler — unlike a Server Action — invalidates
    // none of it: `invalidateBfCache()` has exactly two callers in the Next
    // runtime, the refresh reducer and the server-action reducer. So without this
    // line the owner switches a system off during an incident, clicks Home to
    // confirm it stopped, and reads the PRE-toggle state for the length of the
    // stale time, with nothing on screen to distinguish a stale cache from a save
    // that never landed. (The halt itself is server-side and immediate; only the
    // display lags. That is still the screen he decides from.) Every other write
    // surface in the tree already refreshes — equipment, the IT desk, pre-visit,
    // the patient editors, the diary, the top bar; this one did not.
    //
    // ONE CALL COVERS EVERY SURFACE, because the invalidation bumps the cache
    // version and the whole client cache is dropped, not just this route.
    //
    // OUTSIDE THE TRY, AND ONLY ON A WRITE THAT LANDED: a throw from the refresh
    // must not be caught by the block above and reported to the owner as "could
    // not update that system", which would be the panel lying about a switch it
    // successfully flipped. Pinned by control-panel.test.ts, "a flipped switch
    // invalidates the server-rendered screens that read it".
    // -----------------------------------------------------------------------
    if (wrote) router.refresh();
  }

  const { total, running, stalled, off: offCount } = systemHeadlineCounts(rows ?? []);

  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: (rows ?? []).filter((r) => r.group === g),
  })).filter((g) => g.items.length > 0);

  const systemsPanel = (
    <>
      <p className="mb-5 max-w-3xl text-[13px] text-muted">{killSwitchSummary()}</p>

      {rowError ? (
        <p className="rounded-xl border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{rowError}</p>
      ) : null}

      {loadError ? (
        <SectionCard title="Couldn't load controls">
          <p className="text-sm text-muted">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setReloadKey((k) => k + 1);
            }}
            className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold text-navy hover:bg-card-muted"
          >
            Try again
          </button>
        </SectionCard>
      ) : !rows ? (
        <SectionCard title="Systems">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading your systems…
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-6">
          {groups.map(({ group, items }) => (
            <SectionCard
              key={group}
              title={group}
              // The one group that needs a line of its own: the master lever is
              // not a module, and what it holds back is on the tab next to this
              // one. Said once, here, rather than repeated on every row.
              description={
                group === "Dentally"
                  ? "One lever above every module. Every write it holds back is listed on the Dentally sync tab."
                  : undefined
              }
              bodyClassName="p-0"
            >
              <ul className="divide-y divide-line">
                {items.map((r) => (
                  <SystemRowLine
                    key={r.slug}
                    row={r}
                    busy={busy.has(r.slug)}
                    onToggle={() => void toggle(r.slug, !r.enabled)}
                  />
                ))}
              </ul>
            </SectionCard>
          ))}
        </div>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title="System controls"
        description="Your master on/off for every automated system, and the record of what this platform writes back to Dentally."
        stats={
          rows ? (
            <>
              <StatCard label="Systems running" value={`${running} of ${total}`} dot="bg-status-green" />
              {stalled > 0 ? <StatCard label="Not started" value={stalled} dot="bg-status-amber" /> : null}
              {offCount > 0 ? <StatCard label="Switched off" value={offCount} dot="bg-status-amber" /> : null}
            </>
          ) : undefined
        }
      />
      <Tabs
        tabs={[
          { key: "systems", label: "Systems", content: systemsPanel },
          { key: "sync", label: "Dentally sync", content: <SyncStatusView clientSlug={clientSlug} /> },
        ]}
      />
    </>
  );
}

/**
 * ONE ROW of the panel.
 *
 * EXPORTED, and pulled out of the map for that reason: SystemsView fetches its
 * rows in an effect, so a test that renders the view gets the loading state and
 * nothing else — which is how "Needs first" could be hidden on every switched-on
 * row without one assertion going red. Rendered directly, each state of a row is
 * a test rather than a click.
 */
export function SystemRowLine({
  row,
  busy,
  onToggle,
}: {
  row: SystemRow;
  busy: boolean;
  onToggle: () => void;
}) {
  const warning = registrationWarning(row);
  return (
    <li className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-navy">
          {row.label}
          {!row.enabled ? (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              Off
            </span>
          ) : null}
        </p>
        {/* THE SENTENCE FOLLOWS THE SWITCH, AND IT USED TO BE THE
            WRONG WAY ROUND. A row that is OFF printed what would
            stop if you switched it off — a fact about a state it is
            already in — and a row that is ON printed nothing but
            "Running.". Each row now answers the question its own
            state raises: an off row says what switching it on
            starts, an on row says what switching it off stops. */}
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{systemRowSentence(row)}</p>
        {/* AND THE ON ROW SAYS WHEN IT CANNOT ACTUALLY RUN. "Running." over a
            sweep with no cron job is the one sentence on this screen that is
            simply untrue, and it is the state the platform's own first step
            walks the owner into. See registrationWarning above. */}
        {warning ? (
          <p className="mt-1 text-[11px] leading-relaxed text-warning">{warning}</p>
        ) : null}
        {/* WHAT TO DO FIRST, on the screen where an owner decides to switch
            it on. Above "Needs first" because it is the step that comes
            before the prerequisites are worth reading — for the Dentally
            lever it is "read the sync tab and see what is waiting", which is
            the tab immediately to the right of this one. Only while OFF: a
            running system's first step has been taken. `?? null` for the same
            rollout reason as the list below. */}
        {!row.enabled && (row.firstStep ?? null) ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted">{row.firstStep}</p>
        ) : null}
        {/* `?? []` because a browser holding the new bundle can
            reach the previous deployment's route for a few seconds
            during a rollout, and a control panel is not the place
            to throw on a missing field. */}
        {!row.enabled && (row.needsFirst ?? []).length > 0 ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            <span className="font-semibold">Needs first:</span> {row.needsFirst.join(" · ")}
          </p>
        ) : null}
      </div>
      <SystemSwitch enabled={row.enabled} busy={busy} label={row.label} onToggle={onToggle} />
    </li>
  );
}

function SystemSwitch({
  enabled,
  busy,
  label,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} is ${enabled ? "on" : "off"}`}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2",
        enabled ? "bg-success" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "inline-flex h-5 w-5 translate-x-0.5 items-center justify-center rounded-full bg-white shadow-sm transition-transform",
          enabled && "translate-x-[22px]",
        )}
      >
        {busy ? <Loader2 size={11} className="animate-spin text-muted" /> : <Power size={10} className={enabled ? "text-success" : "text-muted"} />}
      </span>
    </button>
  );
}
