import { StatusPill } from "@/components/primitives";
import { PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { londonDateTimeLabel } from "@/lib/time/london";
import type { PatientAuditEntry } from "@/lib/patient/profile-audit";

/**
 * Audit: ONE chronological trail, because Dentally's Audit tab is one trail.
 *
 * Field edits and status changes are merged, newest first. The two focused trails that
 * already existed stay exactly where they were: the profile editor keeps its per-field
 * history and the status manager keeps its status-only history, both inline on
 * Details. This tab is additive, never a replacement.
 *
 * A refused write is NOT invisible. When Dentally rejected an edit, nothing changed on
 * the record, and the row says so rather than reading as a change that happened.
 */
export function TabAudit({ entries, failed = false }: { entries: PatientAuditEntry[]; failed?: boolean }) {
  return (
    <div className="space-y-5">
      <PanelSection title="Changes made through this platform">
        {/* "No changes have been made" is a positive claim about the record, so a
            failed read must never be allowed to make it. */}
        {failed ? (
          <PanelFailed>{FAILED_COPY.audit}</PanelFailed>
        ) : entries.length === 0 ? (
          <PanelEmpty>{EMPTY_COPY.audit}</PanelEmpty>
        ) : (
          <ol className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[13px] font-medium text-navy">{e.label}</span>
                  <span className="text-[12.5px] text-ink">
                    <span className="text-muted">{e.from ?? "empty"}</span>
                    {" → "}
                    <span className="font-medium">{e.to === "" ? "empty" : e.to}</span>
                  </span>
                  {e.dentallyResult === "failed" ? (
                    <StatusPill tone="danger">Dentally refused this, so it was not saved</StatusPill>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  <span className="tabular-nums">{londonDateTimeLabel(e.createdAt)}</span>
                  {e.actorEmail ? ` · ${e.actorEmail}` : ""}
                  {e.reason ? ` · ${e.reason}` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
        <PanelNote>{CANNOT_READ_COPY.dentallyAudit}</PanelNote>
      </PanelSection>
    </div>
  );
}
