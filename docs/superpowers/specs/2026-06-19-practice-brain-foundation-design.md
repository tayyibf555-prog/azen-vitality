# Practice Brain (Knowledge Hub) — Foundation Design Spec

Date: 2026-06-19
Status: Approved (design). Build depth: real wiring (Supabase + Claude classification). Auth stays mock.

## Context

The Azen x Vitality platform is an AI operations layer built on top of Dentally for a
multi-site dental group. The foundation/shell is built (agency view + client dashboard on
mock data, module placeholders wired from `src/lib/nav.ts`), and the first real module
(Treatment Coordinator) is in progress.

This spec covers the **Practice Brain**: the internal knowledge hub. The `CLAUDE.md` build
scope tags it "PILOT for a basic knowledge base, PHASE 2 for the full AI version". The owner
wants the eventual full vision: a self-learning hub that an AI co-pilot pulls from, where
every piece of business knowledge (SOPs, scripts, protocols, pricing, workflows, marketing,
patient-handling, HR) is captured, auto-sorted, and gated by staff clearance.

That full vision is several subsystems. This spec is the **foundation slice only** (layers
1–4 of 7). It establishes the knowledge store, the agent classification pipeline, clearance
enforcement, and a browse UI, shaped so the co-pilot, file ingest, cross-module feeds, and
the self-learning loop drop in cleanly later.

## The product metaphor: a central hub with branches

Practice Brain is presented as a **central `Practice brain` hub with branches radiating off
it** (Marketing, Patients, Treatments, Pricing, Compliance, Reception, Protocols, HR & team,
and so on), not a flat list or a single "brain" view. Knowledge lives in a hierarchy:
hub → branch → sub-branch → item. The classifier decides which branch a new piece of
knowledge grows on, and proposes a new branch when nothing fits. This is the visual and
mental model the owner chose during brainstorming.

## Scope

### In scope (this slice)

- Supabase-backed knowledge store with a branch hierarchy (self-referential).
- A real Claude classifier (Sonnet) that, on capture, assigns: branch, title, cleaned body,
  sensitivity tier, and tags — in one structured pass. Proposes a new branch when none fit.
- 4-tier sensitivity ladder with a deterministic access guard (code, not an LLM).
- Capture path: typed/pasted notes, with a human confirm/override step on the classification.
- Browse UI: the central-hub branches canvas (clearance-filtered), drill-in to sub-branches
  and items, an item detail view, and keyword search.
- A needs-review queue for owner/manager.

### Out of scope (deferred to later slices)

- Co-pilot Q&A (conversational answers with citations) — layer 6.
- Semantic / vector search and embeddings (pgvector) — lands with the co-pilot.
- File uploads + parsing/OCR — layer 3b.
- Cross-module auto-feeds (Pricing & USPs, dialler scripts, Dentally workflows) — layer 3c.
- Conversation capture / self-learning loop (confirmed co-pilot answers saved back) — layer 7.
- Real Supabase auth + RLS, and a full staff-role/HR system. Auth stays mock this round.
- Re-classification background jobs.

## Decisions (locked)

- **Hierarchy:** knowledge items and branches are the same self-referential tree
  (`parent_id`). A branch is a node with children; an item is a leaf with `body`. This keeps
  "branches off branches" and "an item can be promoted to a branch" trivial.
- **Classification is one Claude call, not three agents.** The owner described separate
  agents for sensitivity, sorting, and access. Sensitivity + sorting + titling + tagging are
  done in a single structured Sonnet call (cheaper, consistent, one source of truth). Access
  is enforced separately and deterministically (see below). Sonnet per the `CLAUDE.md`
  "Sonnet for high-volume classification" note.
- **The access guard is deterministic, not an LLM.** "Only the right people can view it" is a
  hard query-layer filter (`item.tier <= viewer.maxTier`), never a Claude judgement. Security
  must not be promptable.
- **Fail closed on uncertainty.** If the classifier's confidence is low, the item is stored
  at the most restrictive tier (T4) and flagged `needs_review`. Nothing leaks while a
  manager/owner confirms. Human-in-the-loop per `CLAUDE.md` principle 5.
- **Auth stays mock.** The existing `useAuth` session maps role → max tier
  (`client_coordinator → T2`, `client_owner → T4`, `agency_admin → all`). The same filter
  becomes an RLS policy when real Supabase auth lands.
- **No clinical data.** The "Clinical-adjacent / Protocols" branch holds operations around
  care only (sterilisation SOPs, consent scripts, recall workflows), never diagnosis,
  imaging, charting, or treatment-decision logic. Enforced in the classifier prompt and
  called out in the UI.
- **No em-dashes** in any Claude-generated text (titles, cleaned bodies). `CLAUDE.md` copy rule.
- **Multi-site by default.** Every node carries `client_id` and a nullable `site_id`
  (null = applies to all sites).
- **Graceful degradation.** If Supabase / Anthropic env vars are absent, the module renders a
  clear "not configured" state and a small seeded demo tree rather than crashing.

## The 4-tier sensitivity ladder

| Tier | Name | Who (max tier) | Example knowledge |
|------|------|----------------|-------------------|
| T1 | General | all staff | scripts, public SOPs, published pricing |
| T2 | Operational | coordinators+ | internal workflows, follow-up cadences, conversion tactics |
| T3 | Management | managers / owner | performance context, financials, HR-adjacent ops |
| T4 | Confidential | owner + agency | commercials, contracts, strategy |

Role → max tier (mock auth bridge): `client_coordinator → T2`, `client_owner → T4`,
`agency_admin → T4 (all)`.

## Branch taxonomy (seed)

Branches are data, not code — they grow. The store is seeded with a starter set so the hub
is never empty: Marketing, Patients, Treatments, Pricing & finance, Compliance & GDPR,
Reception, Protocols (clinical-adjacent), HR & team, Dentally & systems, Commercial &
strategy. The classifier is given the current branch list at call time and either picks one
or proposes a new branch name (which is created on confirm).

## Architecture

```
Capture (typed note)
      |
      v
Server action: classify()  --(Sonnet, structured output)-->  { branch, title, body, tier, tags, confidence, reasoning }
      |                                                                  |
      |  low confidence?  -> tier=T4, status=needs_review                |
      v                                                                  v
Supabase: knowledge_node (tree)            <----- human confirm/override on classification
      ^
      |  read (clearance-filtered, deterministic guard by viewer.maxTier)
      v
Central-hub branches UI  ->  drill-in  ->  item detail / search / needs-review queue
```

## Data model — `knowledge_node` (Supabase / Postgres)

One self-referential table for both branches and items.

- `id` uuid pk
- `client_id` text (tenancy scope)
- `site_id` text null (null = all sites)
- `parent_id` uuid null (null = top-level branch off the hub; fk to `knowledge_node.id`)
- `kind` text enum: `branch` | `item`
- `title` text (classifier-generated for items; human/seed name for branches)
- `body` text null (classifier-cleaned content; null for branches)
- `raw_input` text null (original captured text, for future re-classification)
- `tier` smallint 1–4
- `tags` text[] (classifier-extracted keywords; powers keyword search)
- `source` text enum: `manual_note` (now) | `file_upload` | `module_feed` | `copilot_capture`
- `source_ref` text null
- `classification` jsonb null (classifier reasoning + confidence, for audit and the review queue)
- `status` text enum: `active` | `needs_review` | `archived`
- `created_by` text (session user id)
- `created_at` / `updated_at` timestamptz

Indexes: `(client_id, parent_id)`, `(client_id, tier)`, `(client_id, status)`, a GIN index on
`tags`, and a trigram or `to_tsvector` index on `title`/`body` for keyword search. No
embeddings column this slice (added with the co-pilot).

## Classification pipeline (server)

`classifyKnowledge(rawInput, { branches, siteId })` calls Claude (Sonnet) with a system
prompt that:
- explains the 4-tier ladder and asks for a tier with a confidence 0–1,
- supplies the current branch list and asks the model to pick one or propose a new branch,
- asks for a concise title, a cleaned body, and 3–8 tags,
- forbids em-dashes and forbids inventing clinical content,
- returns strict structured JSON (validated; on parse/validation failure, fail closed).

Result handling:
- confidence ≥ threshold → store `active` at the assigned tier under the chosen/new branch.
- confidence < threshold (or any error) → store `needs_review` at T4.
- The capture UI shows the assignment for the human to confirm or override before it is saved.

## Access enforcement

A single data-access layer (`listVisibleNodes`, `getNode`, `getBranchTree`) takes the current
session's `maxTier` (derived from role) and applies `tier <= maxTier AND status = 'active'`
(needs-review items are visible only to owner/manager in the review queue). Branch item counts
shown on the hub are computed post-filter, so each role sees only what it is cleared for. When
real auth lands, this exact predicate becomes a Supabase RLS policy and the data-access layer
stops passing `maxTier` explicitly.

## UI

Route: `src/app/c/[client]/practice-brain/page.tsx` (replaces the placeholder).

- **Hub view:** a data-driven SVG/CSS radial. Centre node = current branch (or `Practice
  brain` at the root). Children radiate out as branch/item nodes with counts. Positions
  computed from child count (evenly spaced); no heavy graph library. Clicking a branch
  re-centres on it (drill-in); a breadcrumb returns toward the hub.
- **Item view:** title, body, branch path, tier badge, tags, source, last updated.
- **Capture:** an "Add knowledge" panel — paste/type + optional site scope → runs
  `classify()` → shows assigned branch / tier / tags for confirm or override → saves.
- **Needs-review queue:** owner/manager only; list of `needs_review` nodes with the
  classifier's reasoning, to confirm tier/branch or edit.
- **Search:** keyword box over title/body/tags, clearance-filtered, results link into the tree.
- Uses existing primitives (`PageHeader`, `SectionCard`, `StatusPill`, `EmptyState`) and the
  brand tokens already in the app.

## Backend & integration

- Supabase: a server client (service role, server-only) for writes/classification and reads;
  the browser never holds the service role. Env: `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` (already in `.env.example`).
- Anthropic: existing `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`. Sonnet model id from a shared
  constant.
- A SQL migration creates `knowledge_node`, enums, indexes, and seeds the starter branches.
- If env is missing: a `not configured` banner + a small in-memory seed tree so the UI is
  demonstrable without credentials.

## Testing

TDD on the deterministic pieces, mirroring `scoring.test.ts` / `normalise.test.ts` (Claude
call mocked):
- the access guard: items above `maxTier` are filtered; needs-review hidden from browse;
  counts reflect the viewer's tier.
- the classification-result parser/normaliser: valid JSON maps correctly; malformed/low-
  confidence output fails closed to T4 + needs-review; em-dashes stripped/rejected.
- the tree/branch assembly: parent/child nesting, new-branch creation on confirm.

## Error & edge handling

- Empty or whitespace-only capture is rejected client-side.
- Input length capped this slice (long-doc chunking deferred with file ingest).
- Classifier/network failure → item saved as `needs_review` @ T4, user told it needs review.
- Never store a visible item without a tier; unclassified is impossible by construction.
- Deleting a branch with children is blocked (must move/empty first) to avoid orphaning.

## Future slices (not built now)

1. Co-pilot Q&A + retrieval API + embeddings (pgvector).
2. File uploads + parsing/OCR.
3. Cross-module auto-feeds (Pricing & USPs, scripts, Dentally workflows).
4. Self-learning loop (confirmed co-pilot answers saved back as knowledge).
5. Real Supabase auth + RLS; staff-role/HR clearance grants.
6. Re-classification + branch-reshaping background jobs.

## Open assumptions

- A Supabase project and Anthropic key will be available to run live; absent them the module
  runs in degraded/demo mode.
- The starter branch taxonomy is a seed, expected to drift as the classifier proposes new
  branches and the practice reshapes the tree.
