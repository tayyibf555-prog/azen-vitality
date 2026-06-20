import { serviceClient } from "@/lib/supabase/server";
import type {
  ClassificationMeta, KnowledgeNode, KnowledgeSource, KnowledgeStatus, Tier,
} from "./types";
import { isSemanticEnabled, embed } from "./embeddings";

const TABLE = "knowledge_node";

interface Row {
  id: string;
  client_id: string;
  site_id: string | null;
  parent_id: string | null;
  kind: "branch" | "item";
  title: string;
  body: string | null;
  raw_input: string | null;
  tier: number;
  tags: string[] | null;
  source: KnowledgeNode["source"];
  source_ref: string | null;
  classification: ClassificationMeta | null;
  status: KnowledgeStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  embedding: number[] | null;
}

function toNode(r: Row): KnowledgeNode {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    rawInput: r.raw_input,
    tier: (r.tier as Tier) ?? 4,
    tags: r.tags ?? [],
    source: r.source,
    sourceRef: r.source_ref,
    classification: r.classification,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    embedding: r.embedding ?? null,
  };
}

/** All active nodes for a client (branches + items). Caller applies clearance. */
export async function listActiveNodes(clientId: string): Promise<KnowledgeNode[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toNode);
}

/** Top-level branch names (used to prime the classifier). */
export async function listBranchNames(clientId: string): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("title")
    .eq("client_id", clientId)
    .eq("kind", "branch")
    .is("parent_id", null);
  if (error) throw new Error(error.message);
  return (data as { title: string }[]).map((r) => r.title);
}

/** Find a top-level branch by name (case-insensitive) or create it. Returns its id. */
export async function ensureBranch(clientId: string, name: string, tier: Tier): Promise<string> {
  const trimmed = name.trim();
  const { data: existing } = await serviceClient()
    .from(TABLE)
    .select("id")
    .eq("client_id", clientId)
    .eq("kind", "branch")
    .is("parent_id", null)
    .ilike("title", trimmed)
    .limit(1);
  if (existing && existing.length > 0) return (existing[0] as { id: string }).id;

  const { data, error } = await serviceClient()
    .from(TABLE)
    .insert({ client_id: clientId, kind: "branch", title: trimmed, tier, source: "manual_note", created_by: "classifier" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export interface CreateItemInput {
  clientId: string;
  parentId: string | null;
  title: string;
  body: string;
  rawInput: string;
  tier: Tier;
  tags: string[];
  status: KnowledgeStatus;
  classification: ClassificationMeta;
  createdBy: string;
  siteId?: string | null;
  source?: KnowledgeSource;
}

export async function createItem(input: CreateItemInput): Promise<KnowledgeNode> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .insert({
      client_id: input.clientId,
      site_id: input.siteId ?? null,
      parent_id: input.parentId,
      kind: "item",
      title: input.title,
      body: input.body,
      raw_input: input.rawInput,
      tier: input.tier,
      tags: input.tags,
      source: input.source ?? "manual_note",
      status: input.status,
      classification: input.classification,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const node = toNode(data as Row);

  // Best-effort: embed the new item when semantic retrieval is enabled.
  // A failure here never blocks the create — keyword retrieval is always the fallback.
  if (isSemanticEnabled()) {
    try {
      const vec = await embed(input.body);
      if (vec) {
        await serviceClient().from(TABLE).update({ embedding: vec }).eq("id", node.id);
        node.embedding = vec;
      }
    } catch {
      // Swallow — semantic is optional.
    }
  }

  return node;
}

export async function listNeedsReview(clientId: string): Promise<KnowledgeNode[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "needs_review")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toNode);
}

export async function resolveReview(id: string, patch: { tier: Tier; parentId: string }): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE)
    .update({ tier: patch.tier, parent_id: patch.parentId, status: "active" })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export interface VerifiedCredential {
  id: string;
  label: string;
  tier: Tier;
}

// ---------------------------------------------------------------------------
// Knowledge gap log
// ---------------------------------------------------------------------------

const GAP_TABLE = "practice_brain_gap";

export interface KnowledgeGap {
  id: string;
  question: string;
  askerTier: number;
  createdAt: string;
}

export async function logKnowledgeGap(clientId: string, question: string, askerTier: number): Promise<void> {
  const { error } = await serviceClient()
    .from(GAP_TABLE)
    .insert({ client_id: clientId, question, asker_tier: askerTier });
  if (error) throw new Error(error.message);
}

export async function listOpenGaps(clientId: string): Promise<KnowledgeGap[]> {
  const { data, error } = await serviceClient()
    .from(GAP_TABLE)
    .select("id, question, asker_tier, created_at")
    .eq("client_id", clientId)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as { id: string; question: string; asker_tier: number; created_at: string }[]).map((r) => ({
    id: r.id,
    question: r.question,
    askerTier: r.asker_tier,
    createdAt: r.created_at,
  }));
}

export async function resolveGap(id: string): Promise<void> {
  const { error } = await serviceClient()
    .from(GAP_TABLE)
    .update({ status: "resolved" })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Q&A conversation log
// ---------------------------------------------------------------------------

const QA_TABLE = "practice_brain_qa";

export interface QaLogInput {
  clientId: string;
  question: string;
  answer: string;
  groundedIn: number;
  askerTier: number;
  citedIds: string[];
}

export async function logQa(input: QaLogInput): Promise<string> {
  const { data, error } = await serviceClient()
    .from(QA_TABLE)
    .insert({
      client_id: input.clientId,
      question: input.question,
      answer: input.answer,
      grounded_in: input.groundedIn,
      asker_tier: input.askerTier,
      cited_ids: input.citedIds,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function setQaFeedback(id: string, value: number): Promise<void> {
  const { error } = await serviceClient()
    .from(QA_TABLE)
    .update({ feedback: value })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------

/** Verifies a plaintext password in Postgres (bcrypt). Returns the credential or null. */
export async function verifyCredential(clientId: string, password: string): Promise<VerifiedCredential | null> {
  const { data, error } = await serviceClient().rpc("verify_practice_brain_password", {
    p_client_id: clientId,
    p_password: password,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; label: string; tier: number }[];
  if (rows.length === 0) return null;
  return { id: rows[0].id, label: rows[0].label, tier: rows[0].tier as Tier };
}
