"use client";

import { TIER_LABELS, type KnowledgeNode } from "@/lib/practice-brain/types";

export function ItemDetail({ node, onClose }: { node: KnowledgeNode; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-line-strong bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{node.title}</h3>
        <button onClick={onClose} className="text-xs text-muted">Close</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-line-strong px-2 py-0.5">Tier {node.tier} {TIER_LABELS[node.tier]}</span>
        {node.tags.map((t) => (
          <span key={t} className="rounded-full bg-blue-light/20 px-2 py-0.5 text-blue-dark">{t}</span>
        ))}
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{node.body}</p>
      <p className="mt-3 text-xs text-muted">Source: {node.source}. Updated {new Date(node.updatedAt).toLocaleDateString("en-GB")}.</p>
    </div>
  );
}
