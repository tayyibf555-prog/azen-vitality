"use client";

import { ClipboardList, Sparkles, Users } from "lucide-react";
import { DataTable, EmptyState, SectionCard, Tabs, type Column, type TabItem } from "@/components/primitives";
import { londonDateLabel } from "@/lib/time/london";
import type { InterestTreatment, InterestTreatmentKey } from "@/lib/triage/types";
import { BankEditor } from "./bank-editor";

// The module's three panels, behind tabs so the screen stays one viewport.
//
// A CLIENT component because Tabs is one (it holds the active key) and because
// the bank editor saves. Every piece of data arrives as a plain prop, resolved on
// the server: nothing here fetches the lists, so there is no authed route to guard
// for a read that a server component already did.
//
// NULL vs EMPTY IS LOAD-BEARING IN ALL THREE PANELS. `null` means the read
// FAILED and says so; `[]` means the read succeeded and found nothing. An empty
// list rendered for a failed read would tell a practice that nobody is interested
// in whitening when the truth is that we could not look.

export interface InterestRow {
  id: string;
  patientId: string;
  patientName: string;
  treatment: string;
  createdAt: string;
}

export interface MiningRow {
  id: string;
  patientId: string;
  patientName: string;
  age: number;
  lastExtractionAt: string;
  matchedText: string;
}

export function PreVisitWorkspace({
  clientSlug,
  isOwner,
  treatments,
  interest,
  interestCounts,
  mining,
  miningTitle,
  miningCoverage,
  miningExclusions,
  miningCaveats,
}: {
  clientSlug: string;
  isOwner: boolean;
  treatments: InterestTreatment[];
  interest: InterestRow[] | null;
  interestCounts: Record<string, number> | null;
  mining: MiningRow[] | null;
  miningTitle: string;
  miningCoverage: string;
  miningExclusions: string;
  miningCaveats: string[];
}) {
  const tabs: TabItem[] = [
    {
      key: "interest",
      label: "Interest lists",
      icon: Users,
      badge: interest ? interest.length : undefined,
      content: (
        <InterestPanel treatments={treatments} rows={interest} counts={interestCounts} />
      ),
    },
    {
      key: "mining",
      label: "Implants",
      icon: Sparkles,
      badge: mining ? mining.length : undefined,
      content: (
        <MiningPanel
          title={miningTitle}
          rows={mining}
          coverage={miningCoverage}
          exclusions={miningExclusions}
          caveats={miningCaveats}
        />
      ),
    },
  ];

  // The bank editor is OWNER-ONLY, and it is not rendered at all for a manager
  // rather than rendered disabled. A disabled editor invites somebody to ask for
  // it to be enabled; an absent one says the questions are not theirs to change.
  // The API route refuses her either way, which is the real lock.
  if (isOwner) {
    tabs.unshift({
      key: "questions",
      label: "Question lists",
      icon: ClipboardList,
      content: <BankEditor clientSlug={clientSlug} />,
    });
  }

  return <Tabs tabs={tabs} />;
}

function InterestPanel({
  treatments,
  rows,
  counts,
}: {
  treatments: InterestTreatment[];
  rows: InterestRow[] | null;
  counts: Record<string, number> | null;
}) {
  const labelByKey = new Map<string, string>(treatments.map((t) => [t.key as string, t.label]));

  if (rows === null) {
    return (
      <SectionCard title="Interest lists">
        <p className="text-[13px] text-status-red">
          These lists could not be read. That is a failure to read them, not a finding that nobody is
          interested.
        </p>
      </SectionCard>
    );
  }

  const columns: Column<InterestRow>[] = [
    { key: "patientName", header: "Patient", cell: (r) => r.patientName || r.patientId },
    {
      key: "treatment",
      header: "Asked about",
      cell: (r) => labelByKey.get(r.treatment) ?? r.treatment,
    },
    { key: "createdAt", header: "When", cell: (r) => londonDateLabel(r.createdAt) },
  ];

  return (
    <div className="space-y-5">
      <SectionCard
        title="Who asked to hear more"
        description="Every patient who said yes on a pre-visit form. The count is people, not answers: a patient who said yes twice is one person."
      >
        {counts === null ? (
          <p className="text-[13px] text-status-red">The totals could not be read.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {treatments.map((t) => (
              <li key={t.key} className="rounded-xl border border-line bg-card px-4 py-3">
                <p className="text-[12.5px] font-medium text-muted">{t.label}</p>
                <p className="mt-0.5 text-[22px] font-bold tabular-nums text-navy">
                  {counts[t.key as InterestTreatmentKey] ?? 0}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Most recent first">
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={Users}
            title="Nobody has asked to hear more yet"
            description="Yeses from the pre-visit form land here as soon as patients start filling it in."
          />
        ) : (
          <DataTable rows={rows} columns={columns} getRowKey={(r) => r.id} maxRows={25} />
        )}
      </SectionCard>
    </div>
  );
}

/**
 * EXPORTED so its caveats can be asserted on the RENDERED SCREEN rather than on
 * the constant they come from.
 *
 * The Tabs primitive mounts only the ACTIVE panel, so a test that renders the
 * whole workspace never reaches this one — which meant a "the caveats are on the
 * screen" test could pass while the screen rendered none of them. Mutation
 * testing found exactly that. Rendering this component directly is what makes the
 * claim true.
 */
export function MiningPanel({
  title,
  rows,
  coverage,
  exclusions,
  caveats,
}: {
  title: string;
  rows: MiningRow[] | null;
  coverage: string;
  exclusions: string;
  caveats: string[];
}) {
  const columns: Column<MiningRow>[] = [
    { key: "patientName", header: "Patient", cell: (r) => r.patientName || r.patientId },
    { key: "age", header: "Age", cell: (r) => String(r.age), align: "right" },
    { key: "lastExtractionAt", header: "Extraction on record", cell: (r) => londonDateLabel(r.lastExtractionAt) },
    { key: "matchedText", header: "What the diary said", cell: (r) => r.matchedText || "—" },
  ];

  return (
    <SectionCard title={title} description={coverage}>
      {/*
        THE CAVEATS ARE ON THE SCREEN, above the list, not behind a tooltip and not
        in a help page. This list is a regex over free text that somebody could
        mistake for a clinical shortlist, and the difference between those two
        readings is a phone call the practice cannot stand behind. So they are read
        BEFORE the names, every time, by everyone.
      */}
      <ul className="mb-4 space-y-1.5 rounded-xl border border-line bg-card-muted/40 px-4 py-3">
        {caveats.map((c) => (
          <li key={c} className="text-[12.5px] leading-[1.55] text-muted">
            {c}
          </li>
        ))}
      </ul>
      {exclusions ? <p className="mb-4 text-[12.5px] text-muted">{exclusions}</p> : null}

      {rows === null ? (
        <p className="text-[13px] text-status-red">
          This list could not be read. That is a failure to read it, not a finding that there is nobody on it.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={Sparkles}
          title="Nobody on this list yet"
          description="The scan reads the appointment book a window at a time and adds anyone it finds. The dates it has covered so far are above."
        />
      ) : (
        <DataTable rows={rows} columns={columns} getRowKey={(r) => r.id} maxRows={25} />
      )}
    </SectionCard>
  );
}
