import type { Role } from "@/lib/types";
import type { KnowledgeNode, Tier } from "./types";

/** Mock-auth bridge: role -> highest tier the viewer may see. Becomes an RLS policy later. */
export function maxTierForRole(role: Role): Tier {
  switch (role) {
    case "client_coordinator":
      return 2;
    case "client_owner":
      return 4;
    case "agency_admin":
      return 4;
    default:
      return 1;
  }
}

/** Hard, deterministic access guard. Never an LLM decision. */
export function visibleNodes(nodes: KnowledgeNode[], maxTier: Tier): KnowledgeNode[] {
  return nodes.filter((n) => n.tier <= maxTier && n.status === "active");
}

export function childrenOf(nodes: KnowledgeNode[], parentId: string | null): KnowledgeNode[] {
  return nodes.filter((n) => n.parentId === parentId);
}

/** Direct-child count per branch among the supplied nodes (caller filters for clearance first). */
export function branchCounts(nodes: KnowledgeNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    if (n.parentId) counts[n.parentId] = (counts[n.parentId] ?? 0) + 1;
  }
  return counts;
}
