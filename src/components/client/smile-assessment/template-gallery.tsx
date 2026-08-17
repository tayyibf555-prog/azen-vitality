import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, PenLine, Search, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { goalLabel } from "@/lib/smile-assessment/campaign";
import { normaliseAndValidateFlow } from "@/lib/smile-assessment/flow-validate";
import {
  FLOW_TEMPLATES,
  SCRATCH_FLOW_KEY,
  buildScratchFlow,
  templateForGoal,
  type FlowTemplate,
} from "@/lib/smile-assessment/flow-templates";
import {
  THUMBNAIL_ASPECT,
  flowThumbnail,
  type FlowThumbnail,
} from "@/lib/smile-assessment/flow-thumbnail";
import {
  ALL_TEMPLATES_CATEGORY,
  filterTemplates,
  gridHeading,
  recommendedTemplates,
  showRecommendedRow,
  templateCategories,
} from "@/lib/smile-assessment/template-recommend";
import type { TemplateChoice, TemplateSource } from "@/lib/smile-assessment/wizard-state";
import { NODE_ACCENT } from "./flow-canvas";

/**
 * STAGE 1 OF THE CREATE WIZARD: the templates screen.
 *
 * It TAKES OVER the module's content area rather than sitting on top of one long
 * form. That is the whole point of the rebuild: choosing a starting point is a
 * decision in its own right and deserves the screen, not a strip bolted above six
 * text fields. The takeover is bounded by the section it replaces, so the app's
 * navigation stays reachable, nothing traps the page's scroll, and there is no
 * z-index race with the shell.
 *
 * EVERY CARD SHOWS THE FUNNEL IT WOULD GIVE YOU. The miniature is the real graph
 * through the real layout engine (flow-thumbnail.ts), so a card cannot promise a
 * shape the builder then contradicts. Names and blurbs describe; the picture is
 * the thing that actually tells an owner these seven funnels are not the same.
 *
 * IT OWNS NO RULES. What is recommended, what the rail contains, what a search
 * matches and whether the recommended row shows all come from
 * template-recommend.ts, tested; the geometry comes from flow-thumbnail.ts,
 * tested. This file decides what is on screen and computes nothing.
 *
 * "LET AI WRITE ONE" NEVER TRUSTS THE REPLY. The route validates, and then this
 * validates again with the same pure gate before anything is handed on. If the
 * reply cannot be read, or the route is not deployed, or the model is having a
 * bad day, the owner gets the starter for that goal and a line saying exactly
 * what happened - never an empty canvas, never a half-drawn funnel, never
 * silence. The line travels ON the choice (TemplateChoice.note), because this
 * screen is gone by the time the owner reads it.
 *
 * NO COLOUR LITERALS: tints and inks are token classes, and the thumbnail's
 * strokes are the CSS custom properties the canvas itself uses (NODE_ACCENT).
 */

export type { TemplateChoice, TemplateSource };

export interface TemplateGalleryProps {
  clientSlug: string;
  /** Passed to the generator so it writes for the right enquiry. */
  idealCustomer?: string;
  targetBudget?: string;
  /**
   * The PRACTICE's own name. A FACT the writer is given rather than copy it may
   * invent: it heads a trust strip, and without one no trust strip is written at
   * all (flow-generate.ts). Never the campaign's name, which is an internal source
   * label ("Instagram bio").
   */
  practiceName?: string;
  /** The currently chosen key, so a card reads as chosen when the owner comes back. */
  chosenKey?: string | null;
  onChoose: (choice: TemplateChoice) => void;
  /** Leaving without choosing anything. */
  onClose?: () => void;
  className?: string;
}

/** One card's data: the template, its funnel, and that funnel's miniature. */
interface GalleryCard {
  template: FlowTemplate;
  thumb: FlowThumbnail;
  questions: number;
}

export function TemplateGallery({
  clientSlug,
  idealCustomer,
  targetBudget,
  practiceName,
  chosenKey,
  onChoose,
  onClose,
  className,
}: TemplateGalleryProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_TEMPLATES_CATEGORY);
  const [generating, setGenerating] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "warning" | "info"; text: string } | null>(null);

  // Built ONCE. `build()` returns a fresh graph every call and the layout is
  // pure, so this is only ever the same eight pictures - recomputing them on
  // every keystroke in the search box would be work with no output.
  const cards = useMemo<GalleryCard[]>(
    () =>
      FLOW_TEMPLATES.map((template) => {
        const graph = template.build();
        return {
          template,
          thumb: flowThumbnail(graph),
          questions: graph.nodes.filter((n) => n.kind === "question").length,
        };
      }),
    [],
  );

  const byKey = useMemo(() => new Map(cards.map((c) => [c.template.key, c])), [cards]);
  const categories = useMemo(() => templateCategories(FLOW_TEMPLATES), []);
  // Memoised as one object so the filter passed to every rule below is the same
  // object across a render, and the shelf is only recomputed when the owner
  // actually changed something.
  const filter = useMemo(() => ({ search: query, category }), [query, category]);
  const visible = useMemo(() => filterTemplates(FLOW_TEMPLATES, filter), [filter]);
  const recommended = useMemo(() => recommendedTemplates(FLOW_TEMPLATES), []);
  const withRecommended = showRecommendedRow(filter);

  // Escape leaves, the way any takeover should. Registered on the document
  // because the takeover has no single focused element to hang it off.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function generate(goal: string) {
    if (generating) return;
    setGenerating(goal);
    setNote(null);

    const fallback = (text: string) => {
      const template = templateForGoal(goal);
      setNote({ tone: "warning", text });
      onChoose({
        key: template.key,
        goal: template.goal,
        graph: template.build(),
        source: "template",
        note: text,
      });
    };

    try {
      const res = await fetch("/api/smile-assessment/flow-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          goal,
          idealCustomer: idealCustomer || undefined,
          targetBudget: targetBudget || undefined,
          practiceName: practiceName || undefined,
        }),
      });

      if (res.status === 404) {
        fallback(
          "Writing a funnel with AI is not available on this deployment yet, so this is the starter for that goal instead.",
        );
        return;
      }
      if (res.status === 429 || res.status === 503) {
        fallback(
          "The funnel writer is busy at the moment, so this is the starter for that goal instead. Try again shortly.",
        );
        return;
      }

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        flow?: unknown;
        source?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.flow) {
        fallback(
          data.error
            ? `${data.error} This is the starter for that goal instead.`
            : "The funnel could not be written just now, so this is the starter for that goal instead.",
        );
        return;
      }

      // The same gate the runtime uses. A reply that does not pass it is not
      // handed on, however confident the response looked.
      const { graph } = normaliseAndValidateFlow(data.flow);
      if (!graph) {
        fallback(
          "The funnel that came back did not pass its checks, so this is the starter for that goal instead.",
        );
        return;
      }

      const usedTemplate = data.source === "template";
      const text = usedTemplate
        ? "The writer could not settle on a funnel, so this is the starter for that goal. Read it through on the canvas."
        : "Written for this goal. Read it through before you switch it on.";
      setNote({ tone: usedTemplate ? "warning" : "info", text });
      onChoose({
        key: goal,
        goal,
        graph,
        source: usedTemplate ? "template" : "ai",
        note: text,
      });
    } catch {
      fallback(
        "The funnel writer could not be reached, so this is the starter for that goal instead.",
      );
    } finally {
      setGenerating(null);
    }
  }

  function useTemplate(card: GalleryCard) {
    setNote(null);
    onChoose({
      key: card.template.key,
      goal: card.template.goal,
      graph: card.template.build(),
      source: "template",
    });
  }

  function startBlank() {
    setNote(null);
    onChoose({
      key: SCRATCH_FLOW_KEY,
      goal: null,
      graph: buildScratchFlow(),
      source: "scratch",
    });
  }

  const cardsFor = (templates: readonly FlowTemplate[]): GalleryCard[] =>
    templates.map((t) => byKey.get(t.key)).filter((c): c is GalleryCard => c !== undefined);

  return (
    <section
      aria-label="Templates"
      className={cn(
        "max-h-[76vh] overflow-y-auto rounded-2xl border border-line-strong bg-card",
        className,
      )}
    >
      {/* The bar stays put while the shelf scrolls under it: search and the way
          out are the two things that must never scroll off. */}
      <header className="sticky top-0 z-10 flex flex-col gap-3 rounded-t-2xl border-b border-line bg-card px-4 py-3.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-title text-navy">Templates</h3>
          <p className="mt-0.5 text-caption font-normal text-muted">
            Pick the funnel this assessment starts from. Every one asks only questions the
            scoring already understands, and you can change it afterwards.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="h-8 w-full rounded-lg border border-line bg-card-muted pl-8 pr-2.5 text-[12.5px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={startBlank}>
            <Wand2 size={14} /> Start from scratch
          </Button>
          {onClose ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close templates">
              <X size={15} />
            </Button>
          ) : null}
        </div>
      </header>

      {note ? (
        <p
          className={cn(
            "mx-4 mt-3 flex items-start gap-1.5 rounded-lg px-3 py-2 text-[11.5px] sm:mx-5",
            note.tone === "warning"
              ? "border border-warning/25 bg-tint-amber text-status-amber"
              : "border border-blue-royal/20 bg-tint-royal text-status-royal",
          )}
        >
          {note.tone === "warning" ? (
            <AlertTriangle size={13} className="mt-px shrink-0" />
          ) : (
            <Sparkles size={13} className="mt-px shrink-0" />
          )}
          <span>{note.text}</span>
        </p>
      ) : null}

      <div className="grid lg:grid-cols-[190px_minmax(0,1fr)]">
        {/* The rail. A column on a laptop; a scrollable chip row on a phone, in
            its OWN overflow box so the page body never scrolls sideways. */}
        <nav aria-label="Template categories" className="border-b border-line lg:border-b-0 lg:border-e">
          <div className="flex gap-1.5 overflow-x-auto px-4 py-2.5 sm:px-5 lg:flex-col lg:overflow-x-visible lg:px-2.5 lg:py-3.5">
            {categories.map((c) => {
              const active = c.key === category;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategory(c.key)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-start text-[12px] font-medium transition-colors lg:w-full lg:shrink",
                    active
                      ? "bg-tint-royal text-status-royal"
                      : "text-ink hover:bg-card-muted",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span
                    className={cn(
                      "tabular-nums text-[10.5px]",
                      active ? "text-status-royal" : "text-faint",
                    )}
                  >
                    {c.count}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="min-w-0 px-4 py-4 sm:px-5">
          {withRecommended ? (
            <section className="mb-5">
              <ShelfHeading
                title="Recommended"
                note="Where most practices start."
              />
              <CardGrid
                cards={cardsFor(recommended)}
                keyPrefix="rec"
                chosenKey={chosenKey}
                generating={generating}
                onUse={useTemplate}
                onGenerate={generate}
              />
            </section>
          ) : null}

          <section>
            <ShelfHeading
              title={gridHeading(filter, FLOW_TEMPLATES)}
              note={`${visible.length} ${visible.length === 1 ? "template" : "templates"}`}
            />
            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
                <p className="text-[12.5px] font-semibold text-navy">Nothing matches that</p>
                <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-muted">
                  Try a treatment name, or start from scratch and add the questions you want.
                </p>
                <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={startBlank}>
                  <Wand2 size={13} /> Start from scratch
                </Button>
              </div>
            ) : (
              <CardGrid
                cards={cardsFor(visible)}
                keyPrefix="all"
                chosenKey={chosenKey}
                generating={generating}
                onUse={useTemplate}
                onGenerate={generate}
              />
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ShelfHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
      <h4 className="text-[12.5px] font-semibold text-navy">{title}</h4>
      <span className="text-[11px] text-muted">{note}</span>
    </div>
  );
}

function CardGrid({
  cards,
  keyPrefix,
  chosenKey,
  generating,
  onUse,
  onGenerate,
}: {
  cards: GalleryCard[];
  keyPrefix: string;
  chosenKey?: string | null;
  generating: string | null;
  onUse: (card: GalleryCard) => void;
  onGenerate: (goal: string) => void;
}) {
  return (
    <div className="mt-2.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <TemplateCard
          key={`${keyPrefix}-${card.template.key}`}
          card={card}
          chosen={chosenKey === card.template.key}
          generating={generating === card.template.goal}
          busy={generating !== null}
          onUse={() => onUse(card)}
          onGenerate={() => onGenerate(card.template.goal)}
        />
      ))}
    </div>
  );
}

/**
 * The miniature on its own, for the details screen's "this is what you picked"
 * strip. Exported so there is ONE drawing of a funnel shape in the app: a second
 * copy would be a second chance for the confirmation and the card to disagree
 * about what was chosen.
 */
export { FlowShape as FlowShapeThumbnail };

function TemplateCard({
  card,
  chosen,
  generating,
  busy,
  onUse,
  onGenerate,
}: {
  card: GalleryCard;
  chosen: boolean;
  generating: boolean;
  busy: boolean;
  onUse: () => void;
  onGenerate: () => void;
}) {
  const { template, thumb, questions } = card;

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-card transition-colors",
        chosen ? "border-blue-royal" : "border-line hover:border-line-strong",
      )}
    >
      {/* The funnel this card would actually give you. */}
      <div className="border-b border-line bg-card-muted/50 p-2.5">
        <FlowShape thumb={thumb} />
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-start justify-between gap-2">
          <h5 className="min-w-0 text-[12.5px] font-semibold text-navy">{template.label}</h5>
          {chosen ? <StatusPill tone="info">Chosen</StatusPill> : null}
        </div>
        <p className="mt-1 flex-1 text-[11.5px] leading-relaxed text-muted">{template.blurb}</p>
        <p className="mt-1.5 text-[10.5px] text-faint">
          {goalLabel(template.goal)}
          <span className="px-1">·</span>
          {questions} {questions === 1 ? "question" : "questions"}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant={chosen ? "primary" : "secondary"}
            size="sm"
            className="h-7 px-2.5 text-[11.5px]"
            onClick={onUse}
          >
            <PenLine size={12} />
            {chosen ? "Chosen" : "Use this"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            disabled={busy}
            onClick={onGenerate}
          >
            {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Let AI write one
          </Button>
        </div>
      </div>
    </article>
  );
}

/**
 * The miniature. Draws what flow-thumbnail.ts handed it and computes NOTHING -
 * the same split as flow-canvas.tsx, for the same reason.
 *
 * aria-hidden, because the card's name, blurb and question count already say in
 * words what the picture says in shape; a screen reader announcing "diagram"
 * eight times would be noise, not information.
 */
function FlowShape({ thumb }: { thumb: FlowThumbnail }) {
  return (
    // The box takes its shape from the SAME constant the viewBox was fitted to,
    // so the drawing fills it exactly and no card letterboxes its funnel.
    <div className="w-full" style={{ aspectRatio: String(THUMBNAIL_ASPECT) }}>
      <svg
        viewBox={thumb.viewBox}
        className="block h-full w-full"
        aria-hidden="true"
        focusable="false"
      >
        {/* Wires first, so a step always sits on top of the line into it. */}
        {thumb.edges.map((e) => (
          <path
            key={e.index}
            d={e.d}
            fill="none"
            strokeWidth={1}
            style={{ stroke: e.forward ? "var(--line-strong)" : "var(--danger)" }}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {thumb.nodes.map((n) => (
          <rect
            key={n.id}
            x={n.x}
            y={n.y}
            width={n.w}
            height={n.h}
            rx={n.rx}
            style={{ fill: "var(--card)", stroke: NODE_ACCENT[n.kind] }}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
