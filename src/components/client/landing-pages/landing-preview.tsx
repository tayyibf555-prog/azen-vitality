"use client";

import { useState } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";

// Embedded, scrollable live preview of a landing page, shown inline in Growth >
// Landing pages so the owner can eyeball a page without leaving the console, then
// pop it out to a full browser tab if they want.
//
// The iframe is sandboxed WITHOUT allow-scripts on purpose: the landing page is
// fully server-rendered (HTML + inline CSS + same-origin images), so it renders
// completely without JavaScript, while the page's analytics tracker never runs.
// That matters because the src is the page's real URL: without this, every time
// an owner opened the preview it would fire a `viewed` event and inflate the A/B
// stats sitting right next to it. `allow-same-origin` lets its own CSS/images load.
// The "Open" link lives OUTSIDE the iframe, so popping out still gives the real,
// interactive page in a new tab.
export function LandingPreview({
  url,
  title,
  isDraft,
}: {
  url: string;
  title: string;
  isDraft: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [v, setV] = useState<"a" | "b">("a");
  const src = `${url}${url.includes("?") ? "&" : "?"}v=${v}`;

  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-card-muted px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 gap-1" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="truncate font-mono text-[11px] text-muted">{url}</span>
          {isDraft ? (
            <span className="shrink-0 rounded-full bg-tint-blue px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-blue-dark">
              Draft, private link
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="inline-flex overflow-hidden rounded-md border border-line-strong" role="tablist" aria-label="Preview variant">
            {(["a", "b"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={v === k} onClick={() => setV(k)}
                className={"px-2 py-1 text-xs font-semibold " + (v === k ? "bg-navy text-white" : "bg-card text-muted hover:text-navy")}>
                {k.toUpperCase()}
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
          src={src}
          title={`Live preview of ${title}`}
          loading="lazy"
          // No allow-scripts: renders the page but blocks its analytics tracker, so a
          // preview never counts as a visit. allow-same-origin loads its CSS/images.
          sandbox="allow-same-origin"
          className="block h-[520px] w-full bg-white"
        />
      ) : null}
    </div>
  );
}
