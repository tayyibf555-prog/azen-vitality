"use client";

import { useEffect, useState } from "react";

interface Gap {
  id: string;
  question: string;
  askerTier: number;
  createdAt: string;
}

export function GapsQueue() {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/practice-brain/gaps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (res.success) setGaps(res.data.gaps);
    else setError(res.error);
  }

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/practice-brain/gaps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      if (res.success) setGaps(res.data.gaps);
      else setError(res.error);
    })();
  }, []);

  async function resolve(id: string) {
    const res = await fetch("/api/practice-brain/resolve-gap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.success) {
      await load();
    } else {
      setError(res.error);
    }
  }

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (gaps.length === 0)
    return (
      <p className="text-xs text-muted">No open questions the brain could not answer.</p>
    );

  return (
    <div className="space-y-2">
      {gaps.map((gap) => (
        <div key={gap.id} className="rounded-lg border border-line bg-card-muted p-3 text-sm">
          <p className="font-medium text-ink">{gap.question}</p>
          <p className="mt-1 text-xs text-muted">
            Asked at tier {gap.askerTier} &middot;{" "}
            {new Date(gap.createdAt).toLocaleDateString("en-GB")}
          </p>
          <div className="mt-2">
            <button
              onClick={() => void resolve(gap.id)}
              className="rounded bg-blue-dark px-2 py-1 text-xs font-medium text-white"
            >
              Resolve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
