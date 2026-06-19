"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KnowledgeNode } from "@/lib/practice-brain/types";
import { PageHeader } from "@/components/primitives";
import { Constellation } from "./constellation";
import { CapturePanel } from "./capture-panel";
import { ItemDetail } from "./item-detail";
import { NeedsReview } from "./needs-review";
import { PasswordGate } from "./password-gate";

export function PracticeBrainView() {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [maxTier, setMaxTier] = useState(0);
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [activeHubId, setActiveHubId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/practice-brain/tree", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (res.success) {
      setNodes(res.data.nodes);
      setMaxTier(res.data.maxTier);
      setUnlocked(true);
    }
    setLoading(false);
  }, []);

  // Detect an existing unlock cookie on mount (returning within the session).
  useEffect(() => {
    (async () => {
      const r = await fetch("/api/practice-brain/tree", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.ok) {
        const j = await r.json();
        if (j.success) {
          setNodes(j.data.nodes);
          setMaxTier(j.data.maxTier);
          setUnlocked(true);
        }
      }
      setChecking(false);
    })();
  }, []);

  const selectedItem = useMemo(
    () => nodes.find((n) => n.id === selectedItemId) ?? null,
    [nodes, selectedItemId],
  );
  const canReview = maxTier >= 3;

  function selectHub(id: string) {
    const node = nodes.find((n) => n.id === id);
    if (node && node.kind === "branch") {
      setActiveHubId(id);
      setFocusId(id);
    }
  }

  const breadcrumb = useMemo(() => {
    const trail: KnowledgeNode[] = [];
    let cur = focusId;
    while (cur) {
      const n = nodes.find((x) => x.id === cur);
      if (!n) break;
      trail.unshift(n);
      cur = n.parentId;
    }
    return trail;
  }, [focusId, nodes]);

  return (
    <>
      <PageHeader
        title="Practice brain"
        description="The practice knowledge hub. Branches grow as you add knowledge; the co-pilot will draw from it."
      />

      {checking ? (
        <div className="rounded-xl border border-line bg-card p-8 text-center text-sm text-muted">Checking access...</div>
      ) : !unlocked ? (
        <PasswordGate onUnlocked={() => { void load(); }} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <button onClick={() => { setFocusId(null); setActiveHubId(null); }} className="text-xs text-muted hover:text-ink">
              Practice brain
            </button>
            {breadcrumb.map((b) => (
              <span key={b.id} className="text-xs text-muted">/ {b.title}</span>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the brain..."
              className="ml-auto w-48 rounded-lg border border-line bg-card-muted px-2 py-1 text-sm"
            />
          </div>

          {loading ? (
            <div className="rounded-xl border border-line bg-card p-8 text-center text-sm text-muted">Loading the constellation...</div>
          ) : (
            <Constellation
              nodes={nodes}
              focusId={focusId}
              activeHubId={activeHubId}
              query={query}
              onSelectHub={selectHub}
              onSelectItem={setSelectedItemId}
            />
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <CapturePanel onSaved={load} />
            {selectedItem ? (
              <ItemDetail node={selectedItem} onClose={() => setSelectedItemId(null)} />
            ) : canReview ? (
              <div className="rounded-xl border border-line-strong bg-card p-4">
                <h3 className="mb-2 text-sm font-semibold text-ink">Needs review</h3>
                <NeedsReview onResolved={load} />
              </div>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
