import { StatusPill } from "@/components/primitives";
import type { NumberHealth } from "@/lib/messaging/number-health";

// A small, read-only deliverability chip shown beside a patient's mobile number. It
// reflects the verdicts the Twilio Lookup pre-send validation has accumulated in
// phone_lookup - it never triggers a lookup itself. A sibling of the status manager,
// deliberately kept separate from it (status is an editable control; this is a hint).

/** The tint chip for a patient's number health, or nothing when there is no number. */
export function PatientNumberHealth({ health }: { health: NumberHealth | undefined | null }) {
  if (!health || health.state === "none") return null;

  if (health.state === "mobile") {
    return (
      <StatusPill tone="success" className="shrink-0">
        Mobile ✓
      </StatusPill>
    );
  }

  if (health.state === "undeliverable") {
    // Name the line type when known (e.g. "landline") so the owner sees WHY a send to
    // this number would be blocked, not just that it would.
    const detail = health.lineType ? ` · ${health.lineType}` : "";
    return (
      <StatusPill tone="danger" className="shrink-0">
        Undeliverable ✗{detail}
      </StatusPill>
    );
  }

  // "unchecked": a usable number the send path has not validated yet (never messaged).
  return (
    <StatusPill tone="neutral" className="shrink-0">
      Not checked yet
    </StatusPill>
  );
}
