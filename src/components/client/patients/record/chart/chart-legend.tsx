import { surfaceStyle } from "@/lib/charting/render-state";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import type { FundingCode, SurfaceOrigin } from "@/lib/charting/types";

/**
 * THE LEGEND. Always visible, never behind a toggle, and the reason every mark on
 * the arch is unmistakable rather than merely distinguishable.
 *
 * ONE DENSE LINE-SET, NOT A DRIFT OF CHIPS. It used to be a single flex-wrap of nine
 * items that re-flowed into a different shape at every panel width, so a reader
 * looking for "what does lavender mean" had to scan the whole block each time. It is
 * now three labelled lines - SURFACES, MARKS, FUNDING - each a fixed row with its own
 * gutter label. Same information, a third of the vertical space, and a position a
 * reader can return to. Grouping is the density: nothing was removed to buy it, and
 * NOTHING MAY BE. Every origin surfaceStyle can produce is named here; a mark on a
 * clinical chart with no entry in the legend is an unexplained mark.
 *
 * IT IS SIZED FOR THE SAME ROOM AS THE ARCH. DENTALLY.md's MEASURED GEOMETRY exists
 * because the owner's verdict was "you make everything small it should be bigger",
 * and a legend a clinician cannot read from a metre away is a legend that does not
 * do its job while the chart beside it does. 12.5px text and 13px swatches, not
 * 11px text and 11px swatches: the swatch has to be big enough to carry a colour at
 * surgery distance, which is the entire mechanism by which this component prevents a
 * misread. Size alone was never going to do it — the swatches used to be a pale
 * yellow beside a pale cyan, four fills all sitting within 1.1:1 of the card behind
 * them, and no amount of pixels rescues that. The state fills are now a saturated
 * set with a real luminance ladder (globals.css, CHARTING block, which carries the
 * measured contrast and the dichromat separation). This file did not need editing to
 * follow, because it reads the same variables the arch does.
 *
 * FIVE ORIGINS, NOT THREE. Completed in Dentally, planned in Dentally, on a plan the
 * patient has NOT accepted, from the base chart, and (only when the draft layer is
 * switched on) planned here and not sent to Dentally. An item on a declined or
 * superseded plan rendering identically to one on the live accepted plan is a booking
 * error waiting to happen, so it is its own origin with its own swatch and its own
 * words.
 *
 * THE SWATCHES RENDER FROM surfaceStyle, THE SAME FUNCTION THE ARCH USES, so the
 * legend genuinely cannot drift from the chart. That is only true because
 * surfaceStyle derives everything - fill, line, dash, glyph and label - from the
 * origin alone, with no palette slot it could not honestly know.
 *
 * WITH TWO EXCEPTIONS, BOTH DELIBERATE, BOTH ADDED IN THE TONE PASS. The chart now
 * has two visible fills that are NOT findings: the crown's warm cream, and the white
 * of a surface nobody has charted. Before the tone pass the crown was near-white and
 * the point was arguable; --chart-tooth is now a real cream you can see across a
 * room, and an unexplained fill on a clinical chart is exactly what the paragraph
 * above says must not exist. So both get a swatch and both are named as NOT a
 * finding, which is the same invariant globals.css and tooth.tsx state in prose,
 * carried in the one place a reader actually looks it up.
 *
 * NEITHER of those two can come from surfaceStyle, and that is a correctness point
 * rather than a shortcut. surfaceStyle("none") returns a null fill and
 * --chart-tooth-line, but tooth.tsx draws an uncharted region as --card filled with
 * a --muted stroke. Rendering the "none" style here would put a swatch on the legend
 * that does not match a single region on the arch. These two therefore name the
 * tokens the arch actually uses, and they are the only swatches in this file that
 * do. If tooth.tsx ever changes what an unmarked surface is drawn in, this is the
 * second place to change.
 *
 * COLOUR ENCODES STATE, NOT TREATMENT FAMILY, and the legend is where that is
 * legible. The diary's palette is keyed on treatment family and would render a whole
 * restorative chart as one amber; and colour is not the safety channel there because
 * the treatment type is PRINTED on the block, which a 20px trapezoid cannot do.
 *
 * NO "use client": pure presentation.
 */
const ORIGINS: readonly SurfaceOrigin[] = [
  "dentally-completed",
  "dentally-planned",
  "dentally-unaccepted",
  "dentally-base",
];

const FUNDING_VAR: Record<Exclude<FundingCode, "unknown">, string> = {
  nhs: "var(--fund-nhs)",
  private: "var(--fund-private)",
  udc: "var(--fund-udc)",
};

export function ChartLegend({ draftEnabled }: { draftEnabled: boolean }) {
  const origins: SurfaceOrigin[] = draftEnabled ? [...ORIGINS, "draft"] : [...ORIGINS];
  return (
    <div
      className="rounded-xl border border-line bg-card px-4 py-2.5 text-[12.5px] leading-[1.35] text-muted"
      role="group"
      aria-label="Chart legend"
    >
      <Line label="Surfaces">
        {/* NOT CHARTED, FIRST, because it is the state most of the mouth is in and
            the one every other swatch is read against. It leads the line rather than
            trailing it so a reader learns "white square = nothing here" before
            learning the four colours, which is the order they will scan the arch in.
            Drawn in the arch's own two tokens, not through surfaceStyle: see the
            banner. */}
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="size-[13px] shrink-0 rounded-[3px] border"
            style={{ background: "var(--card)", borderColor: "var(--muted)" }}
          />
          Not charted
        </span>
        {origins.map((origin) => {
          const style = surfaceStyle(origin);
          return (
            <span key={origin} className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="size-[13px] shrink-0 rounded-[3px] border"
                style={{
                  background: cssVar(style.fillVar) ?? "transparent",
                  borderColor: cssVar(style.lineVar),
                  borderStyle: style.dashed ? "dashed" : "solid",
                }}
              />
              {style.label}
            </span>
          );
        })}
      </Line>

      {/* The whole-tooth ring, which is the mark a surfaceless extraction, crown,
          bridge, endo or implant gets. Without it in the legend, the one mark that
          exists to prevent a wrong-site event is unexplained. It gets its own line
          rather than trailing the surface swatches because it is a different KIND of
          mark - a ring around the whole tooth, not a filled region - and a reader who
          reads it as a fifth surface colour has learnt the chart wrong.

          THE SWATCH IS AN EXEMPLAR, NOT A FIFTH COLOUR, and the sentence now says so.
          tooth.tsx strokes the ring in the ORIGIN'S OWN line variable, so a planned
          extraction rings in gold and a completed one rings in steel; one swatch
          cannot show four rings without becoming the busiest thing on the panel. A
          legend that showed a single gold ring and said nothing was quietly teaching
          that the ring is always gold, which is the kind of misreading this component
          exists to prevent. Drawn in the planned line because planned is the state a
          whole-tooth finding is in when it matters most - a booked extraction that has
          not happened yet. */}
      <Line label="Marks">
        {/* THE CROWN'S CREAM, NAMED AS NOT A FINDING. It leads this line because the
            ring beside it is drawn ON this cream, so the two belong together: the
            tooth, then the mark on the tooth. Filled and round against the ring's
            unfilled and round, which is the same filled-vs-outline distinction the
            arch itself uses at that spot, and deliberately not the rounded SQUARE
            the surface swatches use - a crown is not a region of the grid and its
            swatch should not look like one. */}
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="size-[13px] shrink-0 rounded-full border"
            style={{
              background: "var(--chart-tooth)",
              borderColor: "var(--chart-tooth-line)",
            }}
          />
          The tooth itself. Every crown is this cream whether it is charted or not
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="size-[13px] shrink-0 rounded-full border-2"
            style={{ borderColor: "var(--chart-planned-line)" }}
          />
          Whole tooth: extraction, crown, bridge, endodontics, implant. The ring takes
          the colour of its own state above
        </span>
      </Line>

      {/* The funding rail's own vocabulary, read from the diary's module rather than
          restated, so the two screens cannot come to disagree about what blue means. */}
      <Line label="Funding">
        {(["nhs", "private", "udc"] as const).map((code) => (
          <span key={code} className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="h-[13px] w-[4px] shrink-0 rounded-[2px]"
              style={{ background: FUNDING_VAR[code] }}
            />
            {FUNDING_LABEL[code]}
          </span>
        ))}
      </Line>
    </div>
  );
}

/**
 * One labelled line of the set. The gutter label is a fixed width so the three lines
 * start on one vertical edge: a ragged left edge is what made the old block read as
 * loose, and alignment is most of what "dense" actually means here.
 *
 * The rows are separated by a hairline rather than by space, which is Dentally's own
 * habit and costs a pixel instead of a gap.
 */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line py-1 first:border-t-0 first:pt-0 last:pb-0">
      <span className="w-[58px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Accepts a bare variable name or an already-wrapped one, so the legend and the arch
 *  cannot disagree by one `var()` wrapper. Mirrors tooth.tsx. */
function cssVar(name: string | null): string | undefined {
  if (!name) return undefined;
  return name.startsWith("var(") ? name : `var(${name})`;
}
