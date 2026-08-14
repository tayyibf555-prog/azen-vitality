"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Lock, RotateCcw } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, Toggle } from "@/components/primitives";
import { cn } from "@/lib/utils";

// ===========================================================================
// THE PERMISSIONS GRID. Rows are people, columns are what they may do.
//
// Owner-only. Reads and writes /api/permissions, which repeats every gate on the
// server — nothing here is a security boundary, and the grid greys a control for
// the same reason it tells you why: so the owner is not clicking things that
// will be refused.
//
// PER-CELL OPTIMISTIC WRITES, not a save bar. Fifty staff by twenty-five
// capabilities is over a thousand cells; a batch save would be a diff nobody can
// review and one failed row would poison the whole submission. Each toggle
// writes one row, flips locally, and reverts with a message if the write fails —
// the same shape as the kill-switch panel.
//
// TWO STATES PER CELL, and the difference is the whole point of the screen:
//   INHERITED  the answer comes from the person's role. No row is stored.
//   DECIDED    somebody chose this for this person. A dot marks it, and "Reset"
//              deletes the row so the cell goes back to following the role.
// ===========================================================================

type CellSource = "role" | "granted" | "revoked";

interface Cell {
  capability: string;
  held: boolean;
  source: CellSource;
}

interface PersonRow {
  id: string;
  name: string;
  email: string;
  role: string;
  cells: Cell[];
}

interface CapabilityCol {
  key: string;
  group: string;
  label: string;
  description: string;
  destructive: boolean;
  locked: boolean;
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

const GROUP_LABEL: Record<string, string> = {
  diary: "The diary",
  patient: "Patients",
  clinical: "The clinical record",
  messaging: "Messaging patients",
  people: "Staff and time",
  reports: "Reports",
  system: "The platform",
  security: "Permissions themselves",
};

const ROLE_LABEL: Record<string, string> = {
  agency_admin: "Platform admin",
  client_owner: "Owner",
  client_coordinator: "Practice manager",
  client_clinician: "Clinician",
  client_staff: "Staff",
};

const ROW_LABEL_WIDTH = 240;
const COL_WIDTH = 168;

export function PermissionsView({ clientSlug }: { clientSlug: string }) {
  const [data, setData] = useState<GridResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<string | null>(null);

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

  const groups = useMemo(() => {
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
  }, [capabilities]);

  const decidedCount = people.reduce(
    (n, p) => n + p.cells.filter((c) => c.source !== "role").length,
    0,
  );

  /** Why this cell cannot be changed, or null when it can. */
  function lockedReason(person: PersonRow, column: CapabilityCol): string | null {
    if (column.locked) {
      return "This one comes with being an owner. It cannot be switched on or off for anybody.";
    }
    if (protectedRoles.has(person.role)) {
      return "An owner's permissions cannot be changed here.";
    }
    if (actorId && person.id === actorId) {
      return "You cannot change your own permissions. Ask the other owner.";
    }
    return null;
  }

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
        description="Who can do what. Each person starts with what their role allows; switch one on or off here and that decision follows them everywhere. Changes apply immediately — they may need to refresh before a button disappears from their screen, but the platform refuses the action either way."
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
          <Legend />
          {groups.map(({ group, columns }) => (
            <SectionCard key={group} title={GROUP_LABEL[group] ?? group} bodyClassName="p-0">
              {/* The table scrolls inside its own card. The page body never scrolls
                  sideways, and the name column stays put while it does. */}
              <div className="overflow-x-auto">
                <div
                  className="grid min-w-max text-sm"
                  // INLINE, not a Tailwind arbitrary class: Tailwind v4 never
                  // generates an interpolated class name, so grid-cols-[...] built
                  // from a variable silently produces no CSS at all.
                  style={{
                    gridTemplateColumns: `${ROW_LABEL_WIDTH}px repeat(${columns.length}, ${COL_WIDTH}px)`,
                  }}
                >
                  <div
                    className="sticky left-0 z-20 border-b border-line bg-card-muted px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted"
                    style={{ width: ROW_LABEL_WIDTH }}
                  >
                    Person
                  </div>
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      title={c.description}
                      className="border-b border-l border-line bg-card-muted px-3 py-2.5"
                    >
                      <p className="flex items-start gap-1 text-[12.5px] font-semibold leading-snug text-navy">
                        {c.locked ? <Lock size={11} className="mt-[3px] shrink-0 text-muted" /> : null}
                        {c.label}
                      </p>
                    </div>
                  ))}

                  {people.map((person) => (
                    <PersonCells
                      key={`${group}:${person.id}`}
                      person={person}
                      columns={columns}
                      busy={busy}
                      lockedReason={lockedReason}
                      onToggle={write}
                      onReset={reset}
                    />
                  ))}
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </>
  );
}

function PersonCells({
  person,
  columns,
  busy,
  lockedReason,
  onToggle,
  onReset,
}: {
  person: PersonRow;
  columns: CapabilityCol[];
  busy: Set<string>;
  lockedReason: (p: PersonRow, c: CapabilityCol) => string | null;
  onToggle: (p: PersonRow, c: CapabilityCol, granted: boolean) => void;
  onReset: (p: PersonRow, c: CapabilityCol) => void;
}) {
  return (
    <>
      <div
        className="sticky left-0 z-10 border-b border-line bg-card px-4 py-3"
        style={{ width: ROW_LABEL_WIDTH }}
      >
        <p className="truncate text-sm font-semibold text-navy">{person.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5">
          <StatusPill tone="neutral">{ROLE_LABEL[person.role] ?? person.role}</StatusPill>
        </p>
      </div>
      {columns.map((column) => {
        const cell = person.cells.find((c) => c.capability === column.key);
        const key = `${person.id}:${column.key}`;
        const reason = lockedReason(person, column);
        const overridden = cell ? cell.source !== "role" : false;
        return (
          <div
            key={key}
            title={reason ?? column.description}
            className="flex items-center gap-2 border-b border-l border-line px-3 py-3"
          >
            <Toggle
              checked={Boolean(cell?.held)}
              onChange={(next) => onToggle(person, column, next)}
              label={`${column.label} for ${person.name}`}
              size="sm"
              busy={busy.has(key)}
              disabled={Boolean(reason)}
            />
            {overridden ? (
              <button
                type="button"
                onClick={() => onReset(person, column)}
                disabled={busy.has(key)}
                title="Set by hand. Reset to what their role allows."
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium",
                  "text-status-blue hover:bg-tint-blue disabled:opacity-50",
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-status-blue" aria-hidden />
                <RotateCcw size={10} aria-hidden />
                <span className="sr-only">Reset {column.label} for {person.name} to their role default</span>
              </button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function Legend() {
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
