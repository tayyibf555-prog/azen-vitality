"use client";

import { ShieldCheck } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/primitives";
import { MOCK_POLICIES } from "@/lib/compliance/mock";
import type { PolicyDoc } from "@/lib/compliance/types";
import { statusTone, statusLabel, statusWeight, fmtDate } from "./status";

// Policies grouped by category, with the categories carrying missing or
// review-due policies surfaced first, and the same ordering inside each group.
function groupByCategory(policies: PolicyDoc[]): { category: string; items: PolicyDoc[] }[] {
  const groups = new Map<string, PolicyDoc[]>();
  for (const p of policies) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }

  const sorted = [...groups.entries()].map(([category, items]) => ({
    category,
    items: [...items].sort(
      (a, b) => statusWeight(a.status) - statusWeight(b.status) || a.name.localeCompare(b.name),
    ),
  }));

  // Categories with the most attention-needing policy float to the top.
  sorted.sort((a, b) => {
    const aw = Math.min(...a.items.map((p) => statusWeight(p.status)));
    const bw = Math.min(...b.items.map((p) => statusWeight(p.status)));
    return aw - bw || a.category.localeCompare(b.category);
  });
  return sorted;
}

const GROUPS = groupByCategory(MOCK_POLICIES);

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone="danger">Missing</StatusPill>
      <StatusPill tone="warning">Review due</StatusPill>
      <StatusPill tone="success">In place</StatusPill>
    </div>
  );
}

function PolicyRow({ policy }: { policy: PolicyDoc }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-card p-3.5 shadow-[0_1px_2px_rgba(10,14,26,0.04)] sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-navy">{policy.name}</h4>
          {policy.required ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card-muted px-2 py-0.5 text-[11px] font-medium text-ink">
              <ShieldCheck size={11} /> Required
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted">Last reviewed {fmtDate(policy.lastReviewedAt)}</p>
      </div>
      <StatusPill tone={statusTone(policy.status)} className="shrink-0 self-start sm:self-auto">
        {statusLabel(policy.status)}
      </StatusPill>
    </li>
  );
}

export function PoliciesList() {
  return (
    <SectionCard
      title="Policy library"
      description="Your required practice policies, grouped by area. Missing and review-due policies are surfaced first so the gaps are easy to spot."
      actions={<Legend />}
    >
      <div className="space-y-6">
        {GROUPS.map((group) => (
          <div key={group.category}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {group.category}
            </p>
            <ul className="mt-2 space-y-2.5">
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
