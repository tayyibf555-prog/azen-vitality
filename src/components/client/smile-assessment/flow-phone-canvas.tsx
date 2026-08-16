import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PHONE_ADD_SIZE,
  insertionPoints,
  type PhoneEdge,
  type PhoneFlowLayout,
} from "@/lib/smile-assessment/flow-phone-layout";
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
 * ACCESSIBILITY, AND THE ONE THING THAT CHANGES WHEN IT BECOMES EDITABLE. Read-
 * only, the strip is role="img" with a label, which makes it a leaf for a screen
 * reader exactly like the canvas's <svg role="img">, and nothing in it is
 * focusable: it is a picture of a funnel. Hand it an `onSelect` and it is no
 * longer a picture - each screen becomes a real <button> and the wrapper becomes
 * a role="group", because a control inside a role="img" is a control no screen
 * reader can reach. The read-only rendering is byte-for-byte what it always was
 * (the wizard's stage-2 preview passes no callback and must not grow tab stops).
 *
 * IT STILL DECIDES NOTHING. Selection is the BUILDER's state: this file is handed
 * `selectedId` and calls `onSelect` with a node id. It does not know what a
 * selection opens, it does not know what is wrong with a step - `faultyNodeIds`
 * arrives finished from validateFlow - and it does not write the label on a
 * button, because that would mean reading the question bank (describeNode), which
 * is exactly the import this file is pinned against.
 *
 * THE SAME GOES FOR THE +. `onAddAfter` gives the strip a second interaction - add
 * a screen after this one - and it is the same shape as the first: a node id
 * handed back, nothing decided. WHERE each + sits and WHICH screens get one are
 * insertionPoints' answer (flow-phone-layout.ts, where the arithmetic and the
 * "does it fit in the box" check are testable); WHAT gets added, and whether
 * anything can be, is planScreenInsertion's (flow-edit.ts, against the validator).
 * The control is therefore never disabled: a step that cannot take an insertion
 * gets a refusal in words from the builder, which is the house rule about clicks
 * that appear to do nothing.
 */

export interface FlowPhoneCanvasProps {
  /** From phoneFlowLayout. Every number this component uses is in here. */
  layout: PhoneFlowLayout;
  /** One resolved screen per node id, from screenFor. */
  screens: ReadonlyMap<string, PhoneScreen>;
  /** The practice's name for the header lockup. Never the campaign's name. */
  practiceName?: string;
  /** The step wearing the selection ring, or null. */
  selectedId?: string | null;
  /**
   * Present = editable. Absent = a picture, with nothing focusable in it. There
   * is no third state: a strip that highlights a step nobody can select is a
   * strip that looks broken.
   */
  onSelect?: (id: string) => void;
  /** Steps a validation failure named, ringed in the danger colour. */
  faultyNodeIds?: ReadonlySet<string>;
  /**
   * The accessible name for each step's button, by node id. FINISHED STRINGS, as
   * data: naming a step means reading the question bank, and this file may not
   * (flow-phone-mini.test.ts pins the import ban). A step with no entry falls
   * back to the words on its own screen, which is what a button's content gives
   * it anyway.
   */
  selectLabels?: ReadonlyMap<string, string>;
  /**
   * ADD A SCREEN AFTER THIS ONE. Present = the strip grows a + in the gutter after
   * every screen that has a wire out of it; absent = it does not, which is what the
   * wizard's read-only preview gets. It hands back a NODE ID and nothing else: which
   * wire that lands on, which question it asks and what the new step is called are
   * all planScreenInsertion's answer (flow-edit.ts), not this file's.
   */
  onAddAfter?: (nodeId: string) => void;
  /**
   * The accessible name for each +, by the node it follows. Finished strings, for
   * the same reason as selectLabels: naming a step means reading the question bank.
   * Without one the control still says what it does, just not which screen it
   * follows.
   */
  addLabels?: ReadonlyMap<string, string>;
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
  selectedId,
  onSelect,
  faultyNodeIds,
  selectLabels,
  onAddAfter,
  addLabels,
  idPrefix,
  className,
  viewportClassName,
}: FlowPhoneCanvasProps) {
  const arrow = `${idPrefix}-parrow`;
  const arrowBad = `${idPrefix}-parrow-bad`;
  const label = onSelect
    ? `Funnel: the ${layout.nodes.length} screens a patient sees, in order. Choose one to edit it.`
    : `Funnel preview: the ${layout.nodes.length} screens a patient sees, in order`;
  // Positions, and which screens may take one at all, arrive finished from the
  // layout module - the same numbers the minis and the wires are drawn at. The
  // SMALL-SCREEN list reads the same set (the ids), so the two renderings cannot
  // offer different operations on one funnel.
  const adds = onAddAfter ? insertionPoints(layout) : [];

  return (
    <div className={cn("rounded-xl border border-line bg-card", className)}>
      <div className={cn("hidden overflow-auto p-1 sm:block", viewportClassName ?? "max-h-[520px]")}>
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height }}
          role={onSelect ? "group" : "img"}
          aria-label={label}
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
                <Frame
                  nodeId={n.id}
                  selected={selectedId === n.id}
                  faulty={faultyNodeIds?.has(n.id) ?? false}
                  label={selectLabels?.get(n.id)}
                  onSelect={onSelect}
                >
                  <PhoneMini screen={screen} practiceName={practiceName} />
                </Frame>
              </div>
            );
          })}

          {/* THE + BETWEEN THE SCREENS. Drawn after the minis so it sits over the
              wire it stands on, and positioned at the layout's own numbers like
              everything else here. */}
          {onAddAfter
            ? adds.map((p) => (
                <div
                  key={`add-${p.nodeId}`}
                  className="absolute"
                  style={{ left: p.x, top: p.y, width: p.size, height: p.size }}
                >
                  <AddButton
                    nodeId={p.nodeId}
                    label={addLabels?.get(p.nodeId)}
                    onAddAfter={onAddAfter}
                  />
                </div>
              ))
            : null}
        </div>
      </div>

      {/* The small-screen reading: the same minis, the same sizes, downwards -
          and selectable in exactly the same way, because a practice manager
          reading this on a phone is reading the only rendering they get. The +
          comes with them, as a row between the screens rather than a dot in a
          gutter this rendering does not have. */}
      <ol className="space-y-3 p-3 sm:hidden">
        {layout.nodes.map((n) => {
          const screen = screens.get(n.id);
          if (!screen) return null;
          return (
            <li key={n.id} className="mx-auto w-full" style={{ maxWidth: n.w }}>
              <div style={{ height: n.h }}>
                <Frame
                  nodeId={n.id}
                  selected={selectedId === n.id}
                  faulty={faultyNodeIds?.has(n.id) ?? false}
                  label={selectLabels?.get(n.id)}
                  onSelect={onSelect}
                >
                  <PhoneMini screen={screen} practiceName={practiceName} />
                </Frame>
              </div>
              {onAddAfter && adds.some((p) => p.nodeId === n.id) ? (
                <div className="flex justify-center pt-3">
                  <div style={{ width: PHONE_ADD_SIZE, height: PHONE_ADD_SIZE }}>
                    <AddButton nodeId={n.id} label={addLabels?.get(n.id)} onAddAfter={onAddAfter} />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * ONE SCREEN MORE, HERE. It carries a node id and calls back; it does not know
 * what will be added, or whether anything can be - planScreenInsertion decides
 * that against the validator, and the builder shows the refusal in words if the
 * answer is no. A control that grey-mattered itself out would be a second copy of
 * that rule, in the file no test can reach.
 *
 * Square by the layout's numbers on the strip and by its own class in the list, so
 * the two renderings agree on what it is without the list needing coordinates.
 */
function AddButton({
  nodeId,
  label,
  onAddAfter,
}: {
  nodeId: string;
  label?: string;
  onAddAfter: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAddAfter(nodeId)}
      aria-label={label ?? "Add a screen after this one"}
      title={label ?? "Add a screen after this one"}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full border border-line-strong bg-card text-muted shadow-sm transition",
        "hover:border-blue-royal hover:bg-tint-royal hover:text-status-royal",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40",
      )}
    >
      <Plus size={14} aria-hidden />
    </button>
  );
}

/**
 * THE SELECTION RING, and the click target under it.
 *
 * WITH NO `onSelect` THIS RENDERS ITS CHILD AND NOTHING ELSE - not a wrapper div,
 * not a class, not an element. The wizard's stage-2 preview goes through here on
 * every render, and "the read-only strip is exactly what it was" is a promise
 * that has to be structural rather than remembered.
 *
 * THE RING IS THE BUTTON'S OWN, drawn at the mini's outer radius so it hugs the
 * handset instead of boxing it. A ring rather than a border, because a border
 * would move the mini by 2px and the wires - drawn at the layout's coordinates on
 * a layer that knows nothing about selection - would no longer meet its edge.
 *
 * SELECTED WINS OVER FAULTY. A step can be both, and the ring's job while you are
 * standing on a step is to say WHICH step you are standing on; the failure is
 * spelled out in words in the rail beside it, which is more use than a colour.
 */
function Frame({
  nodeId,
  selected,
  faulty,
  label,
  onSelect,
  children,
}: {
  nodeId: string;
  selected: boolean;
  faulty: boolean;
  label?: string;
  onSelect?: (id: string) => void;
  children: React.ReactNode;
}) {
  if (!onSelect) return <>{children}</>;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={() => onSelect(nodeId)}
      className={cn(
        "block h-full w-full rounded-[1.75rem] text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40",
        selected
          ? "ring-2 ring-blue-royal ring-offset-2 ring-offset-card"
          : faulty
            ? "ring-2 ring-danger"
            : "hover:ring-2 hover:ring-line-strong",
      )}
    >
      {children}
    </button>
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
