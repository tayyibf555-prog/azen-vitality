"use client";

import { Calendar, User, Info } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { AUDIT_DEFINITIONS } from "@/lib/compliance/knowledge";
import type { AuditDefinition } from "@/lib/compliance/types";

// The recurring audit and check calendar as REFERENCE structure: the obligations a
// UK dental practice runs, with their regulation, cadence and owning role. The
// practice's own completed and due dates (and the overdue/due-soon statuses that
// come from them) are added on top once records are logged, so no dates or statuses
// are invented here.
function AuditRow({ audit }: { audit: AuditDefinition }) {
  return (
    <li className="flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-navy">{audit.name}</h4>
        <p className="mt-1 text-xs text-muted">
          {audit.regulation} <span className="text-line-strong">&middot;</span> {audit.cadence}
        </p>
        <p className="mt-1 inline-flex items-center gap-1 text-xs capitalize text-muted">
          <User size={12} /> {audit.ownerRole}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted sm:text-right">
        <Calendar size={12} className="shrink-0" />
        Add your last completed and due dates
      </div>
    </li>
  );
}

export function AuditsList() {
  return (
    <SectionCard
      title="Audit and check calendar"
      description="The recurring compliance obligations a UK dental practice runs: decontamination and IPC, radiography, fire, Legionella and water safety, medical emergencies, and clinical audits."
    >
      <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-3.5 py-2.5">
        <Info size={15} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          This is the reference calendar. Log each audit&rsquo;s completed and due dates to track
          what is overdue or due soon and to feed the readiness score.
        </p>
      </div>
      <ul>
        {AUDIT_DEFINITIONS.map((audit) => (
          <AuditRow key={audit.id} audit={audit} />
        ))}
      </ul>
    </SectionCard>
  );
}
