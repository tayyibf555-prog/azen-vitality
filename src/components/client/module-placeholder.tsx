"use client";

import { CLIENT_NAV } from "@/lib/nav";
import { PageHeader, EmptyState, SectionCard } from "@/components/primitives";

/**
 * Reusable placeholder for any non-Overview client module. Looks the NavItem up
 * from the single CLIENT_NAV source of truth, so a future session can pick the
 * module up cold: the label, icon and full PILOT spec note are already here.
 */
export function ModulePlaceholder({ slug }: { slug: string }) {
  const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);

  if (!item) {
    return (
      <PageHeader title="Module" description="This module could not be found." />
    );
  }

  const Icon = item.icon;

  return (
    <>
      <PageHeader
        title={item.label}
        description="A pilot module. The shell and route are live, the build comes next."
        actions={
          <span className="rounded-full border border-line-strong bg-card-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Phase 2
          </span>
        }
      />

      <EmptyState
        icon={Icon}
        title="This module is being built"
        description="The groundwork is in place. This view will light up once the module ships in a later session."
      />

      <SectionCard title="What this module will do">
        <p className="text-sm leading-relaxed text-ink">
          {item.note ?? "Specification to follow."}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <span className="rounded-full border border-blue-dark/20 bg-blue-dark/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-blue-dark">
            Pilot module
          </span>
          <span className="text-xs text-muted">A future session will build this out.</span>
        </div>
      </SectionCard>
    </>
  );
}
