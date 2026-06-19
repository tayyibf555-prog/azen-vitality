"use client";

import { Bot, Send, Sparkles } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/primitives";

/**
 * Polished placeholder for the practice AI co-pilot. No backend call yet: the
 * input is disabled and a short note explains what it will do once it ships.
 */
const SAMPLE_PROMPTS = [
  "Which sites are below target on recalls this month?",
  "What is our recovered revenue versus last quarter?",
  "Where are we leaking the most treatment value right now?",
];

export function CopilotView() {
  return (
    <>
      <PageHeader
        title="Co-pilot"
        description="Ask about your practice in plain English. The co-pilot reads your operational data and answers with the numbers behind it."
        actions={
          <span className="rounded-full border border-line-strong bg-card-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Coming soon
          </span>
        }
      />

      <SectionCard className="overflow-hidden" bodyClassName="p-0">
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-card-muted text-blue-dark shadow-sm">
            <Bot size={26} />
          </span>
          <h3 className="text-lg text-navy">Your practice, on demand</h3>
          <p className="mt-1 max-w-md text-sm text-muted">
            Soon you will be able to query performance, recovery and team workload
            in natural language and get a clear answer with the data to back it up.
            No dashboards to hunt through.
          </p>

          <div className="mt-7 flex w-full max-w-xl flex-wrap items-center justify-center gap-2">
            {SAMPLE_PROMPTS.map((prompt) => (
              <span
                key={prompt}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs text-muted"
              >
                <Sparkles size={12} className="shrink-0 text-blue-dark" />
                {prompt}
              </span>
            ))}
          </div>

          <div className="mt-7 flex w-full max-w-xl items-center gap-2 rounded-xl border border-line bg-card-muted/60 p-2">
            <input
              type="text"
              disabled
              aria-label="Ask about your practice"
              placeholder="Ask about your practice..."
              className="flex-1 cursor-not-allowed bg-transparent px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none"
            />
            <button
              type="button"
              disabled
              aria-label="Send"
              className="flex h-9 w-9 cursor-not-allowed items-center justify-center rounded-lg bg-blue-dark/40 text-white"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">
            The co-pilot is being built and will light up in a later release.
          </p>
        </div>
      </SectionCard>
    </>
  );
}
