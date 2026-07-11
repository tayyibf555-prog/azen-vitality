"use client";

import { ChevronRight } from "lucide-react";
import { FIRST_QUESTION_ID, questionById } from "@/lib/smile-assessment/quiz";
import { iconFor } from "./option-icons";

// A live, non-interactive preview of the public Smile Assessment funnel's LANDING
// screen (the first thing a lead sees from an ad), shown in the campaign builder so
// the owner can see how their headline + intro will look as they type. It mirrors
// the real funnel's branded chrome and the opening (treatment) question, and reuses
// the funnel's icon mapping so the two never drift. Every later question is chosen
// by AI from the lead's answers, which the caption notes.

// Kept in step with the live funnel's fallback intro in assessment-quiz.tsx.
const DEFAULT_INTRO = "Find the right next step for your smile. About 30 seconds, no wrong answers.";

export function AssessmentPreview({
  practiceName,
  headline,
  intro,
}: {
  practiceName: string;
  headline: string;
  intro: string;
}) {
  const question = questionById(FIRST_QUESTION_ID);
  const options = question?.options ?? [];
  const name = practiceName.trim() || "Smile Assessment";

  return (
    <div className="lg:sticky lg:top-4">
      <p className="mb-2 text-xs font-semibold text-navy">Live preview</p>

      {/* Phone frame */}
      <div className="mx-auto w-full max-w-[300px] rounded-[2rem] border border-line-strong bg-card p-2 shadow-[0_12px_44px_rgba(10,14,26,0.16)]">
        <div className="relative overflow-hidden rounded-[1.6rem] bg-cream px-3 pb-4 pt-5">
          {/* Soft brand glow, mirroring the live funnel. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(60%_70%_at_50%_0%,rgba(91,196,247,0.22),transparent_72%)]"
          />

          {/* Branded header — the same compact horizontal lockup as the live funnel. */}
          <div className="relative mb-2.5 flex items-center justify-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-card shadow-[0_2px_10px_rgba(10,14,26,0.10)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/copilot-logo.png" alt="" width={20} height={20} className="h-5 w-5 object-contain" />
            </span>
            <div className="leading-tight">
              <p className="text-xs font-bold tracking-tight text-navy">{name}</p>
              <p className="text-[0.55rem] font-semibold uppercase tracking-[0.18em] text-blue-deep">
                Smile Assessment
              </p>
            </div>
          </div>

          {/* Card. */}
          <div className="relative overflow-hidden rounded-xl border border-line bg-card shadow-[0_4px_20px_rgba(10,14,26,0.06)]">
            <div className="h-1 w-full bg-card-muted">
              <div className="h-full w-1/6 rounded-r-full bg-blue-dark" />
            </div>
            <div className="space-y-2.5 p-3">
              <div className="flex justify-end">
                <span className="rounded-full bg-card-muted px-2 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wide text-muted">
                  Question 1
                </span>
              </div>

              {headline.trim() ? <p className="text-[0.72rem] font-semibold text-navy">{headline.trim()}</p> : null}
              <p className="text-[0.72rem] leading-snug text-muted">{intro.trim() || DEFAULT_INTRO}</p>

              <p className="pt-0.5 text-sm font-bold leading-snug text-navy">{question?.prompt}</p>

              <div className="space-y-1.5">
                {options.map((o) => {
                  const Icon = iconFor(o.value);
                  return (
                    <div
                      key={o.value}
                      className="flex items-center gap-2 rounded-lg border border-line bg-card px-2 py-1.5"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-dark/10 text-blue-dark">
                        <Icon size={13} strokeWidth={2} />
                      </span>
                      <span className="flex-1 text-[0.68rem] font-medium leading-tight text-ink">{o.label}</span>
                      <ChevronRight size={12} className="shrink-0 text-muted/60" aria-hidden />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="mx-auto mt-3 max-w-[300px] text-center text-[0.7rem] leading-snug text-muted">
        This is the opening screen. Each following question is chosen by AI from the lead&apos;s answers to qualify them.
      </p>
    </div>
  );
}
