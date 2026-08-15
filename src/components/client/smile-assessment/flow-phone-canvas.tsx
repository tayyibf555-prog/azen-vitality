import { cn } from "@/lib/utils";
import type { PhoneEdge, PhoneFlowLayout } from "@/lib/smile-assessment/flow-phone-layout";
import type { PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import { PhoneMini } from "./flow-phone-mini";

/**
 * THE FUNNEL AS A STRIP OF PHONE SCREENS, and it computes NOTHING.
 *
 * Every x, y, w, h, every wire path and the box they all live in arrive finished
 * from phoneFlowLayout (flow-phone-layout.ts) - which is layoutFlow itself, run at
 * phone metrics with no text. This file positions and paints. If you find an
 * arithmetic expression in here it belongs in the layout module with a test.
 *
 * TWO LAYERS, ONE COORDINATE SPACE. An SVG underlay draws the wires; the minis are
 * ordinary HTML absolutely positioned at the very same numbers, on top. No
 * transforms and no scaling anywhere, so the two layers cannot disagree about
 * where a screen is - the SVG is exactly layout.width x layout.height CSS pixels
 * and its viewBox is the same box at 1:1.
 *
 * WHY NOT foreignObject: it does not reflow, Tailwind behaves inconsistently
 * inside it, and this repo has never shipped one. Absolutely-positioned HTML off
 * pure layout data is, by contrast, the house idiom - the diary's appointment
 * blocks are exactly this (appointment-block.tsx:216-224): className="absolute"
 * plus inline computed offsets, never style={{position:"absolute"}}.
 *
 * THE MINIS ARE OPAQUE, so a wire passing beneath one stops at its edge, the same
 * way the canvas's card rects cover the wires under them. Only wires are drawn in
 * SVG; there is no rect, no header strip and no accent bar, because a screen's
 * corners and colours are CSS.
 *
 * TWO RENDERINGS OF ONE LAYOUT, as the canvas does (flow-canvas.tsx:26-32). Above
 * ~640px the strip, in its OWN scroll box so the page body never moves. Below it,
 * the same minis as a vertical ordered list: a diagram you have to drag sideways
 * on a phone is a diagram nobody reads, and a nine-step funnel is 3400px wide.
 * The wires are not redrawn in the list - unlabelled routes reduced to "goes to
 * screen 4" would be noise - so the small-screen reading is the SCREENS in order,
 * and the branch shape stays a thing you open on a wider display.
 *
 * ACCESSIBILITY. The strip is role="img" with a label, which makes it a leaf for a
 * screen reader exactly like the canvas's <svg role="img">; the ordered list is
 * the readable rendering. Nothing in either is focusable: this is a picture of a
 * funnel, and the editor is stage 3.
 */

export interface FlowPhoneCanvasProps {
  /** From phoneFlowLayout. Every number this component uses is in here. */
  layout: PhoneFlowLayout;
  /** One resolved screen per node id, from screenFor. */
  screens: ReadonlyMap<string, PhoneScreen>;
  /** The practice's name for the header lockup. Never the campaign's name. */
  practiceName?: string;
  /** Unique within the document: several strips can be on one page. */
  idPrefix: string;
  className?: string;
  /**
   * The scroll box's height cap.
   *
   * IT SCROLLS BOTH WAYS, and that is a correction to the obvious guess. A funnel
   * with three result steps lays out in three ROWS (1530px tall), not one, so a
   * strip capped to a single mini would hide two thirds of the funnel with no way
   * to reach it. The cap is what keeps the form below it on screen; `overflow-auto`
   * is what keeps every step reachable. One row plus the top of the next is
   * visible by default, which is also the scroll affordance.
   */
  viewportClassName?: string;
}

export function FlowPhoneCanvas({
  layout,
  screens,
  practiceName,
  idPrefix,
  className,
  viewportClassName,
}: FlowPhoneCanvasProps) {
  const arrow = `${idPrefix}-parrow`;
  const arrowBad = `${idPrefix}-parrow-bad`;

  return (
    <div className={cn("rounded-xl border border-line bg-card", className)}>
      <div className={cn("hidden overflow-auto p-1 sm:block", viewportClassName ?? "max-h-[520px]")}>
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height }}
          role="img"
          aria-label={`Funnel preview: the ${layout.nodes.length} screens a patient sees, in order`}
        >
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={layout.viewBox}
            className="absolute inset-0 block"
            aria-hidden
          >
            <defs>
              <ArrowMarker id={arrow} colour="var(--line-strong)" />
              <ArrowMarker id={arrowBad} colour="var(--danger)" />
            </defs>
            {layout.edges.map((e) => (
              <Wire
                key={`${e.from}-${e.to}-${e.index}`}
                edge={e}
                markerId={e.forward ? arrow : arrowBad}
              />
            ))}
          </svg>

          {layout.nodes.map((n) => {
            const screen = screens.get(n.id);
            if (!screen) return null;
            return (
              <div
                key={n.id}
                className="absolute"
                style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
              >
                <PhoneMini screen={screen} practiceName={practiceName} />
              </div>
            );
          })}
        </div>
      </div>

      {/* The small-screen reading: the same minis, the same sizes, downwards. */}
      <ol className="space-y-3 p-3 sm:hidden">
        {layout.nodes.map((n) => {
          const screen = screens.get(n.id);
          if (!screen) return null;
          return (
            <li key={n.id} className="mx-auto w-full" style={{ maxWidth: n.w, height: n.h }}>
              <PhoneMini screen={screen} practiceName={practiceName} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** flow-canvas.tsx:166-180, at this strip's own ids. */
function ArrowMarker({ id, colour }: { id: string; colour: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX={7}
      refY={4}
      markerWidth={7}
      markerHeight={7}
      orient="auto-start-reverse"
    >
      <path d="M 0 1 L 7 4 L 0 7 z" style={{ fill: colour }} />
    </marker>
  );
}

/**
 * One routed wire. No label: the answers are ON the screens now, as the rows a
 * patient taps, so a word in the gutter would be the same word a second time
 * (flow-phone-layout.ts, PHONE_EDGE_LABEL).
 *
 * Colour through `style` and a custom property rather than a Tailwind stroke
 * utility - a fill/stroke utility built around a variable outside @theme inline
 * renders TRANSPARENT (flow-canvas.tsx:17-22).
 */
function Wire({ edge, markerId }: { edge: PhoneEdge; markerId: string }) {
  return (
    <path
      d={edge.d}
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      style={{ stroke: edge.forward ? "var(--line-strong)" : "var(--danger)" }}
      markerEnd={`url(#${markerId})`}
      vectorEffect="non-scaling-stroke"
    />
  );
}
