"use client";

import { useState } from "react";
import { MEDICAL_QUESTIONS, type MedicalAnswerValue } from "@/lib/patient-medical/questions";

// The patient-facing medical-history form. A DUMB client component: it collects
// yes/no/unknown answers to the versioned bank, two free-text lists, a typed
// signature, and posts them with the opaque token. It holds no clinical rule and
// makes no claim about the patient — the server validates and stores.
//
// NEUTRAL CHROME. This is a clinical screening form; it carries no NHS-vs-private
// funding framing of any kind. The only "declaration" is the patient confirming
// their answers are accurate, which every medical-history form requires.

interface AnswerState {
  answer: MedicalAnswerValue | null;
  detail: string;
}

const CHOICES: { value: MedicalAnswerValue; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Not sure" },
];

export function MhForm({ token, practiceName }: { token: string; practiceName: string | null }) {
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() =>
    Object.fromEntries(MEDICAL_QUESTIONS.map((q) => [q.key, { answer: null, detail: "" }])),
  );
  const [medications, setMedications] = useState("");
  const [allergies, setAllergies] = useState("");
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function setAnswer(key: string, answer: MedicalAnswerValue) {
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], answer } }));
  }
  function setDetail(key: string, detail: string) {
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], detail } }));
  }

  const unanswered = MEDICAL_QUESTIONS.filter((q) => answers[q.key].answer === null).length;
  const canSubmit = unanswered === 0 && name.trim().length > 0 && confirmed && status !== "submitting";

  async function submit() {
    if (!canSubmit) return;
    setStatus("submitting");
    setError(null);
    try {
      const payload = {
        token,
        patientName: name.trim(),
        medicationsText: medications.trim() || undefined,
        allergiesText: allergies.trim() || undefined,
        answers: MEDICAL_QUESTIONS.map((q) => ({
          key: q.key,
          answer: answers[q.key].answer,
          detail: answers[q.key].detail.trim() || undefined,
        })),
        signature: { method: "typed", value: name.trim(), signedAt: new Date().toISOString() },
      };
      const res = await fetch("/api/medical-history/public-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setStatus("done");
      } else {
        setStatus("error");
        setError(data.error ?? "We could not save your answers. Please try again.");
      }
    } catch {
      setStatus("error");
      setError("We could not reach the practice. Please try again.");
    }
  }

  if (status === "done") {
    return (
      <main className="mx-auto max-w-xl px-5 py-16 text-center">
        <div className="rounded-2xl border border-line bg-card px-6 py-10">
          <h1 className="text-[20px] font-bold tracking-[-0.3px] text-navy">Thank you</h1>
          <p className="mt-2 text-[14px] leading-[1.55] text-muted">
            Your medical history has been sent to {practiceName ?? "the practice"}. There is nothing more to do —
            you can close this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <header className="mb-6">
        <h1 className="text-[22px] font-bold tracking-[-0.4px] text-navy">Medical history</h1>
        <p className="mt-1 text-[13.5px] leading-[1.55] text-muted">
          {practiceName ? `${practiceName} ` : "Your dental practice "}
          asks every patient to keep their medical history up to date, as it affects how you can be treated
          safely. Please answer each question and add any detail that helps.
        </p>
      </header>

      <ol className="space-y-4">
        {MEDICAL_QUESTIONS.map((q, i) => {
          const state = answers[q.key];
          const showDetail = q.invitesDetail && state.answer === "yes";
          return (
            <li key={q.key} className="rounded-xl border border-line bg-card px-4 py-3.5">
              <p className="text-[14px] font-medium leading-[1.45] text-ink">
                <span className="mr-1.5 text-muted tabular-nums">{i + 1}.</span>
                {q.prompt}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2" role="group" aria-label={q.prompt}>
                {CHOICES.map((choice) => {
                  const active = state.answer === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      onClick={() => setAnswer(q.key, choice.value)}
                      aria-pressed={active}
                      className={
                        "rounded-lg border px-3.5 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 " +
                        (active
                          ? "border-navy bg-navy text-white"
                          : "border-line-strong bg-card text-navy hover:bg-card-muted")
                      }
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
              {showDetail ? (
                <input
                  type="text"
                  value={state.detail}
                  onChange={(e) => setDetail(q.key, e.target.value)}
                  placeholder="Please add any detail (optional)"
                  maxLength={1000}
                  className="mt-2.5 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-5 space-y-4">
        <label className="block">
          <span className="text-[13px] font-medium text-navy">Medicines you are currently taking</span>
          <textarea
            value={medications}
            onChange={(e) => setMedications(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="List any medicines, or leave blank if none"
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium text-navy">Allergies</span>
          <textarea
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            rows={2}
            maxLength={5000}
            placeholder="List any allergies, or leave blank if none"
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </label>
      </div>

      <div className="mt-6 rounded-xl border border-line bg-card-muted/40 px-4 py-4">
        <label className="block">
          <span className="text-[13px] font-medium text-navy">Your full name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="Type your full name to sign"
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </label>
        <label className="mt-3 flex items-start gap-2.5 text-[13px] leading-[1.45] text-ink">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line-strong"
          />
          <span>
            I confirm that the information I have given is accurate and complete to the best of my knowledge.
          </span>
        </label>
      </div>

      {status === "error" && error ? (
        <p role="alert" className="mt-4 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[13px] text-status-red">
          {error}
        </p>
      ) : null}
      {unanswered > 0 ? (
        <p className="mt-4 text-[12.5px] text-muted">
          {unanswered} question{unanswered === 1 ? "" : "s"} still to answer.
        </p>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-4 w-full rounded-xl bg-navy px-4 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "submitting" ? "Sending…" : "Send to the practice"}
      </button>
    </main>
  );
}
