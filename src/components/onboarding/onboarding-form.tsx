"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Paperclip,
  FileText,
  ImageIcon,
  X,
  UploadCloud,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ONBOARDING_STEPS } from "@/lib/onboarding/steps";
import type {
  OnboardingConsent,
  OnboardingField,
  OnboardingFile,
  OnboardingStep,
} from "@/lib/onboarding/types";

// Public, branded new-patient onboarding form, one step per screen. It mirrors the
// Smile Assessment quiz's chrome (logo tile + practice name + eyebrow, soft brand glow,
// a card with a thin progress bar, ONE step on screen at a time, Back, the assessEnter
// ease-out keyframe gated behind motion-safe:, focus-visible rings, a ThankYou screen).
//
// Unlike the assessment (an adaptive AI funnel) this is a configurable, generic
// sequence: it renders the resolved `steps` by field type, validates required fields
// before advancing, has a dedicated optional documents-upload screen, then a final
// consent screen, and POSTs everything to /api/onboarding/submit.
//
// The steps are resolved per-practice on the server (see resolveSteps) and passed in.
// When no steps are provided we fall back to the hardcoded default flow so the form
// still works on its own. The documents step (id "documents", no fields) is always the
// final resolved step and is rendered specially; consent is a synthetic screen after it.
//
// British English throughout. No clinical advice, no NHS/private framing.

const DOCUMENTS_STEP_ID = "documents";
const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, mirrors the upload endpoint.
const ACCEPT = "application/pdf,image/jpeg,image/png,image/heic,image/webp";

interface Props {
  clientSlug: string;
  /** Practice display name for the branded header (e.g. "Vitality Dental"). */
  practiceName?: string;
  /**
   * The resolved form steps for this practice (from resolveSteps). Defaults to the
   * hardcoded ONBOARDING_STEPS so the form still works if rendered without a config.
   * The last step is expected to be the documents step (id "documents", no fields).
   */
  steps?: OnboardingStep[];
  /** The onboarding form slug (from /onboard/<client>/<slug>). Attributes the submission
   *  to that named form; omitted for the default /onboard/<client> flow. */
  formSlug?: string;
  /** Optional public hero copy for a named form (shown under the practice name). */
  headline?: string;
  intro?: string;
}

/** A file in the middle of, or finished, uploading — tracked per picked file. */
interface UploadItem {
  /** Stable local id so a row survives re-renders and removal targets the right one. */
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  /** The server reference once the upload succeeds. */
  ref?: OnboardingFile;
  error?: string;
}

type Phase = "step" | "consent" | "thanks";

const DEFAULT_CONSENT: OnboardingConsent = {
  sms: true,
  email: true,
  marketing: false,
  data: false,
};

export function OnboardingForm({ clientSlug, practiceName, steps, formSlug, headline, intro }: Props) {
  // The flow: every resolved step, then consent as a final synthetic screen.
  const STEPS = steps && steps.length > 0 ? steps : ONBOARDING_STEPS;
  const TOTAL = STEPS.length + 1; // +1 for the consent screen.

  const [index, setIndex] = useState(0); // index into STEPS
  const [phase, setPhase] = useState<Phase>("step");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [consent, setConsent] = useState<OnboardingConsent>(DEFAULT_CONSENT);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Bumped on every screen change so the entrance animation re-triggers.
  const [animKey, setAnimKey] = useState(0);

  const name = practiceName?.trim() || "New patient onboarding";

  // 1-based position for the progress bar: each step, then consent, then full.
  const position = phase === "consent" ? STEPS.length + 1 : phase === "thanks" ? TOTAL : index + 1;
  const progress = Math.round((position / TOTAL) * 100);

  const current = STEPS[index];

  /** Files successfully uploaded, ready to attach to the submission. */
  const uploadedFiles = useMemo(
    () => uploads.filter((u) => u.status === "done" && u.ref).map((u) => u.ref as OnboardingFile),
    [uploads],
  );
  const anyUploading = uploads.some((u) => u.status === "uploading");

  function setAnswer(key: string, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  /** Validate the required fields on the current step before advancing. */
  function validateStep(): string | null {
    for (const field of current.fields) {
      if (!field.required) continue;
      const v = (answers[field.key] ?? "").trim();
      if (v === "") return `${field.label} is required.`;
    }
    return null;
  }

  function goNext() {
    if (busy) return;
    setError(null);

    // Documents step has no fields to validate; everything else does.
    if (current.id !== DOCUMENTS_STEP_ID) {
      const msg = validateStep();
      if (msg) {
        setError(msg);
        return;
      }
    }

    if (index < STEPS.length - 1) {
      setIndex((i) => i + 1);
    } else {
      setPhase("consent");
    }
    setAnimKey((k) => k + 1);
  }

  function goBack() {
    if (busy) return;
    setError(null);
    if (phase === "consent") {
      setPhase("step");
    } else if (index > 0) {
      setIndex((i) => i - 1);
    } else {
      return;
    }
    setAnimKey((k) => k + 1);
  }

  // --- Documents upload ----------------------------------------------------

  async function uploadOne(file: File) {
    const localId = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setUploads((prev) => [
      ...prev,
      { localId, name: file.name, size: file.size, status: "uploading" },
    ]);
    try {
      const form = new FormData();
      form.append("clientSlug", clientSlug);
      form.append("file", file);
      const res = await fetch("/api/onboarding/upload", { method: "POST", body: form });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; file?: OnboardingFile; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.file) {
        setUploads((prev) =>
          prev.map((u) =>
            u.localId === localId
              ? { ...u, status: "error", error: data?.error || "Upload failed" }
              : u,
          ),
        );
        return;
      }
      setUploads((prev) =>
        prev.map((u) => (u.localId === localId ? { ...u, status: "done", ref: data.file } : u)),
      );
    } catch {
      setUploads((prev) =>
        prev.map((u) =>
          u.localId === localId
            ? { ...u, status: "error", error: "Upload failed, please try again" }
            : u,
        ),
      );
    }
  }

  function onPickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const room = MAX_FILES - uploads.length;
    if (room <= 0) {
      setError(`You can add up to ${MAX_FILES} documents.`);
      return;
    }
    const chosen = Array.from(fileList).slice(0, room);
    if (Array.from(fileList).length > room) {
      setError(`You can add up to ${MAX_FILES} documents, so only the first ${room} were added.`);
    }
    for (const file of chosen) {
      if (file.size > MAX_FILE_BYTES) {
        setUploads((prev) => [
          ...prev,
          {
            localId: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            size: file.size,
            status: "error",
            error: "That file is too large (max 10MB)",
          },
        ]);
        continue;
      }
      void uploadOne(file);
    }
  }

  function removeUpload(localId: string) {
    setUploads((prev) => prev.filter((u) => u.localId !== localId));
  }

  // --- Submit --------------------------------------------------------------

  async function submit() {
    if (busy) return;
    if (!consent.data) {
      setError("Please tick the box to let us store your details so we can register you.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          formSlug,
          answers,
          files: uploadedFiles,
          consent,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        if (res.status === 429) {
          setError("We've already received your details. Our team will be in touch shortly.");
        } else {
          setError(data?.error || "Sorry, something went wrong. Please try again in a moment.");
        }
        setBusy(false);
        return;
      }
      setDone(true);
      setPhase("thanks");
      setAnimKey((k) => k + 1);
    } catch {
      setError("Sorry, something went wrong. Please try again in a moment.");
    }
    setBusy(false);
  }

  const canGoBack = phase === "consent" || index > 0;

  return (
    <main className="relative mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
      <style>{ENTER_KEYFRAMES}</style>

      {/* Soft brand glow behind the card. */}
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
            New patient onboarding
          </p>
        </div>
      </header>

      {/* Optional per-form hero copy (named forms only). */}
      {headline || intro ? (
        <div className="mb-5 text-center">
          {headline ? <h1 className="text-xl font-semibold text-navy">{headline}</h1> : null}
          {intro ? <p className="mx-auto mt-1 max-w-md text-sm text-muted">{intro}</p> : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[1.4rem] border border-line bg-card shadow-[0_8px_40px_rgba(10,14,26,0.08)]">
        {/* Progress track — grows as steps complete, full at the thank-you screen. */}
        <div className="h-1.5 w-full bg-card-muted" aria-hidden>
          <div
            className="h-full rounded-r-full bg-blue-dark transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="p-6 sm:p-8">
          {phase === "thanks" && done ? (
            <ThankYou name={answers.first_name?.trim()} />
          ) : phase === "consent" ? (
            <ConsentStep
              animKey={animKey}
              consent={consent}
              setConsent={setConsent}
              busy={busy}
              error={error}
              onSubmit={submit}
              onBack={goBack}
            />
          ) : (
            <StepScreen
              animKey={animKey}
              step={current}
              position={position}
              total={TOTAL}
              answers={answers}
              setAnswer={setAnswer}
              error={error}
              canGoBack={canGoBack}
              onBack={goBack}
              onNext={goNext}
              // Documents wiring (only used by the documents step):
              uploads={uploads}
              anyUploading={anyUploading}
              onPickFiles={onPickFiles}
              removeUpload={removeUpload}
            />
          )}
        </div>
      </div>

      <p className="mt-5 text-center text-[0.7rem] text-muted">
        Your details are kept secure and used only to register you and arrange your care.
      </p>
    </main>
  );
}

/* ---------------------------------------------------------------------------
 * Step screen — renders one ONBOARDING_STEPS entry generically by field type.
 * ------------------------------------------------------------------------- */

function StepScreen({
  animKey,
  step,
  position,
  total,
  answers,
  setAnswer,
  error,
  canGoBack,
  onBack,
  onNext,
  uploads,
  anyUploading,
  onPickFiles,
  removeUpload,
}: {
  animKey: number;
  step: OnboardingStep;
  position: number;
  total: number;
  answers: Record<string, string>;
  setAnswer: (key: string, value: string) => void;
  error: string | null;
  canGoBack: boolean;
  onBack: () => void;
  onNext: () => void;
  uploads: UploadItem[];
  anyUploading: boolean;
  onPickFiles: (files: FileList | null) => void;
  removeUpload: (localId: string) => void;
}) {
  const isDocuments = step.id === DOCUMENTS_STEP_ID;

  // Move focus to the step region on each advance so a screen reader announces it.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [animKey]);

  return (
    <div
      key={animKey}
      ref={regionRef}
      tabIndex={-1}
      className="outline-none motion-safe:[animation:assessEnter_240ms_ease-out]"
    >
      <div className="mb-5 flex items-center justify-between">
        {canGoBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            <ArrowLeft size={14} />
            Back
          </button>
        ) : (
          <span />
        )}
        <span className="rounded-full bg-card-muted px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
          Step {position} of {total}
        </span>
      </div>

      <h2 className="text-[1.4rem] font-bold leading-snug text-navy">{step.title}</h2>
      {step.intro ? <p className="mt-1.5 text-sm text-muted">{step.intro}</p> : null}

      <div className="mt-5 space-y-5">
        {isDocuments ? (
          <DocumentsField
            uploads={uploads}
            onPickFiles={onPickFiles}
            removeUpload={removeUpload}
          />
        ) : (
          step.fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={answers[field.key] ?? ""}
              onChange={(v) => setAnswer(field.key, v)}
            />
          ))
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]"
        >
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        variant="primary"
        className="mt-6 w-full"
        onClick={onNext}
        disabled={anyUploading}
      >
        {anyUploading ? (
          <>
            <Loader2 size={16} className="motion-safe:animate-spin" />
            Uploading&hellip;
          </>
        ) : (
          <>
            Continue
            <ArrowRight size={16} />
          </>
        )}
      </Button>

      {isDocuments ? (
        <p className="mt-3 text-center text-xs text-muted">
          This step is optional. You are welcome to bring any documents along instead.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Field control — one input per field type.
 * ------------------------------------------------------------------------- */

const inputClass =
  "w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus-visible:border-blue-dark/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: OnboardingField;
  value: string;
  onChange: (value: string) => void;
}) {
  const labelId = `onb-${field.key}`;

  const labelRow = (
    <span className="mb-1.5 flex items-baseline gap-1.5">
      <span className="text-sm font-semibold text-navy">{field.label}</span>
      {!field.required ? (
        <span className="text-[0.7rem] font-medium text-muted">Optional</span>
      ) : null}
    </span>
  );

  // Radio-card group for selects (matches the assessment's option cards).
  if (field.type === "select") {
    return (
      <fieldset>
        <legend className="mb-1.5 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-navy">{field.label}</span>
          {!field.required ? (
            <span className="text-[0.7rem] font-medium text-muted">Optional</span>
          ) : null}
        </legend>
        {field.help ? <p className="-mt-0.5 mb-2 text-xs text-muted">{field.help}</p> : null}
        <div className="grid gap-2.5">
          {(field.options ?? []).map((o) => {
            const checked = value === o.value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={checked}
                onClick={() => onChange(o.value)}
                className={[
                  "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  checked
                    ? "border-blue-dark bg-blue-dark/[0.08] shadow-[0_3px_14px_rgba(43,138,192,0.14)]"
                    : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted motion-safe:hover:-translate-y-0.5",
                ].join(" ")}
              >
                <span className={["text-sm font-medium", checked ? "text-navy" : "text-ink"].join(" ")}>
                  {o.label}
                </span>
                {checked ? (
                  <CheckCircle2 size={18} className="shrink-0 text-blue-dark" aria-hidden />
                ) : (
                  <span
                    className="h-[18px] w-[18px] shrink-0 rounded-full border border-line-strong"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  // Two-button yes/no.
  if (field.type === "yesno") {
    return (
      <fieldset>
        <legend className="mb-1.5 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-navy">{field.label}</span>
          {!field.required ? (
            <span className="text-[0.7rem] font-medium text-muted">Optional</span>
          ) : null}
        </legend>
        {field.help ? <p className="-mt-0.5 mb-2 text-xs text-muted">{field.help}</p> : null}
        <div className="grid grid-cols-2 gap-2.5">
          {[
            { v: "yes", label: "Yes" },
            { v: "no", label: "No" },
          ].map((opt) => {
            const checked = value === opt.v;
            return (
              <button
                key={opt.v}
                type="button"
                aria-pressed={checked}
                onClick={() => onChange(opt.v)}
                className={[
                  "rounded-xl border px-3.5 py-3 text-sm font-semibold transition duration-150 ease-out",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  checked
                    ? "border-blue-dark bg-blue-dark/[0.08] text-blue-deep shadow-[0_3px_14px_rgba(43,138,192,0.12)]"
                    : "border-line bg-card text-muted hover:border-blue-dark/40 hover:bg-card-muted",
                ].join(" ")}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  // Textarea.
  if (field.type === "textarea") {
    return (
      <label className="block" htmlFor={labelId}>
        {labelRow}
        {field.help ? <p className="-mt-0.5 mb-2 text-xs text-muted">{field.help}</p> : null}
        <textarea
          id={labelId}
          value={value}
          rows={3}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={[inputClass, "min-h-[88px] resize-y"].join(" ")}
        />
      </label>
    );
  }

  // text / email / tel / date.
  const inputType =
    field.type === "email" ? "email" : field.type === "tel" ? "tel" : field.type === "date" ? "date" : "text";
  const autoComplete =
    field.key === "first_name"
      ? "given-name"
      : field.key === "last_name"
        ? "family-name"
        : field.key === "email"
          ? "email"
          : field.key === "phone"
            ? "tel"
            : field.key === "address_line1"
              ? "address-line1"
              : field.key === "address_postcode"
                ? "postal-code"
                : field.key === "date_of_birth"
                  ? "bday"
                  : undefined;

  return (
    <label className="block" htmlFor={labelId}>
      {labelRow}
      {field.help ? <p className="-mt-0.5 mb-2 text-xs text-muted">{field.help}</p> : null}
      <input
        id={labelId}
        type={inputType}
        inputMode={field.type === "tel" ? "tel" : undefined}
        autoComplete={autoComplete}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </label>
  );
}

/* ---------------------------------------------------------------------------
 * Documents field — picker + per-file chips with progress/remove.
 * ------------------------------------------------------------------------- */

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentsField({
  uploads,
  onPickFiles,
  removeUpload,
}: {
  uploads: UploadItem[];
  onPickFiles: (files: FileList | null) => void;
  removeUpload: (localId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const atLimit = uploads.length >= MAX_FILES;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        onChange={(e) => {
          onPickFiles(e.target.files);
          // Reset so the same file can be re-picked if removed.
          if (inputRef.current) inputRef.current.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={atLimit}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-card-muted/50 px-6 py-8 text-center transition-colors hover:border-blue-dark/40 hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30 disabled:opacity-50 disabled:pointer-events-none"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-card text-blue-dark shadow-sm">
          <UploadCloud size={22} aria-hidden />
        </span>
        <span className="text-sm font-semibold text-navy">
          {atLimit ? "You've added the maximum" : "Add documents"}
        </span>
        <span className="text-xs text-muted">PDF or image, up to 10MB each (max {MAX_FILES})</span>
      </button>

      {uploads.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {uploads.map((u) => {
            const isImage = /image/i.test(u.name) || /\.(jpe?g|png|heic|webp)$/i.test(u.name);
            const Icon = isImage ? ImageIcon : FileText;
            return (
              <li
                key={u.localId}
                className="flex items-center gap-3 rounded-xl border border-line bg-card px-3 py-2.5"
              >
                <span
                  className={[
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    u.status === "error" ? "bg-danger/10 text-danger" : "bg-blue-dark/10 text-blue-dark",
                  ].join(" ")}
                  aria-hidden
                >
                  {u.status === "uploading" ? (
                    <Loader2 size={16} className="motion-safe:animate-spin" />
                  ) : (
                    <Icon size={16} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{u.name}</span>
                  <span
                    className={[
                      "block text-xs",
                      u.status === "error" ? "text-danger" : "text-muted",
                    ].join(" ")}
                  >
                    {u.status === "uploading"
                      ? "Uploading…"
                      : u.status === "error"
                        ? u.error || "Upload failed"
                        : `${bytes(u.size)} · Added`}
                  </span>
                </span>
                {u.status === "done" ? (
                  <CheckCircle2 size={18} className="shrink-0 text-success" aria-hidden />
                ) : null}
                <button
                  type="button"
                  onClick={() => removeUpload(u.localId)}
                  aria-label={`Remove ${u.name}`}
                  className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
                >
                  <X size={16} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <Paperclip size={13} aria-hidden />
          For example a referral letter, previous records, or insurance details.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Consent screen — the final step before submit.
 * ------------------------------------------------------------------------- */

const CONSENT_OPTIONS: {
  key: keyof OnboardingConsent;
  label: string;
  description: string;
  required?: boolean;
}[] = [
  {
    key: "data",
    label: "Store and use my details to register me",
    description: "We need this to set up your record and arrange your care.",
    required: true,
  },
  {
    key: "sms",
    label: "Contact me by text message",
    description: "Appointment confirmations and reminders.",
  },
  {
    key: "email",
    label: "Contact me by email",
    description: "Confirmations, reminders and anything you ask us about.",
  },
  {
    key: "marketing",
    label: "Send me occasional practice updates",
    description: "Offers and news. You can opt out at any time.",
  },
];

function ConsentStep({
  animKey,
  consent,
  setConsent,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  animKey: number;
  consent: OnboardingConsent;
  setConsent: (c: OnboardingConsent) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  function toggle(key: keyof OnboardingConsent) {
    setConsent({ ...consent, [key]: !consent[key] });
  }

  return (
    <div
      key={animKey}
      className="motion-safe:[animation:assessEnter_240ms_ease-out]"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="-mx-1 mb-5 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-dark/10 text-blue-dark">
          <ShieldCheck size={20} aria-hidden />
        </span>
        <div className="space-y-1">
          <h2 className="text-xl font-bold leading-tight text-navy">A few permissions</h2>
          <p className="text-xs text-muted">
            Tell us how we may keep in touch. You can change any of these later.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-2.5">
        {CONSENT_OPTIONS.map((opt) => {
          const checked = consent[opt.key];
          return (
            <button
              key={opt.key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => toggle(opt.key)}
              className={[
                "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition duration-150 ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                checked
                  ? "border-blue-dark bg-blue-dark/[0.06]"
                  : "border-line bg-card hover:border-blue-dark/40 hover:bg-card-muted",
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
                  <span className="text-sm font-semibold text-navy">{opt.label}</span>
                  {opt.required ? (
                    <span className="text-[0.7rem] font-semibold text-blue-deep">Required</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{opt.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-muted">
        We store your details securely and use them only to register you and look after your care.
        We never sell your information.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-[#b3261e]"
        >
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        variant="primary"
        className="mt-5 w-full"
        onClick={onSubmit}
        disabled={busy || !consent.data}
      >
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" /> : null}
        Submit and register
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Thank-you screen.
 * ------------------------------------------------------------------------- */

function ThankYou({ name }: { name?: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center motion-safe:[animation:assessEnter_240ms_ease-out]">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 size={28} />
      </span>
      <h1 className="text-2xl font-bold text-navy">{name ? `Thank you, ${name}` : "Thank you"}</h1>
      <p className="max-w-sm text-sm text-muted">
        We have received your details. Our team will be in touch shortly to welcome you and arrange
        your first visit.
      </p>
    </div>
  );
}

// Opacity + small translateY only (no layout-property animation). Gated behind
// motion-safe: at the call site so prefers-reduced-motion users get no movement.
const ENTER_KEYFRAMES = `@keyframes assessEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
