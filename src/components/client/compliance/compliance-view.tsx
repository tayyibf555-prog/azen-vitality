import { ShieldCheck, ClipboardCheck, FileText, GraduationCap } from "lucide-react";
import { PageHeader, StatCard, SampleNote } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { READINESS } from "@/lib/compliance/mock";
import { statusLabel } from "./status";
import { ComplianceWorkspace } from "./compliance-workspace";

// Compliance section: CQC and GDC obligations organised in one place. A readiness
// view across the five key lines of enquiry, the recurring audit and check
// calendar, the policy library and the staff training matrix, with an AI
// readiness check. Decision-support and an organiser, not legal advice; the data
// is mock until the practice's real records are connected.
export function ComplianceView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Compliance" description="This client could not be found." />;
  }

  const r = READINESS;

  return (
    <>
      <PageHeader
        title="Compliance"
        description="Your CQC and GDC compliance organised in one place: a readiness view across the five key lines of enquiry, the recurring audit and check calendar, the policy library and the staff training matrix, with an AI readiness check. This is decision-support and an organiser, not legal advice, and the data is mock for now."
      />

      {/* The header hints "mock for now" but the stat cards do not; this note makes
          the readiness %, audits and training figures unmistakably sample. */}
      <SampleNote>Sample data, not yet from your live sources. Readiness and audit figures are pilot estimates until your real records are connected.</SampleNote>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Overall readiness"
          value={`${r.overallScore}%`}
          icon={ShieldCheck}
          hint={statusLabel(r.status)}
        />
        <StatCard
          label="Audits overdue"
          value={r.auditsOverdue}
          icon={ClipboardCheck}
          hint={`+ ${r.auditsDue} due soon`}
        />
        <StatCard
          label="Policies to action"
          value={r.policiesNeedingAttention}
          icon={FileText}
          hint="Review due or missing"
        />
        <StatCard
          label="Training expiring"
          value={r.trainingExpiring}
          icon={GraduationCap}
          hint="Overdue or due soon"
        />
      </div>

      <ComplianceWorkspace clientSlug={clientSlug} />
    </>
  );
}
