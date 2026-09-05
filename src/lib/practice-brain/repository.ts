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

/**
 * Fold a branch name to the key two names are "the same branch" under.
 *
 * Trimmed and lower-cased, which is what `ilike` used to be asked for and all it
 * was ever wanted for. `toLowerCase()` rather than `toLocaleLowerCase()` on
 * purpose: Unicode default case folding does not move with the server's locale,
 * so the key a branch is found under is the same key on every machine that runs
 * this. The one place it can disagree with Postgres' collation is the Turkish
 * dotted/dotless i, and the cost of that disagreement is a second branch in the
 * tree, not a wrong answer.
 */
function branchKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Find a top-level branch by name (case-insensitive) or create it. Returns its id.
 *
 * THE NAME IS UNTRUSTED TEXT, SO IT IS NEVER A PATTERN (programme ruling W3/12).
 * This used to read `.ilike("title", trimmed)`, and `trimmed` is not a constant:
 * it reaches here as `result.branch` off the `create` request body, as the
 * classifier's own model output on `learn`, and as `body.branch` on
 * `resolve-review`. `plainLabel` in the route strips controls and caps the
 * length; it does not — and should not — strip `%` or `_`, because those are
 * ordinary characters in a branch name someone might genuinely type.
 *
 * As a LIKE pattern they are not ordinary. A branch of `%` matched whatever the
 * database returned first and filed the note under a branch nobody named; worse,
 * the tier step below then LOWERED that unrelated branch's tier to this item's,
 * which is a visibility change in the tree UI. (The per-node clearance filter in
 * `visibleNodes` still governs what the co-pilot may read, so this was
 * mis-filing rather than disclosure — but mis-filing the practice's own
 * knowledge is exactly what this function exists to prevent.)
 *
 * ESCAPING WAS NOT THE FIX. `%` and `_` could be backslash-escaped, but
 * PostgREST additionally rewrites `*` to `%` inside a like/ilike pattern before
 * Postgres ever sees it, and there is no escape for that rewrite: `\*` becomes
 * `\%`, which then matches a literal per-cent sign rather than a literal
 * asterisk. So the pattern goes entirely and the match happens here, on values,
 * the same way `serialKey` does it in src/lib/equipment/repository.ts.
 *
 * The read is the same set `listBranchNames` already reads unbounded on every
 * classify — one client's top-level branches, a handful of rows — ordered oldest
 * first so that a tree which already contains two same-named branches (from
 * before this fix) resolves to the same one every time. A read FAILURE throws
 * rather than falling through to the insert: silently creating a duplicate
 * branch is how the tree would rot without anyone being told, and `createItem`
 * on the next line would throw on the same outage anyway.
 */
export async function ensureBranch(clientId: string, name: string, tier: Tier): Promise<string> {
  const trimmed = name.trim();
  const { data: branches, error: readError } = await serviceClient()
    .from(TABLE)
    .select("id, tier, title")
    .eq("client_id", clientId)
    .eq("kind", "branch")
    .is("parent_id", null)
    .order("created_at", { ascending: true });
  if (readError) throw new Error(readError.message);
  const wanted = branchKey(trimmed);
  const existing = ((branches ?? []) as { id: string; tier: number; title: string }[])
    .filter((b) => branchKey(String(b.title ?? "")) === wanted);
  if (existing.length > 0) {
    const row = existing[0];
    // A branch is structure: its tier must be the MINIMUM of its children so that
    // anyone who can see any child can see the branch. If this item is more
    // accessible (lower tier) than the branch was first created at, lower the
    // branch's tier; otherwise a cleared item would stay hidden behind an
    // over-restrictive parent in the tree UI.
    if (Number(row.tier) > tier) {
      await serviceClient().from(TABLE).update({ tier }).eq("id", row.id);
    }
    return row.id;
  }

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
