"use client";

import { useState } from "react";
import { TRIAGE_PUBLIC_COPY, URGENT_HELP_THRESHOLD, urgentHelpLine } from "@/lib/triage/copy";
import { SCALE_MAX, SCALE_MIN } from "@/lib/triage/types";
import type { InterestAnswer, InterestTreatment, InterestTreatmentKey } from "@/lib/triage/types";
import type { ProjectedQuestion } from "@/lib/triage/project";

// ===========================================================================
// The patient-facing pre-visit form. A DUMB client component.
//
// It renders the questions the SERVER decided this patient is asked, collects
// answers, and posts them with the opaque token. It holds no rule about which
// questions exist: `questions` arrives already projected, so this file cannot put
// a symptom question in front of a patient the server said must not see one.
//
// IT KNOWS NOTHING ABOUT THE PATIENT. No id, no site, no plan, no fork. The token
// is opaque and the server resolves everything from it. That is deliberate: the
// browser is the one place this data could leak from, so it is given nothing to
// leak. The `questions` prop is the ONLY thing that differs between the two
// banks, and it differs by being shorter.
//
// NO SCREEN HERE EXPLAINS WHY. There is no "based on your plan", no funding word,
// no note about which list this is. The short form is simply shorter — two
// patients comparing their phones must not be able to work out that they were
// asked different things because of how they are seen.
//
// Every string a patient reads comes from TRIAGE_PUBLIC_COPY or from the
// projected question, both of which are crawled by copy.test.ts.
// ===========================================================================

const YESNO_CHOICES: { value: string; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Not sure" },
];

export interface PreVisitFormProps {
  token: string;
  practiceName: string;
  questions: ProjectedQuestion[];
  interest: readonly InterestTreatment[];
  /** The medical-history form, when that feature is switched on. Null otherwise. */
  medicalLink: string | null;
  /**
   * The SITE's own public number, for the urgent-help line. Null until the owner
   * supplies it, and null is honoured rather than filled in with a guess.
   */
  practicePhone: string | null;
}

/**
 * Did the patient rate any discomfort scale at or above the help threshold?
 *
 * PURE and exported, so "a 7 shows the line and a 6 does not" is assertable
 * without driving the form. It reads EVERY scale question rather than the
 * `pain-now` key, because a practice can add a scale question of its own and a
 * high score on it deserves the same sentence.
 */
export function hasUrgentScore(
  questions: ProjectedQuestion[],
  answers: Record<string, string>,
): boolean {
  return questions.some((q) => {
    if (q.type !== "scale") return false;
    const n = Number((answers[q.key] ?? "").trim());
    return Number.isFinite(n) && n >= URGENT_HELP_THRESHOLD;
  });
}

/**
 * The presentational half, with every piece of state arriving as a prop.
 *
 * Split from the stateful wrapper for the reason closer-drafts.tsx is: effects do
 * not run in a static render, so a component whose states are only reachable by
 * clicking is a component whose states cannot be asserted. Every screen this form
 * can show is renderable directly from here.
 */
export function PreVisitFormView({
  practiceName,
  questions,
  interest,
  answers,
  interestAnswers,
  status,
  error,
  outstanding,
  onAnswer,
  onInterest,
  practicePhone,
  onSubmit,
}: Omit<PreVisitFormProps, "token" | "medicalLink"> & {
  answers: Record<string, string>;
  interestAnswers: Partial<Record<InterestTreatmentKey, InterestAnswer>>;
  status: "idle" | "submitting" | "error";
  error: string | null;
  outstanding: number;
  onAnswer: (key: string, value: string) => void;
  onInterest: (key: InterestTreatmentKey, value: InterestAnswer) => void;
  onSubmit: () => void;
}) {
  const gridShown = questions.some((q) => q.type === "interest");
  const gridQuestion = questions.find((q) => q.type === "interest");
  const canSubmit = outstanding === 0 && status !== "submitting";

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <header className="mb-6">
        <h1 className="text-[22px] font-bold tracking-[-0.4px] text-navy">
          {TRIAGE_PUBLIC_COPY.heading}
        </h1>
        <p className="mt-1 text-[13.5px] leading-[1.55] text-muted">
          {practiceName}. {TRIAGE_PUBLIC_COPY.intro}
        </p>
      </header>

      <ol className="space-y-4">
        {questions
          .filter((q) => q.type !== "interest")
          .map((q, i) => (
            <li key={q.key} className="rounded-xl border border-line bg-card px-4 py-3.5">
              <p className="text-[14px] font-medium leading-[1.45] text-ink">
                <span className="mr-1.5 text-muted tabular-nums">{i + 1}.</span>
                {q.label}
                {q.required ? <span className="ml-1.5 text-[12px] font-normal text-muted">(needed)</span> : null}
              </p>
              {q.help ? <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">{q.help}</p> : null}
              <div className="mt-2.5">
                <QuestionControl
                  question={q}
                  value={answers[q.key] ?? ""}
                  onChange={(v) => onAnswer(q.key, v)}
                />
              </div>
              {/*
                IMMEDIATELY, under the question they just answered, not at the
                bottom of the form. A patient who has just said their pain is a 9
                may not scroll any further, and nothing in this module acts on that
                9 by itself, so this sentence is the whole of the route to help.
              */}
              {q.type === "scale" && hasUrgentScore([q], answers) ? (
                <p
                  role="status"
                  className="mt-2.5 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[13px] leading-[1.5] text-ink"
                >
                  {urgentHelpLine(practicePhone)}
                </p>
              ) : null}
            </li>
          ))}
      </ol>

      {gridShown ? (
        <section className="mt-6 rounded-xl border border-line bg-card px-4 py-4">
          <h2 className="text-[15px] font-semibold text-navy">
            {gridQuestion?.label ?? "Would you like to hear more about any of these?"}
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">{TRIAGE_PUBLIC_COPY.interestNote}</p>
          <ul className="mt-3 space-y-3">
            {interest.map((t) => (
              <li key={t.key} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <p className="text-[14px] font-medium text-ink">{t.label}</p>
                <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{t.blurb}</p>
                {/*
                  THE REFUSAL IS ALWAYS THERE AND ALWAYS EQUAL. Both buttons are the
                  same size, the same shape and side by side; "Not right now" is not
                  a link, not smaller, and not hidden behind the yes. Required-but-
                  refusable means the patient must answer, never that they must
                  agree — and a layout that made declining harder would be the
                  dishonest way to raise the yes rate.
                */}
                <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label={t.label}>
                  {(["yes", "not_now"] as const).map((value) => {
                    const active = interestAnswers[t.key] === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onInterest(t.key, value)}
                        aria-pressed={active}
                        className={
                          "rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 " +
                          (active
                            ? "border-navy bg-navy text-white"
                            : "border-line-strong bg-card text-navy hover:bg-card-muted")
                        }
                      >
                        {value === "yes" ? TRIAGE_PUBLIC_COPY.interestAccept : TRIAGE_PUBLIC_COPY.interestDecline}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {status === "error" && error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[13px] text-status-red"
        >
          {error}
        </p>
      ) : null}
      {outstanding > 0 ? (
        <p className="mt-4 text-[12.5px] text-muted">{TRIAGE_PUBLIC_COPY.incomplete(outstanding)}</p>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="mt-4 w-full rounded-xl bg-navy px-4 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "submitting" ? TRIAGE_PUBLIC_COPY.submitting : TRIAGE_PUBLIC_COPY.submit}
      </button>
    </main>
  );
}

/**
 * The thank-you screen, and the one place the medical-history handover happens.
 *
 * IT DERIVES THE URGENT FLAG ITSELF from the answers, rather than taking a boolean
 * the caller computed. That is deliberate and it is a fix, not a preference: with
 * a boolean prop there was a WIRING SEAM between this screen and the form, and a
 * mutation that hard-coded `urgent={false}` in the wrapper left the screen's own
 * test green — it was rendering the leaf with the flag already set. Removing the
 * prop removes the seam, so the test of this component IS the test of the
 * behaviour. (The same lesson as the mining panel: test what the reader sees, and
 * do not leave a hop in between that nothing exercises.)
 */
export function PreVisitDone({
  medicalLink,
  questions,
  answers,
  practicePhone,
}: {
  medicalLink: string | null;
  /**
   * REQUIRED, not optional with a default, and that is the second half of closing
   * the seam. With `questions = []` the wrapper could stop passing them and the
   * screen would quietly derive `false` for everybody — a mutation that dropped
   * exactly those two props survived until this was tightened. Required makes that
   * a COMPILE error rather than a silent behaviour change, which is the stronger
   * guarantee and the one this codebase reaches for ("a new role or tool is a
   * compile error until placed").
   */
  questions: ProjectedQuestion[];
  answers: Record<string, string>;
  practicePhone: string | null;
}) {
  const urgent = hasUrgentScore(questions, answers);
  return (
    <main className="mx-auto max-w-xl px-5 py-16 text-center">
      <div className="rounded-2xl border border-line bg-card px-6 py-10">
        <h1 className="text-[20px] font-bold tracking-[-0.3px] text-navy">
          {TRIAGE_PUBLIC_COPY.doneHeading}
        </h1>
        <p className="mt-2 text-[14px] leading-[1.55] text-muted">{TRIAGE_PUBLIC_COPY.doneBody}</p>
        {/*
          AGAIN on the way out, for the patient who scored high and then kept
          scrolling. "There is nothing more to do" is true about the FORM and would
          be a bad last word to somebody in pain, so it is immediately qualified.
        */}
        {urgent ? (
          <p
            role="status"
            className="mt-4 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-left text-[13.5px] leading-[1.5] text-ink"
          >
            {urgentHelpLine(practicePhone)}
          </p>
        ) : null}
        {medicalLink ? (
          <div className="mt-6 border-t border-line pt-6">
            <p className="text-[13.5px] leading-[1.55] text-muted">{TRIAGE_PUBLIC_COPY.medicalNext}</p>
            <a
              href={medicalLink}
              className="mt-3 inline-block rounded-xl bg-navy px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              {TRIAGE_PUBLIC_COPY.medicalNextCta}
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}

/** One question's control. Five types, and the grid is rendered elsewhere. */
function QuestionControl({
  question,
  value,
  onChange,
}: {
  question: ProjectedQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  if (question.type === "textarea") {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={2000}
        aria-label={question.label}
        className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
      />
    );
  }
  if (question.type === "text") {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={2000}
        aria-label={question.label}
        className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
      />
    );
  }
  if (question.type === "scale") {
    // Eleven buttons rather than a slider. A slider needs a starting value, and
    // any starting value is an answer the patient did not give — a 5 sitting under
    // their thumb reads to a clinician as "they said 5". Buttons have no default.
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={question.label}>
        {Array.from({ length: SCALE_MAX - SCALE_MIN + 1 }, (_, i) => String(SCALE_MIN + i)).map((n) => {
          const active = value === n;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={active}
              className={
                "h-9 w-9 rounded-lg border text-[13px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 " +
                (active ? "border-navy bg-navy text-white" : "border-line-strong bg-card text-navy hover:bg-card-muted")
              }
            >
              {n}
            </button>
          );
        })}
      </div>
    );
  }
  const choices = question.type === "yesno" ? YESNO_CHOICES : (question.options ?? []);
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={question.label}>
      {choices.map((c) => {
        const active = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            aria-pressed={active}
            className={
              "rounded-lg border px-3.5 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 " +
              (active ? "border-navy bg-navy text-white" : "border-line-strong bg-card text-navy hover:bg-card-muted")
            }
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How many answers are still outstanding.
 *
 * Exported and pure so the "required means required" rule can be asserted without
 * driving the form: a required question with no answer counts, and EVERY interest
 * row counts until it carries one of the two values. Declining is answering.
 */
export function outstandingCount(
  questions: ProjectedQuestion[],
  interest: readonly InterestTreatment[],
  answers: Record<string, string>,
  interestAnswers: Partial<Record<InterestTreatmentKey, InterestAnswer>>,
): number {
  let n = 0;
  for (const q of questions) {
    if (q.type === "interest") continue;
    if (q.required && !(answers[q.key] ?? "").trim()) n += 1;
  }
  if (questions.some((q) => q.type === "interest")) {
    for (const t of interest) {
      if (!interestAnswers[t.key]) n += 1;
    }
  }
  return n;
}

/** The stateful wrapper. Holds answers, posts, and swaps to the thank-you screen. */
export function PreVisitForm({
  token,
  practiceName,
  questions,
  interest,
  medicalLink,
  practicePhone,
}: PreVisitFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [interestAnswers, setInterestAnswers] = useState<
    Partial<Record<InterestTreatmentKey, InterestAnswer>>
  >({});
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const outstanding = outstandingCount(questions, interest, answers, interestAnswers);

  async function submit() {
    if (outstanding > 0 || status === "submitting") return;
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/previsit/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          answers: Object.entries(answers)
            .filter(([, v]) => v.trim() !== "")
            .map(([key, value]) => ({ key, value: value.trim() })),
          interest: questions.some((q) => q.type === "interest")
            ? interest.map((t) => ({ treatment: t.key, answer: interestAnswers[t.key] }))
            : [],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setStatus("done");
      } else {
        setStatus("error");
        setError(data.error ?? TRIAGE_PUBLIC_COPY.saveFailed);
      }
    } catch {
      // A DIFFERENT SENTENCE FROM A SERVER REFUSAL, deliberately. "We could not
      // reach the practice" tells the patient to check their signal; "we could not
      // save your answers" tells them the practice heard and something went wrong.
      // They are different facts and they have different fixes.
      setStatus("error");
      setError(TRIAGE_PUBLIC_COPY.reachFailed);
    }
  }

  if (status === "done") {
    return (
      <PreVisitDone
        medicalLink={medicalLink}
        questions={questions}
        answers={answers}
        practicePhone={practicePhone}
      />
    );
  }

  return (
    <PreVisitFormView
      practiceName={practiceName}
      questions={questions}
      interest={interest}
      answers={answers}
      interestAnswers={interestAnswers}
      status={status}
      error={error}
      outstanding={outstanding}
      practicePhone={practicePhone}
      onAnswer={(key, value) => setAnswers((prev) => ({ ...prev, [key]: value }))}
      onInterest={(key, value) => setInterestAnswers((prev) => ({ ...prev, [key]: value }))}
      onSubmit={submit}
    />
  );
}
