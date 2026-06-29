"use client";

import { useMemo, useRef, useState } from "react";
import { Loader2, CheckCircle2, Sparkles, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIRST_QUESTION_ID, questionById } from "@/lib/smile-assessment/quiz";

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
  message: string;
}

interface Props {
  clientSlug: string;
  campaignSlug?: string;
  headline?: string | null;
  intro?: string | null;
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

export function AssessmentQuiz({ clientSlug, campaignSlug, headline, intro }: Props) {
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
  }

  /** Record the chosen answer, then ask the backend for the next question. */
  async function choose(value: string) {
    if (advancing.current || thinking || busy) return;
    advancing.current = true;
    const q = current.question;
    const nextAnswers = { ...answers, [q.id]: value };

    // Show the chosen option as selected, then drop into the thinking state.
    setPendingValue(value);
    setAnswers(nextAnswers);
    setError(null);
    // A brief beat so the selection registers before the spinner replaces it.
    await new Promise((r) => setTimeout(r, 260));
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
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
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
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; band?: string; message?: string; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.band || !data.message) {
        setError(
          data?.error === "too many submissions from this contact, please try again later" ||
            data?.error === "too many submissions, please try again later"
            ? "We've already received your details. Our team will be in touch shortly."
            : "Sorry, something went wrong. Please try again in a moment.",
        );
        setBusy(false);
        return;
      }
      setResult({ band: data.band as SubmitResult["band"], message: data.message });
      setPhase("thanks");
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col px-5 py-10">
      <style>{ENTER_KEYFRAMES}</style>

      <header className="mb-8 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-dark text-white">
          <Sparkles size={18} />
        </span>
        <div>
          <p className="text-lg font-extrabold tracking-tight text-navy">Smile Assessment</p>
          <p className="text-xs text-muted">A quick check to point you to the right next step.</p>
        </div>
      </header>

      <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-[0_1px_3px_rgba(10,14,26,0.06)]">
        {/* Progress track — grows as steps complete, full at contact/thanks. */}
        <div className="h-1 w-full bg-card-muted" aria-hidden>
          <div
            className="h-full bg-blue-dark transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="p-6 sm:p-8">
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

  return (
    <div key={animKey} className="motion-safe:[animation:assessEnter_220ms_ease-out]">
      <div className="mb-5 flex items-center justify-between">
        {canGoBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={thinking}
            className="inline-flex items-center gap-1 text-xs font-semibold text-muted transition-colors hover:text-navy disabled:opacity-40"
          >
            <ArrowLeft size={14} />
            Back
          </button>
        ) : (
          <span />
        )}
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Question {step}</span>
      </div>

      {isFirst ? (
        <div className="mb-6 space-y-1">
          <h1 className="text-2xl text-navy">{headline || "Let's find your best next step"}</h1>
          <p className="text-sm text-muted">
            {intro ||
              "A few quick questions. There are no wrong answers, and nothing here is medical advice."}
          </p>
        </div>
      ) : transition ? (
        <p className="mb-5 text-sm text-muted">{transition}</p>
      ) : null}

      <fieldset className="space-y-3" disabled={thinking}>
        <legend className="mb-2 text-base font-semibold text-navy">{question.prompt}</legend>
        <div className="grid gap-2">
          {question.options.map((o) => {
            const checked = selected === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChoose(o.value)}
                disabled={thinking}
                className={[
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                  checked
                    ? "border-blue-dark/40 bg-blue-dark/10 text-navy"
                    : "border-line-strong bg-card text-ink hover:bg-card-muted",
                  thinking ? "cursor-default" : "cursor-pointer",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-blue-dark" : "border-line-strong",
                  ].join(" ")}
                  aria-hidden
                >
                  {checked ? <span className="h-2 w-2 rounded-full bg-blue-dark" /> : null}
                </span>
                <span>{o.label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {thinking ? (
        <p className="mt-5 flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
          <Loader2 size={14} className="motion-safe:animate-spin" />
          Finding your next question...
        </p>
      ) : null}
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
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <form
      key={animKey}
      onSubmit={onSubmit}
      className="space-y-5 motion-safe:[animation:assessEnter_220ms_ease-out]"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="inline-flex items-center gap-1 text-xs font-semibold text-muted transition-colors hover:text-navy disabled:opacity-40"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="space-y-1">
        <h2 className="text-xl text-navy">Where should we send your next step?</h2>
        <p className="text-xs text-muted">We'll only use this to follow up about your enquiry.</p>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">First name</span>
        <input
          type="text"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
        />
      </label>

      <div>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          How would you like us to reply?
        </span>
        <div className="flex flex-wrap gap-2">
          {(["sms", "whatsapp", "email"] as Channel[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={[
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                channel === c
                  ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
                  : "border-line-strong bg-card text-muted hover:bg-card-muted",
              ].join(" ")}
            >
              {c === "sms" ? "Text" : c === "whatsapp" ? "WhatsApp" : "Email"}
            </button>
          ))}
        </div>
      </div>

      {channel === "email" ? (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
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
            className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          />
        </label>
      )}

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={!canSubmit || busy}>
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        See my next step
      </Button>
      <p className="text-center text-xs text-muted">
        By sending this you agree we can contact you about your enquiry. Prices in GBP (£).
      </p>
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Thank-you screen
 * ------------------------------------------------------------------------- */

function ThankYou({ result }: { result: SubmitResult }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center motion-safe:[animation:assessEnter_220ms_ease-out]">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <h1 className="text-2xl text-navy">Thank you</h1>
      <p className="max-w-sm text-sm text-muted">{result.message}</p>
    </div>
  );
}

// Opacity + small translateY only (no layout-property animation). Gated behind
// motion-safe: at the call site so prefers-reduced-motion users get no movement.
const ENTER_KEYFRAMES = `@keyframes assessEnter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`;
