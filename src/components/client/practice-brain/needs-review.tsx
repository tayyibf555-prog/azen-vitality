"use client";

import { useEffect, useState } from "react";
import { TIER_LABELS, type KnowledgeNode, type Tier } from "@/lib/practice-brain/types";

const HUBS = ["Back office", "Sales", "Reception", "Marketing", "Operations", "Intelligence"];

export function NeedsReview({ onResolved }: { onResolved: () => void }) {
  const [items, setItems] = useState<KnowledgeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/practice-brain/needs-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (res.success) setItems(res.data.nodes);
    else setError(res.error);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolve(id: string, branch: string, tier: Tier) {
    const res = await fetch("/api/practice-brain/resolve-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, branch, tier }),
    }).then((r) => r.json());
    if (res.success) {
      await load();
      onResolved();
    } else {
      setError(res.error);
    }
  }

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (items.length === 0) return <p className="text-xs text-muted">Nothing waiting for review.</p>;

  return (
    <div className="space-y-2">
      {items.map((n) => (
        <ReviewRow key={n.id} node={n} onResolve={resolve} />
      ))}
    </div>
  );
}

function ReviewRow({ node, onResolve }: { node: KnowledgeNode; onResolve: (id: string, branch: string, tier: Tier) => void }) {
  const [branch, setBranch] = useState(HUBS[0]);
  const [tier, setTier] = useState<Tier>(node.tier);
  return (
    <div className="rounded-lg border border-line bg-card-muted p-3 text-sm">
      <p className="font-medium text-ink">{node.title}</p>
      <p className="mt-1 text-xs text-muted">{node.body}</p>
      {node.classification && (
        <p className="mt-1 text-xs text-amber-600">Classifier: {node.classification.reasoning} (confidence {Math.round(node.classification.confidence * 100)}%)</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded border border-line bg-card px-1 py-0.5">
          {HUBS.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <select value={tier} onChange={(e) => setTier(Number(e.target.value) as Tier)} className="rounded border border-line bg-card px-1 py-0.5">
          {[1, 2, 3, 4].map((t) => <option key={t} value={t}>{t} {TIER_LABELS[t as Tier]}</option>)}
        </select>
        <button onClick={() => onResolve(node.id, branch, tier)} className="rounded bg-blue-dark px-2 py-1 font-medium text-white">Approve</button>
      </div>
    </div>
  );
}
