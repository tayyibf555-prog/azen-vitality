"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard, Toggle } from "@/components/primitives";
import { FORK_LABEL, FORK_NOTE } from "@/lib/triage/fork";
import type { DroppedQuestion, ProjectedQuestion } from "@/lib/triage/project";
import type { TriageBankConfig, TriageFork, TriageQuestion } from "@/lib/triage/types";

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
// ===========================================================================

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
