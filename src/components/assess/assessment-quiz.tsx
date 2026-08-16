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
import { createFunnelTracker, type FunnelTracker } from "@/lib/funnel/client";
import { iconFor } from "./option-icons";
import { GuidedAssessmentQuiz } from "./guided-assessment-quiz";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";
import type { PublicFlow } from "@/lib/smile-assessment/campaign";

// Shared Smile Assessment quiz UI — an ADAPTIVE, one-question-at-a-time funnel.
// The first question is deterministic (instant, no network); after each answer
// the funnel asks the backend (/api/smile-assessment/next) for the single best
// next question plus a short, warm AI transition line, until the backend says
// "done". Then it captures light contact details and POSTs to
// /api/smile-assessment/submit, showing a band-specific thank-you.
//
// Used by both the generic page (/assess/<client>) and a campaign landing page
// (/assess/<client>/<slug>). When a campaignSlug is set the submission is
// attributed to that campaign, and the optional headline/intro reframe the hero
// (shown only on the very first question screen).
//
// This is a client component: it imports only pure quiz data + fetch — never a
// server-only module.

type Channel = "sms" | "email" | "whatsapp";
type Phase = "question" | "contact" | "thanks";

/** A question as rendered in the funnel (options reduced to value + label). */
interface FunnelQuestion {
  id: string;
  prompt: string;
  options: { value: string; label: string }[];
}

/** One step in the asked-question history, powering the Back affordance. */
interface Step {
  question: FunnelQuestion;
  /** The AI lead-in line shown above this question (absent on the first). */
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
  /** When set, the thank-you screen offers a direct link to the booking page. */
  bookingUrl?: string;
}

interface Props {
  clientSlug: string;
  campaignSlug?: string;
  headline?: string | null;
  intro?: string | null;
  /** Practice display name for the branded header (e.g. "Vitality Dental"). */
  practiceName?: string;
  /**
   * Visual/interaction style. Omitted (or "classic") renders exactly today's
   * funnel, byte-identical. "guided" renders the premium one-question-per-screen
   * GuidedAssessmentQuiz instead. No code path here ever DEFAULTS this to
   * "guided" — callers must opt in explicitly (?style=guided on the public
   * pages, or the Classic/Guided switch in the internal live preview).
   */
  style?: "classic" | "guided";
  /**
   * True only for the internal admin live-preview iframe (?preview=1 on the
   * public pages). When true the funnel tracker no-ops (no telemetry from an
   * owner clicking through a preview) and the final submit step is disabled
   * with a small note, so opening a preview can never record a real enquiry
   * or send a real SMS/email.
   */
  previewMode?: boolean;
  /**
   * An AUTHORED funnel, already validated and stripped to public fields by the
   * page. When present the quiz walks that graph instead of asking the model for
   * the next question. Absent (the default, and every existing link) is the
   * adaptive funnel, unchanged.
   *
   * v1 is Classic-only: `style` is ignored when a flow is present, because there
   * is no Guided rendering of a drawn funnel yet and showing a mode that does not
   * exist would be worse than ignoring the switch.
   */
  flow?: PublicFlow | null;
  /**
   * Which SAVE of that funnel is on screen (flow_version, 0078). Used only by the
   * deterministic runtime, and only for step-drop-off telemetry: a tally that mixes
   * versions averages the funnel an owner just fixed with the one they fixed it
   * from. Ignored by Classic and Guided, which have no authored funnel to version.
   */
  flowVersion?: number;
}

/** Normalise the first deterministic question into a FunnelQuestion. */
function firstStep(): Step {
  const q = questionById(FIRST_QUESTION_ID);
  if (!q) {
    // Defensive: the bank always defines the first question, but never crash.
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

export function AssessmentQuiz(props: Props) {
  // Dispatch to the premium Guided style. This is a SEPARATE component (never a
  // conditional early-return inside ClassicAssessmentQuiz) on purpose:
  // ClassicAssessmentQuiz calls hooks unconditionally on every render, so a
  // style branch has to happen at the mount boundary (which component gets
  // rendered), not as an early return before those hooks run.
  //
  // An authored funnel is checked FIRST and wins over `style`: v1 has no Guided
  // rendering of a drawn funnel, so honouring ?style=guided here would silently
  // drop the practice's own funnel and run the adaptive one instead.
  if (props.flow) {
    return <DeterministicAssessmentQuiz {...props} flow={props.flow} />;
  }
  if (props.style === "guided") {
    return (
      <GuidedAssessmentQuiz
        clientSlug={props.clientSlug}
        campaignSlug={props.campaignSlug}
        headline={props.headline}
        intro={props.intro}
        practiceName={props.practiceName}
        previewMode={props.previewMode}
      />
    );
  }
  return <ClassicAssessmentQuiz {...props} />;
}

function ClassicAssessmentQuiz({ clientSlug, campaignSlug, headline, intro, practiceName, previewMode }: Props) {
  // The funnel history: history[history.length - 1] is the live question.
  const [history, setHistory] = useState<Step[]>(() => [firstStep()]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>("question");
  // The just-picked option on the current question (held briefly before advancing).
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  // Contact step.
  const [firstName, setFirstName] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // Bumped on every screen change so the entrance animation re-triggers.
  const [animKey, setAnimKey] = useState(0);
  // Guards against double-advance from a rapid second click while thinking.
  const advancing = useRef(false);

  // PII-free funnel telemetry (started / question_answered / contact_viewed /
  // submitted). Created once via useState's lazy initializer (never a ref
  // read/written during render) so listeners are not re-registered per render.
  // previewMode (the internal admin live-preview iframe) must never emit
  // telemetry: a no-op tracker, never the real createFunnelTracker.
  const [tracker] = useState<FunnelTracker>(() =>
    previewMode
      ? { track: () => {}, flush: () => {} }
      : createFunnelTracker({ surface: "assessment", clientSlug, campaignSlug }),
  );
  useEffect(() => {
    tracker.track("started");
  }, [tracker]);

  const current = history[history.length - 1];
  const step = history.length; // 1-based count of questions shown so far.

  const progress = useMemo(() => {
    if (phase === "question") return Math.min(0.9, step / 6) * 100;
    return 100;
  }, [phase, step]);

  const canSubmit = useMemo(() => {
    if (firstName.trim() === "") return false;
    if (channel === "email") return email.trim() !== "";
    return phone.trim() !== "";
  }, [firstName, channel, email, phone]);

  /** Move to the contact phase (when the funnel is done, or as a safe fallback). */
  function goToContact() {
    setThinking(false);
    setPendingValue(null);
    advancing.current = false;
    setPhase("contact");
    setAnimKey((k) => k + 1);
    tracker.track("contact_viewed");
  }

  /** Record the chosen answer, then ask the backend for the next question. */
  async function choose(value: string) {
    if (advancing.current || thinking || busy) return;
    advancing.current = true;
    // Which question (1-based) they just answered — the index only, never the answer.
    tracker.track("question_answered", { index: history.length });
    const q = current.question;
    const nextAnswers = { ...answers, [q.id]: value };

    // Highlight the chosen option and start fetching the next question right
    // away (no artificial delay) so it loads as fast as possible.
    setPendingValue(value);
    setAnswers(nextAnswers);
    setError(null);
    setThinking(true);

    const got = await fetchNext(nextAnswers);
    if (got === "error") {
      // Endpoint should never fail, but if the network does, don't strand them.
      goToContact();
      return;
    }
    if (got.done) {
      goToContact();
      return;
    }
    setHistory((prev) => [...prev, { question: got.question, transition: got.transition }]);
    setPendingValue(null);
    setThinking(false);
    advancing.current = false;
    setAnimKey((k) => k + 1);
  }

  /** POST /next with one retry. Returns a parsed step, "done", or "error". */
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
        if (!question) {
          // Valid "ok" but no usable question — treat as the funnel finishing.
          return { done: true };
        }
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
    // previewMode is also enforced by disabling the submit button below; this
    // is defense in depth (e.g. an implicit Enter-key form submit).
    if (!canSubmit || busy || previewMode) return;
    setBusy(true);
    setError(null);
    try {
      // Short-lived page token: marks this submission as coming from the real
      // funnel (our pages or the practice-website iframe embed), which unlocks
      // the instant first-contact text. Best effort — a failed fetch still
      // records the assessment, the team just contacts the patient manually.
      const pageToken = await fetch(
        `/api/smile-assessment/token?client=${encodeURIComponent(clientSlug)}`,
      )
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

  const name = practiceName?.trim() || "Smile Assessment";

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-4 sm:px-5 sm:py-8">
      <style>{ENTER_KEYFRAMES}</style>

      {/* Soft brand glow behind the card. The colour is the ONE brand value on
          this page that no Tailwind token could reach, so it is promoted to
          --assess-glow (src/lib/assess/palette.ts) and a campaign's chosen
          scheme re-tints it with everything else. The literal stays as the
          fallback because this component also renders with no themed wrapper
          above it (the generic /assess/<client> quiz, the internal live
          preview), and a bare var() would resolve to nothing there — which
          invalidates the whole gradient and drops the glow entirely. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,var(--assess-glow,rgba(91,196,247,0.20)),transparent_72%)]"
      />

      {/* Compact horizontal brand lockup: every vertical pixel saved here keeps
          the whole funnel on one phone screen. The question stays the hero. */}
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
        {/* Progress track — grows as steps complete, full at contact/thanks. */}
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
            <ThankYou result={result} />
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
              headline={headline}
              intro={intro}
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

      {/* GDC/ASA-safe trust + the required suitability line. Never testimonials.
          text-ink (not text-muted) on purpose: --muted misses AA contrast on the
          cream page background at this small size. */}
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

  // On advancing to a later question, move focus to the question region so a
  // screen reader announces the new step (the screen changed under the user).
  // Skipped on the first screen, which reads naturally top-down on load.
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
        {/* Honest momentum: the funnel is adaptive (no fixed total), so instead of a
            question count that could read as endless, the chip signals closeness. */}
        <span className="rounded-full bg-card-muted px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink">
          {step >= 3 ? `Question ${step} · nearly there` : `Question ${step}`}
        </span>
      </div>

      {isFirst ? (
        <div className="mb-3 space-y-1">
          {headline ? <p className="text-[0.8rem] font-semibold text-navy">{headline}</p> : null}
          {/* The 5-second hook: outcome + time expectation before the first tap. */}
          <p className="text-[0.8rem] leading-snug text-muted">
            {intro ||
              "Find the right next step for your smile. About 30 seconds, no wrong answers."}
          </p>
        </div>
      ) : transition ? (
        // No icon on purpose: the sparkle glyph reads as "generic AI", which is
        // exactly the wrong note for a warm human acknowledgment line.
        <p className="mb-3 text-[0.8rem] font-medium leading-snug text-blue-deep">{transition}</p>
      ) : null}

      <fieldset disabled={thinking}>
        {/* The question is the hero on every screen. */}
        <legend className="mb-3 text-lg font-bold leading-snug text-navy [text-wrap:balance] sm:text-xl">
          {question.prompt}
        </legend>
        {/* Option-heavy questions split into two columns on wider screens so the
            card stays short; on phones a single column keeps rows tappable. */}
        <div className={["grid gap-2", question.options.length > 3 ? "sm:grid-cols-2" : ""].join(" ")}>
          {question.options.map((o) => {
            const checked = selected === o.value;
            const Icon = iconFor(o.value);
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

      {/* While the next question resolves, sell that it is COMING: a light
          skeleton of the next step under the answered options, so the wait reads
          as progress rather than a stall. Purely decorative (aria-hidden); the
          sr-only live region below carries the accessible announcement. */}
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
  // WhatsApp is hidden until the practice's WhatsApp sender is connected (Meta
  // login pending): offering it would promise a channel we cannot yet send on.
  // First contact goes by text; re-add the option when WhatsApp goes live.
  const channels: { key: Channel; label: string; icon: LucideIcon }[] = [
    { key: "sms", label: "Text", icon: MessageSquare },
    { key: "email", label: "Email", icon: Mail },
  ];

  // The question fieldset disables itself while the last answer resolves, which
  // drops keyboard focus to <body> when this screen swaps in. Focus the form (it
  // is labelled by the heading) so the change is announced and Tab continues here.
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

      {/* Results-teaser framing: the details unlock a promised, personal outcome
          (peak-curiosity gate), never a bare "give us your details". */}
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

      {/* fieldset/legend so screen readers announce the group question with each
          channel toggle (mirrors the question step). */}
      <fieldset>
        <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          How would you like us to reply?
        </legend>
        {/* Columns match the live channel count so the row always fills the card
            evenly (WhatsApp rejoins this list once the sender is connected). */}
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

      <Button
        type="submit"
        variant="primary"
        className="min-h-12 w-full"
        disabled={!canSubmit || busy || previewMode}
      >
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

function ThankYou({ result }: { result: SubmitResult }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center motion-safe:[animation:assessEnter_240ms_ease-out]">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <h1 className="text-xl text-navy">Thank you</h1>
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

// Opacity + small translateY only (no layout-property animation). Gated behind
// motion-safe: at the call site so prefers-reduced-motion users get no movement.
const ENTER_KEYFRAMES = `@keyframes assessEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
