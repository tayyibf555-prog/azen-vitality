"use client";

import { CheckCircle2 } from "lucide-react";
import type { OnboardingField, OnboardingStep } from "@/lib/onboarding/types";

// A live, non-interactive preview of the public new-patient onboarding form, shown in
// the form builder so the owner can see how their chosen questions will look as they
// pick them. It mirrors the real form's branded chrome (logo tile + practice name +
// eyebrow "New patient onboarding", soft brand glow, a card with a thin progress bar)
// and renders the FIRST resolved step's fields compactly by field type. It re-renders
// whenever `steps` changes. Display only — nothing here is interactive.
//
// British English throughout. No clinical advice, no NHS/private framing.

const DOCUMENTS_STEP_ID = "documents";

export function OnboardingPreview({
  practiceName,
  steps,
}: {
  practiceName: string;
  steps: OnboardingStep[];
}) {
  const name = practiceName.trim() || "New patient onboarding";

  // The form always renders the resolved steps then a synthetic consent screen, so the
  // total a patient sees is steps + 1. The documents step is part of `steps` already.
  const total = steps.length > 0 ? steps.length + 1 : 0;
  const first = steps[0];

  return (
    <div className="lg:sticky lg:top-4">
      <p className="mb-2 text-xs font-semibold text-navy">Live preview</p>

      {/* Phone frame */}
      <div className="mx-auto w-full max-w-[300px] rounded-[2rem] border border-line-strong bg-card p-2 shadow-[0_12px_44px_rgba(10,14,26,0.16)]">
        <div className="relative overflow-hidden rounded-[1.6rem] bg-cream px-3 pb-4 pt-5">
          {/* Soft brand glow, mirroring the live form. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(60%_70%_at_50%_0%,rgba(91,196,247,0.22),transparent_72%)]"
          />

          {/* Branded header. */}
          <div className="relative mb-3 flex flex-col items-center gap-1.5 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-card shadow-[0_2px_10px_rgba(10,14,26,0.10)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/copilot-logo.png" alt="" width={26} height={26} className="h-[26px] w-[26px] object-contain" />
            </span>
            <div>
              <p className="text-xs font-bold tracking-tight text-navy">{name}</p>
              <p className="text-[0.55rem] font-semibold uppercase tracking-[0.18em] text-blue-deep">
                New patient onboarding
              </p>
            </div>
          </div>

          {/* Card. */}
          <div className="relative overflow-hidden rounded-xl border border-line bg-card shadow-[0_4px_20px_rgba(10,14,26,0.06)]">
            <div className="h-1 w-full bg-card-muted">
              <div
                className="h-full rounded-r-full bg-blue-dark"
                style={{ width: total > 0 ? `${Math.round((1 / total) * 100)}%` : "0%" }}
              />
            </div>

            {first ? (
              <div className="space-y-2.5 p-3">
                <div className="flex justify-end">
                  <span className="rounded-full bg-card-muted px-2 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wide text-muted">
                    Step 1 of {total}
                  </span>
                </div>

                <p className="pt-0.5 text-sm font-bold leading-snug text-navy">{first.title}</p>
                {first.intro ? (
                  <p className="text-[0.72rem] leading-snug text-muted">{first.intro}</p>
                ) : null}

                <div className="space-y-2.5 pt-0.5">
                  {first.id === DOCUMENTS_STEP_ID ? (
                    <PreviewDocuments />
                  ) : (
                    first.fields.map((field) => <PreviewField key={field.key} field={field} />)
                  )}
                </div>
              </div>
            ) : (
              <div className="p-5 text-center">
                <p className="text-[0.78rem] font-medium leading-snug text-muted">
                  Add some questions to preview the form.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {first ? (
        <p className="mx-auto mt-3 max-w-[300px] text-center text-[0.7rem] leading-snug text-muted">
          This is the opening screen. The rest of your questions follow step by step,
          finishing with a consent screen.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A compact, display-only control per field type, mirroring the public form's
 * look at a smaller scale.
 * ------------------------------------------------------------------------- */

function FieldLabel({ field }: { field: OnboardingField }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[0.72rem] font-semibold text-navy">{field.label}</span>
      {field.required ? (
        <span className="text-[0.6rem] font-semibold text-blue-deep">Required</span>
      ) : (
        <span className="text-[0.6rem] font-medium text-muted">Optional</span>
      )}
    </span>
  );
}

function PreviewField({ field }: { field: OnboardingField }) {
  // Select — show the first couple of option cards so its shape reads clearly.
  if (field.type === "select") {
    const options = (field.options ?? []).slice(0, 3);
    return (
      <div className="space-y-1.5">
        <FieldLabel field={field} />
        <div className="space-y-1.5">
          {options.length > 0 ? (
            options.map((o, i) => (
              <div
                key={o.value}
                className={[
                  "flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5",
                  i === 0 ? "border-blue-dark bg-blue-dark/[0.08]" : "border-line bg-card",
                ].join(" ")}
              >
                <span className="text-[0.68rem] font-medium leading-tight text-ink">{o.label}</span>
                {i === 0 ? (
                  <CheckCircle2 size={13} className="shrink-0 text-blue-dark" aria-hidden />
                ) : (
                  <span
                    className="h-[13px] w-[13px] shrink-0 rounded-full border border-line-strong"
                    aria-hidden
                  />
                )}
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-line bg-card px-2 py-1.5 text-[0.68rem] text-muted">
              Add options to show choices
            </div>
          )}
        </div>
      </div>
    );
  }

  // Yes / no — two pills.
  if (field.type === "yesno") {
    return (
      <div className="space-y-1.5">
        <FieldLabel field={field} />
        <div className="grid grid-cols-2 gap-1.5">
          {["Yes", "No"].map((opt, i) => (
            <div
              key={opt}
              className={[
                "rounded-lg border px-2 py-1.5 text-center text-[0.68rem] font-semibold",
                i === 0
                  ? "border-blue-dark bg-blue-dark/[0.08] text-blue-deep"
                  : "border-line bg-card text-muted",
              ].join(" ")}
            >
              {opt}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Textarea — a taller box.
  if (field.type === "textarea") {
    return (
      <div className="space-y-1">
        <FieldLabel field={field} />
        <div className="h-10 w-full rounded-lg border border-line-strong bg-card" aria-hidden />
      </div>
    );
  }

  // text / email / tel / date — a single input box, with the placeholder echoed.
  return (
    <div className="space-y-1">
      <FieldLabel field={field} />
      <div className="flex h-7 w-full items-center rounded-lg border border-line-strong bg-card px-2">
        <span className="truncate text-[0.66rem] text-muted/70">
          {field.placeholder ?? PLACEHOLDER_BY_TYPE[field.type] ?? ""}
        </span>
      </div>
    </div>
  );
}

const PLACEHOLDER_BY_TYPE: Partial<Record<OnboardingField["type"], string>> = {
  email: "you@example.com",
  tel: "07700 900123",
  date: "DD / MM / YYYY",
};

function PreviewDocuments() {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong bg-card-muted/50 px-3 py-4 text-center">
      <span className="text-[0.72rem] font-semibold text-navy">Add documents</span>
      <span className="text-[0.6rem] text-muted">Optional — PDF or image</span>
    </div>
  );
}
