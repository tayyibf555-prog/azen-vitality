"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard, Toggle } from "@/components/primitives";
import { FORK_LABEL, FORK_NOTE } from "@/lib/triage/fork";
import type { DroppedQuestion, ProjectedQuestion } from "@/lib/triage/project";
import type {
  TriageBankConfig,
  TriageCustomQuestion,
  TriageFork,
  TriageQuestion,
} from "@/lib/triage/types";

// ===========================================================================
// THE OWNER EDITOR for the two question banks.
//
// The onboarding form builder's shape, deliberately: an owner who has configured
// the onboarding form should not have to learn a second editor. Load, toggle,
// save; the same three-state save UX (saving / error / saved) and the same
// {enabledKeys, required, custom} config.
//
// ---------------------------------------------------------------------------
// WHAT IS NEW HERE, AND WHY IT IS THE POINT OF THE SCREEN.
// ---------------------------------------------------------------------------
// A question the owner switches on may still not be ASKED. The short list cannot
// carry a pain / symptom / treatment-need question — that is contractual, not
// editorial — so `projectBank` drops one whatever the config says, on the server,
// on every render of the public form.
//
// A silent drop would be intolerable here: the owner would switch a question on,
// see it in their list, and never learn that no patient was ever asked it. So
// this editor renders the DROPPED list the server sends back, names the exact
// word that blocked each question, and does it BOTH on load and in the response
// to every save. The guard explains itself, which is the difference between a
// rule that gets rewritten around and one that gets reported as a bug.
//
// ---------------------------------------------------------------------------
// THE PRACTICE'S OWN QUESTIONS (wave-3 review, 4 September 2026).
// ---------------------------------------------------------------------------
// `TriageCustomQuestion` is documented as "a question the practice wrote itself,
// IN THE OWNER EDITOR", and every layer beneath that sentence was built: the ten
// question cap and the per-question refusal in the PUT route, `usableCustom`,
// the W3/3 scan over custom OPTION labels and values, `resolveAnswerKind`'s
// custom index, `UNKNOWN_ANSWER_KIND` failing to restricted. The editor was the
// missing half. It rendered the shipped library as switches and posted
// `bank.config` straight back, so `config.custom` could only ever round-trip
// what the GET returned — the owner could neither write one, see one, nor
// remove one, and a custom question already stored was INVISIBLE here while
// being asked of patients.
//
// So the draft form below is the onboarding form builder's, deliberately, down
// to the `custom-<kebab>` key minting and the collision suffix: an owner who has
// configured the onboarding form should not learn a second editor, and that one
// has been in front of practices for months.
//
// WHAT THIS SCREEN DOES NOT DO IS VALIDATE THE RULE. It checks only that a
// question is well formed enough to be worth sending. Whether a question may be
// ASKED is the server's decision — `usableCustom` refuses the save, `projectBank`
// drops it at render — and the answer comes back in the `dropped` list above,
// naming the word that stopped it. A second copy of the forbidden-word scan in
// the browser would be a copy that drifts, and the one in the bundle would be
// the copy nobody notices going stale.
// ===========================================================================

/**
 * The most questions a practice may write, and it MUST match `MAX_CUSTOM` in
 * src/app/api/previsit/bank/route.ts — the route slices the array at its own
 * figure, so a higher number here would silently drop the eleventh question
 * after the owner had typed it. Pinned equal by bank-editor.test.ts, which reads
 * the route's source, the same way os-band.test.ts pins its own bound.
 */
const MAX_CUSTOM = 10;

/** The answer types `usableCustom` accepts, in the owner's words. */
const CUSTOM_TYPES: readonly { value: TriageCustomQuestion["type"]; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "textarea", label: "Longer answer" },
  { value: "choice", label: "Multiple choice" },
  { value: "yesno", label: "Yes / no" },
  { value: "scale", label: "0 to 10" },
];

/**
 * The three classifications, in the owner's words rather than the code's.
 *
 * The words matter: this choice decides which patients are asked. The note under
 * the picker says so without naming a funding regime, which this screen is
 * allowed to do (it is owner-facing) but does not need to here — "the short list"
 * is the name the rest of the editor already uses.
 */
const CUSTOM_KINDS: readonly { value: TriageCustomQuestion["kind"]; label: string }[] = [
  { value: "logistics", label: "Getting to the appointment" },
  { value: "cosmetic", label: "What they would like to hear about" },
  { value: "symptom", label: "Their teeth, pain or symptoms" },
];

interface Draft {
  label: string;
  type: TriageCustomQuestion["type"];
  kind: TriageCustomQuestion["kind"];
  optionsText: string;
  required: boolean;
}

const EMPTY_DRAFT: Draft = {
  label: "",
  type: "text",
  kind: "logistics",
  optionsText: "",
  required: false,
};

/** `custom-<kebab>`, the one shape `usableCustom` accepts. */
function customKeyFromLabel(label: string): string {
  const kebab = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `custom-${kebab || "question"}`;
}

/**
 * A draft as a question, or the sentence saying why it is not one yet.
 *
 * EXPORTED AND PURE, so every refusal is a test rather than a click. The rules
 * are `usableCustom`'s own, restated in the owner's words: a question needs
 * words, a multiple choice needs at least two things to choose between, and the
 * key has to be unique among the practice's own questions.
 */
export function draftToQuestion(
  draft: Draft,
  taken: readonly string[],
): { question: TriageCustomQuestion } | { error: string } {
  const label = draft.label.replace(/\s+/g, " ").trim();
  if (label.length === 0) return { error: "Write the question first." };
  if (label.length > 200) return { error: "That question is too long — keep it under 200 characters." };

  let options: { value: string; label: string }[] | undefined;
  if (draft.type === "choice") {
    const parsed = draft.optionsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    options = [];
    for (const optionLabel of parsed.slice(0, 12)) {
      const base = customKeyFromLabel(optionLabel).replace(/^custom-/, "") || "option";
      let value = base;
      let n = 2;
      while (seen.has(value)) value = `${base}-${n++}`;
      seen.add(value);
      options.push({ value, label: optionLabel });
    }
    if (options.length < 2) {
      return { error: "A multiple-choice question needs at least two answers, one per line." };
    }
  }

  const base = customKeyFromLabel(label);
  const used = new Set(taken);
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}-${n++}`;

  return { question: { key, label, type: draft.type, kind: draft.kind, options, required: draft.required } };
}

interface BankState {
  fork: TriageFork;
  isDefault: boolean;
  config: TriageBankConfig;
  updatedAt: string | null;
  updatedBy: string | null;
  questions: ProjectedQuestion[];
  dropped: DroppedQuestion[];
}

interface LoadResponse {
  ok?: boolean;
  banks?: BankState[];
  library?: TriageQuestion[];
  error?: string;
}

export function BankEditor({ clientSlug }: { clientSlug: string }) {
  const [banks, setBanks] = useState<BankState[] | null>(null);
  const [library, setLibrary] = useState<TriageQuestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<TriageFork | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<TriageFork | null>(null);

  // THE LOAD, as a SUBSCRIPTION rather than as a synchronous state write.
  //
  // Every setState below happens in a callback AFTER an await, and the `cancelled`
  // flag means a reader who navigates away mid-flight is not written to at all.
  // That is what react-hooks/set-state-in-effect asks for, and it is also the
  // right behaviour: without the flag, switching practice while this request is in
  // the air would paint the previous practice's question lists.
  //
  // (The onboarding form builder — this editor's model in every other respect —
  // calls setState synchronously in its effect and trips the same rule today. It
  // is not copied here; see the ledger.)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/previsit/bank?client=${encodeURIComponent(clientSlug)}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as LoadResponse;
        if (cancelled) return;
        if (!res.ok || !data.ok || !data.banks) {
          throw new Error(data.error || `The question lists could not be read (${res.status}).`);
        }
        setBanks(data.banks);
        setLibrary(data.library ?? []);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "The question lists could not be read.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientSlug]);

  function update(fork: TriageFork, config: TriageBankConfig) {
    setBanks((prev) =>
      prev ? prev.map((b) => (b.fork === fork ? { ...b, config } : b)) : prev,
    );
    // Any edit invalidates the last "saved" tick, so the screen never shows a
    // confirmation for a state the server has not seen.
    setSaved(null);
    setSaveError(null);
  }

  async function save(fork: TriageFork) {
    const bank = banks?.find((b) => b.fork === fork);
    if (!bank) return;
    setSaving(fork);
    setSaveError(null);
    try {
      const res = await fetch("/api/previsit/bank", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, fork, config: bank.config }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        questions?: ProjectedQuestion[];
        dropped?: DroppedQuestion[];
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Those settings were not saved (${res.status}).`);
      }
      // Take the SERVER'S projection, not the local config. What the owner needs to
      // see after a save is what patients will actually be asked, which is not the
      // same thing as what they just ticked.
      setBanks((prev) =>
        prev
          ? prev.map((b) =>
              b.fork === fork
                ? { ...b, isDefault: false, questions: data.questions ?? b.questions, dropped: data.dropped ?? [] }
                : b,
            )
          : prev,
      );
      setSaved(fork);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Those settings were not saved.");
    } finally {
      setSaving(null);
    }
  }

  if (loadError) {
    return (
      <SectionCard title="Question lists">
        <p role="alert" className="text-[13px] text-status-red">
          {loadError}
        </p>
      </SectionCard>
    );
  }
  if (!banks) {
    return (
      <SectionCard title="Question lists">
        <p className="text-[13px] text-muted">Reading the question lists…</p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      {banks.map((bank) => (
        <BankPanel
          key={bank.fork}
          bank={bank}
          library={library}
          busy={saving === bank.fork}
          saved={saved === bank.fork}
          error={saving === null && saveError !== null && saved === null ? saveError : null}
          onChange={(config) => update(bank.fork, config)}
          onSave={() => save(bank.fork)}
        />
      ))}
    </div>
  );
}

/**
 * One bank's panel. Presentational: every piece of state arrives as a prop, so
 * each screen (busy, saved, error, dropped-questions) is renderable directly in a
 * test rather than reachable only by clicking.
 */
export function BankPanel({
  bank,
  library,
  busy,
  saved,
  error,
  onChange,
  onSave,
}: {
  bank: BankState;
  library: TriageQuestion[];
  busy: boolean;
  saved: boolean;
  error: string | null;
  onChange: (config: TriageBankConfig) => void;
  onSave: () => void;
}) {
  const enabled = new Set(bank.config.enabledKeys);
  const custom = bank.config.custom ?? [];
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);

  function addCustom() {
    setDraftError(null);
    if (custom.length >= MAX_CUSTOM) {
      setDraftError(`You can write up to ${MAX_CUSTOM} of your own questions.`);
      return;
    }
    const result = draftToQuestion(draft, custom.map((c) => c.key));
    if ("error" in result) {
      setDraftError(result.error);
      return;
    }
    onChange({ ...bank.config, custom: [...custom, result.question] });
    setDraft(EMPTY_DRAFT);
  }

  function removeCustom(key: string) {
    const required = { ...bank.config.required };
    delete required[key];
    onChange({ ...bank.config, custom: custom.filter((c) => c.key !== key), required });
  }

  function toggleEnabled(key: string, on: boolean) {
    const enabledKeys = on
      ? Array.from(new Set([...bank.config.enabledKeys, key]))
      : bank.config.enabledKeys.filter((k) => k !== key);
    const required = { ...bank.config.required };
    if (!on) delete required[key]; // drop a stale required override
    onChange({ ...bank.config, enabledKeys, required });
  }

  function toggleRequired(key: string, on: boolean) {
    onChange({ ...bank.config, required: { ...bank.config.required, [key]: on } });
  }

  return (
    <SectionCard
      title={FORK_LABEL[bank.fork]}
      description={FORK_NOTE[bank.fork]}
      actions={
        <>
          {saved ? <span className="text-[12.5px] text-success">Saved</span> : null}
          <Button type="button" onClick={onSave} disabled={busy} size="sm">
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-status-red">
          {error}
        </p>
      ) : null}
      {bank.isDefault ? (
        <p className="mb-3 text-[12.5px] text-muted">
          This list has never been edited, so it is the one the platform ships with. Saving makes it yours.
        </p>
      ) : null}

      {/*
        THE REFUSALS, NAMED. A question the owner has switched on that will not be
        asked, and the exact word that stopped it. Rendered ABOVE the switches so
        it cannot be scrolled past, and phrased as a fact about the question rather
        than as an error the owner has made.
      */}
      {bank.dropped.length > 0 ? (
        <div className="mb-4 rounded-xl border border-tint-amber-line bg-tint-amber px-4 py-3">
          <p className="text-[13px] font-medium text-navy">
            {bank.dropped.length === 1
              ? "One question on this list is not being asked"
              : `${bank.dropped.length} questions on this list are not being asked`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {bank.dropped.map((d) => (
              <li key={d.key} className="text-[12.5px] leading-[1.5] text-muted">
                <span className="text-ink">{d.label || d.key}</span>
                {" — "}
                {dropReason(d)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="space-y-2">
        {library
          .filter((q) => q.type !== "interest")
          .map((q) => {
            const on = enabled.has(q.key);
            return (
              <li
                key={q.key}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] text-ink">{q.label}</p>
                  {q.help ? <p className="mt-0.5 text-[12px] text-muted">{q.help}</p> : null}
                  {/*
                    THE OWNER-FACING NOTE. Rendered only here, never on the patient
                    form, which is why it is allowed to name the funding regime the
                    decision turns on. It exists for the one question whose fork
                    placement is the practice's call rather than this codebase's.
                  */}
                  {q.ownerNote ? (
                    <p className="mt-1 text-[12px] leading-[1.45] text-status-amber">{q.ownerNote}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  {on && q.requirable ? (
                    <label className="flex items-center gap-2 text-[12px] text-muted">
                      <Toggle
                        checked={bank.config.required[q.key] === true}
                        onChange={(v) => toggleRequired(q.key, v)}
                        size="sm"
                        label={`Make "${q.label}" a required question`}
                      />
                      Needed
                    </label>
                  ) : null}
                  <Toggle
                    checked={on}
                    onChange={(v) => toggleEnabled(q.key, v)}
                    label={`Ask "${q.label}"`}
                  />
                </div>
              </li>
            );
          })}
      </ul>

      <p className="mt-4 text-[12.5px] text-muted">
        The treatment questions are always asked and cannot be switched off here. Patients must answer them,
        and &quot;Not right now&quot; is always one of the answers.
      </p>

      {/* ===================================================================
          THE PRACTICE'S OWN QUESTIONS. See the file header for why this exists
          and what it deliberately does not check.
          =================================================================== */}
      <div className="mt-5 rounded-xl border border-line-strong bg-card-muted/40 p-4">
        <p className="text-[13px] font-semibold text-navy">Your own questions</p>
        <p className="mt-0.5 text-[12px] text-muted">
          Up to {MAX_CUSTOM}, and {custom.length} written so far. They are asked after the ones above, in the
          order you add them.
        </p>

        {custom.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {custom.map((c) => (
              <li
                key={c.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{c.label}</span>
                  <span className="block text-[12px] text-muted">
                    {CUSTOM_TYPES.find((t) => t.value === c.type)?.label ?? c.type}
                    {" · "}
                    {CUSTOM_KINDS.find((k) => k.value === c.kind)?.label ?? c.kind}
                    {c.required ? " · needed" : ""}
                    {c.options && c.options.length > 0 ? ` · ${c.options.map((o) => o.label).join(", ")}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeCustom(c.key)}
                  aria-label={`Remove "${c.label}"`}
                  className="pressable shrink-0 rounded-md border border-line px-2 py-1 text-[12px] font-medium text-muted hover:text-navy"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* THE TRAP THIS WARNS ABOUT IS REAL AND IS NOT THIS SCREEN'S TO FIX.
            `usableConfig` (src/lib/triage/project.ts) falls back to the fork's
            shipped defaults whenever `enabledKeys` is empty — and the fallback
            replaces the WHOLE config, so a stored `custom` array goes with it.
            An owner who switches every shipped question off loses the questions
            they wrote. Until that is fixed in the projection, the editor says so
            rather than letting somebody find out from an empty form. */}
        {custom.length > 0 && bank.config.enabledKeys.length === 0 ? (
          <p className="mt-3 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-relaxed text-navy">
            Keep at least one of the questions above switched on. A list with none of them on falls back to the
            questions this platform ships with, and your own questions are not asked.
          </p>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">The question</span>
            <input
              type="text"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="e.g. Is there anything that would make getting here difficult?"
              className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Answer type</span>
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as Draft["type"] })}
              className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
            >
              {CUSTOM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">What it asks about</span>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}
              className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
            >
              {CUSTOM_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          {draft.type === "choice" ? (
            <label className="sm:col-span-2 flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
                Answers to choose from, one per line
              </span>
              <textarea
                rows={3}
                value={draft.optionsText}
                onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
                placeholder={"Yes\nNo\nNot sure"}
                className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
              />
            </label>
          ) : null}

          <label className="sm:col-span-2 flex items-center gap-2 text-[12px] text-muted">
            <Toggle
              checked={draft.required}
              onChange={(v) => setDraft({ ...draft, required: v })}
              size="sm"
              label="Make this a needed question"
            />
            Needed — the patient cannot finish the form without answering it
          </label>
        </div>

        {/* THE CLASSIFICATION IS NOT COSMETIC, so the consequence is written next
            to the picker rather than discovered after a save. */}
        <p className="mt-2 text-[12px] leading-[1.5] text-muted">
          Questions about teeth, pain or symptoms are only asked on the longer list. If you file one here that
          the short list cannot carry — or word one that reads like a symptom question whatever you file it as —
          it is not asked, and it appears at the top of this panel with the word that stopped it.
        </p>

        {draftError ? (
          <p role="alert" className="mt-3 text-[12.5px] text-status-red">
            {draftError}
          </p>
        ) : null}

        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addCustom}
            disabled={custom.length >= MAX_CUSTOM}
          >
            Add this question
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/** Plain English for a refusal, naming the word where there is one. */
export function dropReason(d: DroppedQuestion): string {
  if (d.reason === "symptom-on-brief") {
    return d.matched === "symptom"
      ? "it asks about a symptom, and this list does not ask about symptoms."
      : `it uses the word "${d.matched}", and this list does not ask about symptoms.`;
  }
  if (d.reason === "funding-word") {
    return `it uses the word "${d.matched}", which patients must never be shown.`;
  }
  if (d.reason === "unknown-key") return "it is not a question this platform knows about any more.";
  return "it could not be read.";
}
