"use client";

import { useState } from "react";
import { Check, Loader2, Trash2, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import type { AbsenceRow } from "@/lib/absence/types";
import type { RotaStaff } from "@/lib/rota/types";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE, daysLabel, rangeLabel, staffName } from "./shared";

// The absence rows. PRESENTATION ONLY: every condition it renders (`canDecide`,
// `canCancel`, `overlapIds`, `days`) was computed by @/lib/absence/rules and arrives
// on the row. This component decides nothing, which is the point: this repo has
// already shipped five defects from rules living inside a React closure.

export type DecisionAction = "approve" | "refuse";

function ClashWarning({ count }: { count: number }) {
  return (
    <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-tint-amber-line bg-tint-amber px-2 py-1 text-[11.5px] text-status-amber">
      <AlertTriangle size={13} className="mt-[1px] shrink-0" />
      {count === 1
        ? "This clashes with other time off already booked for the same person."
        : `This clashes with ${count} other periods already booked for the same person.`}
    </p>
  );
}

function AbsenceItem({
  row,
  staff,
  busy,
  onDecide,
  onCancel,
}: {
  row: AbsenceRow;
  staff: RotaStaff[];
  busy: boolean;
  onDecide: (id: string, action: DecisionAction, note: string) => void;
  onCancel: (id: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <li className="border-b border-line py-3.5 first:pt-1 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-navy">{staffName(staff, row.staffId)}</p>
            <StatusPill tone="info">{KIND_LABEL[row.kind]}</StatusPill>
            <StatusPill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</StatusPill>
            {row.current ? <StatusPill tone="warning">Away today</StatusPill> : null}
          </div>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="tabular-nums">{rangeLabel(row.startDate, row.endDate)}</span>
            <span aria-hidden>&middot;</span>
            <span className="tabular-nums">{daysLabel(row.days)}</span>
          </p>

          {row.note ? <p className="text-xs text-ink">{row.note}</p> : null}
          {row.decisionNote ? (
            <p className="text-xs text-muted">
              <span className="font-semibold text-navy">Decision note:</span> {row.decisionNote}
            </p>
          ) : null}
          {row.overlapIds.length > 0 ? <ClashWarning count={row.overlapIds.length} /> : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {row.canDecide ? (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide(row.id, "approve", note)}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Approve
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide(row.id, "refuse", note)}>
                <X size={14} /> Refuse
              </Button>
            </>
          ) : null}
          {row.canCancel ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onCancel(row.id)}>
              <Trash2 size={14} /> Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {row.canDecide ? (
        <div className="mt-2">
          <label htmlFor={`absence-note-${row.id}`} className="sr-only">
            Note for this decision
          </label>
          <input
            id={`absence-note-${row.id}`}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for this decision, for example who is covering"
            className="w-full rounded-lg border border-line bg-card-muted px-3 py-1.5 text-xs text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
          />
        </div>
      ) : null}
    </li>
  );
}

export function AbsenceList({
  rows,
  staff,
  busyId,
  onDecide,
  onCancel,
  emptyMessage,
}: {
  rows: AbsenceRow[];
  staff: RotaStaff[];
  busyId: string | null;
  onDecide: (id: string, action: DecisionAction, note: string) => void;
  onCancel: (id: string) => void;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-muted">{emptyMessage}</p>;
  }
  return (
    <ul>
      {rows.map((row) => (
        <AbsenceItem
          key={row.id}
          row={row}
          staff={staff}
          busy={busyId === row.id}
          onDecide={onDecide}
          onCancel={onCancel}
        />
      ))}
    </ul>
  );
}
