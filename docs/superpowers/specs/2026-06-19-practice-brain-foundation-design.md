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

## The product metaphor: a glowing constellation

Practice Brain is presented as a **constellation / neural map**: a dense luminous core in the
centre, with organic dendritic branches radiating out to iconified category hubs (Back office,
Sales, Reception, Marketing, Operations, Intelligence, and so on), elegant letter-spaced
labels around the edge, and a deep navy canvas with an ambient starfield. The active hub is
lit (gold) while the rest sit calmer. This is the look the owner chose during brainstorming
(reference: a constellation "second brain" dashboard), rendered in the platform's brand navy.

It is NOT a flat list or a single static "brain" blob. Knowledge lives in a hierarchy:
core → hub (top-level branch) → sub-branch → item. Hubs are top-level branches; the dots
radiating off each hub are its sub-branches and items. The classifier decides which branch a
new piece of knowledge grows on, and proposes a new branch when nothing fits. Clearance is
expressed visually: nodes above the viewer's tier are simply absent, so a receptionist's map
has fewer stars than the owner's.

The constellation is a front-end over the ordinary tree data model below; it adds rendering
and interaction, not new domain logic. The visual itself is phased (see UI): a real
data-driven static-layout constellation now, motion/physics polish later.

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
- Owner-dashboard-only placement plus a per-user password gate (credential → tier), seeded
  credentials, unlock flow, and a signed session cookie.

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
- **Placement: owner dashboard only.** Practice Brain is a view inside the practice owner
  dashboard (`/owner/[client]/practice-brain`), not the staff (`/c/[client]`) surface. It is
  removed from `CLIENT_NAV` and added to the owner sidebar's "Practice" group. Staff get
  knowledge later through the co-pilot, not this management view.
- **Access: per-user password gate (this is the clearance mechanism).** Reaching the view
  still requires being logged into the owner dashboard, but opening Practice Brain then
  requires a *personal* password. Each authorised person has their own password mapped to a
  `viewer.maxTier`. The password both authenticates the person and sets what they see, so the
  per-user password gate *is* the tier clearance for this round (it replaces the role→tier
  mock bridge for this view). Passwords are bcrypt-hashed (pgcrypto) in a credentials table;
  verification runs in Postgres; a successful unlock issues a signed, httpOnly session cookie
  carrying `{credentialId, maxTier}`. The data API derives `maxTier` from that cookie, never
  from the client. Pilot-grade (cookie session, single client), hardened later with real auth.
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

| Tier | Name | Granted to (example) | Example knowledge |
|------|------|----------------------|-------------------|
| T1 | General | front desk credential | scripts, public SOPs, published pricing |
| T2 | Operational | coordinator credential | internal workflows, follow-up cadences, conversion tactics |
| T3 | Management | practice manager credential | performance context, financials, HR-adjacent ops |
| T4 | Confidential | owner credential | commercials, contracts, strategy |

`maxTier` comes from the **unlocked per-user credential** (see "Access: per-user password
gate"), not from the mock `useAuth` role. The owner's credential is T4 (sees everything).

## Access: per-user password gate

Each authorised person has a row in `practice_brain_credential` (`label`, bcrypt
`password_hash`, `tier`). Flow:

1. The logged-in owner opens `/owner/[client]/practice-brain`. If there is no valid unlock
   cookie, a password screen is shown (no knowledge is fetched yet).
2. They enter their personal password. `POST /api/practice-brain/unlock` calls a Postgres
   function `verify_practice_brain_password(client_id, password)` that returns the matching
   credential (`crypt(input, password_hash) = password_hash`) or nothing.
3. On a match, the route sets a signed, httpOnly session cookie `pb_session`
   (HMAC of `{credentialId, maxTier, exp}` using `PRACTICE_BRAIN_SESSION_SECRET`). On no
   match, a 401 and the screen shows "incorrect password".
4. Every data action (`tree`, `classify`, `create`, `needs-review`, `resolve-review`) reads
   and verifies `pb_session`, derives `maxTier`, and applies the deterministic clearance
   filter. Without a valid cookie the data actions return 401.

Credentials are seeded with bcrypt hashes of documented pilot passwords (owner T4, manager
T3, coordinator T2); an in-app credential manager is a later slice. The owner rotates the
seeded passwords after handover.

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

## Data model — `practice_brain_credential` (Supabase / Postgres)

Per-user passwords for the gate (see "Access: per-user password gate").

- `id` uuid pk
- `client_id` text
- `label` text (who: "Owner", "Practice manager", "Coordinator")
- `password_hash` text (bcrypt via pgcrypto `crypt()`/`gen_salt('bf')`)
- `tier` smallint 1–4 (the `maxTier` this person is granted)
- `created_at` timestamptz

Plus a Postgres function `verify_practice_brain_password(p_client_id text, p_password text)`
returning the matching `(id, label, tier)` row (or none), so the plaintext password is
compared in the database, never in app memory longer than the request.

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

The data-access layer applies `tier <= maxTier AND status = 'active'` (needs-review items are
visible only at tier ≥ 3, in the review queue). `maxTier` is derived server-side from the
verified `pb_session` cookie, never from the client. Branch item counts shown on the hub are
computed post-filter, so each credential sees only what it is cleared for. When real auth
lands, this predicate becomes a Supabase RLS policy.

## UI

Route: rendered in the owner dashboard via `src/app/owner/[client]/[module]/page.tsx` for
`module === "practice-brain"` (a `PracticeBrainView` component), mirroring how
`treatment-coordinator` is wired there. The staff route
`src/app/c/[client]/practice-brain/page.tsx` stays a placeholder; the module is removed from
`CLIENT_NAV` and added to the owner sidebar's "Practice" group.

- **Password screen (gate):** shown first if there is no valid `pb_session` cookie. A single
  password field → `POST /api/practice-brain/unlock`. On success the constellation loads; on
  failure it shows "incorrect password". No knowledge is fetched until unlocked.

- **Constellation view (primary):** a data-driven SVG on a navy canvas. Centre = the dense
  core; top-level branches render as iconified hubs around it; each hub's sub-branches and
  items radiate outward as a dendritic tree of nodes and edges. Letter-spaced labels sit near
  each hub. Layout is deterministic (positions derived from the tree: hubs spaced by angle,
  child nodes fanned outward) — no heavy graph/physics library this slice. Interactions:
  click a hub to focus/drill (it lights gold and re-centres), breadcrumb to step back, hover a
  node for its label, keyword search lights up matching nodes. Built so a later slice can swap
  the static layout for force-directed motion without touching the data layer.
  - Visual phasing — **Build 1 (this slice):** real data-driven static-layout constellation,
    clearance-filtered, click-to-focus, hover labels, the navy/glow aesthetic.
    **Later:** force-directed animation, drifting motion, zoom transitions, starfield twinkle.
  - The aesthetic is a deliberate dark scene (brand navy), the one place the UI departs from
    the app's lighter surfaces; brand tokens from `CLAUDE.md` (navy, light/dark blue, cream).
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
- A SQL migration creates `knowledge_node` and `practice_brain_credential`, enums, indexes,
  the `pgcrypto` extension, the `verify_practice_brain_password` function, and seeds the
  starter branches and pilot credentials.
- New env: `PRACTICE_BRAIN_SESSION_SECRET` (HMAC secret for the `pb_session` cookie). Added to
  `.env.example`; set in `.env.local`.
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
7. Constellation motion polish: force-directed/animated layout, drifting motion, zoom
   transitions, ambient starfield twinkle (Build 1 ships a static deterministic layout).
8. In-app credential manager (add/rotate/remove per-user passwords and tiers); Build 1 seeds
   credentials in the migration and the owner rotates them after handover.

## Open assumptions

- A Supabase project and Anthropic key will be available to run live; absent them the module
  runs in degraded/demo mode.
- The starter branch taxonomy is a seed, expected to drift as the classifier proposes new
  branches and the practice reshapes the tree.
