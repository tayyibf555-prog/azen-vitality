"use client";

import { ShieldCheck, Info } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { POLICY_TEMPLATES } from "@/lib/compliance/knowledge";
import type { PolicyTemplate } from "@/lib/compliance/types";

// The required UK dental practice policies as REFERENCE templates, grouped by area.
// This is the checklist of policies a CQC-registered practice should hold, with the
// review cadence for each. Whether the practice holds each one, and when it was last
// reviewed (and so the in-place/review-due/missing status), is added on top once the
// practice's records are in, so nothing is invented here.
function groupByCategory(policies: PolicyTemplate[]): { category: string; items: PolicyTemplate[] }[] {
  const groups = new Map<string, PolicyTemplate[]>();
  for (const p of policies) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }
  return [...groups.entries()]
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

const GROUPS = groupByCategory(POLICY_TEMPLATES);

function PolicyRow({ policy }: { policy: PolicyTemplate }) {
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-navy">{policy.name}</h4>
          {policy.required ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-[11px] font-medium text-ink">
              <ShieldCheck size={11} /> Required
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted">Review cadence: {policy.reviewCadence}</p>
      </div>
      <span className="shrink-0 self-start text-xs text-muted sm:self-auto">Add your document and review date</span>
    </li>
  );
}

export function PoliciesList() {
  return (
    <SectionCard
      title="Policy library"
      description="The practice policies a UK dental practice should hold, grouped by area, with the review cadence for each."
    >
      <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-3.5 py-2.5">
        <Info size={15} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          This is the reference checklist. Add your own document and last-reviewed date for each to
          track what is in place, due for review or missing.
        </p>
      </div>
      <div className="space-y-6">
        {GROUPS.map((group) => (
          <div key={group.category}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {group.category}
            </p>
            <ul className="mt-1">
              {group.items.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
