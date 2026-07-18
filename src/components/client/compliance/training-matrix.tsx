"use client";

import { GraduationCap, Info } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { TRAINING_REQUIREMENTS } from "@/lib/compliance/knowledge";
import type { TrainingRequirement } from "@/lib/compliance/types";

// The mandatory training obligations as REFERENCE structure: the recurring training
// a UK dental practice must keep up, the roles each applies to, and the cadence. The
// practice's own team and their completion and expiry dates (and so the overdue or
// expiring statuses) are added on top once records are in, so no staff or dates are
// invented here.
function RequirementRow({ requirement }: { requirement: TrainingRequirement }) {
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3.5 last:border-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-navy">{requirement.name}</h4>
          {requirement.mandatory ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-[11px] font-medium text-ink">
              <GraduationCap size={11} /> Mandatory
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs capitalize text-muted">
          Applies to: {requirement.appliesToRoles.join(", ")}
        </p>
      </div>
      <div className="shrink-0 text-xs text-muted sm:text-right">
        <p>{requirement.cadence}</p>
        <p className="mt-0.5">Add your team&rsquo;s records</p>
      </div>
    </li>
  );
}

export function TrainingMatrix() {
  return (
    <SectionCard
      title="Staff training matrix"
      description="The mandatory training a UK dental practice must keep up, the roles each applies to, and how often it recurs."
    >
      <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-3.5 py-2.5">
        <Info size={15} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          This is the reference set. Add your team members and their completion and expiry dates to
          track who is up to date, due soon or overdue.
        </p>
      </div>
      <ul>
        {TRAINING_REQUIREMENTS.map((requirement) => (
          <RequirementRow key={requirement.id} requirement={requirement} />
        ))}
      </ul>
    </SectionCard>
  );
}
