import { cn } from "@/lib/utils";
import type { BlockView } from "@/lib/smile-assessment/flow-block-view";

/**
 * A2's CONTENT BLOCKS, as a patient sees them, on the two screens that are not an
 * ask: the first screen (under the answers) and the result screen.
 *
 * IT DECIDES NOTHING. Every string arrives authored and already
 * compliance-scanned at write time (flow-copy.ts), and every picture arrives
 * resolved to a shipped path with alt text by flow-block-view.ts - which is also
 * the module that refuses the ones it cannot vouch for. There is no `src` built in
 * here, no fallback copy, and no rule: this file is classes.
 *
 * IT RENDERS NOTHING WHEN THERE IS NOTHING. `blocks.length === 0` returns null
 * rather than an empty wrapper, which is what makes a funnel with no furniture
 * render byte-for-byte the page it rendered before A2 - pinned against a captured
 * baseline in funnel-blocks.test.ts. A wrapper "for spacing" would be a two-line
 * gap under the answers of every funnel on the platform.
 *
 * TOKENS ONLY, and only the AA-contrast ones. `text-navy`, `text-ink`,
 * `text-muted` and `text-blue-deep` are the four the quiz already sets copy in;
 * every one of them is inside PALETTE_TOKENS (palette.ts:41-66), so a re-coloured
 * campaign re-paints this furniture from the same paletteVars wrapper as the rest
 * of the screen, and every one of them is contrast-checked against the surfaces
 * below it by palette.test.ts. `text-faint` is deliberately not used: it is meta
 * ink for footnotes, not for a sentence a practice is asking a patient to read.
 *
 * THE FAQ IS <details>, NOT STATE. Two to six answers of up to 240 characters
 * under a question screen is a wall; an accordion is the honest control for it.
 * Native <details> gives it keyboard and screen-reader behaviour for free and
 * keeps this component what it says it is - no useState, no client rule, nothing
 * that could disagree with the phone mini's drawing of the same block.
 */

export function FunnelBlocks({
  blocks,
  className,
}: {
  blocks: readonly BlockView[];
  /**
   * Positioning from the screen that owns the slot. It lands on the ROOT rather
   * than on a wrapper the caller renders, because a wrapper is markup - and a
   * caller that wrapped an empty list would put an element (and, inside a `gap`
   * column, a gap) on every funnel that has no furniture at all.
   */
  className?: string;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className={cn("mt-4 space-y-3 border-t border-line pt-4", className)}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: BlockView }) {
  switch (block.kind) {
    case "trust-strip":
      return (
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-blue-deep">
            {block.practiceName}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {block.chips.map((chip, i) => (
              <li
                key={i}
                className="rounded-full bg-card-muted px-2.5 py-0.5 text-[0.7rem] font-medium text-ink"
              >
                {chip}
              </li>
            ))}
          </ul>
        </div>
      );

    case "testimonial":
      return (
        // A quote the practice already holds. The AI lane may polish its grammar
        // and may never invent one (charter, patient-facing copy), which is why
        // there is no "review" or "rating" anywhere in this block: a star is a
        // claim, and this is a sentence somebody actually said.
        <figure className="rounded-xl border border-line bg-card-muted/60 px-3 py-2.5">
          <blockquote className="text-[0.8rem] leading-snug text-ink">
            &ldquo;{block.quote}&rdquo;
          </blockquote>
          <figcaption className="mt-1 text-[0.7rem] font-semibold text-muted">
            {block.attribution}
          </figcaption>
        </figure>
      );

    case "faq":
      return (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i}>
              <details className="rounded-xl border border-line bg-card px-3 py-2">
                <summary className="cursor-pointer text-[0.8rem] font-semibold leading-snug text-navy">
                  {item.q}
                </summary>
                <p className="mt-1 text-[0.78rem] leading-snug text-muted">{item.a}</p>
              </details>
            </li>
          ))}
        </ul>
      );

    case "image":
      return (
        // width/height are the asset's intrinsic size, so the box is reserved
        // before the lazy-loaded file arrives and the answers above it never jump.
        <span className="block overflow-hidden rounded-xl bg-card-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={block.image.src}
            alt={block.image.alt}
            width={block.image.width}
            height={block.image.height}
            loading="lazy"
            decoding="async"
            className="h-auto w-full object-cover"
          />
        </span>
      );
  }
}
