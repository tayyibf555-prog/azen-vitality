"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EXEMPTION_CATEGORIES,
  PAYING_KEY,
  PAYING_LABEL,
} from "@/lib/fp17/exemptions";
import { FP17_COPY } from "@/lib/fp17/copy";

// Public, branded FP17 / PR consent + exemption declaration form.
//
// DUMB by design: every rule lives in the tested modules (exemptions.ts / validate.ts)
// and the server re-validates on submit. This component only collects and POSTs.
//
// Two steps, mirroring the paper form:
//   FRONT  — consent to the course of treatment (+ optional data sharing, name/dob).
//   BACK   — one exemption claim OR the "I will pay" opt-out, the evidence
//            acknowledgement (for an exemption), the declaration-truth tick, and a
//            typed signature.
//
// THE HONESTY LINE (FP17_COPY.notCompass) is shown on every screen: nothing here is
// submitted to the NHS (Compass). Neutral chrome, no NHS-vs-private funding framing
// beyond the declaration's own tick-boxes. British English throughout.

type Phase = "consent" | "declaration" | "thanks";

interface Props {
  clientSlug: string;
  token: string;
  practiceName: string;
}

export function Fp17Form({ clientSlug, token, practiceName }: Props) {
  const [phase, setPhase] = useState<Phase>("consent");

  // Front (consent).
  const [consentTreatment, setConsentTreatment] = useState(false);
  const [consentDataShare, setConsentDataShare] = useState(false);
  const [patientName, setPatientName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Back (declaration).
  const [choice, setChoice] = useState<string | null>(null);
  const [evidenceAck, setEvidenceAck] = useState(false);
  const [declarationTruth, setDeclarationTruth] = useState(false);
  const [signature, setSignature] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [animKey, setAnimKey] = useState(0);

  const name = practiceName?.trim() || "Your practice";
  const isExemptionChoice = choice !== null && choice !== PAYING_KEY;

  function bump() {
    setAnimKey((k) => k + 1);
  }

  function goToDeclaration() {
    setError(null);
    if (!consentTreatment) {
      setError("Please confirm you consent to the course of treatment to continue.");
      return;
    }
    setPhase("declaration");
    bump();
  }

  function goBack() {
    if (busy) return;
    setError(null);
    setPhase("consent");
    bump();
  }

  async function submit() {
    if (busy) return;
    setError(null);

    // Mirror the server rules for a friendly inline message; the server re-validates.
    if (!choice) {
      setError("Please choose one option below.");
      return;
    }
    if (isExemptionChoice && !evidenceAck) {
      setError("Please confirm you understand you may be asked to show evidence.");
      return;
    }
    if (!declarationTruth) {
      setError("Please confirm the information you have given is correct.");
      return;
    }
    if (signature.trim() === "") {
      setError("Please type your full name to sign the declaration.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/fp17/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          token,
          exemptionCategory: choice,
          evidenceAck,
          declarationTruth,
          consentTreatment,
          consentDataShare,
          signatureMethod: "typed",
          signatureValue: signature.trim(),
          patientName: patientName.trim() || undefined,
          dateOfBirth: dateOfBirth.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        if (res.status === 429) {
          setError(
            "The form is busy right now. Please wait a moment and tap submit again — your answers are saved on this screen.",
          );
        } else if (res.status === 503) {
          setError(
            "This form is not currently accepting declarations. Please speak to the practice team.",
          );
        } else {
          setError(data?.error || "Sorry, something went wrong. Please try again in a moment.");
        }
        setBusy(false);
        return;
      }
      setPhase("thanks");
      bump();
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <main className="relative mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
      <style>{ENTER_KEYFRAMES}</style>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,rgba(91,196,247,0.20),transparent_72%)]"
      />

      <header className="mb-6 flex flex-col items-center gap-3 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-card shadow-[0_4px_16px_rgba(10,14,26,0.10)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/copilot-logo.png" alt={`${name} logo`} width={44} height={44} className="h-11 w-11 object-contain" />
        </span>
        <div className="space-y-0.5">
          <p className="text-lg font-bold tracking-tight text-navy">{name}</p>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
            NHS dental declaration
          </p>
        </div>
      </header>

      <div className="overflow-hidden rounded-[1.4rem] border border-line bg-card shadow-[0_8px_40px_rgba(10,14,26,0.08)]">
        <div className="p-6 sm:p-8">
          {phase === "thanks" ? (
            <ThankYou animKey={animKey} name={patientName.trim()} />
          ) : phase === "consent" ? (
            <ConsentStep
              animKey={animKey}
              consentTreatment={consentTreatment}
              setConsentTreatment={setConsentTreatment}
              consentDataShare={consentDataShare}
              setConsentDataShare={setConsentDataShare}
              patientName={patientName}
              setPatientName={setPatientName}
              dateOfBirth={dateOfBirth}
              setDateOfBirth={setDateOfBirth}
              error={error}
              onNext={goToDeclaration}
            />
          ) : (
            <DeclarationStep
              animKey={animKey}
              choice={choice}
              setChoice={setChoice}
              isExemptionChoice={isExemptionChoice}
              evidenceAck={evidenceAck}
              setEvidenceAck={setEvidenceAck}
              declarationTruth={declarationTruth}
              setDeclarationTruth={setDeclarationTruth}
              signature={signature}
              setSignature={setSignature}
              error={error}
              busy={busy}
              onBack={goBack}
              onSubmit={submit}
            />
          )}
        </div>
      </div>

      {/* The load-bearing honesty line — on every screen. */}
      <p className="mt-5 flex items-start justify-center gap-1.5 text-center text-[0.72rem] leading-relaxed text-muted">
        <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>{FP17_COPY.notCompass}</span>
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------------- */

const inputClass =
  "w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";

function CheckRow({
  checked,
  onToggle,
  label,
  required,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={[
        "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50",
        checked ? "border-blue-dark bg-blue-dark/[0.06]" : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted",
      ].join(" ")}
    >
      <span
        className={[
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
          checked ? "border-blue-dark bg-blue-dark text-white" : "border-line-strong bg-card",
        ].join(" ")}
        aria-hidden
      >
        {checked ? <CheckCircle2 size={14} /> : null}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium text-navy">{label}</span>
          {required ? <span className="text-[0.7rem] font-semibold text-blue-deep">Required</span> : null}
        </span>
      </span>
    </button>
  );
}

function ConsentStep({
  animKey,
  consentTreatment,
  setConsentTreatment,
  consentDataShare,
  setConsentDataShare,
  patientName,
  setPatientName,
  dateOfBirth,
  setDateOfBirth,
  error,
  onNext,
}: {
  animKey: number;
  consentTreatment: boolean;
  setConsentTreatment: (v: boolean) => void;
  consentDataShare: boolean;
  setConsentDataShare: (v: boolean) => void;
  patientName: string;
  setPatientName: (v: string) => void;
  dateOfBirth: string;
  setDateOfBirth: (v: string) => void;
  error: string | null;
  onNext: () => void;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [animKey]);

  return (
    <div key={animKey} ref={regionRef} tabIndex={-1} className="outline-none motion-safe:[animation:assessEnter_240ms_ease-out]">
      <div className="mb-5 flex items-center justify-between">
        <span />
        <span className="rounded-full bg-card-muted px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
          Step 1 of 2
        </span>
      </div>

      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-dark/10 text-blue-dark">
          <ShieldCheck size={20} aria-hidden />
        </span>
        <div className="space-y-1">
          <h2 className="text-xl font-bold leading-tight text-navy">Your consent</h2>
          <p className="text-xs text-muted">{FP17_COPY.formIntro}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-navy">Your name</span>
            <span className="text-[0.7rem] font-medium text-muted">Optional</span>
          </span>
          <input
            type="text"
            autoComplete="name"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            className={inputClass}
            placeholder="Full name"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-navy">Date of birth</span>
            <span className="text-[0.7rem] font-medium text-muted">Optional</span>
          </span>
          <input
            type="date"
            autoComplete="bday"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="mt-4 space-y-2.5">
        <CheckRow
          checked={consentTreatment}
          onToggle={() => setConsentTreatment(!consentTreatment)}
          label={FP17_COPY.consentTreatment}
          required
        />
        <CheckRow
          checked={consentDataShare}
          onToggle={() => setConsentDataShare(!consentDataShare)}
          label={FP17_COPY.consentDataShare}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]">
          {error}
        </p>
      ) : null}

      <Button type="button" variant="primary" className="mt-6 w-full" onClick={onNext}>
        Continue
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}

function DeclarationStep({
  animKey,
  choice,
  setChoice,
  isExemptionChoice,
  evidenceAck,
  setEvidenceAck,
  declarationTruth,
  setDeclarationTruth,
  signature,
  setSignature,
  error,
  busy,
  onBack,
  onSubmit,
}: {
  animKey: number;
  choice: string | null;
  setChoice: (v: string) => void;
  isExemptionChoice: boolean;
  evidenceAck: boolean;
  setEvidenceAck: (v: boolean) => void;
  declarationTruth: boolean;
  setDeclarationTruth: (v: boolean) => void;
  signature: string;
  setSignature: (v: string) => void;
  error: string | null;
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [animKey]);

  return (
    <div key={animKey} ref={regionRef} tabIndex={-1} className="outline-none motion-safe:[animation:assessEnter_240ms_ease-out]">
      <div className="mb-5 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="rounded-full bg-card-muted px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
          Step 2 of 2
        </span>
      </div>

      <h2 className="text-xl font-bold leading-tight text-navy">Help with the cost of your treatment</h2>
      <p className="mt-1.5 text-sm text-muted">
        Choose the one option that applies to you. If none applies, choose that you will pay.
      </p>

      <fieldset className="mt-5">
        <legend className="sr-only">Exemption category</legend>
        <div className="grid gap-2.5">
          {EXEMPTION_CATEGORIES.map((c) => (
            <ChoiceCard
              key={c.key}
              checked={choice === c.key}
              onSelect={() => setChoice(c.key)}
              label={c.label}
              note={c.note}
            />
          ))}
          <ChoiceCard
            checked={choice === PAYING_KEY}
            onSelect={() => setChoice(PAYING_KEY)}
            label={PAYING_LABEL}
          />
        </div>
      </fieldset>

      {isExemptionChoice ? (
        <div className="mt-4">
          <CheckRow
            checked={evidenceAck}
            onToggle={() => setEvidenceAck(!evidenceAck)}
            label={FP17_COPY.evidenceAck}
            required
          />
        </div>
      ) : null}

      <div className="mt-3">
        <CheckRow
          checked={declarationTruth}
          onToggle={() => setDeclarationTruth(!declarationTruth)}
          label={FP17_COPY.declarationTruth}
          required
        />
      </div>

      <label className="mt-5 block">
        <span className="mb-1.5 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-navy">Sign by typing your full name</span>
          <span className="text-[0.7rem] font-semibold text-blue-deep">Required</span>
        </span>
        <input
          type="text"
          autoComplete="name"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          className={inputClass}
          placeholder="Type your full name"
        />
      </label>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]">
          {error}
        </p>
      ) : null}

      <Button type="button" variant="primary" className="mt-6 w-full" onClick={onSubmit} disabled={busy}>
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        Submit declaration
      </Button>
    </div>
  );
}

function ChoiceCard({
  checked,
  onSelect,
  label,
  note,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  note?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={[
        "flex items-start justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        checked
          ? "border-blue-dark bg-blue-dark/[0.08] shadow-[0_3px_14px_rgba(43,138,192,0.14)]"
          : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted",
      ].join(" ")}
    >
      <span className="min-w-0">
        <span className={["block text-sm font-medium", checked ? "text-navy" : "text-ink"].join(" ")}>{label}</span>
        {note ? <span className="mt-1 block text-xs text-muted">{note}</span> : null}
      </span>
      {checked ? (
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-blue-dark" aria-hidden />
      ) : (
        <span className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border border-line-strong" aria-hidden />
      )}
    </button>
  );
}

function ThankYou({ animKey, name }: { animKey: number; name?: string }) {
  return (
    <div key={animKey} className="flex flex-col items-center gap-4 py-6 text-center motion-safe:[animation:assessEnter_240ms_ease-out]">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={28} />
      </span>
      <h1 className="text-2xl font-bold text-navy">{name ? `Thank you, ${name}` : "Thank you"}</h1>
      <p className="max-w-sm text-sm text-muted">{FP17_COPY.thanks}</p>
    </div>
  );
}

const ENTER_KEYFRAMES = `@keyframes assessEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
