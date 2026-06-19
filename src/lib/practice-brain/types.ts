/**
 * Practice Brain domain types.
 *
 * One self-referential tree: a `branch` node has children; an `item` node is a leaf
 * with a `body`. Clearance is a per-node sensitivity tier (1 lowest, 4 highest); each
 * viewer has a max tier and sees only nodes at or below it. No clinical data lives here.
 */

export type KnowledgeKind = "branch" | "item";
export type KnowledgeStatus = "active" | "needs_review" | "archived";
export type KnowledgeSource = "manual_note" | "file_upload" | "module_feed" | "copilot_capture";

/** 1 General, 2 Operational, 3 Management, 4 Confidential. */
export type Tier = 1 | 2 | 3 | 4;

export const TIER_LABELS: Record<Tier, string> = {
  1: "General",
  2: "Operational",
  3: "Management",
  4: "Confidential",
};

export interface KnowledgeNode {
  id: string;
  clientId: string;
  siteId: string | null;
  parentId: string | null;
  kind: KnowledgeKind;
  title: string;
  body: string | null;
  rawInput: string | null;
  tier: Tier;
  tags: string[];
  source: KnowledgeSource;
  sourceRef: string | null;
  classification: ClassificationMeta | null;
  status: KnowledgeStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Stored on the node (jsonb) for audit and the review queue. */
export interface ClassificationMeta {
  reasoning: string;
  confidence: number;
  branchIsNew: boolean;
}

/** What the classifier returns for a captured note (before it is saved). */
export interface ClassificationResult {
  branch: string;
  branchIsNew: boolean;
  title: string;
  body: string;
  tier: Tier;
  tags: string[];
  confidence: number;
  reasoning: string;
  /** Derived: low confidence or no branch -> fail closed to needs_review @ tier 4. */
  needsReview: boolean;
}
