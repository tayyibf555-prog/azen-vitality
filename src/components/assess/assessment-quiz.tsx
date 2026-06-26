"use client";

import { useMemo, useState } from "react";
import { Loader2, CheckCircle2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QUIZ_QUESTIONS } from "@/lib/smile-assessment/quiz";

// Shared Smile Assessment quiz UI. A friendly single-page form: the qualifying
// questions plus light contact details. On submit it POSTs to the public
// /api/smile-assessment/submit endpoint and shows a band-specific thank-you.
//
// Used by both the generic page (/assess/<client>) and a campaign landing page
// (/assess/<client>/<slug>). When a campaignSlug is set the submission is
// attributed to that campaign, and the optional headline/intro reframe the hero.
// This is a client component: it imports only QUIZ_QUESTIONS (pure) and fetch —
// never a server-only module.

type Channel = "sms" | "email" | "whatsapp";

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

export function AssessmentQuiz({ clientSlug, campaignSlug, headline, intro }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [firstName, setFirstName] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const answeredCount = Object.keys(answers).length;
  const canSubmit = useMemo(() => {
    if (firstName.trim() === "" || answeredCount === 0) return false;
    if (channel === "email") return email.trim() !== "";
    return phone.trim() !== "";
  }, [firstName, answeredCount, channel, email, phone]);

  function select(questionId: string, value: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
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
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col px-5 py-10">
      <header className="mb-8 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-dark text-white">
          <Sparkles size={18} />
        </span>
        <div>
          <p className="text-lg font-extrabold tracking-tight text-navy">Smile Assessment</p>
          <p className="text-xs text-muted">A quick check to point you to the right next step.</p>
        </div>
      </header>

      <div className="rounded-2xl border border-line bg-card p-6 shadow-[0_1px_3px_rgba(10,14,26,0.06)] sm:p-8">
        {result ? (
          <ThankYou result={result} />
        ) : (
          <form onSubmit={submit} className="space-y-7">
            <div className="space-y-1">
              <h1 className="text-2xl text-navy">{headline || "Let's find your best next step"}</h1>
              <p className="text-sm text-muted">
                {intro ||
                  "A few quick questions. There are no wrong answers, and nothing here is medical advice."}
              </p>
            </div>

            {QUIZ_QUESTIONS.map((q) => (
              <fieldset key={q.id} className="space-y-2">
                <legend className="text-sm font-semibold text-navy">{q.prompt}</legend>
                <div className="grid gap-2">
                  {q.options.map((o) => {
                    const checked = answers[q.id] === o.value;
                    return (
                      <label
                        key={o.value}
                        className={[
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                          checked
                            ? "border-blue-dark/40 bg-blue-dark/10 text-navy"
                            : "border-line-strong bg-card text-ink hover:bg-card-muted",
                        ].join(" ")}
                      >
                        <input
                          type="radio"
                          name={q.id}
                          value={o.value}
                          checked={checked}
                          onChange={() => select(q.id, o.value)}
                          className="h-4 w-4 accent-[var(--blue-dark)]"
                        />
                        <span>{o.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <div className="space-y-4 border-t border-line pt-6">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-navy">Where should we send your next step?</h2>
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
            </div>

            {error ? (
              <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
            ) : null}

            <Button type="submit" variant="primary" className="w-full" disabled={!canSubmit || busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : null}
              See my next step
            </Button>
            <p className="text-center text-xs text-muted">
              By sending this you agree we can contact you about your enquiry. Prices in GBP (£).
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

function ThankYou({ result }: { result: SubmitResult }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={24} />
      </span>
      <h1 className="text-2xl text-navy">Thank you</h1>
      <p className="max-w-sm text-sm text-muted">{result.message}</p>
    </div>
  );
}
