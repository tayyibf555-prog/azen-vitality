"use client";

import { useState } from "react";
import { TIER_LABELS, type ClassificationResult, type Tier } from "@/lib/practice-brain/types";

interface Props {
  onSaved: () => void;
}

export function CapturePanel({ onSaved }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function classify() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawInput: text }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Classification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result, rawInput: text }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      setText("");
      setResult(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line-strong bg-card p-4">
      <h3 className="text-sm font-semibold text-ink">Add knowledge</h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Paste an SOP, script, protocol or note. The classifier files it on the right branch."
        className="mt-2 w-full rounded-lg border border-line bg-card-muted p-2 text-sm text-ink"
      />
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {!result && (
        <button
          onClick={classify}
          disabled={busy || text.trim().length === 0}
          className="mt-2 rounded-lg bg-blue-dark px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Classifying..." : "Classify"}
        </button>
      )}

      {result && (
        <div className="mt-3 rounded-lg border border-line bg-card-muted p-3 text-sm">
          <p className="font-medium text-ink">{result.title}</p>
          <p className="mt-1 text-xs text-muted">{result.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-line-strong px-2 py-0.5">Branch: {result.branch || "unsorted"}{result.branchIsNew ? " (new)" : ""}</span>
            <label className="flex items-center gap-1">
              Tier:
              <select
                value={result.tier}
                onChange={(e) => setResult({ ...result, tier: Number(e.target.value) as Tier })}
                className="rounded border border-line bg-card px-1 py-0.5"
              >
                {[1, 2, 3, 4].map((t) => (
                  <option key={t} value={t}>{t} {TIER_LABELS[t as Tier]}</option>
                ))}
              </select>
            </label>
            {result.tags.map((t) => (
              <span key={t} className="rounded-full bg-blue-light/20 px-2 py-0.5 text-blue-dark">{t}</span>
            ))}
          </div>
          {result.needsReview && (
            <p className="mt-2 text-xs text-amber-600">Low confidence. This will be saved to the review queue at the most restrictive tier.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button onClick={save} disabled={busy} className="rounded-lg bg-blue-dark px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
            <button onClick={() => setResult(null)} disabled={busy} className="rounded-lg border border-line px-3 py-1.5 text-sm">Re-do</button>
          </div>
        </div>
      )}
    </div>
  );
}
