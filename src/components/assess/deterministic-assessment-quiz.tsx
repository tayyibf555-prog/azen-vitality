"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  CheckCircle2,
  ArrowLeft,
  ChevronRight,
  MessageSquare,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIRST_QUESTION_ID, questionById } from "@/lib/smile-assessment/quiz";
import { resultCopy } from "@/lib/smile-assessment/result-copy";
import { outcomeNodeFor, walkFlow, welcomeNode } from "@/lib/smile-assessment/flow-runtime";
import {
  blockViews,
  optionImageViews,
  type BlockView,
  type ImageView,
} from "@/lib/smile-assessment/flow-block-view";
import type { PublicFlow } from "@/lib/smile-assessment/campaign";
import { createFunnelTracker, type FunnelTracker } from "@/lib/funnel/client";
import { FunnelBlocks } from "./funnel-blocks";
import { iconFor } from "./option-icons";

// The DETERMINISTIC Smile Assessment funnel: the same screens as the Classic
// quiz, but the next question comes from the funnel the practice DREW rather than
// from the model. No /next call, no per-step wait, and the same path for every
// patient who answers the same way.
//
// WHY THIS IS A SEPARATE COMPONENT, like GuidedAssessmentQuiz before it.
// AssessmentQuiz dispatches at the MOUNT BOUNDARY (assessment-quiz.tsx:133-152)
// because ClassicAssessmentQuiz calls its hooks unconditionally: a mode branch
// has to decide WHICH component mounts, never return early inside one that has
// already started calling hooks. Duplicating the contact and thank-you screens is
// the price, and it is deliberately paid: Classic's tested path is left untouched.
//
// THE ADAPTIVE FUNNEL IS THE FALLBACK, HERE TOO. The page only serves a flow that
// re-validated on read, so `walkFlow` should never fail. If it does anyway - a
// funnel edited underneath a loaded page, a graph that reached the runtime some
// other way - this component does NOT strand the patient and does NOT skip to the
// contact step. Skipping is the dangerous one: the submission would be missing
// core questions, scoring.ts:98-105 would cap the band at "medium", and the
// practice would silently get no fast-tracked leads (submit/route.ts:291). So it
// degrades to the adaptive funnel mid-session instead, asking
// /api/smile-assessment/next from the answers it already has. The patient sees a
// working quiz either way; the console says what happened.
//
// This is a client component: it imports only pure quiz data + fetch, never a
// server-only module. flow-runtime.ts imports nothing but flow.ts by design, so
// the walk carries no scoring weights into the browser, and `flow.questions`
// arrives already stripped to { id, prompt, options: [{ value, label }] } by
// toPublicFlow (campaign.ts).

type Channel = "sms" | "email" | "whatsapp";
type Phase = "question" | "contact" | "thanks";
/** "flow" walks the authored funnel; "adaptive" is the degraded fallback above. */
type Mode = "flow" | "adaptive";

interface FunnelQuestion {
  id: string;
  prompt: string;
  options: { value: string; label: string }[];
}

interface Step {
  question: FunnelQuestion;
  /** The warm lead-in above this question (absent on the first screen). */
  transition?: string;
  /**
   * The answer-card pictures for THIS step, keyed by option value, or absent when
   * the step has none - which is every step of every funnel drawn before A2, and
   * the degraded adaptive path, which routes by the bank alone and has no node to
   * read a picture off.
   *
   * Per-STEP rather than per-question because the pictures hang off the node
   * (flow.ts, FlowOptionImage): the same bank question can appear on two branches
   * wearing different art, and `flow.questions` is per-question by construction.
   */
  images?: ReadonlyMap<string, ImageView>;
}

interface NextResponse {
  ok?: boolean;
  done?: boolean;
  question?: { id?: unknown; prompt?: unknown; options?: unknown };
  transition?: unknown;
  step?: unknown;
}

interface SubmitResult {
  band: "high" | "medium" | "low";
  leadCreated: boolean;
  bookingUrl?: string;
}

interface Props {
  clientSlug: string;
  campaignSlug?: string;
  headline?: string | null;
  intro?: string | null;
  practiceName?: string;
  /** The authored funnel, already validated and stripped server-side. */
  flow: PublicFlow;
  /**
   * True only for the internal admin live-preview iframe (?preview=1). The funnel
   * tracker no-ops and the final submit is disabled, so an owner clicking through
   * a preview can never record a real enquiry or fire a real text. Honoured here
   * exactly as ClassicAssessmentQuiz honours it (assessment-quiz.tsx:89-96, 320).
   */
  previewMode?: boolean;
}

/** The bank's opening question, for the degraded path only. */
function bankFirstStep(): Step {
  const q = questionById(FIRST_QUESTION_ID);
  if (!q) {
    return { question: { id: FIRST_QUESTION_ID, prompt: "What are you most interested in?", options: [] } };
  }
  return {
    question: { id: q.id, prompt: q.prompt, options: q.options.map((o) => ({ value: o.value, label: o.label })) },
  };
}

/** Coerce a /next response question into a FunnelQuestion, or null if invalid. */
function parseQuestion(raw: NextResponse["question"]): FunnelQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { id?: unknown; prompt?: unknown; options?: unknown };
  if (typeof r.id !== "string" || typeof r.prompt !== "string" || !Array.isArray(r.options)) return null;
  const options: { value: string; label: string }[] = [];
  for (const o of r.options) {
    if (o && typeof o === "object") {
      const oo = o as { value?: unknown; label?: unknown };
      if (typeof oo.value === "string" && typeof oo.label === "string") {
        options.push({ value: oo.value, label: oo.label });
      }
    }
  }
  if (options.length === 0) return null;
  return { id: r.id, prompt: r.prompt, options };
}

export function DeterministicAssessmentQuiz({
  clientSlug,
  campaignSlug,
  headline,
  intro,
  practiceName,
  flow,
  previewMode,
}: Props) {
  // The question wording, by id. Built once: the funnel only ever asks questions
  // that are in here, because toPublicFlow refuses to build a payload otherwise.
  const questions = useMemo(
    () => new Map(flow.questions.map((q) => [q.id, q] as const)),
    [flow.questions],
  );

  /** The graph's next demand, given some answers, in screen terms. */
  function stepFor(answers: Record<string, string>): Step | "contact" | "stuck" {
    const walk = walkFlow(flow.graph, answers);
    if (walk.status === "contact") return "contact";
    if (walk.status === "stuck") {
      console.warn(`[assess] funnel could not route this session: ${walk.reason}`);
      return "stuck";
    }
    const q = questions.get(walk.node.questionId);
    if (!q) {
      console.warn(`[assess] funnel asks for "${walk.node.questionId}", which was not published with it`);
      return "stuck";
    }
    // Absent rather than an empty Map when the step has no art: a funnel with no
    // pictures must render the answer rows it rendered before A2, and the
    // difference between "no images" and "an empty images map" is what decides it.
    const images = optionImageViews(walk.node);
    const step: Step = { question: q, transition: walk.transition ?? undefined };
    if (images.size > 0) step.images = images;
    return step;
  }

  // The funnel's own opening screen. Computed once, at mount, and it decides which
  // mode this session runs in.
  const [opening] = useState<{ mode: Mode; step: Step }>(() => {
    const first = stepFor({});
    if (first === "contact" || first === "stuck") {
      // A funnel that wants nothing, or cannot start, is not a funnel. Say so and
      // run the adaptive quiz, which always works.
      console.warn("[assess] falling back to the adaptive funnel for this session");
      return { mode: "adaptive", step: bankFirstStep() };
    }
    return { mode: "flow", step: first };
  });

  const [mode, setMode] = useState<Mode>(opening.mode);
  const [history, setHistory] = useState<Step[]>(() => [opening.step]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>("question");
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const [animKey, setAnimKey] = useState(0);
  const advancing = useRef(false);

  // PII-free funnel telemetry, gated exactly as Classic gates it: previewMode gets
  // a no-op tracker, never the real one, so an owner clicking through the inline
  // preview emits nothing.
  const [tracker] = useState<FunnelTracker>(() =>
    previewMode
      ? { track: () => {}, flush: () => {} }
      : createFunnelTracker({ surface: "assessment", clientSlug, campaignSlug }),
  );
  useEffect(() => {
    tracker.track("started");
  }, [tracker]);

  const current = history[history.length - 1];
  const step = history.length;

  // The funnel's own opening copy wins over the campaign's when it has any. A
  // welcome node is an OVERRIDE of the hero line, not a separate screen: the
  // campaign already owns a headline and an intro, and two sources of the same
  // words on one screen is how they end up contradicting each other.
  const welcome = useMemo(() => welcomeNode(flow.graph), [flow.graph]);
  const heroHeadline = welcome?.headline ?? headline;
  const heroIntro = welcome?.intro ?? intro;

  // The welcome step's furniture, drawn UNDER the first screen's answers - the
  // same place the hero copy's screen is, because there is no separate welcome
  // screen in this runtime (see the note on heroHeadline above). Empty for a
  // funnel that opens straight on a question: a question node cannot carry blocks
  // (flow.ts, FLOW_BLOCK_SCREEN_KINDS), so there is nothing to draw.
  const welcomeBlocks = useMemo(() => (welcome ? blockViews(welcome) : []), [welcome]);

  const progress = useMemo(() => {
    if (phase === "question") return Math.min(0.9, step / 6) * 100;
    return 100;
  }, [phase, step]);

  const canSubmit = useMemo(() => {
    if (firstName.trim() === "") return false;
    if (channel === "email") return email.trim() !== "";
    return phone.trim() !== "";
  }, [firstName, channel, email, phone]);

  function goToContact() {
    setThinking(false);
    setPendingValue(null);
    advancing.current = false;
    setPhase("contact");
    setAnimKey((k) => k + 1);
    tracker.track("contact_viewed");
  }

  function showStep(next: Step) {
    setHistory((prev) => [...prev, next]);
    setPendingValue(null);
    setThinking(false);
    advancing.current = false;
    setAnimKey((k) => k + 1);
  }

  /** Record the answer, then take whichever route this session is running on. */
  async function choose(value: string) {
    if (advancing.current || thinking || busy) return;
    advancing.current = true;
    // The question INDEX only, never the answer itself.
    tracker.track("question_answered", { index: history.length });
    const nextAnswers = { ...answers, [current.question.id]: value };

    setPendingValue(value);
    setAnswers(nextAnswers);
    setError(null);

    if (mode === "flow") {
      const next = stepFor(nextAnswers);
      if (next === "contact") {
        goToContact();
        return;
      }
      if (next !== "stuck") {
        // No network call at all: this is the whole point of a drawn funnel.
        showStep(next);
        return;
      }
      // Degrade rather than strand or skip. See the header.
      setMode("adaptive");
    }

    setThinking(true);
    const got = await fetchNext(nextAnswers);
    if (got === "error" || got.done) {
      goToContact();
      return;
    }
    showStep({ question: got.question, transition: got.transition });
  }

  /** POST /next with one retry. The degraded path only. */
  async function fetchNext(
    nextAnswers: Record<string, string>,
  ): Promise<{ done: true } | { done: false; question: FunnelQuestion; transition?: string } | "error"> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/smile-assessment/next", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientSlug,
            campaignSlug: campaignSlug || undefined,
            answers: nextAnswers,
          }),
        });
        const data = (await res.json().catch(() => null)) as NextResponse | null;
        if (!res.ok || !data?.ok) {
          if (attempt === 0) continue;
          return "error";
        }
        if (data.done) return { done: true };
        const question = parseQuestion(data.question);
        if (!question) return { done: true };
        const transition = typeof data.transition === "string" ? data.transition : undefined;
        return { done: false, question, transition };
      } catch {
        if (attempt === 0) continue;
        return "error";
      }
    }
    return "error";
  }

  /** Step back one question: drop the live question and re-show the previous. */
  function back() {
    if (history.length <= 1 || thinking || busy) return;
    const previous = history[history.length - 2];
    setHistory((prev) => prev.slice(0, -1));
    setAnswers((prev) => {
      const copy = { ...prev };
      delete copy[previous.question.id];
      return copy;
    });
    setPendingValue(null);
    setError(null);
    advancing.current = false;
    setAnimKey((k) => k + 1);
  }

  /** From the contact step, go back to the last question we asked. */
  function backFromContact() {
    if (busy) return;
    const last = history[history.length - 1];
    setAnswers((prev) => {
      const copy = { ...prev };
      delete copy[last.question.id];
      return copy;
    });
    setPendingValue(null);
    setError(null);
    setPhase("question");
    setAnimKey((k) => k + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // previewMode is also enforced by disabling the button below; this is defence
    // in depth (an implicit Enter-key form submit).
    if (!canSubmit || busy || previewMode) return;
    setBusy(true);
    setError(null);
    try {
      const pageToken = await fetch(`/api/smile-assessment/token?client=${encodeURIComponent(clientSlug)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { token?: string | null } | null) => j?.token ?? undefined)
        .catch(() => undefined);
      const res = await fetch("/api/smile-assessment/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          campaignSlug: campaignSlug || undefined,
          firstName: firstName.trim(),
          channel,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          responses: answers,
          pageToken,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; band?: string; message?: string; error?: string; bookingUrl?: unknown; leadCreated?: unknown }
        | null;
      if (!res.ok || !data?.ok || !data.band || !data.message) {
        setError(
          data?.error === "too many submissions from this contact, please try again later" ||
            data?.error === "too many submissions, please try again later"
            ? "Thanks, we've already got your details from a moment ago. If you'd like to speak to us sooner, please get in touch with the practice directly."
            : "Sorry, something went wrong. Please try again in a moment.",
        );
        setBusy(false);
        return;
      }
      setResult({
        band: data.band as SubmitResult["band"],
        leadCreated: data.leadCreated === true,
        bookingUrl: typeof data.bookingUrl === "string" && data.bookingUrl ? data.bookingUrl : undefined,
      });
      setPhase("thanks");
      tracker.track("submitted", { band: data.band });
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  // The authored result heading for the band we actually got. Only the HEADING:
  // the body stays resultCopy(), which is derived from band + leadCreated +
  // bookingUrl, so nothing here can promise a callback that is not going to happen.
  const outcome = result ? outcomeNodeFor(flow.graph, result.band) : null;
  const outcomeHeadline = outcome?.headline ?? null;
  // The result step's own furniture, for the band this patient actually got. Read
  // off the SAME node the headline came from, so a practice cannot end up with the
  // hot screen's headline above the cold screen's reassurance.
  const outcomeBlocks = outcome ? blockViews(outcome) : [];

  const name = practiceName?.trim() || "Smile Assessment";

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-4 sm:px-5 sm:py-8">
      <style>{ENTER_KEYFRAMES}</style>

      {/* The same promoted glow as the classic quiz, with the same load-bearing
          fallback — see assessment-quiz.tsx and src/lib/assess/palette.ts. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,var(--assess-glow,rgba(91,196,247,0.20)),transparent_72%)]"
      />

      <header className="mb-3 flex items-center justify-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-card shadow-[0_2px_10px_rgba(10,14,26,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/copilot-logo.png" alt={`${name} logo`} width={26} height={26} className="h-[26px] w-[26px] object-contain" />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight text-navy">{name}</p>
          <p className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-blue-deep">Smile Assessment</p>
        </div>
      </header>

      <div className="overflow-hidden rounded-[1.25rem] border border-line bg-card shadow-[0_8px_40px_rgba(10,14,26,0.08)]">
        <div className="h-1 w-full bg-card-muted" aria-hidden>
          <div
            className={[
              "h-full rounded-r-full bg-blue-dark transition-[width] duration-300 ease-out",
              thinking ? "motion-safe:animate-pulse" : "",
            ].join(" ")}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="p-5 sm:p-6">
          {phase === "thanks" && result ? (
            <ThankYou result={result} outcomeHeadline={outcomeHeadline} blocks={outcomeBlocks} />
          ) : phase === "contact" ? (
            <ContactStep
              animKey={animKey}
              firstName={firstName}
              setFirstName={setFirstName}
              channel={channel}
              setChannel={setChannel}
              phone={phone}
              setPhone={setPhone}
              email={email}
              setEmail={setEmail}
              canSubmit={canSubmit}
              busy={busy}
              error={error}
              previewMode={previewMode}
              onSubmit={submit}
              onBack={backFromContact}
            />
          ) : (
            <QuestionStep
              animKey={animKey}
              step={step}
              question={current.question}
              transition={current.transition}
              images={current.images}
              blocks={welcomeBlocks}
              headline={heroHeadline}
              intro={heroIntro}
              answers={answers}
              pendingValue={pendingValue}
              thinking={thinking}
              canGoBack={history.length > 1}
              onChoose={choose}
              onBack={back}
            />
          )}
        </div>
      </div>

      {/* GDC/ASA-safe trust + the required suitability line. Never testimonials. */}
      <p className="mt-3 px-2 text-center text-[0.65rem] leading-relaxed text-ink">
        Your answers help us point you to the right next step; nothing here is medical advice. Our
        dentists are GDC registered and treatment suitability always depends on a clinical
        assessment.
      </p>
    </main>
  );
}

/* ---------------------------------------------------------------------------
 * Question screen
 * ------------------------------------------------------------------------- */

function QuestionStep({
  animKey,
  step,
  question,
  transition,
  images,
  blocks,
  headline,
  intro,
  answers,
  pendingValue,
  thinking,
  canGoBack,
  onChoose,
  onBack,
}: {
  animKey: number;
  step: number;
  question: FunnelQuestion;
  transition?: string;
  /** Answer-card pictures for this step, keyed by option value. Usually absent. */
  images?: ReadonlyMap<string, ImageView>;
  /** The welcome step's furniture. Drawn on the FIRST screen only, under the answers. */
  blocks: readonly BlockView[];
  headline?: string | null;
  intro?: string | null;
  answers: Record<string, string>;
  pendingValue: string | null;
  thinking: boolean;
  canGoBack: boolean;
  onChoose: (value: string) => void;
  onBack: () => void;
}) {
  const isFirst = step === 1;
  const selected = pendingValue ?? answers[question.id] ?? null;
  // ONE STEP, ONE SHAPE. As soon as any answer on this step has a picture, every
  // answer on it is drawn as a card, so a question with art on three of eight
  // options is not half a list and half a gallery. A step with no art at all keeps
  // the row layout exactly as it shipped - the branch below is what makes that
  // byte-identical rather than merely similar.
  const cards = (images?.size ?? 0) > 0;

  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step > 1) regionRef.current?.focus();
  }, [step]);

  return (
    <div
      key={animKey}
      ref={regionRef}
      tabIndex={-1}
      className="outline-none motion-safe:[animation:assessEnter_240ms_ease-out]"
    >
      <div className="mb-3 flex items-center justify-between">
        {canGoBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={thinking}
            className="-mx-2 -my-2.5 inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
          >
            <ArrowLeft size={14} />
            Back
          </button>
        ) : (
          <span />
        )}
        <span className="rounded-full bg-card-muted px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink">
          {step >= 3 ? `Question ${step} · nearly there` : `Question ${step}`}
        </span>
      </div>

      {isFirst ? (
        <div className="mb-3 space-y-1">
          {headline ? <p className="text-[0.8rem] font-semibold text-navy">{headline}</p> : null}
          <p className="text-[0.8rem] leading-snug text-muted">
            {intro || "Find the right next step for your smile. About 30 seconds, no wrong answers."}
          </p>
        </div>
      ) : transition ? (
        <p className="mb-3 text-[0.8rem] font-medium leading-snug text-blue-deep">{transition}</p>
      ) : null}

      <fieldset disabled={thinking}>
        <legend className="mb-3 text-lg font-bold leading-snug text-navy [text-wrap:balance] sm:text-xl">
          {question.prompt}
        </legend>
        <div
          className={
            cards
              ? // Two up, at every width. A picture card is square-ish, and one
                // per row on a phone would put the second answer below the fold.
                "grid grid-cols-2 gap-2"
              : ["grid gap-2", question.options.length > 3 ? "sm:grid-cols-2" : ""].join(" ")
          }
        >
          {question.options.map((o) => {
            const checked = selected === o.value;
            const Icon = iconFor(o.value);
            const image = images?.get(o.value) ?? null;

            // AN ANSWER AS AN IMAGE CARD: the picture on top, the answer's own
            // words under it. SAME CONTROL, SAME SEMANTICS - the same <button
            // aria-pressed> firing the same onChoose, so the keyboard, the
            // screen-reader announcement, the selected state and the pending
            // spinner are unchanged. A picture is a bigger target, not a
            // different interaction.
            //
            // AN ANSWER WITH NO PICTURE KEEPS ITS ICON, exactly as the Guided
            // style handles the same gap (guided-assessment-quiz.tsx:601-628): a
            // card with a hole where the art should be reads as broken, while the
            // icon chip reads as an answer that did not need a photograph. That is
            // what lets an owner picture the answers worth picturing and leave
            // "I'm not sure" alone (rule 14 allows exactly the last one bare).
            //
            // NO CHEVRON. On a row it points along the reading direction; under a
            // label it would point at nothing. The tick and the spinner stay, in a
            // reserved slot, so choosing does not resize the grid under a thumb.
            if (cards) {
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => onChoose(o.value)}
                  disabled={thinking}
                  className={[
                    "group flex min-h-28 flex-col items-center gap-2 rounded-xl border px-2 py-2.5 text-center transition duration-150 ease-out",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                    checked
                      ? "border-blue-dark bg-blue-dark/[0.08] shadow-[0_3px_14px_rgba(43,138,192,0.14)]"
                      : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                    thinking ? "cursor-default" : "cursor-pointer",
                  ].join(" ")}
                >
                  {image ? (
                    // width/height are the asset's intrinsic size, so the grid is
                    // the right shape before the lazy tile lands and no card jumps.
                    <span
                      className={[
                        "block w-full overflow-hidden rounded-lg bg-card-muted ring-1 transition-colors",
                        checked ? "ring-blue-dark/40" : "ring-transparent",
                      ].join(" ")}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={image.src}
                        alt={image.alt}
                        width={image.width}
                        height={image.height}
                        loading="lazy"
                        decoding="async"
                        className="h-auto w-full object-cover"
                      />
                    </span>
                  ) : (
                    <span
                      className={[
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                        checked
                          ? "bg-blue-dark text-white"
                          : "bg-blue-dark/10 text-blue-dark group-hover:bg-blue-dark/15",
                      ].join(" ")}
                      aria-hidden
                    >
                      <Icon size={16} strokeWidth={2} />
                    </span>
                  )}
                  <span className={["text-sm font-medium leading-snug", checked ? "text-navy" : "text-ink"].join(" ")}>
                    {o.label}
                  </span>
                  <span className="mt-auto flex h-4 shrink-0 items-center" aria-hidden>
                    {checked && thinking ? (
                      <Loader2 size={16} className="text-blue-dark motion-safe:animate-spin" />
                    ) : checked ? (
                      <CheckCircle2 size={16} className="text-blue-dark" />
                    ) : null}
                  </span>
                </button>
              );
            }

            // THE ROW, UNCHANGED. Every class, every icon and the order they are
            // in are what shipped before A2 - which is what makes a funnel with no
            // answer pictures render the page it rendered before, down to the byte
            // (funnel-blocks.test.ts holds it against a captured baseline).
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={checked}
                onClick={() => onChoose(o.value)}
                disabled={thinking}
                className={[
                  "group flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2 text-left transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  checked
                    ? "border-blue-dark bg-blue-dark/[0.08] shadow-[0_3px_14px_rgba(43,138,192,0.14)]"
                    : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                  thinking ? "cursor-default" : "cursor-pointer",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                    checked
                      ? "bg-blue-dark text-white"
                      : "bg-blue-dark/10 text-blue-dark group-hover:bg-blue-dark/15",
                  ].join(" ")}
                  aria-hidden
                >
                  <Icon size={16} strokeWidth={2} />
                </span>
                <span className={["flex-1 text-sm font-medium leading-snug", checked ? "text-navy" : "text-ink"].join(" ")}>
                  {o.label}
                </span>
                <span className="shrink-0" aria-hidden>
                  {checked && thinking ? (
                    <Loader2 size={16} className="text-blue-dark motion-safe:animate-spin" />
                  ) : checked ? (
                    <CheckCircle2 size={16} className="text-blue-dark" />
                  ) : (
                    <ChevronRight size={15} className="text-muted/70 transition-colors group-hover:text-blue-dark" />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* The welcome step's furniture, under the answers and on the first screen
          only - the same screen its headline and intro are on, because that is the
          only screen a welcome step has (see the hero block above). Renders
          nothing at all when there is none. */}
      {isFirst ? <FunnelBlocks blocks={blocks} /> : null}

      {/* Only ever shown on the degraded path: a drawn funnel has nothing to wait
          for, so the next screen is already there. */}
      {thinking ? (
        <div aria-hidden className="mt-4 space-y-2 motion-safe:animate-pulse">
          <div className="h-4 w-2/3 rounded-md bg-card-muted" />
          <div className="h-10 rounded-xl border border-line bg-card-muted/60" />
          <div className="h-10 rounded-xl border border-line bg-card-muted/40" />
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {thinking ? "Loading the next question" : ""}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Contact screen
 * ------------------------------------------------------------------------- */

function ContactStep({
  animKey,
  firstName,
  setFirstName,
  channel,
  setChannel,
  phone,
  setPhone,
  email,
  setEmail,
  canSubmit,
  busy,
  error,
  previewMode,
  onSubmit,
  onBack,
}: {
  animKey: number;
  firstName: string;
  setFirstName: (v: string) => void;
  channel: Channel;
  setChannel: (c: Channel) => void;
  phone: string;
  setPhone: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  canSubmit: boolean;
  busy: boolean;
  error: string | null;
  previewMode?: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  // WhatsApp stays hidden until the practice's sender is connected: offering it
  // would promise a channel we cannot yet send on.
  const channels: { key: Channel; label: string; icon: LucideIcon }[] = [
    { key: "sms", label: "Text", icon: MessageSquare },
    { key: "email", label: "Email", icon: Mail },
  ];

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.focus();
  }, []);

  return (
    <form
      key={animKey}
      ref={formRef}
      tabIndex={-1}
      aria-labelledby="assess-contact-heading"
      onSubmit={onSubmit}
      className="space-y-3 outline-none motion-safe:[animation:assessEnter_240ms_ease-out]"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="-mx-2 -my-2.5 inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-dark/10 text-blue-dark">
          <CheckCircle2 size={18} />
        </span>
        <div className="space-y-0.5">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-blue-deep">
            Your assessment is ready
          </p>
          <h2 id="assess-contact-heading" className="text-lg leading-tight text-navy [text-wrap:balance]">
            Where should we send your tailored next step?
          </h2>
          <p className="text-xs leading-snug text-muted">
            You&apos;ll get a recommendation for your goal and the soonest time we can see you.
            We&apos;ll only use this to follow up about your enquiry.
          </p>
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">First name</span>
        <input
          type="text"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
        />
      </label>

      <fieldset>
        <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          How would you like us to reply?
        </legend>
        <div className={["grid gap-2", channels.length === 3 ? "grid-cols-3" : "grid-cols-2"].join(" ")}>
          {channels.map((c) => {
            const active = channel === c.key;
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setChannel(c.key)}
                aria-pressed={active}
                className={[
                  "flex min-h-12 items-center justify-center gap-2 rounded-xl border px-2 py-2 text-xs font-semibold transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  active
                    ? "border-blue-dark bg-blue-dark/[0.08] text-blue-deep shadow-[0_3px_14px_rgba(43,138,192,0.12)]"
                    : "border-line bg-card text-muted hover:border-blue-dark/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                ].join(" ")}
              >
                <Icon size={16} />
                {c.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {channel === "email" ? (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
          />
        </label>
      ) : (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Mobile number</span>
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
          />
        </label>
      )}

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]">{error}</p>
      ) : null}

      <Button type="submit" variant="primary" className="min-h-12 w-full" disabled={!canSubmit || busy || previewMode}>
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        See my next step
      </Button>
      {previewMode ? (
        <p className="text-center text-[0.7rem] font-semibold leading-snug text-blue-deep">
          Preview mode. Submissions are disabled here.
        </p>
      ) : (
        <p className="text-center text-[0.7rem] leading-snug text-muted">
          By sending this you agree we can contact you about your enquiry.
        </p>
      )}
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Thank-you screen
 * ------------------------------------------------------------------------- */

function ThankYou({
  result,
  outcomeHeadline,
  blocks,
}: {
  result: SubmitResult;
  outcomeHeadline: string | null;
  /** This band's result step's furniture. Empty for a funnel that has none. */
  blocks: readonly BlockView[];
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center motion-safe:[animation:assessEnter_240ms_ease-out]">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <h1 className="text-xl text-navy [text-wrap:balance]">{outcomeHeadline || "Thank you"}</h1>
      <p className="max-w-sm text-sm text-muted">
        {resultCopy(result.band, result.leadCreated, Boolean(result.bookingUrl))}
      </p>
      {result.bookingUrl ? (
        <Button asChild variant="primary" className="w-full sm:w-auto">
          <a href={result.bookingUrl}>Book your appointment now</a>
        </Button>
      ) : null}
      {/* BELOW the booking button on purpose. The button is the next step this
          patient was just promised; furniture that pushed it down the screen would
          be reassurance getting in the way of the thing it is reassuring them
          about. Left-aligned inside a centred column, because a wrapped FAQ answer
          set centre-ragged is unreadable. */}
      <FunnelBlocks blocks={blocks} className="w-full text-left" />
    </div>
  );
}

const ENTER_KEYFRAMES = `@keyframes assessEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
