"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, FileText } from "lucide-react";
import { TIER_LABELS, type KnowledgeNode, type Tier } from "@/lib/practice-brain/types";
import { childrenOf } from "@/lib/practice-brain/clearance";

/**
 * File view: the same knowledge tree as the constellation, shown as a familiar
 * folder explorer. Branches are folders (expand/collapse); items are files that
 * open into the shared ItemDetail. Search filters to matching files and their path.
 */

const TIER_DOT: Record<Tier, string> = { 1: "#94A3B8", 2: "#3B82F6", 3: "#F59E0B", 4: "#EF4444" };

function TierPill({ tier }: { tier: Tier }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-muted">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_DOT[tier] }} />
      {TIER_LABELS[tier]}
    </span>
  );
}

function sortNodes(ns: KnowledgeNode[]): KnowledgeNode[] {
  return [...ns].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "branch" ? -1 : 1; // folders first
    return a.title.localeCompare(b.title);
  });
}

function Row({
  node,
  nodes,
  depth,
  query,
  pathMatch,
  expanded,
  toggle,
  selectedItemId,
  onSelectItem,
}: {
  node: KnowledgeNode;
  nodes: KnowledgeNode[];
  depth: number;
  query: string;
  pathMatch: Set<string> | null;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}) {
  const pad = 10 + depth * 18;
  const isBranch = node.kind === "branch";
  const kids = useMemo(
    () => (isBranch ? sortNodes(childrenOf(nodes, node.id)) : []),
    [isBranch, nodes, node.id],
  );
  const visibleKids = pathMatch ? kids.filter((k) => pathMatch.has(k.id)) : kids;
  const open = pathMatch ? true : expanded.has(node.id);
  const selected = node.id === selectedItemId;

  return (
    <li>
      <button
        type="button"
        onClick={() => (isBranch ? toggle(node.id) : onSelectItem(node.id))}
        style={{ paddingLeft: pad }}
        className={`group flex w-full items-start gap-2 rounded-lg py-2 pr-3 text-left transition-colors ${
          selected ? "bg-blue-light/40" : "hover:bg-card-muted"
        }`}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted">
          {isBranch ? (
            <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          ) : null}
        </span>
        <span className="mt-0.5 shrink-0 text-muted">
          {isBranch ? (open ? <FolderOpen size={16} /> : <Folder size={16} />) : <FileText size={15} className="text-muted" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`truncate text-sm ${isBranch ? "font-semibold text-ink" : "font-medium text-ink"}`}>{node.title}</span>
            <TierPill tier={node.tier} />
            {isBranch ? (
              <span className="text-xs text-muted">{kids.length === 0 ? "empty" : `${kids.length} item${kids.length === 1 ? "" : "s"}`}</span>
            ) : null}
          </span>
          {!isBranch && node.body ? (
            <span className="mt-0.5 line-clamp-1 block text-xs text-muted">{node.body}</span>
          ) : null}
        </span>
      </button>

      {isBranch && open ? (
        visibleKids.length > 0 ? (
          <ul>
            {visibleKids.map((k) => (
              <Row
                key={k.id}
                node={k}
                nodes={nodes}
                depth={depth + 1}
                query={query}
                pathMatch={pathMatch}
                expanded={expanded}
                toggle={toggle}
                selectedItemId={selectedItemId}
                onSelectItem={onSelectItem}
              />
            ))}
          </ul>
        ) : !pathMatch ? (
          <p style={{ paddingLeft: pad + 26 }} className="py-1.5 text-xs italic text-muted">No items yet</p>
        ) : null
      ) : null}
    </li>
  );
}

export function FileTree({
  nodes,
  query,
  selectedItemId,
  onSelectItem,
}: {
  nodes: KnowledgeNode[];
  query: string;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}) {
  const roots = useMemo(() => sortNodes(childrenOf(nodes, null)), [nodes]);

  // Default: top-level folders open so the structure is visible at a glance.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(roots.filter((r) => r.kind === "branch").map((r) => r.id)),
  );
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Search: keep every node on a path to a title/body match, and force those branches open.
  const q = query.trim().toLowerCase();
  const pathMatch = useMemo(() => {
    if (!q) return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const keep = new Set<string>();
    for (const n of nodes) {
      if (n.title.toLowerCase().includes(q) || (n.body ?? "").toLowerCase().includes(q)) {
        let cur: KnowledgeNode | undefined = n;
        while (cur) {
          keep.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    return keep;
  }, [nodes, q]);

  const visibleRoots = pathMatch ? roots.filter((r) => pathMatch.has(r.id)) : roots;

  return (
    <div className="rounded-[10px] border border-line bg-card p-2 sm:p-3">
      {roots.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted">
          No knowledge captured yet. Add a note below and it will file itself onto the right branch.
        </p>
      ) : pathMatch && visibleRoots.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted">No files match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul>
          {visibleRoots.map((r) => (
            <Row
              key={r.id}
              node={r}
              nodes={nodes}
              depth={0}
              query={query}
              pathMatch={pathMatch}
              expanded={expanded}
              toggle={toggle}
              selectedItemId={selectedItemId}
              onSelectItem={onSelectItem}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
