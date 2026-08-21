"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Lock, RotateCcw } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, Toggle } from "@/components/primitives";
import { ROLE_LABELS } from "@/lib/provisioning/rules";
import { cn } from "@/lib/utils";

// ===========================================================================
// THE PERMISSIONS SCREEN. A LIST OF PEOPLE, COLLAPSED, AND NOTHING ELSE UNTIL
// ONE IS OPENED.
//
// Owner-only. Reads and writes /api/permissions, which repeats every gate on the
// server — nothing here is a security boundary, and the screen greys a control
// for the same reason it tells you why: so the owner is not clicking things that
// will be refused.
//
// WHY PERSON-FIRST, AND NOT THE GRID THIS USED TO BE. The grid was one wide
// table PER CAPABILITY GROUP, and every one of them listed every person again.
// Five people and eight groups is the same five names printed eight times, each
// table scrolling sideways off the screen, and the owner reading a wall of
// switches to answer a question that is always about ONE person: "what may
// Blerta do?". So the axes are inverted. The page is a list of names; you click
// a name and you get that person's permissions, every group, stacked vertically
// so it fits the width of any screen. No horizontal scrolling anywhere.
//
// ONE OPEN AT A TIME (an accordion), which is the house pattern for exactly this
// shape — see the onboarding submissions worklist. A side detail panel would be
// a new pattern in this app, and permissions is not the place to introduce one.
//
// PER-CELL OPTIMISTIC WRITES, not a save bar. Fifty staff by twenty-five
// capabilities is over a thousand decisions; a batch save would be a diff nobody
// can review and one failed row would poison the whole submission. Each toggle
// writes one row, flips locally, and reverts with a message if the write fails —
// the same shape as the kill-switch panel.
//
// TWO STATES PER CAPABILITY, and the difference is the whole point of the screen:
//   INHERITED  the answer comes from the person's role. No row is stored.
//   DECIDED    somebody chose this for this person. A dot marks it, and the
//              arrow deletes the row so it goes back to following the role.
// ===========================================================================

type CellSource = "role" | "granted" | "revoked";

export interface Cell {
  capability: string;
  held: boolean;
  source: CellSource;
}

export interface PersonRow {
  id: string;
  name: string;
  email: string;
  role: string;
  cells: Cell[];
}

export interface CapabilityCol {
  key: string;
  group: string;
  label: string;
  description: string;
  destructive: boolean;
  locked: boolean;
}

/** One capability group, with the capabilities that belong to it. */
export interface CapabilityGroupView {
  group: string;
  columns: CapabilityCol[];
}

interface GridResponse {
  ok?: boolean;
  people?: PersonRow[];
  capabilities?: CapabilityCol[];
  protectedRoles?: string[];
  actorId?: string | null;
  error?: string;
}

/** Render groups in this order; anything unexpected falls to the end. */
const GROUP_ORDER = [
  "diary",
  "patient",
  "clinical",
  "messaging",
  "people",
  "reports",
  "system",
  "security",
];

export const GROUP_LABEL: Record<string, string> = {
  diary: "The diary",
  patient: "Patients",
  clinical: "The clinical record",
  messaging: "Messaging patients",
  people: "Staff and time",
  reports: "Reports",
  system: "The platform",
  security: "Permissions themselves",
};

/**
 * The catalog, split into the groups the open panel stacks vertically.
 *
 * Exported and pure so the test can prove the panel heads EVERY group the real
 * catalog contains — a group that quietly lost its heading is a capability the
 * owner can no longer find.
 */
export function groupCapabilities(capabilities: CapabilityCol[]): CapabilityGroupView[] {
  const seen = new Map<string, CapabilityCol[]>();
  for (const c of capabilities) {
    const list = seen.get(c.group) ?? [];
    list.push(c);
    seen.set(c.group, list);
  }
  const ordered = [
    ...GROUP_ORDER.filter((g) => seen.has(g)),
    ...[...seen.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  return ordered.map((g) => ({ group: g, columns: seen.get(g)! }));
}

/** Why nobody at all may be given this capability, or null. */
const OWNER_ONLY_REASON =
  "This one comes with being an owner. It cannot be switched on or off for anybody.";

/**
 * Why this PERSON cannot be edited at all, or null when they can.
 *
 * Split out from `lockedReason` so the open panel can say it once at the top
 * rather than repeating it on thirty rows — but it is the SAME function the
 * per-capability rule composes with, so the banner and the greyed switch can
 * never disagree.
 */
export function personLockReason(
  person: PersonRow,
  protectedRoles: Set<string>,
  actorId: string | null,
): string | null {
  if (protectedRoles.has(person.role)) {
    return "An owner's permissions cannot be changed here.";
  }
  if (actorId && person.id === actorId) {
    return "You cannot change your own permissions. Ask the other owner.";
  }
  return null;
}

export function PermissionsView({ clientSlug }: { clientSlug: string }) {
  const [data, setData] = useState<GridResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<string | null>(null);
  // COLLAPSED IS THE STARTING STATE, deliberately: null means no one is open, so
  // the screen opens as a short list of names and not a wall of switches.
  const [openPersonId, setOpenPersonId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // THE READ IS SPLIT IN TWO, AND THE SPLIT IS THE HOUSE PATTERN.
  // ---------------------------------------------------------------------------
  // `read` fetches and RETURNS; it sets no state at all. `apply` is the only
  // thing that writes state, and the effect calls it from the promise's callback
  // rather than in its own body (use-diary-day, use-self-service). Two reasons,
  // and only the first is the lint rule:
  //
  //   * a setState reachable synchronously from an effect is a cascading render
  //     before the request has even been issued (react-hooks/set-state-in-effect);
  //   * `cancelled` retires an in-flight answer when the screen unmounts or the
  //     practice changes, so a slow reply for one client cannot repaint over a
  //     faster one for the next. This file had no such guard before.
  // ---------------------------------------------------------------------------
  type GridResult = { grid: GridResponse | null; error: string | null };

  const read = useCallback(async (): Promise<GridResult> => {
    try {
      const res = await fetch(`/api/permissions?client=${encodeURIComponent(clientSlug)}`);
      const json = (await res.json()) as GridResponse;
      if (!res.ok || !json.ok || !Array.isArray(json.people) || !Array.isArray(json.capabilities)) {
        throw new Error(json.error ?? "We could not load the permissions for this practice.");
      }
      return { grid: json, error: null };
    } catch (e) {
      // LOUD FAILURE. An unreadable grid renders as a failure with a retry, never
      // as an empty one: "nobody has any overrides" and "we could not read them"
      // look identical and mean opposite things.
      return {
        grid: null,
        error: e instanceof Error ? e.message : "We could not load the permissions for this practice.",
      };
    }
  }, [clientSlug]);

  const apply = useCallback((result: GridResult) => {
    if (result.grid) setData(result.grid);
    setLoadError(result.error);
  }, []);

  /** For event handlers only — never called from an effect. */
  const load = useCallback(async () => {
    apply(await read());
  }, [read, apply]);

  useEffect(() => {
    let cancelled = false;
    read()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch(() => {
        // `read` does not throw; belt and braces so an unexpected throw becomes an
        // honest failure rather than a grid that never arrives.
        if (!cancelled) apply({ grid: null, error: "We could not load the permissions for this practice." });
      });
    return () => {
      cancelled = true;
    };
  }, [read, apply]);

  const people = data?.people ?? [];
  const capabilities = useMemo(() => data?.capabilities ?? [], [data]);
  const protectedRoles = useMemo(() => new Set(data?.protectedRoles ?? []), [data]);
  const actorId = data?.actorId ?? null;

  const groups: CapabilityGroupView[] = useMemo(
    () => groupCapabilities(capabilities),
    [capabilities],
  );

  const decidedCount = people.reduce(
    (n, p) => n + p.cells.filter((c) => c.source !== "role").length,
    0,
  );

  /** Why this cell cannot be changed, or null when it can. */
  const lockedReason = useCallback(
    (person: PersonRow, column: CapabilityCol): string | null => {
      if (column.locked) return OWNER_ONLY_REASON;
      return personLockReason(person, protectedRoles, actorId);
    },
    [protectedRoles, actorId],
  );

  function applyLocal(personId: string, capability: string, next: Cell | null, fallback: Cell) {
    setData((d) => {
      if (!d?.people) return d;
      return {
        ...d,
        people: d.people.map((p) =>
          p.id !== personId
            ? p
            : {
                ...p,
                cells: p.cells.map((c) => (c.capability === capability ? (next ?? fallback) : c)),
              },
        ),
      };
    });
  }

  async function write(person: PersonRow, column: CapabilityCol, granted: boolean) {
    const key = `${person.id}:${column.key}`;
    if (busy.has(key)) return;
    const before = person.cells.find((c) => c.capability === column.key);
    if (!before) return;
    setRowError(null);
    setBusy((b) => new Set(b).add(key));
    // Optimistic. `source` is recomputed from the server's answer on reload; until
    // then the cell shows the decision that was just made, which is what happened.
    applyLocal(person.id, column.key, { capability: column.key, held: granted, source: granted ? "granted" : "revoked" }, before);
    try {
      const res = await fetch("/api/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, appUserId: person.id, capability: column.key, granted }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "That permission could not be saved.");
    } catch (e) {
      applyLocal(person.id, column.key, null, before);
      setRowError(e instanceof Error ? e.message : "That permission could not be saved.");
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  }

  async function reset(person: PersonRow, column: CapabilityCol) {
    const key = `${person.id}:${column.key}`;
    if (busy.has(key)) return;
    const before = person.cells.find((c) => c.capability === column.key);
    if (!before) return;
    setRowError(null);
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await fetch("/api/permissions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, appUserId: person.id, capability: column.key }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "That permission could not be reset.");
      // The role default is not known client-side, so re-read rather than guess.
      await load();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "That permission could not be reset.");
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  }

  return (
    <>
      <PageHeader
        title="People & permissions"
        description="Who can do what. Each person starts with what their role allows; open a name to switch one on or off, and that decision follows them everywhere. Changes apply immediately — they may need to refresh before a button disappears from their screen, but the platform refuses the action either way."
        stats={
          data ? (
            <>
              <StatCard label="People with a login" value={people.length} />
              <StatCard
                label="Set by hand"
                value={decidedCount}
                dot={decidedCount > 0 ? "bg-status-blue" : undefined}
              />
            </>
          ) : undefined
        }
      />

      {rowError ? (
        <p className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {rowError}
        </p>
      ) : null}

      {loadError ? (
        <SectionCard title="Couldn't load permissions">
          <p className="text-sm text-muted">{loadError}</p>
          <p className="mt-2 text-sm text-muted">
            Nothing is shown rather than an empty grid, because an empty grid would read as
            &ldquo;nobody has any permissions set&rdquo;.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold text-navy hover:bg-card-muted"
          >
            Try again
          </button>
        </SectionCard>
      ) : !data ? (
        <SectionCard title="Permissions">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading your team&rsquo;s permissions…
          </p>
        </SectionCard>
      ) : people.length === 0 ? (
        <SectionCard title="Permissions">
          <p className="text-sm text-muted">
            This practice has no logins yet apart from the platform administrator, so there is nothing
            to set. Invite a colleague first and they will appear here.
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-4">
          <PermissionsLegend />
          <SectionCard
            title="Permissions"
            description="Choose a person to see and change what they may do."
          >
            <ul className="divide-y divide-line">
              {people.map((person) => (
                <PersonAccordionRow
                  key={person.id}
                  person={person}
                  groups={groups}
                  expanded={openPersonId === person.id}
                  onExpandToggle={() =>
                    setOpenPersonId((current) => (current === person.id ? null : person.id))
                  }
                  lockReason={personLockReason(person, protectedRoles, actorId)}
                  busy={busy}
                  lockedReason={lockedReason}
                  onToggle={write}
                  onReset={reset}
                />
              ))}
            </ul>
            {/* Declared ONCE for the whole list rather than per row: the same
                keyframes repeated behind every person is the same CSS parsed
                fifty times. */}
            <style>{`@keyframes permissionsEnter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          </SectionCard>
        </div>
      )}
    </>
  );
}

/** How many of this person's capabilities were decided by hand rather than by their role. */
export function decidedForPerson(person: PersonRow): number {
  return person.cells.filter((c) => c.source !== "role").length;
}

function roleLabel(role: string): string {
  // ROLE_LABELS, not a private copy: the invite panel on THIS SAME PAGE takes its
  // names from it through /api/people, and one screen naming a role two ways is
  // how "Practice manager" and "Coordinator" end up side by side. An agency_admin
  // cannot appear here — listClientPeople filters on client_id and agency rows
  // carry none — so the raw role is the honest fallback rather than a fifth label.
  return (ROLE_LABELS as Record<string, string | undefined>)[role] ?? role;
}

/**
 * ONE PERSON in the list: the always-visible summary line, and — only when it is
 * open — that person's whole permission set.
 *
 * The button is the disclosure (`aria-expanded` + `aria-controls`), the panel is
 * a labelled region pointing back at it, and both ids are derived from the
 * person's id so they are stable across a server render and hydration.
 */
export function PersonAccordionRow({
  person,
  groups,
  expanded,
  onExpandToggle,
  lockReason,
  busy,
  lockedReason,
  onToggle,
  onReset,
}: {
  person: PersonRow;
  groups: CapabilityGroupView[];
  expanded: boolean;
  onExpandToggle: () => void;
  /** Why this whole person cannot be edited, or null. */
  lockReason: string | null;
  busy: Set<string>;
  lockedReason: (p: PersonRow, c: CapabilityCol) => string | null;
  onToggle: (p: PersonRow, c: CapabilityCol, granted: boolean) => void;
  onReset: (p: PersonRow, c: CapabilityCol) => void;
}) {
  const panelId = `permissions-panel-${person.id}`;
  const buttonId = `permissions-person-${person.id}`;
  const decided = decidedForPerson(person);

  return (
    <li>
      <button
        type="button"
        id={buttonId}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onExpandToggle}
        className="flex w-full items-center gap-3 py-3.5 text-left transition-colors hover:bg-card-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
      >
        <span className="text-muted" aria-hidden>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-navy">{person.name}</span>
            <StatusPill tone="neutral">{roleLabel(person.role)}</StatusPill>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
            <span className="truncate">{person.email}</span>
            <span aria-hidden>·</span>
            {decided > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-status-blue">
                <span className="h-1.5 w-1.5 rounded-full bg-status-blue" aria-hidden />
                {decided} set by hand
              </span>
            ) : (
              <span>Follows their role</span>
            )}
            {lockReason ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Lock size={11} aria-hidden />
                  Cannot be changed here
                </span>
              </>
            ) : null}
          </span>
        </span>
      </button>

      {expanded ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="motion-safe:[animation:permissionsEnter_200ms_ease-out] pb-5 pl-7 pr-1"
        >
          {/* SAID ONCE, AT THE TOP, rather than thirty times in thirty tooltips —
              but every switch below is still individually disabled and still
              carries the reason on hover, because a banner is not a lock. */}
          {lockReason ? (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-card-muted px-3.5 py-2.5 text-sm text-muted">
              <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
              {lockReason}
            </p>
          ) : null}

          <div className="space-y-5">
            {groups.map(({ group, columns }) => (
              <div key={group}>
                <h4 className="border-b border-line pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  {GROUP_LABEL[group] ?? group}
                </h4>
                <ul className="divide-y divide-line">
                  {columns.map((column) => (
                    <CapabilityLine
                      key={column.key}
                      person={person}
                      column={column}
                      busy={busy}
                      reason={lockedReason(person, column)}
                      onToggle={onToggle}
                      onReset={onReset}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** One capability, for one person: what it is on the left, the switch on the right. */
function CapabilityLine({
  person,
  column,
  busy,
  reason,
  onToggle,
  onReset,
}: {
  person: PersonRow;
  column: CapabilityCol;
  busy: Set<string>;
  reason: string | null;
  onToggle: (p: PersonRow, c: CapabilityCol, granted: boolean) => void;
  onReset: (p: PersonRow, c: CapabilityCol) => void;
}) {
  const cell = person.cells.find((c) => c.capability === column.key);
  const key = `${person.id}:${column.key}`;
  const overridden = cell ? cell.source !== "role" : false;
  return (
    <li title={reason ?? column.description} className="flex items-start gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1 text-sm font-medium leading-snug text-navy">
          {column.locked ? <Lock size={11} className="mt-[5px] shrink-0 text-muted" aria-hidden /> : null}
          {column.label}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{column.description}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">
        {overridden ? (
          <button
            type="button"
            onClick={() => onReset(person, column)}
            disabled={busy.has(key)}
            title="Set by hand. Reset to what their role allows."
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium",
              "text-status-blue hover:bg-tint-blue disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-status-blue" aria-hidden />
            <RotateCcw size={10} aria-hidden />
            <span className="sr-only">Reset {column.label} for {person.name} to their role default</span>
          </button>
        ) : null}
        <Toggle
          checked={Boolean(cell?.held)}
          onChange={(next) => onToggle(person, column, next)}
          label={`${column.label} for ${person.name}`}
          size="sm"
          busy={busy.has(key)}
          disabled={Boolean(reason)}
        />
      </span>
    </li>
  );
}

export function PermissionsLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-card px-4 py-2.5 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-status-blue" aria-hidden />
        Set by hand for this person — the arrow puts it back to their role
      </span>
      <span className="flex items-center gap-1.5">
        <Lock size={11} aria-hidden />
        Comes with being an owner; cannot be given to anyone else
      </span>
      <span>An owner&rsquo;s row, and your own, cannot be changed here.</span>
    </div>
  );
}
