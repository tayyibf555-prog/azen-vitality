"use client";

import { useEffect, useState } from "react";
import { Loader2, Power } from "lucide-react";
import { PageHeader, SectionCard, StatCard, Tabs } from "@/components/primitives";
import { SyncStatusView } from "./sync-status-view";
import { cn } from "@/lib/utils";

// Owner-only master control panel: one on/off switch per automated system. OFF is
// a full kill switch (the server halts the system's sweeps, sends, agent replies
// and public intake, and the module is hidden). Reads/writes /api/systems, which
// is owner-gated. Optimistic toggles with revert-on-failure.
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
 */
export function registrationWarning(row: Pick<SystemRow, "enabled" | "slug">): string | null {
  if (!row.enabled) return null;
  if (!SWEEPS_WITH_NO_CRON_JOB.includes(row.slug)) return null;
  return (
    "Switched on, but it has not started: its scheduled job has never been registered, so nothing runs and " +
    "nothing is sent. Ask the agency to register it — until then this system is on in name only."
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
    try {
      const res = await fetch("/api/systems", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, slug, enabled: next }),
      });
      if (!res.ok) throw new Error("write failed");
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
  }

  const total = rows?.length ?? 0;
  const running = rows?.filter((r) => r.enabled).length ?? 0;
  const offCount = total - running;

  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: (rows ?? []).filter((r) => r.group === g),
  })).filter((g) => g.items.length > 0);

  const systemsPanel = (
    <>
      <p className="mb-5 max-w-3xl text-[13px] text-muted">
        Turning one off is a full kill switch: it hides the module and stops all of its work, so nothing sends and
        nothing is written to Dentally until you switch it back on.
      </p>

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
