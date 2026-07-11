import { DataTable, StatusPill, EmptyState, type Column } from "@/components/primitives";
import { ClipboardList } from "lucide-react";
import { sourceLabel } from "@/lib/speed-to-lead/source-label";
import { londonDateTimeLabel } from "@/lib/time/london";
import type { AssessmentResponse } from "@/lib/smile-assessment/types";

// Assessment responses that did NOT auto-qualify into the contacted pipeline:
// the "Close to qualified" (medium band) and "Not qualified" (low band) tabs of
// the Leads page. Read-only worklist: staff decide who to nurture manually.

const BAND_TONE: Record<string, "success" | "warning" | "neutral"> = {
  high: "success",
  medium: "warning",
  low: "neutral",
};

function contactLabel(r: AssessmentResponse): string {
  return r.phone ?? r.email ?? "No contact details";
}

export function ResponsesTable({
  responses,
  emptyTitle,
  emptyDescription,
}: {
  responses: AssessmentResponse[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  const columns: Column<AssessmentResponse>[] = [
    { key: "name", header: "Name", cell: (r) => <span className="font-semibold text-navy">{r.firstName}</span> },
    { key: "contact", header: "Contact", cell: (r) => <span className="text-ink">{contactLabel(r)}</span> },
    {
      key: "score",
      header: "Score",
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-semibold tabular-nums text-ink">{r.rawScore}</span>
          <StatusPill tone={BAND_TONE[r.band] ?? "muted"}>{r.band}</StatusPill>
        </span>
      ),
    },
    {
      key: "interest",
      header: "Interest",
      cell: (r) => <span className="text-ink">{r.treatmentInterest || "General enquiry"}</span>,
    },
    { key: "source", header: "Source", cell: (r) => <span className="text-muted">{sourceLabel(r.source)}</span> },
    { key: "when", header: "Submitted", cell: (r) => <span className="text-muted">{londonDateTimeLabel(r.createdAt)}</span> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={responses}
      getRowKey={(r) => r.id}
      maxRows={50}
      empty={<EmptyState icon={ClipboardList} title={emptyTitle} description={emptyDescription} />}
    />
  );
}
