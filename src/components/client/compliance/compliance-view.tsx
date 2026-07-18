import { Info } from "lucide-react";
import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { COMPLIANCE_DISCLAIMER } from "@/lib/compliance/knowledge";
import { ComplianceWorkspace } from "./compliance-workspace";

// Compliance section: CQC and GDC obligations organised in one place. A readiness
// view across the five key lines of enquiry, the recurring audit and check
// calendar, the policy library and the staff training matrix, with an AI readiness
// check. It ships the reference framework (KLOEs, required audits, policy templates
// and training obligations) as guidance; the practice's own records are added on
// top. No practice figures are invented: readiness scores and record statuses
// appear once your real records are in. Decision-support and an organiser, not
// legal advice.
export function ComplianceView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Compliance" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="Compliance"
        description="Your CQC and GDC compliance organised in one place: a readiness view across the five key lines of enquiry, the recurring audit and check calendar, the policy library and the staff training matrix, with an AI readiness check."
      />

      {/* Honest framing: what is shown is the regulatory framework as guidance; the
          practice's own records (and the readiness scoring that comes from them) are
          added on top. No practice figures are invented. */}
      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          This section ships the UK dental regulatory framework as reference: the CQC key lines of
          enquiry, the required audits and their cadences, the policy templates and the training
          obligations. Your practice&rsquo;s own records, and the readiness scoring that builds from
          them, are added on top. {COMPLIANCE_DISCLAIMER}
        </p>
      </div>

      <ComplianceWorkspace clientSlug={clientSlug} />
    </>
  );
}
