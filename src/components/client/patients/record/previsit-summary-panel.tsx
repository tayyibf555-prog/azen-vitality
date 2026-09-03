import { SUMMARY_COPY } from "@/lib/triage/summary";
import { londonDateTimeLabel } from "@/lib/time/london";
import type { PreVisitSummary } from "@/lib/triage/summary";

// ===========================================================================
// "WHAT THE PATIENT SHARED BEFORE THIS VISIT", on the patient record.
//
// A SERVER component, rendered above the Appointments tab's table. It lives on
// Appointments rather than on a twelfth record tab for two reasons: what the
// patient said is ABOUT an appointment (it was asked before one and it is read
// before one), and a tab whose content exists for maybe a fifth of patients is a
// tab that mostly says "nothing here".
//
// THE PROVENANCE LINE IS NOT DECORATION. These are answers a patient typed on
// their phone. Nobody at the practice has checked them, no clinician has
// authored them, and they are not a finding about anything. A clinician reading
// "pain 8/10" three inches under a Dentally-mirrored appointment list must be
// told which of those two things they are looking at, so the sentence is printed
// before a single answer.
//
// WHAT A VIEWER MAY SEE is decided in ./summary.ts and arrives already applied:
// `clinical` is NULL for a viewer who may not read the symptom half, and the
// count in `flaggedForClinician` is shown to everybody instead. The projection is
// the lock; this file only renders what it was handed, and cannot widen it.
// ===========================================================================

export function PreVisitSummaryPanel({
  summary,
  /** True when the read itself failed. Distinct from "no answers captured". */
  failed = false,
}: {
  summary: PreVisitSummary | null;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <section className="rounded-xl border border-tint-red-line bg-tint-red px-4 py-3">
        <p className="text-[13px] text-status-red">{SUMMARY_COPY.readFailed}</p>
      </section>
    );
  }
  // NOTHING CAPTURED RENDERS NOTHING, and that is deliberate. The record already
  // carries eleven tabs of honest empty states; a twelfth panel saying "no
  // pre-visit answers" on every patient who has never been sent one would be
  // noise on every record in the practice. SUMMARY_COPY.none exists for the
  // screens that ask for this patient's answers by name.
  if (!summary) return null;

  return (
    <section className="rounded-xl border border-line bg-card px-4 py-3.5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-navy">{SUMMARY_COPY.heading}</h3>
        <p className="text-[12px] text-faint">{londonDateTimeLabel(summary.submittedAt)}</p>
      </header>
      <p className="mt-1 text-[12.5px] leading-[1.55] text-muted">{SUMMARY_COPY.provenance}</p>

      {/*
        THE DISCOMFORT FLAG, for EVERY role including one that cannot read the
        answers themselves. It is the difference between "book them in a fortnight"
        and "ring them today", which is a front-desk decision and therefore
        front-desk information. It states what the patient said about themselves
        and prompts a person to act; it grades nothing and this module acts on it
        nowhere.
      */}
      {summary.discomfortReported ? (
        <p className="mt-3 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12.5px] text-ink">
          {SUMMARY_COPY.discomfort}
        </p>
      ) : null}

      {summary.logistics.lines.length > 0 ? (
        <Section title={summary.logistics.title} lines={summary.logistics.lines} />
      ) : null}

      {summary.clinical ? (
        summary.clinical.lines.length > 0 ? (
          <Section title={summary.clinical.title} lines={summary.clinical.lines} />
        ) : null
      ) : summary.flaggedForClinician > 0 ? (
        // The omission is STATED rather than hidden. A reader who cannot see these
        // answers must know they exist and who can, or they will assume the
        // patient said nothing.
        <p className="mt-3 text-[12.5px] leading-[1.5] text-muted">
          {SUMMARY_COPY.restricted(summary.flaggedForClinician)}
        </p>
      ) : null}

      {summary.interest.length > 0 ? (
        <div className="mt-3.5 border-t border-line pt-3">
          <h4 className="text-[12px] font-medium uppercase tracking-[0.04em] text-faint">
            Treatments they asked about
          </h4>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {summary.interest.map((row) => (
              <li
                key={row.treatment}
                className={
                  "rounded-full border px-2.5 py-1 text-[12px] " +
                  (row.answer === "yes"
                    ? "border-tint-green-line bg-tint-green text-ink"
                    : "border-line bg-card-muted/50 text-muted")
                }
              >
                {row.label}
                {/* The refusal is printed as plainly as the yes. A patient who said
                    no was ASKED, and a list showing only the yeses would invite the
                    practice to ask them again next month. */}
                {row.answer === "yes" ? "" : ": not right now"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-[11.5px] text-faint">{summary.forkNote}</p>
    </section>
  );
}

function Section({ title, lines }: { title: string; lines: PreVisitSummary["logistics"]["lines"] }) {
  return (
    <div className="mt-3.5 border-t border-line pt-3">
      <h4 className="text-[12px] font-medium uppercase tracking-[0.04em] text-faint">{title}</h4>
      <dl className="mt-1.5 space-y-2">
        {lines.map((line) => (
          <div key={line.key}>
            <dt className="text-[12.5px] text-muted">{line.question}</dt>
            <dd className="text-[13.5px] leading-[1.5] text-ink">
              {/* A free-text answer is set in quotation marks, because the words are
                  the PATIENT'S and a reader must not take them for the practice's
                  summary of what the patient meant. */}
              {line.freeText ? <span className="italic">&ldquo;{line.answer}&rdquo;</span> : line.answer}
              {line.scale !== null ? <span className="text-muted"> out of 10</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
