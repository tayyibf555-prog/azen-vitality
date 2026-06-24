"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, relativeTime } from "@/lib/utils";
import { Filter } from "lucide-react";
import type { RecallCadence, RecallType, RecallTarget } from "@/lib/recall/types";
import { TargetDrawer } from "./target-drawer";

const TYPE_TONE: Record<RecallType, Tone> = {
  dentist: "info",
  hygienist: "whatsapp",
};
const TYPE_LABEL: Record<RecallType, string> = {
  dentist: "Dentist",
  hygienist: "Hygiene",
};

type FilterValue = "all" | RecallType | "due_soon" | "overdue";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "dentist", label: "Dentist" },
  { value: "hygienist", label: "Hygiene" },
  { value: "due_soon", label: "Due soon" },
  { value: "overdue", label: "Overdue" },
];

/** Human label for how far from due a recall is. */
function dueLabel(t: RecallTarget): string {
  if (t.overdueDays > 0) return `${t.overdueDays}d overdue`;
  if (t.overdueDays < 0) return `due in ${Math.abs(t.overdueDays)}d`;
  return "due today";
}

export function Worklist({
  targets,
  cadences,
  nowIso,
}: {
  targets: RecallTarget[];
  cadences: RecallCadence[];
  nowIso: string;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cadenceByTarget = useMemo(() => {
    const map = new Map<string, RecallCadence>();
    for (const c of cadences) map.set(c.targetId, c);
    return map;
  }, [cadences]);

  // Recall is a time-ordered queue: most overdue / soonest due first.
  const ranked = useMemo(
    () => [...targets].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),
    [targets],
  );
  const rows = useMemo(() => {
    if (filter === "all") return ranked;
    if (filter === "due_soon") return ranked.filter((t) => t.overdueDays < 0);
    if (filter === "overdue") return ranked.filter((t) => t.overdueDays >= 0);
    return ranked.filter((t) => t.recallType === filter);
  }, [ranked, filter]);
  const rankByIndex = useMemo(() => {
    const map = new Map<string, number>();
    ranked.forEach((t, i) => map.set(t.id, i + 1));
    return map;
  }, [ranked]);

  const selected = useMemo(() => targets.find((t) => t.id === selectedId) ?? null, [targets, selectedId]);
  const selectedCadence = selected ? cadenceByTarget.get(selected.id) ?? null : null;

  const columns: Column<RecallTarget>[] = [
    {
      key: "rank",
      header: "#",
      cell: (t) => <span className="font-semibold text-muted tabular-nums">{rankByIndex.get(t.id)}</span>,
      className: "w-10",
    },
    { key: "patient", header: "Patient", cell: (t) => <span className="font-semibold text-navy">{t.patientName}</span> },
    {
      key: "type",
      header: "Recall",
      cell: (t) => <StatusPill tone={TYPE_TONE[t.recallType]}>{TYPE_LABEL[t.recallType]}</StatusPill>,
    },
    {
      key: "due",
      header: "Due",
      cell: (t) => (
        <span className={cn("font-semibold tabular-nums", t.overdueDays > 0 ? "text-[#9a6700]" : "text-navy")}>
          {dueLabel(t)}
        </span>
      ),
      align: "right",
    },
    {
      key: "last",
      header: "Last visit",
      cell: (t) => <span className="text-muted">{t.lastVisitAt ? relativeTime(t.lastVisitAt, now) : "Unknown"}</span>,
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
        description="Ordered by recall due date, soonest first. Open any patient to run their recall cadence."
        actions={
          <div className="flex items-center gap-2">
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
                      ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
                      : "border-line-strong bg-card text-muted hover:bg-card-muted",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(t) => t.id}
          onRowClick={(t) => setSelectedId(t.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different recall type." className="m-4" />}
        />
      </SectionCard>

      {selected ? (
        <TargetDrawer target={selected} cadence={selectedCadence} nowIso={nowIso} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}
