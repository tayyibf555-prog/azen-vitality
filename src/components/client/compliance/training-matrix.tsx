"use client";

import { SectionCard, StatusPill } from "@/components/primitives";
import { MOCK_STAFF, MOCK_TRAINING_RECORDS } from "@/lib/compliance/mock";
import { TRAINING_REQUIREMENTS } from "@/lib/compliance/knowledge";
import type { StaffMember, TrainingRecord } from "@/lib/compliance/types";
import { statusTone, statusLabel, statusWeight, fmtDate } from "./status";

const REQ_NAME = new Map(TRAINING_REQUIREMENTS.map((r) => [r.id, r.name]));

function reqName(id: string): string {
  return REQ_NAME.get(id) ?? "Training";
}

// One staff member with their training records, sorted attention-first. Staff
// carrying overdue or due-soon records float to the top of the list.
interface StaffGroup {
  staff: StaffMember;
  records: TrainingRecord[];
  topWeight: number;
}

const GROUPS: StaffGroup[] = MOCK_STAFF.map((staff) => {
  const records = MOCK_TRAINING_RECORDS.filter((r) => r.staffId === staff.id).sort(
    (a, b) => statusWeight(a.status) - statusWeight(b.status) || reqName(a.requirementId).localeCompare(reqName(b.requirementId)),
  );
  const topWeight = records.length
    ? Math.min(...records.map((r) => statusWeight(r.status)))
    : 99;
  return { staff, records, topWeight };
}).sort((a, b) => a.topWeight - b.topWeight || a.staff.name.localeCompare(b.staff.name));

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone="danger">Overdue</StatusPill>
      <StatusPill tone="warning">Due soon</StatusPill>
      <StatusPill tone="success">Compliant</StatusPill>
    </div>
  );
}

function RecordRow({ record }: { record: TrainingRecord }) {
  const attention = record.status === "overdue" || record.status === "due_soon";
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm font-medium text-navy">{reqName(record.requirementId)}</span>
      <div className="flex items-center gap-4 text-xs tabular-nums text-muted sm:gap-6">
        <span>
          <span className="text-[11px] uppercase tracking-wide">Completed </span>
          {fmtDate(record.completedAt, "-")}
        </span>
        <span>
          <span className="text-[11px] uppercase tracking-wide">Expires </span>
          <span className={attention ? "font-semibold text-ink" : undefined}>
            {fmtDate(record.expiresAt, "-")}
          </span>
        </span>
        <StatusPill tone={statusTone(record.status)} className="shrink-0">
          {statusLabel(record.status)}
        </StatusPill>
      </div>
    </li>
  );
}

function StaffCard({ group }: { group: StaffGroup }) {
  const needsAttention = group.topWeight <= 1;
  return (
    <section>
      <header className="flex items-center justify-between gap-3 border-b border-line pb-2.5">
        <div className="min-w-0">
          <h4 className="text-title text-navy">{group.staff.name}</h4>
          <p className="text-xs capitalize text-muted">{group.staff.role}</p>
        </div>
        {needsAttention ? (
          <StatusPill tone={group.topWeight === 0 ? "danger" : "warning"} className="shrink-0">
            Needs attention
          </StatusPill>
        ) : (
          <StatusPill tone="success" className="shrink-0">
            Up to date
          </StatusPill>
        )}
      </header>

      {group.records.length > 0 ? (
        <ul className="divide-y divide-line">
          {group.records.map((record) => (
            <RecordRow key={record.id} record={record} />
          ))}
        </ul>
      ) : (
        <p className="py-3 text-xs text-muted">No training records on file.</p>
      )}
    </section>
  );
}

export function TrainingMatrix() {
  return (
    <SectionCard
      title="Staff training matrix"
      description="Mandatory training by team member, grouped per person, with overdue and expiring records highlighted. Team members needing attention are listed first."
      actions={<Legend />}
    >
      <div className="grid gap-x-10 gap-y-7 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <StaffCard key={group.staff.id} group={group} />
        ))}
      </div>
    </SectionCard>
  );
}
