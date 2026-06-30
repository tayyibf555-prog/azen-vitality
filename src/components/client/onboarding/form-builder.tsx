"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Check, AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/primitives";
import { resolveSteps } from "@/lib/onboarding/resolve";
import type {
  CustomQuestion,
  LibraryQuestion,
  OnboardingCategory,
  OnboardingConfig,
  OnboardingFieldOption,
  OnboardingFieldType,
} from "@/lib/onboarding/types";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";

// The per-practice onboarding form builder. The owner or coordinator picks which
// pre-loaded library questions to include (and which are required), adds their own
// custom questions, and saves the config the PUBLIC form reads. A live phone preview
// on the right recomputes from the working config as they edit, mirroring the Smile
// Assessment campaign builder's side-by-side layout.
//
// resolveSteps is pure and client-safe, so the preview resolves the working config in
// the browser exactly the way the public page does on the server.
//
// British English throughout. No clinical advice, no NHS/private framing.

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

const MAX_CUSTOM = 15;

// Category metadata for the checklist grouping and the custom-question category select.
const CATEGORY_ORDER: OnboardingCategory[] = [
  "personal",
  "contact",
  "address",
  "medical",
  "dental",
  "preferences",
  "marketing",
];
const CATEGORY_LABEL: Record<OnboardingCategory, string> = {
  personal: "Personal",
  contact: "Contact",
  address: "Address",
  medical: "Medical",
  dental: "Dental history",
  preferences: "Preferences",
  marketing: "How they found us",
};

// Custom questions never carry a consent control — consent has its own screen — so the
// type select offers only the input types a practice can mint.
const CUSTOM_TYPES: { value: OnboardingFieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "tel", label: "Phone" },
  { value: "date", label: "Date" },
  { value: "select", label: "Multiple choice" },
  { value: "yesno", label: "Yes / no" },
];

/** Generate a stable custom-<kebab> key from a label. */
function customKeyFromLabel(label: string): string {
  const kebab = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom-${kebab || "question"}`;
}

/** Seed a working config from the library defaults (used when none is saved yet). */
function seedConfig(library: LibraryQuestion[]): OnboardingConfig {
  const enabledKeys = library.filter((q) => q.defaultEnabled).map((q) => q.key);
  const required: Record<string, boolean> = {};
  // Mirror resolveSteps' default required set so the toggles start in the right place.
  const DEFAULT_REQUIRED = new Set<string>([
    "first_name",
    "last_name",
    "date_of_birth",
    "phone",
    "email",
    "address_line1",
    "address_postcode",
    "site",
    "reason",
  ]);
  for (const q of library) {
    if (q.requirable && DEFAULT_REQUIRED.has(q.key) && enabledKeys.includes(q.key)) {
      required[q.key] = true;
    }
  }
  return { enabledKeys, required, custom: [] };
}

interface CustomDraft {
  label: string;
  type: OnboardingFieldType;
  optionsText: string;
  required: boolean;
  category: OnboardingCategory;
}

const EMPTY_DRAFT: CustomDraft = {
  label: "",
  type: "text",
  optionsText: "",
  required: false,
  category: "personal",
};

export function FormBuilder({
  clientSlug,
  practiceName,
}: {
  clientSlug: string;
  practiceName: string;
}) {
  const [library, setLibrary] = useState<LibraryQuestion[]>([]);
  const [config, setConfig] = useState<OnboardingConfig | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [draft, setDraft] = useState<CustomDraft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/onboarding/config?client=${encodeURIComponent(clientSlug)}`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        config?: OnboardingConfig | null;
        library?: LibraryQuestion[];
        error?: string;
      };
      if (!res.ok || !data.ok || !data.library) {
        throw new Error(data.error || `Could not load the form (${res.status}).`);
      }
      setLibrary(data.library);
      setConfig(data.config ?? seedConfig(data.library));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the form.");
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
    setSaved(false);
    setSaveError(null);
    void load();
  }, [load]);

  // Library grouped by category, in a stable order, for the checklist.
  const grouped = useMemo(() => {
    const byCat = new Map<OnboardingCategory, LibraryQuestion[]>();
    for (const q of library) {
      const list = byCat.get(q.category) ?? [];
      list.push(q);
      byCat.set(q.category, list);
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      questions: byCat.get(c) as LibraryQuestion[],
    }));
  }, [library]);

  // The steps the public form would render from the current working config. Pure.
  const previewSteps = useMemo(() => resolveSteps(config), [config]);

  // Any change to the working config clears the just-saved confirmation.
  function update(next: OnboardingConfig) {
    setConfig(next);
    setSaved(false);
  }

  function toggleEnabled(key: string, on: boolean) {
    if (!config) return;
    const enabledKeys = on
      ? Array.from(new Set([...config.enabledKeys, key]))
      : config.enabledKeys.filter((k) => k !== key);
    // Drop a stale required override when a question is switched off.
    const required = { ...config.required };
    if (!on) delete required[key];
    update({ ...config, enabledKeys, required });
  }

  function toggleRequired(key: string, on: boolean) {
    if (!config) return;
    update({ ...config, required: { ...config.required, [key]: on } });
  }

  function addCustom() {
    if (!config) return;
    setDraftError(null);

    const label = draft.label.trim();
    if (!label) {
      setDraftError("Give the question a label.");
      return;
    }
    if (config.custom.length >= MAX_CUSTOM) {
      setDraftError(`You can add up to ${MAX_CUSTOM} custom questions.`);
      return;
    }

    let options: OnboardingFieldOption[] | undefined;
    if (draft.type === "select") {
      const parsed = draft.optionsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length === 0) {
        setDraftError("A multiple-choice question needs at least one option.");
        return;
      }
      const seen = new Set<string>();
      options = [];
      for (const optionLabel of parsed) {
        const value = customKeyFromLabel(optionLabel).replace(/^custom-/, "");
        // Keep option values unique even if two labels kebab to the same value.
        let v = value || "option";
        let n = 2;
        while (seen.has(v)) v = `${value}-${n++}`;
        seen.add(v);
        options.push({ value: v, label: optionLabel });
      }
    }

    // Generate a unique custom-<kebab> key, suffixing on collision.
    const base = customKeyFromLabel(label);
    const taken = new Set(config.custom.map((c) => c.key));
    let key = base;
    let n = 2;
    while (taken.has(key)) key = `${base}-${n++}`;

    const question: CustomQuestion = {
      key,
      label,
      type: draft.type,
      options,
      required: draft.required,
      category: draft.category,
    };
    update({ ...config, custom: [...config.custom, question] });
    setDraft(EMPTY_DRAFT);
  }

  function removeCustom(key: string) {
    if (!config) return;
    update({ ...config, custom: config.custom.filter((c) => c.key !== key) });
  }

  async function save() {
    if (!config || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/onboarding/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, config }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Could not save the form (${res.status}).`);
      }
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the form.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SectionCard title="Form builder" description="Choose the questions new patients answer.">
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" aria-hidden />
          Loading the form&hellip;
        </div>
      </SectionCard>
    );
  }

  if (loadError || !config) {
    return (
      <SectionCard title="Form builder" description="Choose the questions new patients answer.">
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{loadError ?? "Could not load the form."}</span>
        </div>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </SectionCard>
    );
  }

  const enabledSet = new Set(config.enabledKeys);

  return (
    <SectionCard
      title="Form builder"
      description="Pick the questions new patients answer on your onboarding form, mark which are required, and add your own. Changes appear in the preview straight away and go live when you save."
      actions={
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          Save form
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* LEFT — the builder. */}
        <div className="space-y-5">
          {/* Library checklist, grouped by category. */}
          <div className="space-y-4">
            {grouped.map(({ category, questions }) => (
              <fieldset
                key={category}
                className="rounded-xl border border-line bg-card-muted/40 p-3.5"
              >
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                  {CATEGORY_LABEL[category]}
                </legend>
                <div className="space-y-1.5">
                  {questions.map((q) => {
                    const on = enabledSet.has(q.key);
                    // Required value: an explicit override, else the library/default fallback.
                    const isRequired = q.key in config.required ? config.required[q.key] : false;
                    return (
                      <div
                        key={q.key}
                        className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2"
                      >
                        <Toggle
                          checked={on}
                          onChange={(next) => toggleEnabled(q.key, next)}
                          label={`Include "${q.label}"`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">
                            {q.label}
                          </span>
                          {q.help ? (
                            <span className="block truncate text-xs text-muted">{q.help}</span>
                          ) : null}
                        </span>
                        {on && q.requirable ? (
                          <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted">
                            <Toggle
                              checked={isRequired}
                              onChange={(next) => toggleRequired(q.key, next)}
                              label={`Make "${q.label}" required`}
                              small
                            />
                            Required
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          {/* Add a custom question. */}
          <div className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
            <p className="text-sm font-semibold text-navy">Add your own question</p>
            <p className="mt-0.5 text-xs text-muted">
              Up to {MAX_CUSTOM} custom questions ({config.custom.length} added).
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="fb-label" className={labelClass}>
                  Question
                </label>
                <input
                  id="fb-label"
                  type="text"
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder="e.g. Do you have any dental anxiety we should know about?"
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="fb-type" className={labelClass}>
                  Answer type
                </label>
                <select
                  id="fb-type"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, type: e.target.value as OnboardingFieldType }))
                  }
                  className={inputClass}
                >
                  {CUSTOM_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="fb-category" className={labelClass}>
                  Where it sits
                </label>
                <select
                  id="fb-category"
                  value={draft.category}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, category: e.target.value as OnboardingCategory }))
                  }
                  className={inputClass}
                >
                  {CATEGORY_ORDER.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>

              {draft.type === "select" ? (
                <div className="sm:col-span-2">
                  <label htmlFor="fb-options" className={labelClass}>
                    Options (one per line)
                  </label>
                  <textarea
                    id="fb-options"
                    rows={3}
                    value={draft.optionsText}
                    onChange={(e) => setDraft((d) => ({ ...d, optionsText: e.target.value }))}
                    placeholder={"Yes\nNo\nNot sure"}
                    className={inputClass}
                  />
                </div>
              ) : null}

              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 text-xs font-medium text-ink">
                  <Toggle
                    checked={draft.required}
                    onChange={(next) => setDraft((d) => ({ ...d, required: next }))}
                    label="Make this question required"
                    small
                  />
                  Make this required
                </label>
              </div>
            </div>

            {draftError ? (
              <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                {draftError}
              </p>
            ) : null}

            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addCustom}
                disabled={config.custom.length >= MAX_CUSTOM}
              >
                <Plus size={15} /> Add question
              </Button>
            </div>

            {/* Added custom questions. */}
            {config.custom.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {config.custom.map((c) => (
                  <li
                    key={c.key}
                    className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{c.label}</span>
                      <span className="block text-xs text-muted">
                        {CATEGORY_LABEL[c.category]}
                        <span aria-hidden> · </span>
                        {CUSTOM_TYPES.find((t) => t.value === c.type)?.label ?? c.type}
                        {c.required ? (
                          <>
                            <span aria-hidden> · </span>
                            <span className="font-semibold text-blue-deep">Required</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeCustom(c.key)}
                      aria-label={`Remove "${c.label}"`}
                      className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-card-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
                    >
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* Save feedback. */}
          {saveError ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              {saveError}
            </p>
          ) : saved ? (
            <p className="flex items-center gap-1.5 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
              <Check size={15} aria-hidden /> Form saved. New patients will see these questions.
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save form
            </Button>
            {previewSteps.length <= 1 ? (
              <span className="text-xs text-muted">Add at least one question to go live.</span>
            ) : null}
          </div>
        </div>

        {/* RIGHT — the live phone preview. */}
        <OnboardingPreview practiceName={practiceName} steps={previewSteps} />
      </div>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------------
 * A small, accessible switch (role=switch). Used for include + required toggles.
 * ------------------------------------------------------------------------- */

function Toggle({
  checked,
  onChange,
  label,
  small,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        small ? "h-4 w-7" : "h-5 w-9",
        checked ? "border-blue-dark bg-blue-dark" : "border-line-strong bg-card-muted",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block rounded-full bg-white shadow-sm transition-transform",
          small ? "h-3 w-3" : "h-3.5 w-3.5",
          checked
            ? small
              ? "translate-x-3.5"
              : "translate-x-4"
            : "translate-x-0.5",
        ].join(" ")}
        aria-hidden
      />
    </button>
  );
}
