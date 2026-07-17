import { MessageSquare, Mail } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { RECALL_CADENCE } from "@/lib/recall/cadence";

const PURPOSE_LABEL: Record<string, string> = {
  nudge: "Friendly nudge",
  offer: "Booking offer",
  final: "Final reminder",
};

// Cumulative human timing for each step, read from the cadence's per-step waits
// (0, +5, +7 days) so this note stays true to the engine, not a hard-coded copy.
function timingLabels(steps: { waitDays: number }[]): string[] {
  let day = 0;
  return steps.map((s, i) => {
    day += s.waitDays;
    if (i === 0) return "On the recall due date";
    if (day <= 5) return `${day} days later`;
    return "A week later";
  });
}

/**
 * Recall's secondary column: a quiet explainer of the sequence every due recall
 * runs. Surfaces the real RECALL_CADENCE (until now only visible once a patient
 * drawer was opened) so the worklist reads as a system, not a raw list. No new
 * data, tints or charts: a plain hairline section and the existing quiet dots.
 */
export function RecallRail() {
  const timings = timingLabels(RECALL_CADENCE);
  return (
    <aside className="space-y-7">
      <SectionCard
        title="How the cadence works"
        description="Each due recall runs a short, friendly sequence until the patient books or the window closes."
      >
        <ol className="space-y-3.5">
          {RECALL_CADENCE.map((s, i) => {
            const Icon = s.channel === "email" ? Mail : MessageSquare;
            return (
              <li key={s.step} className="flex items-start gap-3">
                <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card-muted text-side-ink">
                  <Icon size={14} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-navy">
                    {PURPOSE_LABEL[s.purpose] ?? s.purpose}
                    <span className="ml-1.5 font-normal text-muted">{s.channel.toUpperCase()}</span>
                  </p>
                  <p className="text-[11.5px] text-faint">{timings[i]}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </SectionCard>

      <SectionCard title="Consent and window">
        <p className="text-[12.5px] leading-relaxed text-muted">
          Patients are messaged only on channels they have agreed to. Anyone who books, replies STOP, or moves past
          the recall window drops out of the sequence automatically.
        </p>
      </SectionCard>
    </aside>
  );
}
