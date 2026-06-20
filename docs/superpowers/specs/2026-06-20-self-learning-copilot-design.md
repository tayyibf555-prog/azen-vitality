# Self-Learning Co-pilot — Design Spec

Date: 2026-06-20
Status: In progress (driven by /loop, self-paced). Builds on the Practice Brain foundation.
Branch: practice-brain-integration (worktree). Auth stays mock; clearance = per-user credential tier.

## Goal

Turn Practice Brain from a self-organising store into a self-learning brain that:
1. **Stores everything** (already true: typed notes auto-classified into the tree).
2. **Learns from everything** — confirmed co-pilot answers and human corrections are written
   back as new knowledge; unanswered questions become a gap queue to fill.
3. **Feeds a practice co-pilot** any staff member can query, with answers filtered to that
   person's clearance tier. The brain is one of the co-pilot's retrieval sources.

## What already exists (foundation, do not rebuild)

`knowledge_node` tree, the Sonnet classifier (branch + tier + tags, fail-closed), the
deterministic clearance guard (`tier <= maxTier`), per-user bcrypt credentials → tier, the
signed `pb_session` cookie, the constellation owner-dashboard view, capture-with-confirm, and
the needs-review queue.

## Architecture additions

```
Staff member (unlocked; maxTier from their credential cookie)
   -> asks the co-pilot a question
   -> RETRIEVE: clearance-filtered knowledge (Postgres full-text + tag overlap now;
                semantic/embeddings later) -> top-K nodes (all tier <= maxTier)
   -> ANSWER: Claude (Sonnet) answers ONLY from the retrieved nodes, cites them,
              says "not in the brain yet" when retrieval is empty
   -> LEARN: if the asker confirms/corrects the answer, it is routed back through the
             existing classify+create pipeline -> becomes new, tiered, sorted knowledge
   -> GAP: if retrieval was empty, the question is logged to a gap queue for an owner to fill
```

**Security invariant:** retrieval is the access boundary. The co-pilot is only ever handed
nodes at or below the asker's tier, so it physically cannot answer above clearance. The LLM is
never the guard. Anything the co-pilot learns is re-classified (so it gets its own tier and,
if low-confidence, lands in needs-review) — learning never bypasses the clearance model.

## Phases (each phase = one /loop iteration: TDD where pure, committed, verified)

- [x] **Phase 1 — Retrieval core.** `rankNodes(query, nodes)` pure ranking (full-text score
  over title/body/tags + tag-overlap boost), and `searchKnowledge(query, maxTier)` in the
  repository (Postgres `websearch_to_tsquery` over the existing `to_tsvector` index, plus tag
  match), clearance-filtered, returns top-K with a snippet. Unit-test the pure ranker.
- [x] **Phase 2 — Co-pilot Q&A endpoint.** `POST /api/practice-brain/ask` (cookie-gated,
  `maxTier` from the cookie): retrieve top-K, build a grounded system prompt, call Sonnet to
  answer strictly from the retrieved knowledge with citations (node id + title), refuse to
  invent, no em-dashes, no clinical content. Returns `{ answer, citations[], usedNodeIds[] }`.
  Unit-test the prompt builder + the answer/citation parser with a fake client.
- [x] **Phase 3 — Co-pilot UI.** A chat panel in the Practice Brain view: ask box, answer with
  inline citations that focus the cited hub/item in the constellation, loading + empty states.
  Available to whoever is unlocked; their tier governs what comes back.
- [x] **Phase 4 — Self-learning loop.** (a) "Save to brain" / "correct this" on an answer →
  routes through `classify` + `create` so it becomes tiered, sorted knowledge. (b) Empty
  retrieval → write to a `knowledge_gap` table (question, asker tier, timestamp); surface a
  gap queue to owner/manager. (c) thumbs up/down stored per Q&A for later tuning.
- [ ] **Phase 5 — Semantic retrieval (upgrade).** Add an embedding column (pgvector) + an
  embeddings provider (Voyage AI is Anthropic's recommendation; needs a key). Embed nodes on
  create; retrieval becomes hybrid (semantic + keyword). Gated on an embeddings key — until
  then Phase 1 keyword retrieval is the live source. Ships behind a flag so absence is graceful.
- [ ] **Phase 6 — "Everyone" access.** A staff-facing co-pilot entry (outside the owner-only
  dashboard) where each person unlocks with their own credential (sets their tier) and asks.
  Reuses the existing gate; no new auth. Real Supabase auth + RLS still deferred.

## Decisions / guardrails

- **Grounded-only answers.** The co-pilot answers strictly from retrieved knowledge, with
  citations. If nothing relevant is retrieved, it says so and triggers gap capture. It must
  not answer from model priors. No clinical content. No em-dashes (CLAUDE.md copy rule).
- **Learning goes through classification.** Every write-back uses the existing classify+create
  path, so new knowledge is tiered and sorted, and uncertain items land in needs-review.
- **Keyword-first.** Phase 1–4 need zero new API keys (Supabase FTS + the existing Anthropic
  key). Embeddings (Phase 5) are an enhancement, not a prerequisite.
- **One source now, many later.** This wires the brain as the co-pilot's source. Other sources
  (Dentally, pricing, scripts) plug into the same retrieve→answer shape later.

## Progress protocol (for the loop)

Each iteration: read this checklist + the git log on `practice-brain-integration`, pick the
lowest unchecked phase, build it (subagent/TDD), verify (tsc + tests + build, live API smoke
where relevant), tick the box in this file, commit, then reschedule. Stop when all phases are
checked or the user intervenes.

## Out of scope (still)

Real Supabase auth/RLS; voice; co-pilot sources beyond the brain; cross-site federation.
