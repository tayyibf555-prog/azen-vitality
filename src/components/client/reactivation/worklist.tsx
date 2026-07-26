"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, gbp, relativeTime } from "@/lib/utils";
import { Filter } from "lucide-react";
import type { ReactivationCadence, ReactivationReason, ReactivationTarget } from "@/lib/reactivation/types";
import { TargetDrawer } from "./target-drawer";

const REASON_TONE: Record<ReactivationReason, Tone> = {
  lapsed: "neutral",
  overdue_recall: "warning",
  stalled_plan: "info",
};
const REASON_LABEL: Record<ReactivationReason, string> = {
  lapsed: "Lapsed",
  overdue_recall: "Overdue recall",
  stalled_plan: "Stalled plan",
};

type FilterValue = "all" | ReactivationReason;
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stalled_plan", label: "Stalled plan" },
  { value: "overdue_recall", label: "Overdue recall" },
  { value: "lapsed", label: "Lapsed" },
];

export function Worklist({
  targets,
  cadences,
  nowIso,
}: {
  targets: ReactivationTarget[];
  cadences: ReactivationCadence[];
  nowIso: string;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const WORKLIST_CAP = 8;

  const cadenceByTarget = useMemo(() => {
    const map = new Map<string, ReactivationCadence>();
    for (const c of cadences) map.set(c.targetId, c);
    return map;
  }, [cadences]);

  // MOST RECENTLY LAPSED FIRST, then value. This deliberately mirrors the server's
  // own ordering (listTargets orders by last_visit_at DESC NULLS LAST, then score).
  //
  // It used to sort by score alone, which was fine while reactivation only looked
  // back twelve months. Now that the cap is gone the pool spans years, and score
  // rises with historic spend, so a patient last seen eight years ago outranks one
  // last seen thirteen months ago by a wide margin. Sorting by score alone would fill
  // the visible worklist with the least winnable people and bury the ones worth
  // ringing today. A missing last visit sorts last: those are the coldest of all.
  const ranked = useMemo(
    () =>
      [...targets].sort((a, b) => {
        const av = a.lastVisitAt ? Date.parse(a.lastVisitAt) : Number.NEGATIVE_INFINITY;
        const bv = b.lastVisitAt ? Date.parse(b.lastVisitAt) : Number.NEGATIVE_INFINITY;
        if (av !== bv) return bv - av;
        return b.reactivationScore - a.reactivationScore;
      }),
    [targets],
  );
  const rows = useMemo(
    () => (filter === "all" ? ranked : ranked.filter((t) => t.reason === filter)),
    [ranked, filter],
  );
  const visibleRows = useMemo(
    () => (expanded ? rows : rows.slice(0, WORKLIST_CAP)),
    [rows, expanded],
  );
  const rankByIndex = useMemo(() => {
    const map = new Map<string, number>();
    ranked.forEach((t, i) => map.set(t.id, i + 1));
    return map;
  }, [ranked]);

  const selected = useMemo(() => targets.find((t) => t.id === selectedId) ?? null, [targets, selectedId]);
  const selectedCadence = selected ? cadenceByTarget.get(selected.id) ?? null : null;

  const columns: Column<ReactivationTarget>[] = [
    {
      key: "rank",
      header: "#",
      cell: (t) => <span className="font-semibold text-muted tabular-nums">{rankByIndex.get(t.id)}</span>,
      className: "w-10",
    },
    { key: "patient", header: "Patient", cell: (t) => <span className="font-semibold text-navy">{t.patientName}</span> },
    {
      key: "reason",
      header: "Cohort",
      cell: (t) => <StatusPill tone={REASON_TONE[t.reason]}>{REASON_LABEL[t.reason]}</StatusPill>,
    },
    {
      key: "value",
      header: "Recoverable",
      cell: (t) => <span className="font-semibold text-navy tabular-nums">{gbp(t.recoverableValue)}</span>,
      align: "right",
    },
    {
      key: "last",
      header: "Last visit / recall",
      cell: (t) => {
        const iso = t.recallDueAt ?? t.lastVisitAt;
        return <span className="text-muted">{iso ? relativeTime(iso, now) : "Unknown"}</span>;
      },
      align: "right",
    },
    {
      key: "step",
      header: "Cadence",
      cell: (t) => {
        const c = cadenceByTarget.get(t.id);
        return <span className="text-muted tabular-nums">{c ? `${c.currentStep} of 3` : "Not started"}</span>;
      },
      align: "right",
    },
    {
      key: "next",
      header: "Next due",
      cell: (t) => {
        const c = cadenceByTarget.get(t.id);
        return <span className="text-muted">{c?.nextDueAt ? relativeTime(c.nextDueAt, now) : "Not scheduled"}</span>;
      },
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="Worklist"
        description="Ranked by recoverable value and winnability. Open any patient to run their cadence."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Filter size={14} className="text-muted" />
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                    filter === f.value
                      ? "border-blue-dark/30 bg-[#f0f4f9] text-side-ink"
                      : "border-line-strong bg-card text-muted hover:bg-card-muted",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {rows.length > WORKLIST_CAP ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="rounded-full border border-line-strong bg-card px-3 py-1 text-xs font-semibold text-blue-dark transition-colors hover:bg-card-muted"
              >
                {expanded ? "Show fewer" : `View all ${rows.length}`}
              </button>
            ) : null}
          </div>
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={visibleRows}
          getRowKey={(t) => t.id}
          onRowClick={(t) => setSelectedId(t.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different cohort." className="m-4" />}
        />
      </SectionCard>

      {selected ? (
        <TargetDrawer target={selected} cadence={selectedCadence} nowIso={nowIso} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}
