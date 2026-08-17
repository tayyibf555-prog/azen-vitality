import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Mail,
  MessageSquare,
} from "lucide-react";
import { iconFor } from "@/components/assess/option-icons";
import type { PhoneBlock, PhoneField, PhoneOption, PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";

/**
 * ONE STEP OF A FUNNEL, DRAWN AS THE PHONE SCREEN IT ACTUALLY IS.
 *
 * WHAT THIS IS FOR. The builder's canvas draws cards ABOUT the steps - "Question",
 * "Contact details", "Result · Hot". That is the right drawing while you are
 * WIRING a funnel. It is the wrong drawing while you are CHOOSING one, because
 * the question an owner is answering on stage 2 is "is this the funnel I want
 * attached?", and that is answered by the words a patient reads, not by the shape
 * of the boxes.
 *
 * IT COMPUTES NOTHING AND IT DECIDES NOTHING. Every string on screen arrives
 * finished in a `PhoneScreen` (flow-phone-screen.ts), which resolves it from the
 * graph, the question bank and result-copy.ts, and NOT from describeNode - that
 * one writes for the owner ("Sits above the first question") and drops the option
 * VALUES the icons are chosen by. This file's whole job is classes.
 *
 * STATIC, AND STRUCTURALLY SO. No useState, no useEffect, no fetch, no tracker,
 * and - the one that matters - it does not mount the real quiz components. A live
 * quiz in a preview strip would fire a funnel tracker, POST a submission and
 * answer its own questions on click, ten times over on one screen. Pinned by an
 * import guard in flow-phone-mini.test.ts. There is not one <button> or <input>
 * in here either: a picture of a form must not be tabbable.
 *
 * THE CLASSES ARE THE RUNTIME'S, AT THE RUNTIME'S OWN SCALE. Structure and tokens
 * are copied from deterministic-assessment-quiz.tsx line for line (the glow, the
 * lockup, the progress track, the option row, the tick). The type ramp is the one
 * the deleted assessment-preview.tsx proved at this width: a real phone gives the
 * quiz ~343px of content, a mini gives it ~236px, so every size is that ratio of
 * the real one. It is the same screen at 76%, not a different design.
 *
 * NO COLOUR LITERALS (pinned by flow-phone-mini.test.ts). Every colour is a token,
 * which is what makes the whole strip re-theme live from one paletteVars wrapper
 * in the panel - `text-navy` compiles to `color: var(--navy)` under @theme inline,
 * so re-declaring the token on any ancestor re-paints everything beneath it
 * (palette.ts:5-17). Two deliberate exceptions, both semantic rather than brand:
 * the result tick stays green and a broken step stays amber on every scheme
 * (--success/--warning are excluded from PALETTE_TOKENS on purpose, palette.ts:36).
 */

/** The runtime's own fallback when a practice name is not supplied (:399). */
const DEFAULT_PRACTICE_NAME = "Smile Assessment";

export interface PhoneMiniProps {
  screen: PhoneScreen;
  /**
   * The PRACTICE's name, as the header lockup reads it. Never the campaign's
   * `name` field: that one is an internal source label ("Instagram bio"), and
   * printing it here would put the owner's own filing system on a patient's
   * phone.
   */
  practiceName?: string;
}

export function PhoneMini({ screen, practiceName }: PhoneMiniProps) {
  const name = practiceName?.trim() || DEFAULT_PRACTICE_NAME;

  return (
    // The handset. A nested radius - a wide outer corner with a tighter screen
    // inside it - is the whole reason this reads as a phone rather than as a tall
    // card, and it is the one part of the deleted mockup worth reviving.
    <div className="h-full w-full rounded-[1.75rem] border border-line-strong bg-card p-1.5 shadow-[0_10px_36px_rgba(10,14,26,0.14)]">
      <div className="relative flex h-full flex-col overflow-hidden rounded-[1.5rem] bg-cream px-2.5 pb-3 pt-3.5">
        {/* The promoted glow, with the fallback that makes an unthemed strip and a
            default-themed strip paint identically (palette.ts, ASSESS_GLOW). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-[radial-gradient(58%_70%_at_50%_0%,var(--assess-glow,rgba(91,196,247,0.20)),transparent_72%)]"
        />

        <Lockup name={name} />

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1rem] border border-line bg-card shadow-[0_4px_20px_rgba(10,14,26,0.06)]">
          <Progress percent={screen.progress} />
          {/* overflow-hidden is the containment valve, not a design choice: every
              mini is exactly as tall as the layout said (flow-phone-layout.ts,
              minH), so a screen whose copy runs long clips itself rather than
              spilling over the wire into the row below. A real phone scrolls at
              exactly this point. */}
          <div className="min-h-0 flex-1 overflow-hidden p-2.5">
            <Screen screen={screen} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** deterministic-assessment-quiz.tsx:412-421, compressed. */
function Lockup({ name }: { name: string }) {
  return (
    <div className="relative mb-2 flex items-center justify-center gap-1.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-card shadow-[0_2px_10px_rgba(10,14,26,0.10)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/copilot-logo.png" alt="" width={18} height={18} className="h-[18px] w-[18px] object-contain" />
      </span>
      <div className="leading-tight">
        <p className="text-[0.66rem] font-bold tracking-tight text-navy">{name}</p>
        <p className="text-[0.5rem] font-semibold uppercase tracking-[0.18em] text-blue-deep">
          Smile Assessment
        </p>
      </div>
    </div>
  );
}

/** deterministic-assessment-quiz.tsx:424-432. The width is a finished number. */
function Progress({ percent }: { percent: number }) {
  return (
    <div className="h-1 w-full shrink-0 bg-card-muted" aria-hidden>
      <div className="h-full rounded-r-full bg-blue-dark" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Screen({ screen }: { screen: PhoneScreen }) {
  switch (screen.kind) {
    case "question":
      return (
        <QuestionScreen
          chip={screen.chip}
          canGoBack={screen.canGoBack}
          transition={screen.transition}
          headline={null}
          intro={null}
          hero={false}
          prompt={screen.prompt}
          options={screen.options}
          // A question step carries no furniture and cannot be given any
          // (flow.ts, FLOW_BLOCK_SCREEN_KINDS).
          blocks={NO_BLOCKS}
        />
      );

    case "welcome-question":
      // THE FIRST SCREEN, hero block and all. There is no separate welcome screen
      // and no start button in the runtime - the headline and intro are rendered
      // ABOVE THE FIRST QUESTION'S PROMPT (:515,549-555) - so this is that screen.
      // Drawing a standalone opening screen would be a picture of something the
      // funnel does not have.
      return (
        <QuestionScreen
          chip={screen.chip}
          canGoBack={false}
          transition={null}
          headline={screen.headline}
          intro={screen.intro}
          hero
          prompt={screen.prompt}
          options={screen.options}
          blocks={screen.blocks}
        />
      );

    case "contact":
      return <ContactScreen screen={screen} />;

    case "outcome":
      return <OutcomeScreen headline={screen.headline} body={screen.body} blocks={screen.blocks} />;

    case "error":
      return <BrokenScreen title={screen.title} detail={screen.detail} />;
  }
}

/* ---------------------------------------------------------------------------
 * Question (and the first screen, which is a question with a hero above it).
 * deterministic-assessment-quiz.tsx:530-611.
 * ------------------------------------------------------------------------- */

function QuestionScreen({
  chip,
  canGoBack,
  transition,
  headline,
  intro,
  hero,
  prompt,
  options,
  blocks,
}: {
  chip: string;
  canGoBack: boolean;
  transition: string | null;
  headline: string | null;
  intro: string | null;
  hero: boolean;
  prompt: string;
  options: readonly PhoneOption[];
  blocks: readonly PhoneBlock[];
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        {/* A span holds the chip right when there is nothing to go back to -
            the runtime's own trick (:541-543). */}
        {canGoBack ? (
          <span className="inline-flex items-center gap-0.5 text-[0.55rem] font-semibold text-muted">
            <ArrowLeft size={10} />
            Back
          </span>
        ) : (
          <span />
        )}
        <span className="rounded-full bg-card-muted px-2 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-ink">
          {chip}
        </span>
      </div>

      {hero ? (
        <div className="mb-2 space-y-0.5">
          {headline ? <p className="text-[0.6rem] font-semibold text-navy">{headline}</p> : null}
          <p className="text-[0.6rem] leading-snug text-muted">{intro}</p>
        </div>
      ) : transition ? (
        <p className="mb-2 text-[0.6rem] font-medium leading-snug text-blue-deep">{transition}</p>
      ) : null}

      <p className="mb-2 text-[0.78rem] font-bold leading-snug text-navy [text-wrap:balance]">
        {prompt}
      </p>

      {/* ONE COLUMN, always. The runtime splits into two only from sm: upward
          (:564) - and sm: is a VIEWPORT query, so what decides the split is the
          patient's device, not this mini's 300px width. A patient on a phone -
          the audience this preview depicts - sees one column, so one column is
          what this screen genuinely renders, not a simplification of it. */}
      {/* The grid is allowed to CLIP only when there is furniture under it. A
          screen with none renders the class string it always did, so a funnel
          drawn before A2 draws the mini it always drew (baseline test). With
          furniture, min-h-0 lets the answers give up the room, because the row of
          chips at the bottom is the thing the owner is here to check - and on a
          real phone the answers are what you scroll past to reach it. */}
      <div className={blocks.length > 0 ? "grid min-h-0 gap-1 overflow-hidden" : "grid gap-1"}>
        {options.map((o) => {
          const Icon = iconFor(o.value);
          return (
            <div
              key={o.value}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-1.5 py-1"
            >
              {o.image ? (
                // The real tile, at the icon chip's size. These are the 360x270
                // WebP derivatives (4-5KB), so a strip of ten minis can afford
                // them - which is exactly why a screen PICTURE is a stand-in
                // (flow-phone-screen.ts, PhoneBlock) and an answer tile is not.
                <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-md bg-card-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={o.image.src}
                    alt={o.image.alt}
                    width={o.image.width}
                    height={o.image.height}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                </span>
              ) : (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-blue-dark/10 text-blue-dark">
                  <Icon size={11} strokeWidth={2} />
                </span>
              )}
              <span className="flex-1 text-[0.6rem] font-medium leading-tight text-ink">
                {o.label}
              </span>
              <ChevronRight size={10} className="shrink-0 text-muted/70" aria-hidden />
            </div>
          );
        })}
      </div>

      {/* Pinned to the bottom of the screen, which is also where it is on the
          page: the runtime draws the welcome step's furniture UNDER the answers
          (deterministic-assessment-quiz.tsx, FunnelBlocks). */}
      <BlockRow blocks={blocks} className="mt-auto" />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Content blocks, at 300px. Each line is finished in flow-phone-screen.ts; this
 * is the strip that holds them.
 * ------------------------------------------------------------------------- */

/** A stable empty list, so a screen with no furniture allocates nothing per render. */
const NO_BLOCKS: readonly PhoneBlock[] = [];

/**
 * Renders NOTHING for an empty list - not an empty div, and above all not a
 * border-top. Every funnel on the platform has no furniture today, and each of
 * them must draw the mini it drew before this file grew a block strip.
 */
function BlockRow({ blocks, className }: { blocks: readonly PhoneBlock[]; className?: string }) {
  if (blocks.length === 0) return null;
  return (
    <div className={["shrink-0 space-y-1 border-t border-line pt-1.5", className ?? ""].join(" ").trim()}>
      {blocks.map((block, i) => (
        <BlockLine key={i} block={block} />
      ))}
    </div>
  );
}

function BlockLine({ block }: { block: PhoneBlock }) {
  switch (block.kind) {
    case "trust-strip":
      return (
        <div>
          <p className="text-[0.48rem] font-semibold uppercase tracking-[0.15em] text-blue-deep">
            {block.practiceName}
          </p>
          <div className="mt-0.5 flex flex-wrap gap-0.5">
            {block.chips.map((chip, i) => (
              <span
                key={i}
                className="rounded-full bg-card-muted px-1 py-px text-[0.45rem] font-medium text-ink"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>
      );

    case "testimonial":
      // Two lines and then an ellipsis: the quote is up to 240 characters and the
      // whole screen is 470px tall. Clamped rather than truncated in the model,
      // because the model must carry the words the practice actually holds.
      return <p className="line-clamp-2 text-[0.5rem] leading-snug text-muted">{block.line}</p>;

    case "faq":
      return <p className="text-[0.5rem] font-medium leading-snug text-ink">{block.line}</p>;

    case "image":
      // A STAND-IN, on purpose, exactly like FauxField below: the screen pictures
      // are 1000px heroes and a strip renders ten minis at once. The plate says
      // "a picture goes here" and the caption says which one, which is what an
      // owner is checking at this size.
      return (
        <div className="flex items-center gap-1">
          <span className="h-4 w-5 shrink-0 rounded-sm border border-line bg-card-muted" aria-hidden />
          <p className="line-clamp-1 text-[0.5rem] leading-snug text-muted">{block.alt}</p>
        </div>
      );

    case "booking":
      // THE BOOKING INVITATION (C1), drawn as what it is: the button, its line,
      // and a stand-in row of times for the calendar that opens behind it.
      //
      // THE CHIPS ARE PLATES, NOT TIMES, and that is the honest drawing. The real
      // screen shows LIVE availability read from the practice diary; a mini that
      // printed "9:00  9:30  10:00" would be inventing appointments that may not
      // exist, on a preview an owner is using to decide what to publish. Blank
      // plates say "a row of times goes here" without claiming which.
      //
      // The button is a <span>, like every other control in this file: a picture
      // of a form must not be tabbable, and this one would open a real calendar.
      //
      // bg-blue-royal, like the contact step's submit below and unlike every other
      // block here: on the real screen this is a <Button variant="primary">, and
      // the mini's whole contract is that it is that screen at 76%.
      return (
        <div className="space-y-1">
          <span className="flex items-center justify-center gap-1 rounded-lg bg-blue-royal px-1.5 py-1 text-[0.55rem] font-semibold text-white">
            <CalendarDays size={10} aria-hidden />
            <span className="line-clamp-1">{block.headline}</span>
          </span>
          <p className="line-clamp-2 text-[0.5rem] leading-snug text-muted">{block.blurb}</p>
          <div className="flex gap-0.5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 flex-1 rounded-sm border border-line bg-card-muted" />
            ))}
          </div>
        </div>
      );
  }
}

/* ---------------------------------------------------------------------------
 * Contact. deterministic-assessment-quiz.tsx:697-796.
 * ------------------------------------------------------------------------- */

const CHANNEL_ICONS = [MessageSquare, Mail];

function ContactScreen({ screen }: { screen: Extract<PhoneScreen, { kind: "contact" }> }) {
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-start gap-1.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-dark/10 text-blue-dark">
          <CheckCircle2 size={14} />
        </span>
        <div className="space-y-0.5">
          <p className="text-[0.5rem] font-semibold uppercase tracking-[0.15em] text-blue-deep">
            {screen.eyebrow}
          </p>
          <p className="text-[0.78rem] leading-tight text-navy [text-wrap:balance]">
            {screen.heading}
          </p>
        </div>
      </div>

      <p className="text-[0.55rem] leading-snug text-muted">{screen.helper}</p>

      <FauxField field={screen.nameField} />

      <div>
        <p className="mb-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-muted">
          {screen.channelLegend}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {screen.channels.map((c, i) => {
            const Icon = CHANNEL_ICONS[i] ?? MessageSquare;
            // The FIRST one is lit, because that is the one the runtime opens on
            // - and it is why the address input below is the mobile one rather
            // than the email one. A static picture shows the screen as it arrives.
            const active = i === 0;
            return (
              <span
                key={c.key}
                className={[
                  "flex items-center justify-center gap-1 rounded-lg border px-1.5 py-1 text-[0.55rem] font-semibold",
                  active
                    ? "border-blue-dark bg-blue-dark/[0.08] text-blue-deep"
                    : "border-line bg-card text-muted",
                ].join(" ")}
              >
                <Icon size={11} />
                {c.label}
              </span>
            );
          })}
        </div>
      </div>

      <FauxField field={screen.addressField} />

      {/* The submit, as a SPAN. Mirrors Button variant="primary" (bg-blue-royal,
          white ink) rather than mounting it: a preview must have nothing to
          press, and a real button in here would be a tab stop on a picture. */}
      <span className="mt-auto block rounded-lg bg-blue-royal px-2 py-1.5 text-center text-[0.62rem] font-semibold text-white">
        {screen.submitLabel}
      </span>
      <p className="text-center text-[0.5rem] leading-snug text-muted">{screen.consent}</p>
    </div>
  );
}

/**
 * An input, drawn rather than rendered. `field.type` is deliberately unused: it
 * says what the REAL control is, and the moment this file honours it by emitting
 * <input type={...}> the preview grows a focusable, typeable form.
 */
function FauxField({ field }: { field: PhoneField }) {
  return (
    <div>
      <p className="mb-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-muted">
        {field.label}
      </p>
      <span className="block h-[1.6rem] w-full rounded-md border border-line-strong bg-card" />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Result. deterministic-assessment-quiz.tsx:805-822.
 * ------------------------------------------------------------------------- */

function OutcomeScreen({
  headline,
  body,
  blocks,
}: {
  headline: string;
  body: string;
  blocks: readonly PhoneBlock[];
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      {/* Green on every scheme, on purpose: --success is semantic, not brand, and
          is excluded from PALETTE_TOKENS (palette.ts:36-39). */}
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={18} />
      </span>
      <p className="text-[0.85rem] leading-tight text-navy [text-wrap:balance]">{headline}</p>
      <p className="text-[0.6rem] leading-snug text-muted">{body}</p>
      {/* Under the result copy, which is where the runtime puts it (ThankYou),
          and left-aligned because a wrapped chip row set centre-ragged is a mess. */}
      <BlockRow blocks={blocks} className="w-full text-left" />
    </div>
  );
}

/**
 * A step that cannot be drawn, drawn LOUDLY. The alternative is a blank phone in
 * the middle of the strip and no clue which step the validation banner means.
 * Amber rather than a themed colour for the same reason the tick is green.
 */
function BrokenScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-amber text-status-amber">
        <AlertTriangle size={18} />
      </span>
      <p className="text-[0.72rem] font-semibold leading-tight text-navy">{title}</p>
      <p className="text-[0.58rem] leading-snug text-muted">{detail}</p>
    </div>
  );
}
