"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, CheckCircle2, ArrowLeft, ChevronRight, MessageSquare, Mail, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FIRST_QUESTION_ID, questionById, Q_TREATMENT } from "@/lib/smile-assessment/quiz";
import { MAX_QUESTIONS } from "@/lib/smile-assessment/funnel";
import { resultCopy } from "@/lib/smile-assessment/result-copy";
import { createFunnelTracker, type FunnelTracker } from "@/lib/funnel/client";
import { metaSubmitFields, trackMetaLead } from "@/lib/assess/meta-pixel-consent";
import { findTreatment } from "@/lib/treatments/catalog";
import { iconFor } from "./option-icons";
import {
  imageFor,
  imageAltFor,
  heroFor,
  OPTION_IMAGE_WIDTH,
  OPTION_IMAGE_HEIGHT,
} from "./option-images";

// The premium "Guided" Smile Assessment style: one question per screen inside a
// white card floating on a navy -> royal Vitality gradient, a real progress bar,
// big tappable tiles (a 3D-model render where option-images.ts has one for that
// question + option, an icon chip otherwise), and a RESULTS REVEAL screen (treatment + a couple of
// factual, catalogue-sourced chips) BEFORE the contact form, instead of asking
// for contact details up front. Rendered by AssessmentQuiz when style="guided";
// never mounted on its own.
//
// This intentionally DUPLICATES a small amount of pure plumbing from
// assessment-quiz.tsx (FunnelQuestion/Step parsing, the /next fetch-with-retry)
// rather than importing it, so Classic's tested code path is never touched by
// Guided-only changes. Both talk to the exact same public endpoints
// (/api/smile-assessment/next, /token, /submit) and the same funnel tracker
// contract, so the two styles are interchangeable server-side.
//
// The reveal step NEVER shows the intent/fit score or band, and NEVER states or
// implies suitability — only "could be a good fit, subject to a clinical
// assessment", the same hedge the compliance footer and the submit route's
// copy already use. That is a hedge, not a promise, on purpose (GDC/ASA).

type Channel = "sms" | "email" | "whatsapp";
type Phase = "intro" | "question" | "reveal" | "contact" | "thanks";

interface FunnelQuestion {
  id: string;
  prompt: string;
  options: { value: string; label: string }[];
}

interface Step {
  question: FunnelQuestion;
  transition?: string;
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
  /**
   * True only when the submit route actually bridged this response into
   * Speed-to-lead (a real contact happens or is retried). The thank-you copy
   * is derived from band + this flag (see result-copy.ts), never from the
   * server's raw "message" string, so it can never promise a callback that
   * is not going to happen.
   */
  leadCreated: boolean;
  bookingUrl?: string;
}

interface Props {
  clientSlug: string;
  campaignSlug?: string;
  headline?: string | null;
  intro?: string | null;
  practiceName?: string;
  /** See assessment-quiz.tsx's Props.previewMode: no telemetry, no real submit. */
  previewMode?: boolean;
}

/** Normalise the first deterministic question into a FunnelQuestion (same bank
 *  lookup as Classic's firstStep, duplicated locally — see file header). */
function firstStep(): Step {
  const q = questionById(FIRST_QUESTION_ID);
  if (!q) {
    return { question: { id: FIRST_QUESTION_ID, prompt: "What are you most interested in?", options: [] } };
  }
  return {
    question: {
      id: q.id,
      prompt: q.prompt,
      options: q.options.map((o) => ({ value: o.value, label: o.label })),
    },
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

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The quiet "4 of 6" counter above each question: this question's number against
 *  the funnel's hard cap, read straight off MAX_QUESTIONS so the counter and the
 *  progress bar (which divides by the same constant) can never disagree.
 *
 *  The funnel is adaptive and often stops early — the cap is a ceiling, not a
 *  prediction, and finishing at 4 of 6 is the normal, good outcome. Clamped
 *  because a patient should never be shown "7 of 6" if the cap is ever raised
 *  server-side ahead of a deploy of this file. */
export function stepCounterLabel(step: number): string {
  return `${Math.min(step, MAX_QUESTIONS)} of ${MAX_QUESTIONS}`;
}

export function GuidedAssessmentQuiz({ clientSlug, campaignSlug, headline, intro, practiceName, previewMode }: Props) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [history, setHistory] = useState<Step[]>(() => [firstStep()]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
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

  // Created once via useState's lazy initializer (never a ref read/written
  // during render): previewMode (the internal admin live-preview iframe) gets
  // a no-op tracker, never the real createFunnelTracker, and the choice never
  // changes after mount.
  const [tracker] = useState<FunnelTracker>(() =>
    previewMode
      ? { track: () => {}, flush: () => {} }
      : createFunnelTracker({ surface: "assessment", clientSlug, campaignSlug }),
  );
  useEffect(() => {
    tracker.track("started");
  }, [tracker]);

  const current = history[history.length - 1]!;
  const step = history.length;

  const progress = useMemo(() => {
    if (phase === "intro") return 0;
    if (phase === "question") return Math.min(0.92, step / MAX_QUESTIONS) * 100;
    return 100;
  }, [phase, step]);

  const canSubmit = useMemo(() => {
    if (firstName.trim() === "") return false;
    if (channel === "email") return email.trim() !== "";
    return phone.trim() !== "";
  }, [firstName, channel, email, phone]);

  function startQuiz() {
    setPhase("question");
    setAnimKey((k) => k + 1);
  }

  /** The funnel finished (or errored): show the results reveal, never contact
   *  details first. */
  function goToReveal() {
    setThinking(false);
    setPendingValue(null);
    advancing.current = false;
    setPhase("reveal");
    setAnimKey((k) => k + 1);
  }

  function proceedToContact() {
    setPhase("contact");
    setAnimKey((k) => k + 1);
    tracker.track("contact_viewed");
  }

  async function choose(value: string) {
    if (advancing.current || thinking || busy) return;
    advancing.current = true;
    tracker.track("question_answered", { index: history.length });
    const q = current.question;
    const nextAnswers = { ...answers, [q.id]: value };

    setPendingValue(value);
    setAnswers(nextAnswers);
    setError(null);
    setThinking(true);

    const got = await fetchNext(nextAnswers);
    if (got === "error" || got.done) {
      goToReveal();
      return;
    }
    setHistory((prev) => [...prev, { question: got.question, transition: got.transition }]);
    setPendingValue(null);
    setThinking(false);
    advancing.current = false;
    setAnimKey((k) => k + 1);
  }

  /** POST /next with one retry. Returns a parsed step, "done", or "error".
   *  Mirrors assessment-quiz.tsx's fetchNext exactly (same endpoint/contract). */
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

  /** Step back one question. */
  function back() {
    if (history.length <= 1 || thinking || busy) return;
    const previous = history[history.length - 2]!;
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

  /** From the reveal, go back to the last question asked (re-answerable). */
  function backFromReveal() {
    if (busy) return;
    const last = history[history.length - 1]!;
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

  /** From contact, go back to the reveal (nothing there needs resetting). */
  function backFromContact() {
    if (busy) return;
    setPhase("reveal");
    setAnimKey((k) => k + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // previewMode is also enforced by disabling the submit button; this is
    // defense in depth (e.g. an implicit Enter-key form submit).
    if (!canSubmit || busy || previewMode) return;
    setBusy(true);
    setError(null);
    try {
      const pageToken = await fetch(`/api/smile-assessment/token?client=${encodeURIComponent(clientSlug)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { token?: string | null } | null) => j?.token ?? undefined)
        .catch(() => undefined);
      // META CONVERSION FIELDS (0083). Two values, minted before the post so the
      // same event id can be given to the browser pixel afterwards and Meta counts
      // ONE conversion rather than two. `metaConsent` is this device's own answer:
      // the server never infers it, and without it no contact detail of any kind
      // reaches the Conversions API. Inert on every practice that runs no pixel.
      const meta = metaSubmitFields();
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
          ...meta,
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
      // The browser half of the conversion. A no-op unless this visitor consented
      // AND the pixel actually loaded; the server-side event is the fallback for
      // every case where it did not, which is what lets this be best-effort.
      trackMetaLead(meta.metaEventId);
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  const name = practiceName?.trim() || "Smile Assessment";

  return (
    <main
      className="relative flex min-h-screen w-full items-center justify-center px-4 py-8 sm:px-6"
      style={{ backgroundImage: "linear-gradient(160deg, var(--navy) 0%, var(--blue-royal) 100%)" }}
    >
      <style>{GUIDED_ENTER_KEYFRAMES}</style>

      <div className="w-full max-w-md">
        <header className="mb-5 flex flex-col items-center gap-2 text-center">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/25 backdrop-blur-sm">
            {/* The logo file is a blue mark on transparency, which sinks into this
                navy gradient. brightness-0 crushes it to solid black and invert
                flips that to solid white, leaving the transparent background
                untouched — a white mark from the one asset, no second file. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/copilot-logo.png"
              alt={`${name} logo`}
              width={28}
              height={28}
              className="h-7 w-7 object-contain brightness-0 invert"
            />
          </span>
          <p className="text-sm font-bold tracking-tight text-white">{name}</p>
        </header>

        {phase !== "intro" ? (
          <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-white/15" aria-hidden>
            <div
              className={cn(
                "h-full rounded-full bg-white transition-[width] duration-300 ease-out",
                thinking ? "motion-safe:animate-pulse" : "",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}

        <div className="overflow-hidden rounded-[1.5rem] bg-white p-6 shadow-[0_24px_70px_rgba(4,14,38,0.35)] sm:p-8">
          {phase === "intro" ? (
            <IntroStep headline={headline} intro={intro} practiceName={practiceName} onStart={startQuiz} />
          ) : phase === "reveal" ? (
            <RevealStep
              animKey={animKey}
              treatmentValue={answers[Q_TREATMENT]}
              onContinue={proceedToContact}
              onBack={backFromReveal}
            />
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
          ) : phase === "thanks" && result ? (
            <ThanksStep result={result} />
          ) : (
            <QuestionStep
              animKey={animKey}
              step={step}
              question={current.question}
              transition={current.transition}
              answers={answers}
              pendingValue={pendingValue}
              thinking={thinking}
              canGoBack={history.length > 1}
              onChoose={choose}
              onBack={back}
            />
          )}
        </div>

        <p className="mt-4 px-2 text-center text-[0.68rem] leading-relaxed text-on-navy-muted">
          Your answers help us point you to the right next step; nothing here is medical advice. Our
          dentists are GDC registered and treatment suitability always depends on a clinical
          assessment.
        </p>
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------------------
 * Intro screen
 * ------------------------------------------------------------------------- */

function IntroStep({
  headline,
  intro,
  practiceName,
  onStart,
}: {
  headline?: string | null;
  intro?: string | null;
  practiceName?: string;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center motion-safe:[animation:guidedEnter_260ms_ease-out]">
      <h1 className="text-2xl font-extrabold leading-tight text-navy [text-wrap:balance]">
        {headline?.trim() || "Find your ideal next step for your smile"}
      </h1>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {intro?.trim() ||
          `Answer a few quick questions and we'll point you to the right next step for your smile at ${
            practiceName?.trim() || "our practice"
          }. It takes about a minute.`}
      </p>
      <Button type="button" variant="primary" size="lg" className="mt-2 w-full" onClick={onStart}>
        Start my assessment
        <ChevronRight size={18} />
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Question screen — big tappable tiles + a real progress bar (drawn by the
 * parent, above this card).
 *
 * A tile shows a 3D-model render when option-images.ts has one for this exact
 * questionId + option value (today: the smile_concern picture question), and
 * its lucide icon chip otherwise. Icon is the DEFAULT, not the fallback: most
 * options have no artwork, so both paths are first-class. Everything else about
 * the tile — selected/hover/focus treatment, aria-pressed, the thinking spinner
 * slot — is identical either way.
 * ------------------------------------------------------------------------- */

function QuestionStep({
  animKey,
  step,
  question,
  transition,
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
  answers: Record<string, string>;
  pendingValue: string | null;
  thinking: boolean;
  canGoBack: boolean;
  onChoose: (value: string) => void;
  onBack: () => void;
}) {
  const selected = pendingValue ?? answers[question.id] ?? null;
  // Big tiles read best in two columns once there's real breathing room; a
  // 3-option question (readiness/experience/location) stacks as full-width
  // rows instead of leaving an awkward lone tile on its own row.
  const twoCol = question.options.length >= 4;

  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step > 1) regionRef.current?.focus();
  }, [step]);

  // Optional per-question hero artwork. Always null today (the map ships empty);
  // this is the wired seam. Rendered just OUTSIDE the fieldset rather than inside
  // it, because <legend> has to stay the fieldset's first child.
  const hero = heroFor(question.id);

  return (
    <div
      key={animKey}
      ref={regionRef}
      tabIndex={-1}
      className="outline-none motion-safe:[animation:guidedEnter_240ms_ease-out]"
    >
      <div className="mb-4 flex items-center justify-between">
        {canGoBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={thinking}
            className="-mx-2 -my-2.5 inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40 disabled:opacity-40"
          >
            <ArrowLeft size={14} />
            Back
          </button>
        ) : (
          <span />
        )}
        {/* Deliberately plain text, not a badge: it is a quiet reassurance about
            length, not a thing to look at. */}
        <span className="text-[0.7rem] font-medium tabular-nums text-muted">{stepCounterLabel(step)}</span>
      </div>

      {transition ? (
        <p className="mb-3 text-[0.8rem] font-medium leading-snug text-blue-royal">{transition}</p>
      ) : null}

      {hero ? (
        <span className="mb-4 block overflow-hidden rounded-2xl bg-[#eef3fb]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={hero}
            alt=""
            width={OPTION_IMAGE_WIDTH}
            height={OPTION_IMAGE_HEIGHT}
            loading="lazy"
            decoding="async"
            className="h-auto w-full object-cover"
          />
        </span>
      ) : null}

      <fieldset disabled={thinking}>
        <legend className="mb-4 text-xl font-extrabold leading-snug text-navy [text-wrap:balance] sm:text-2xl">
          {question.prompt}
        </legend>
        <div className={cn("grid gap-3", twoCol ? "grid-cols-2" : "grid-cols-1")}>
          {question.options.map((o) => {
            const checked = selected === o.value;
            const Icon = iconFor(o.value);
            const artSrc = imageFor(question.id, o.value);
            const artAlt = imageAltFor(question.id, o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={checked}
                onClick={() => onChoose(o.value)}
                disabled={thinking}
                className={cn(
                  "group flex min-h-[6.5rem] flex-col items-center justify-center gap-2 rounded-2xl border-2 px-3 py-4 text-center transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40 focus-visible:ring-offset-2",
                  checked
                    ? "border-blue-royal bg-blue-royal/[0.07] shadow-[0_6px_20px_rgba(22,85,154,0.18)]"
                    : "border-line bg-card hover:border-blue-royal/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                  thinking ? "cursor-default" : "cursor-pointer",
                )}
              >
                {artSrc ? (
                  // The render takes the icon chip's slot. The tinted plate behind
                  // it matches the conditions cards elsewhere on the site so the
                  // cut-out models sit on the same ground. width/height are the
                  // asset's intrinsic 4:3 size, so the box is reserved before the
                  // lazy-loaded file arrives and nothing reflows.
                  <span
                    className={cn(
                      "block w-full max-w-[9rem] shrink-0 overflow-hidden rounded-xl bg-[#eef3fb] ring-1 transition-colors",
                      checked ? "ring-blue-royal/40" : "ring-transparent",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={artSrc}
                      alt={artAlt ?? o.label}
                      width={OPTION_IMAGE_WIDTH}
                      height={OPTION_IMAGE_HEIGHT}
                      loading="lazy"
                      decoding="async"
                      className="h-auto w-full object-cover"
                    />
                  </span>
                ) : (
                  <span
                    className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors",
                      checked ? "bg-blue-royal text-white" : "bg-blue-royal/10 text-blue-royal group-hover:bg-blue-royal/15",
                    )}
                    aria-hidden
                  >
                    <Icon size={22} strokeWidth={2} />
                  </span>
                )}
                <span className={cn("text-[13px] font-semibold leading-snug", checked ? "text-navy" : "text-ink")}>
                  {o.label}
                </span>
                <span className="h-4" aria-hidden>
                  {checked && thinking ? <Loader2 size={14} className="text-blue-royal motion-safe:animate-spin" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {thinking ? (
        <div aria-hidden className="mt-5 h-16 rounded-2xl border border-line bg-card-muted/60 motion-safe:animate-pulse" />
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {thinking ? "Loading the next question" : ""}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Results reveal — treatment + 2-3 factual chips. NEVER the score/band, NEVER
 * a suitability promise: only "could be a good fit, subject to a clinical
 * assessment", matching the compliance footer's hedge.
 * ------------------------------------------------------------------------- */

function RevealStep({
  animKey,
  treatmentValue,
  onContinue,
  onBack,
}: {
  animKey: number;
  treatmentValue?: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  const treatment = treatmentValue ? findTreatment(treatmentValue) : null;

  const chips: string[] = [];
  if (treatment) {
    chips.push(`From £${treatment.priceFrom.toLocaleString("en-GB")}`);
    chips.push(capitalize(treatment.typicalVisits));
    if (treatment.financeAvailable) chips.push("0 percent finance available");
  }

  const headline = treatment
    ? `Based on your answers, ${treatment.name} could be a good fit, subject to a clinical assessment.`
    : "Based on your answers, our team can recommend the right next step, subject to a clinical assessment.";

  return (
    <div
      key={animKey}
      className="flex flex-col items-center gap-4 text-center motion-safe:[animation:guidedEnter_260ms_ease-out]"
    >
      <button
        type="button"
        onClick={onBack}
        className="self-start -mx-2 -my-2.5 inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-blue-royal">
        Your results are ready
      </p>
      <h2 className="text-xl font-extrabold leading-snug text-navy [text-wrap:balance]">{headline}</h2>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {chips.map((c) => (
            <span
              key={c}
              className="rounded-full border border-tint-royal-line bg-tint-royal px-3 py-1.5 text-xs font-semibold text-status-royal"
            >
              {c}
            </span>
          ))}
        </div>
      ) : null}

      <Button type="button" variant="primary" size="lg" className="mt-2 w-full" onClick={onContinue}>
        See your tailored next step
        <ChevronRight size={18} />
      </Button>
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
  // WhatsApp stays hidden until the practice's WhatsApp sender is connected
  // (mirrors assessment-quiz.tsx's ContactStep).
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
      aria-labelledby="guided-contact-heading"
      onSubmit={onSubmit}
      className="space-y-4 outline-none motion-safe:[animation:guidedEnter_240ms_ease-out]"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="-mx-2 -my-2.5 inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40 disabled:opacity-40"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="text-center">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-blue-royal">Almost done</p>
        <h2 id="guided-contact-heading" className="text-xl font-extrabold text-navy [text-wrap:balance]">
          See your tailored next step
        </h2>
        <p className="mt-1 text-xs leading-snug text-muted">
          Tell us where to send it, and the soonest time we could see you.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">First name</span>
        <input
          type="text"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-royal/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/30"
        />
      </label>

      <fieldset>
        <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          How would you like us to reply?
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {channels.map((c) => {
            const active = channel === c.key;
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setChannel(c.key)}
                aria-pressed={active}
                className={cn(
                  "flex min-h-12 items-center justify-center gap-2 rounded-xl border px-2 py-2 text-xs font-semibold transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  active
                    ? "border-blue-royal bg-blue-royal/[0.08] text-blue-royal shadow-[0_3px_14px_rgba(22,85,154,0.14)]"
                    : "border-line bg-card text-muted hover:border-blue-royal/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                )}
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
            className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-royal/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/30"
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
            className="w-full rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-base sm:text-sm text-ink focus-visible:border-blue-royal/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/30"
          />
        </label>
      )}

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]">{error}</p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!canSubmit || busy || previewMode}
      >
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        See my next step
      </Button>
      {previewMode ? (
        <p className="text-center text-[0.7rem] font-semibold leading-snug text-blue-royal">
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

function ThanksStep({ result }: { result: SubmitResult }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center motion-safe:[animation:guidedEnter_240ms_ease-out]">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <h1 className="text-xl font-extrabold text-navy">Thank you</h1>
      <p className="max-w-sm text-sm text-muted">
        {resultCopy(result.band, result.leadCreated, Boolean(result.bookingUrl))}
      </p>
      {result.bookingUrl ? (
        <Button asChild variant="primary" className="w-full sm:w-auto">
          <a href={result.bookingUrl}>Book your appointment now</a>
        </Button>
      ) : null}
    </div>
  );
}

// Opacity + small translateY only (no layout-property animation), gated behind
// motion-safe: at the call site (mirrors assessment-quiz.tsx's ENTER_KEYFRAMES).
const GUIDED_ENTER_KEYFRAMES = `@keyframes guidedEnter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`;
