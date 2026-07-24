"use client";

import { useState } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

type PreviewStyle = "classic" | "guided";

// Embedded, scrollable LIVE preview of a Smile Assessment funnel, shown inline in
// Growth > Smile Assessment so the owner can try the real funnel without leaving
// the console. Modelled on the Landing pages section's LandingPreview (url bar +
// Open in browser + Hide toggle), plus a Classic | Guided STYLE SWITCH that
// swaps the iframe src between the two public styles.
//
// UNLIKE LandingPreview, the sandbox here includes allow-scripts: the Smile
// Assessment funnel is a CLIENT component (it fetches the next question, tracks
// funnel steps, submits a form), so it needs JS to render at all. That is safe
// ONLY because every src here carries ?preview=1: both AssessmentQuiz and
// GuidedAssessmentQuiz treat previewMode as a hard gate that no-ops the funnel
// tracker and disables the submit button, so opening this preview can never
// fire telemetry or write a real submission. allow-same-origin loads the page's
// own CSS/fonts/images; allow-forms lets the contact step's inputs work for a
// full test drive.
export function AssessmentLivePreview({
  path,
  title,
}: {
  /** The campaign's public path, e.g. "/assess/vitality/invisalign" (no query). */
  path: string;
  title: string;
}) {
  const [open, setOpen] = useState(true);
  const [style, setStyle] = useState<PreviewStyle>("classic");

  const src = style === "guided" ? `${path}?style=guided&preview=1` : `${path}?preview=1`;

  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-card-muted px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 gap-1" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="truncate font-mono text-[11px] text-muted">{src}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div
            role="tablist"
            aria-label="Preview style"
            className="inline-flex gap-0.5 rounded-md border border-line-strong bg-card p-[2px]"
          >
            {(["classic", "guided"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={style === s}
                onClick={() => setStyle(s)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-semibold capitalize transition-colors",
                  style === s ? "bg-navy text-white" : "text-muted hover:text-navy",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="pressable inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            {open ? <EyeOff size={13} /> : <Eye size={13} />}
            {open ? "Hide" : "Preview"}
          </button>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="pressable inline-flex items-center gap-1 rounded-md border border-line-strong bg-card px-2 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            <ExternalLink size={13} />
            Open in browser
          </a>
        </div>
      </div>
      {open ? (
        <iframe
          key={style}
          src={src}
          title={`Live preview of ${title} (${style})`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-forms"
          className="block h-[560px] w-full bg-white"
        />
      ) : null}
    </div>
  );
}
