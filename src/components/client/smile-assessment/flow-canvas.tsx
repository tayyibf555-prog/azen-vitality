import { cn } from "@/lib/utils";
import type { FlowLayout, LaidOutEdge, LaidOutNode } from "@/lib/smile-assessment/flow-layout";
import type { FlowNodeKind } from "@/lib/smile-assessment/flow";

/**
 * THE FUNNEL CANVAS. Draws a laid-out funnel and computes NOTHING.
 *
 * Every coordinate, every wrapped line, every baseline and the viewBox itself
 * arrive from flow-layout.ts - and so does the card's chrome: the header strip's
 * path, the kind bar's rect and the hairline above each option row. That split is
 * the charting idiom (tooth.tsx:49-57) and it is the only way any of this is
 * testable: vitest collects no .tsx, so a rule written in here is a rule nothing
 * can hold. Not one COORDINATE below is computed - the card's outline, its strip,
 * its bar and its rules all arrive finished. If you find yourself adding
 * arithmetic, it belongs in flow-layout.ts with a test beside it.
 *
 * NO COLOUR LITERALS. Fills and strokes are CSS custom properties from
 * globals.css, applied through `style` rather than through an interpolated
 * Tailwind class - globals.css records that a fill utility built around a
 * variable outside @theme inline renders TRANSPARENT, which on a chart means a
 * marked thing draws as an unmarked one (tooth.tsx:270).
 *
 * NO TRANSFORMS, and `vectorEffect="non-scaling-stroke"` on everything stroked,
 * so a hairline stays a hairline whatever the viewBox does.
 *
 * TWO RENDERINGS OF ONE LAYOUT. Above ~640px, the canvas, in its OWN
 * overflow-x-auto box so the page body never scrolls sideways. Below it, the
 * same layout as a vertical ordered list: a diagram you have to drag sideways on
 * a phone is a diagram nobody reads (arch-metrics.ts:49-57), and the practice
 * manager opens this tab on a phone. The list is a PROJECTION of the very same
 * `layout.nodes` (already in reading order - see outlineOrder), not a second
 * description of the graph that could disagree with the picture.
 */

/**
 * The left accent bar. One colour per KIND; the band is spelled out in the
 * eyebrow. EXPORTED because the gallery's flow-shape thumbnails draw the same
 * steps at another size, and two copies of this map would be two answers to
 * "what colour is the contact step" - the miniature and the canvas it previews
 * would then disagree on the very thing the miniature is for.
 */
export const NODE_ACCENT: Record<FlowNodeKind, string> = {
  welcome: "var(--status-blue)",
  question: "var(--blue-royal)",
  // The capture step is the one thing that has to happen, so it gets the warm one.
  contact: "var(--status-amber)",
  outcome: "var(--status-green)",
};

/**
 * The header strip's fill: the pale tint that PAIRS with each kind's accent in
 * the chip language (globals.css:56-70). Tokens rather than an opacity on the
 * accent, so a header strip is the same colour as the chip for that kind
 * everywhere else in the app, and no card invents a shade of its own.
 *
 * Not exported: the thumbnails draw no header, because a thumbnail card carries
 * no text and therefore no header strip to put behind it.
 */
const NODE_TINT: Record<FlowNodeKind, string> = {
  welcome: "var(--tint-blue)",
  question: "var(--tint-royal)",
  contact: "var(--tint-amber)",
  outcome: "var(--tint-green)",
};

const KIND_NOTE: Record<FlowNodeKind, string> = {
  welcome: "Opening screen",
  question: "Question",
  contact: "Contact details",
  outcome: "Result",
};

export interface FlowCanvasProps {
  layout: FlowLayout;
  selectedNodeId?: string | null;
  selectedEdgeIndex?: number | null;
  onSelectNode?: (id: string) => void;
  onSelectEdge?: (index: number) => void;
  /** Steps a validation failure named. Drawn with a warning outline. */
  faultyNodeIds?: ReadonlySet<string>;
  /** Unique within the document: several canvases can be on one page. */
  idPrefix: string;
  className?: string;
  /**
   * The scrolling box's height cap. A canvas being READ (the wizard's preview of
   * the funnel it is about to attach) wants a short window; a canvas being
   * EDITED wants most of the screen, which is the default.
   */
  viewportClassName?: string;
}

export function FlowCanvas({
  layout,
  selectedNodeId,
  selectedEdgeIndex,
  onSelectNode,
  onSelectEdge,
  faultyNodeIds,
  idPrefix,
  className,
  viewportClassName,
}: FlowCanvasProps) {
  const arrow = `${idPrefix}-arrow`;
  const arrowOn = `${idPrefix}-arrow-on`;
  const arrowBad = `${idPrefix}-arrow-bad`;

  return (
    <div className={cn("rounded-xl border border-line bg-card", className)}>
      {/* The canvas keeps its scrolling to itself. */}
      <div className={cn("hidden overflow-auto p-1 sm:block", viewportClassName ?? "max-h-[70vh]")}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={layout.viewBox}
          role="img"
          aria-label={`Funnel diagram with ${layout.nodes.length} steps`}
          className="block"
        >
          <defs>
            <ArrowMarker id={arrow} colour="var(--line-strong)" />
            <ArrowMarker id={arrowOn} colour="var(--blue-royal)" />
            <ArrowMarker id={arrowBad} colour="var(--danger)" />
          </defs>

          {/* Wires first, so a card always sits on top of the line into it. */}
          {layout.edges.map((e) => (
            <Wire
              key={`${e.from}-${e.to}-${e.index}`}
              edge={e}
              selected={selectedEdgeIndex === e.index}
              markerId={!e.forward ? arrowBad : selectedEdgeIndex === e.index ? arrowOn : arrow}
              onSelect={onSelectEdge}
            />
          ))}

          {layout.nodes.map((n) => (
            <Card
              key={n.id}
              node={n}
              selected={selectedNodeId === n.id}
              faulty={faultyNodeIds?.has(n.id) ?? false}
              onSelect={onSelectNode}
            />
          ))}
        </svg>
      </div>

      <ol className="divide-y divide-line sm:hidden">
        {layout.nodes.map((n, i) => (
          <OutlineRow
            key={n.id}
            index={i}
            node={n}
            edges={layout.edges.filter((e) => e.from === n.id)}
            targets={layout.nodes}
            selected={selectedNodeId === n.id}
            faulty={faultyNodeIds?.has(n.id) ?? false}
            onSelect={onSelectNode}
          />
        ))}
      </ol>
    </div>
  );
}

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

function Wire({
  edge,
  selected,
  markerId,
  onSelect,
}: {
  edge: LaidOutEdge;
  selected: boolean;
  markerId: string;
  onSelect?: (index: number) => void;
}) {
  const stroke = !edge.forward
    ? "var(--danger)"
    : selected
      ? "var(--blue-royal)"
      : "var(--line-strong)";

  return (
    <g
      className={onSelect ? "cursor-pointer" : undefined}
      onClick={onSelect ? () => onSelect(edge.index) : undefined}
    >
      <title>
        {edge.label ? `${edge.label}: ` : ""}
        {edge.from} to {edge.to}
      </title>
      {/* A fat invisible copy of the wire, purely so a 1.5px line is clickable. */}
      {onSelect ? (
        <path
          d={edge.d}
          fill="none"
          strokeWidth={14}
          style={{ stroke: "var(--card)" }}
          strokeOpacity={0}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={edge.d}
        fill="none"
        strokeWidth={selected ? 2 : 1.5}
        strokeLinecap="round"
        style={{ stroke }}
        markerEnd={`url(#${markerId})`}
        vectorEffect="non-scaling-stroke"
      />
      {edge.label ? (
        <text
          x={edge.labelPoint.x}
          y={edge.labelPoint.y}
          textAnchor="middle"
          fontSize={9.5}
          fontWeight={600}
          style={{ fill: selected ? "var(--blue-royal)" : "var(--muted)" }}
          // The wire runs under the label; the halo is what keeps it readable.
          paintOrder="stroke"
          strokeWidth={3}
          strokeLinejoin="round"
          stroke="var(--card)"
        >
          {edge.label}
        </text>
      ) : null}
    </g>
  );
}

function Card({
  node,
  selected,
  faulty,
  onSelect,
}: {
  node: LaidOutNode;
  selected: boolean;
  faulty: boolean;
  onSelect?: (id: string) => void;
}) {
  const border = selected ? "var(--blue-royal)" : faulty ? "var(--danger)" : "var(--line-strong)";

  return (
    <g
      className={onSelect ? "cursor-pointer" : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onClick={onSelect ? () => onSelect(node.id) : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect(node.id);
            }
          : undefined
      }
    >
      <title>{`${KIND_NOTE[node.kind]}: ${node.titleLines.map((l) => l.text).join(" ")}`}</title>

      {/* The card's body, opaque, so the wires drawn underneath stop at its edge.
          Fill only: the outline goes on LAST, or the header strip and the rules
          would paint over their own border. */}
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.rx}
        style={{ fill: "var(--card)" }}
      />
      {/* The kind, said twice and quietly: a tinted header strip behind the
          eyebrow, and a bar down the left edge. Neither is the card's outline,
          which stays free to mean selected / needs-a-fix and nothing else. */}
      <path d={node.headerD} style={{ fill: NODE_TINT[node.kind] }} />
      <rect
        x={node.accent.x}
        y={node.accent.y}
        width={node.accent.w}
        height={node.accent.h}
        rx={node.accent.rx}
        style={{ fill: NODE_ACCENT[node.kind] }}
      />
      <line
        x1={node.x}
        y1={node.dividerY}
        x2={node.right}
        y2={node.dividerY}
        style={{ stroke: "var(--line)" }}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />

      <text
        x={node.textX}
        y={node.eyebrowY}
        fontSize={9}
        fontWeight={700}
        letterSpacing="0.04em"
        style={{ fill: "var(--muted)" }}
      >
        {node.eyebrow.toUpperCase()}
      </text>

      <text fontSize={11} fontWeight={600} style={{ fill: "var(--navy)" }}>
        {node.titleLines.map((line) => (
          <tspan key={line.y} x={node.textX} y={line.y}>
            {line.text}
          </tspan>
        ))}
      </text>

      {/* One hairline per option row. A separated row per answer is what makes a
          seven-answer question readable at a glance; the bullets it replaces
          only marked where a line started. */}
      {node.optionRuleY.map((y) => (
        <line
          key={y}
          x1={node.x}
          y1={y}
          x2={node.right}
          y2={y}
          style={{ stroke: "var(--line)" }}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <text fontSize={10} style={{ fill: "var(--ink)" }}>
        {node.optionLines.map((line) => (
          <tspan key={line.y} x={node.textX} y={line.y}>
            {line.text}
          </tspan>
        ))}
      </text>

      {/* Last, over the strip and the rules, so the border is one unbroken line. */}
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.rx}
        fill="none"
        style={{ stroke: border }}
        strokeWidth={selected || faulty ? 2 : 1}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** One step of the small-screen projection: the same card, read downwards. */
function OutlineRow({
  index,
  node,
  edges,
  targets,
  selected,
  faulty,
  onSelect,
}: {
  index: number;
  node: LaidOutNode;
  edges: LaidOutEdge[];
  targets: LaidOutNode[];
  selected: boolean;
  faulty: boolean;
  onSelect?: (id: string) => void;
}) {
  const title = node.titleLines.map((l) => l.text).join(" ");
  const titleOf = (id: string): string => {
    const target = targets.find((t) => t.id === id);
    return target ? target.titleLines.map((l) => l.text).join(" ") : id;
  };

  return (
    <li>
      <button
        type="button"
        onClick={onSelect ? () => onSelect(node.id) : undefined}
        disabled={!onSelect}
        className={cn(
          "flex w-full gap-3 px-3 py-2.5 text-left transition-colors",
          onSelect ? "hover:bg-card-muted" : "cursor-default",
          selected ? "bg-tint-royal" : "",
        )}
      >
        <span
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: NODE_ACCENT[node.kind] }}
          aria-hidden="true"
        >
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted">
              {node.eyebrow}
            </span>
            {faulty ? (
              <span className="rounded bg-tint-red px-1 text-[9.5px] font-bold uppercase text-status-red">
                Needs a fix
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12.5px] font-semibold text-navy">{title}</span>
          {node.optionLines.length > 0 ? (
            <span className="mt-0.5 block text-[11px] text-muted">
              {node.optionLines.map((l) => l.text).join(" · ")}
            </span>
          ) : null}
          {edges.length > 0 ? (
            <span className="mt-1 block space-y-0.5">
              {edges.map((e) => (
                <span key={e.index} className="block text-[11px] text-ink">
                  <span className="font-semibold">{e.label ?? "Next"}</span>
                  <span className="px-1 text-line-strong">&rarr;</span>
                  <span className={e.forward ? "text-muted" : "font-semibold text-status-red"}>
                    {titleOf(e.to)}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
