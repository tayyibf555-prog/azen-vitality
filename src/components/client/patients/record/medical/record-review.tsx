"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";

// The "mark medical history as reviewed at this appointment" affordance — a thin
// client component that POSTs to /api/medical-history/review and refreshes. It
// holds NO clinical rule: the server decides the outcome vocabulary, refuses a
// write it cannot attribute to a clinician (GDC 4.1.4), and stores the append-only
// event. This only renders when the feature is on (the shell gates it), so it is
// never on screen while capture is switched off.

export function RecordReview({
  clientSlug,
  siteId,
  patientId,
  questionnaireId,
  hasClinician,
  noAuthorCopy,
  openedAt,
}: {
  clientSlug: string;
  siteId: string;
  patientId: string;
  questionnaireId: string | null;
  /** Whether the server could name a signed-in clinician. When false, the button
   *  is disabled and the reason (GDC 4.1.4) is shown, matching the server refusal. */
  hasClinician: boolean;
  noAuthorCopy: string;
  /** The instant the record was opened, so a review defaults to a coherent "now"
   *  shared with the rest of the page rather than a fresh clock read. */
  openedAt: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(outcome: "no-changes" | "updated") {
    if (busy || !hasClinician) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/medical-history/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: clientSlug,
          siteId,
          patientId,
          outcome,
          questionnaireId,
          recordedAt: openedAt,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        router.refresh();
      } else {
        setError(data.error ?? "That review was not saved.");
      }
    } catch {
      setError("That review was not saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!hasClinician) {
    return <p className="max-w-xs text-right text-[11.5px] leading-[1.4] text-muted">{noAuthorCopy}</p>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => submit("no-changes")}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-[12.5px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          Reviewed, no changes
        </button>
        <button
          type="button"
          onClick={() => submit("updated")}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-[12.5px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-50"
        >
          Reviewed, updated
        </button>
      </div>
      {error ? <p className="text-[11.5px] text-status-red">{error}</p> : null}
    </div>
  );
}
