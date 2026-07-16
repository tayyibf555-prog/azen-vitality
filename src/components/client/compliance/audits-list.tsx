"use client";

import { Calendar, User, CheckCircle2 } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/primitives";
import { MOCK_AUDITS } from "@/lib/compliance/mock";
import type { AuditItem } from "@/lib/compliance/types";
import { statusTone, statusLabel, statusWeight, fmtDate } from "./status";

// Order the calendar so the obligations needing attention sit at the top:
// overdue first, then due soon, then the rest, with the nearest due date next.
const SORTED_AUDITS: AuditItem[] = [...MOCK_AUDITS].sort((a, b) => {
  const w = statusWeight(a.status) - statusWeight(b.status);
  if (w !== 0) return w;
  return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
});

// A short legend so the colour coding reads at a glance.
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone="danger">Overdue</StatusPill>
      <StatusPill tone="warning">Due soon</StatusPill>
      <StatusPill tone="success">Compliant</StatusPill>
    </div>
  );
}

function AuditRow({ audit }: { audit: AuditItem }) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-navy">{audit.name}</h4>
          <StatusPill tone={statusTone(audit.status)}>{statusLabel(audit.status)}</StatusPill>
        </div>
        <p className="mt-1 text-xs text-muted">
          {audit.regulation} <span className="text-line-strong">&middot;</span> {audit.cadence}
        </p>
        <p className="mt-1 inline-flex items-center gap-1 text-xs capitalize text-muted">
          <User size={12} /> {audit.ownerRole}
        </p>
      </div>

      <dl className="flex shrink-0 gap-6 sm:text-right">
        <div className="space-y-0.5">
          <dt className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted sm:flex-row-reverse">
            <CheckCircle2 size={12} /> Last completed
          </dt>
          <dd className="text-sm tabular-nums text-ink">{fmtDate(audit.lastCompletedAt)}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted sm:flex-row-reverse">
            <Calendar size={12} /> Due
          </dt>
          <dd className="text-sm font-semibold tabular-nums text-navy">{fmtDate(audit.dueAt)}</dd>
        </div>
      </dl>
    </li>
  );
}

export function AuditsList() {
  return (
    <SectionCard
      title="Audit and check calendar"
      description="Your recurring compliance obligations, sorted with overdue items first: decontamination and IPC, radiography, fire, Legionella and water safety, medical emergencies, and clinical audits."
      actions={<Legend />}
    >
      <ul className="space-y-3">
        {SORTED_AUDITS.map((audit) => (
          <AuditRow key={audit.id} audit={audit} />
        ))}
      </ul>
    </SectionCard>
  );
}
