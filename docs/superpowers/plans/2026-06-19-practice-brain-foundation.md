# Practice Brain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the Practice Brain knowledge hub as a password-gated view inside the practice owner dashboard: a Supabase-backed self-referential knowledge tree, a Claude (Sonnet) classifier that assigns branch + sensitivity tier + tags on capture, a deterministic clearance guard, and a glowing constellation browse UI with capture and a needs-review queue.

**Architecture:** One self-referential Postgres table (`knowledge_node`) holds both branches and items. On capture, a server action sends the raw note to Claude and gets back structured JSON (branch, title, cleaned body, tier 1-4, tags, confidence); low-confidence results fail closed to tier 4 + `needs_review`. The view lives at `/owner/[client]/practice-brain` and is gated by a per-user password: each person has a bcrypt credential mapped to a tier; unlocking issues a signed httpOnly cookie, and every data action derives `viewer.maxTier` from that cookie and applies a pure clearance filter (`tier <= maxTier`). The per-user password is the clearance mechanism for this round. The browse UI is a deterministic data-driven SVG constellation (navy canvas, luminous core, dendritic branches to iconified hubs). Mock `useAuth` still gates reaching the owner dashboard; the clearance filter becomes an RLS policy when real auth lands.

**Tech Stack:** Next.js 16 (App Router) + React 19, TypeScript (strict), Tailwind v4, `@supabase/supabase-js`, `@anthropic-ai/sdk` (model `claude-sonnet-4-6`), Vitest. Reuses `src/lib/supabase/server.ts` (`serviceClient`) and the `src/lib/coordinator/*` + `supabase/migrations/*` patterns.

**Spec:** `docs/superpowers/specs/2026-06-19-practice-brain-foundation-design.md`

---

## File structure

Created in this plan:

- `supabase/migrations/0003_practice_brain.sql` — table, enums, indexes, trigger, pilot RLS, seed branches.
- `src/lib/ai/models.ts` — shared Anthropic model id constant.
- `src/lib/practice-brain/types.ts` — domain types.
- `src/lib/practice-brain/clearance.ts` (+ `.test.ts`) — role→tier, visibility filter, branch counts. Pure.
- `src/lib/practice-brain/classify.ts` (+ `.test.ts`) — classifier prompt, JSON parser/normaliser (fail-closed), Claude call. Claude client dependency-injected for tests.
- `src/lib/practice-brain/layout.ts` (+ `.test.ts`) — deterministic constellation layout math. Pure.
- `src/lib/practice-brain/session.ts` (+ `.test.ts`) — sign/verify the `pb_session` HMAC cookie. Pure.
- `src/lib/practice-brain/repository.ts` — Supabase data access (reuses `serviceClient`), incl. `verifyCredential`.
- `src/app/api/practice-brain/[action]/route.ts` — `unlock` | `tree` | `classify` | `create` | `needs-review` | `resolve-review`.
- `src/components/client/practice-brain/practice-brain-view.tsx` — top-level view: password gate → constellation page (used by the owner route).
- `src/components/client/practice-brain/password-gate.tsx` — the unlock screen.
- `src/components/client/practice-brain/constellation.tsx` — the SVG constellation view.
- `src/components/client/practice-brain/capture-panel.tsx` — capture + classify preview + confirm.
- `src/components/client/practice-brain/item-detail.tsx` — single item view.
- `src/components/client/practice-brain/needs-review.tsx` — review queue (tier ≥ 3).
- `src/components/client/practice-brain/index.ts` — barrel.

Modified:

- `src/app/owner/[client]/[module]/page.tsx` — render `PracticeBrainView` for `module === "practice-brain"`.
- `src/components/owner/owner-sidebar.tsx` — add a "Practice brain" link to the "Practice" group.
- `src/lib/nav.ts` — remove `practice-brain` from `CLIENT_NAV` (owner-only now; the staff route stays a placeholder).
- `.env.example` — add `PRACTICE_BRAIN_SESSION_SECRET`.

**Placement & access:** Practice Brain is an owner-dashboard view at `/owner/[client]/practice-brain`, gated by a per-user password. `maxTier` is derived from the unlocked credential's signed cookie, not from the mock role.

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/0003_practice_brain.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0003_practice_brain.sql
-- Practice Brain: a self-referential tree of knowledge branches and items.

create extension if not exists "pgcrypto";

create type knowledge_kind as enum ('branch', 'item');
create type knowledge_status as enum ('active', 'needs_review', 'archived');
create type knowledge_source as enum ('manual_note', 'file_upload', 'module_feed', 'copilot_capture');

create table knowledge_node (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,
  parent_id uuid references knowledge_node (id) on delete restrict,
  kind knowledge_kind not null,
  title text not null,
  body text,
  raw_input text,
  tier smallint not null default 4 check (tier between 1 and 4),
  tags text[] not null default '{}',
  source knowledge_source not null default 'manual_note',
  source_ref text,
  classification jsonb,
  status knowledge_status not null default 'active',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_node_client_parent_idx on knowledge_node (client_id, parent_id);
create index knowledge_node_client_tier_idx on knowledge_node (client_id, tier);
create index knowledge_node_client_status_idx on knowledge_node (client_id, status);
create index knowledge_node_tags_idx on knowledge_node using gin (tags);
create index knowledge_node_search_idx on knowledge_node
  using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '')));

create or replace function set_knowledge_node_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger knowledge_node_set_updated_at
  before update on knowledge_node
  for each row execute function set_knowledge_node_updated_at();

-- Pilot permissive RLS (mirrors migration 0002). Real per-site/tier policy lands with auth.
alter table knowledge_node enable row level security;
create policy knowledge_node_pilot_all on knowledge_node
  for all using (true) with check (true);

-- Seed six top-level hubs for the Vitality pilot (the constellation hubs).
insert into knowledge_node (client_id, parent_id, kind, title, tier, source, created_by) values
  ('vitality', null, 'branch', 'Back office',  3, 'manual_note', 'seed'),
  ('vitality', null, 'branch', 'Sales',        2, 'manual_note', 'seed'),
  ('vitality', null, 'branch', 'Reception',    1, 'manual_note', 'seed'),
  ('vitality', null, 'branch', 'Marketing',    1, 'manual_note', 'seed'),
  ('vitality', null, 'branch', 'Operations',   2, 'manual_note', 'seed'),
  ('vitality', null, 'branch', 'Intelligence', 3, 'manual_note', 'seed');

-- Per-user password gate for the owner-dashboard view.
create table practice_brain_credential (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  label text not null,
  password_hash text not null,
  tier smallint not null check (tier between 1 and 4),
  created_at timestamptz not null default now()
);

alter table practice_brain_credential enable row level security;
-- No permissive policy: this table is only ever read via the SECURITY DEFINER function
-- below (service role bypasses RLS for seeding). The anon key can never read hashes.

-- Verifies a plaintext password against the stored bcrypt hash, in the database.
create or replace function verify_practice_brain_password(p_client_id text, p_password text)
returns table (id uuid, label text, tier smallint)
language sql security definer
as $$
  select c.id, c.label, c.tier
  from practice_brain_credential c
  where c.client_id = p_client_id
    and c.password_hash = crypt(p_password, c.password_hash)
  limit 1;
$$;

-- Seed pilot credentials. Documented pilot passwords (rotate after handover):
--   Owner            -> vitality-owner-2026   (tier 4)
--   Practice manager -> vitality-manager-2026 (tier 3)
--   Coordinator      -> vitality-coord-2026   (tier 2)
insert into practice_brain_credential (client_id, label, password_hash, tier) values
  ('vitality', 'Owner',            crypt('vitality-owner-2026',   gen_salt('bf')), 4),
  ('vitality', 'Practice manager', crypt('vitality-manager-2026', gen_salt('bf')), 3),
  ('vitality', 'Coordinator',      crypt('vitality-coord-2026',   gen_salt('bf')), 2);
```

After applying, add the cookie-signing secret to the environment. Append to `.env.example`:
```env
# Practice Brain: HMAC secret for the per-user unlock session cookie
PRACTICE_BRAIN_SESSION_SECRET=
```
And set a real value in `.env.local` (any long random string), e.g.:
```env
PRACTICE_BRAIN_SESSION_SECRET=<paste a long random string>
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool `mcp__plugin_supabase_supabase__apply_migration` with `name: "0003_practice_brain"` and the SQL above. (Fallback if MCP is unavailable: `supabase db push` from the repo root, or paste the SQL into the Supabase dashboard SQL editor.)

- [ ] **Step 3: Verify the table and seed**

Use `mcp__plugin_supabase_supabase__execute_sql` with:
```sql
select kind, title, tier from knowledge_node where client_id = 'vitality' order by title;
select label, tier from practice_brain_credential where client_id = 'vitality' order by tier desc;
select label, tier from verify_practice_brain_password('vitality', 'vitality-owner-2026');
```
Expected: 6 branch rows; 3 credential rows (Owner/4, Practice manager/3, Coordinator/2); the
third query returns exactly one row `Owner | 4` (proves bcrypt verification works).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_practice_brain.sql .env.example
git commit -m "feat: practice brain schema, seed hubs + per-user credentials"
```

---

## Task 2: Shared model constant + domain types

**Files:**
- Create: `src/lib/ai/models.ts`
- Create: `src/lib/practice-brain/types.ts`

- [ ] **Step 1: Write the model constant**

`src/lib/ai/models.ts`:
```ts
/** Anthropic model ids used across the platform. */
export const SONNET = "claude-sonnet-4-6";
```

- [ ] **Step 2: Write the domain types**

`src/lib/practice-brain/types.ts`:
```ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (these files are not yet imported anywhere, so this just type-checks them).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/models.ts src/lib/practice-brain/types.ts
git commit -m "feat: practice brain domain types + model constant"
```

---

## Task 3: Clearance module (TDD)

**Files:**
- Create: `src/lib/practice-brain/clearance.ts`
- Test: `src/lib/practice-brain/clearance.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/practice-brain/clearance.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { maxTierForRole, visibleNodes, childrenOf, branchCounts } from "./clearance";
import type { KnowledgeNode, Tier } from "./types";

function node(p: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n", clientId: "vitality", siteId: null, parentId: null, kind: "item",
    title: "t", body: "b", rawInput: null, tier: 1 as Tier, tags: [],
    source: "manual_note", sourceRef: null, classification: null, status: "active",
    createdBy: null, createdAt: "", updatedAt: "", ...p,
  };
}

describe("maxTierForRole", () => {
  it("maps coordinator to 2, owner and agency to 4", () => {
    expect(maxTierForRole("client_coordinator")).toBe(2);
    expect(maxTierForRole("client_owner")).toBe(4);
    expect(maxTierForRole("agency_admin")).toBe(4);
  });
});

describe("visibleNodes", () => {
  it("hides nodes above the viewer tier and non-active nodes", () => {
    const nodes = [
      node({ id: "a", tier: 1 }),
      node({ id: "b", tier: 3 }),
      node({ id: "c", tier: 2, status: "needs_review" }),
      node({ id: "d", tier: 2 }),
    ];
    const visible = visibleNodes(nodes, 2).map((n) => n.id);
    expect(visible).toEqual(["a", "d"]);
  });
});

describe("childrenOf", () => {
  it("returns nodes whose parentId matches", () => {
    const nodes = [
      node({ id: "root", kind: "branch", parentId: null }),
      node({ id: "x", parentId: "root" }),
      node({ id: "y", parentId: "other" }),
    ];
    expect(childrenOf(nodes, "root").map((n) => n.id)).toEqual(["x"]);
  });
});

describe("branchCounts", () => {
  it("counts direct children per branch among the given (already filtered) nodes", () => {
    const nodes = [
      node({ id: "h1", kind: "branch", parentId: null }),
      node({ id: "i1", parentId: "h1" }),
      node({ id: "i2", parentId: "h1" }),
      node({ id: "h2", kind: "branch", parentId: null }),
    ];
    const counts = branchCounts(nodes);
    expect(counts.h1).toBe(2);
    expect(counts.h2 ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/practice-brain/clearance.test.ts`
Expected: FAIL ("Failed to resolve import ./clearance" / functions not defined).

- [ ] **Step 3: Write minimal implementation**

`src/lib/practice-brain/clearance.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/practice-brain/clearance.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/practice-brain/clearance.ts src/lib/practice-brain/clearance.test.ts
git commit -m "feat: practice brain clearance guard (tier filter)"
```

---

## Task 4: Classifier prompt + parser (TDD)

**Files:**
- Create: `src/lib/practice-brain/classify.ts`
- Test: `src/lib/practice-brain/classify.test.ts`

This task adds the pure pieces: `buildClassifyPrompt`, `stripEmDash`, `parseClassification`, `failClosed`. The Claude call is added in Task 5 in the same file.

- [ ] **Step 1: Write the failing test**

`src/lib/practice-brain/classify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildClassifyPrompt, stripEmDash, parseClassification, failClosed } from "./classify";

describe("stripEmDash", () => {
  it("replaces em and en dashes with commas", () => {
    expect(stripEmDash("book in — then confirm – politely")).not.toMatch(/[—–]/);
    expect(stripEmDash("a — b")).toBe("a, b");
  });
});

describe("buildClassifyPrompt", () => {
  it("lists the branches and embeds the raw note", () => {
    const { system, user } = buildClassifyPrompt("Reset the autoclave nightly", ["Reception", "Operations"]);
    expect(system).toMatch(/JSON/);
    expect(system).toMatch(/no em-dash/i);
    expect(user).toMatch(/Reception/);
    expect(user).toMatch(/Reset the autoclave nightly/);
  });
});

describe("parseClassification", () => {
  it("parses a confident result", () => {
    const json = JSON.stringify({
      branch: "Operations", branchIsNew: false, title: "Autoclave nightly reset",
      body: "Reset the autoclave each night.", tier: 1, tags: ["autoclave", "sop"],
      confidence: 0.9, reasoning: "Routine SOP.",
    });
    const r = parseClassification(json);
    expect(r.branch).toBe("Operations");
    expect(r.tier).toBe(1);
    expect(r.needsReview).toBe(false);
    expect(r.tags).toEqual(["autoclave", "sop"]);
  });

  it("fails closed to tier 4 + needs review when confidence is low", () => {
    const json = JSON.stringify({
      branch: "Back office", branchIsNew: false, title: "Maybe finances",
      body: "Unclear note.", tier: 2, tags: [], confidence: 0.2, reasoning: "Unsure.",
    });
    const r = parseClassification(json);
    expect(r.tier).toBe(4);
    expect(r.needsReview).toBe(true);
  });

  it("strips em-dashes from title and body", () => {
    const json = JSON.stringify({
      branch: "Reception", branchIsNew: false, title: "Call back — same day",
      body: "Ring the patient — within the hour.", tier: 1, tags: ["calls"],
      confidence: 0.8, reasoning: "ok",
    });
    const r = parseClassification(json);
    expect(r.title).not.toMatch(/[—–]/);
    expect(r.body).not.toMatch(/[—–]/);
  });

  it("fails closed on malformed JSON", () => {
    const r = parseClassification("not json at all");
    expect(r.needsReview).toBe(true);
    expect(r.tier).toBe(4);
    expect(r.confidence).toBe(0);
  });

  it("clamps an out-of-range tier", () => {
    const json = JSON.stringify({ branch: "Sales", title: "x", body: "y", tier: 9, confidence: 0.9, tags: [] });
    const r = parseClassification(json);
    expect([1, 2, 3, 4]).toContain(r.tier);
  });
});

describe("failClosed", () => {
  it("produces a tier 4 needs-review result from raw text", () => {
    const r = failClosed("some long captured note about the kettle");
    expect(r.tier).toBe(4);
    expect(r.needsReview).toBe(true);
    expect(r.body).toContain("kettle");
    expect(r.title.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/practice-brain/classify.test.ts`
Expected: FAIL ("Failed to resolve import ./classify").

- [ ] **Step 3: Write minimal implementation**

`src/lib/practice-brain/classify.ts`:
```ts
import type { ClassificationResult, Tier } from "./types";

const CONFIDENCE_THRESHOLD = 0.6;

export function stripEmDash(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .trim();
}

function clampTier(value: unknown): Tier {
  const n = Math.round(Number(value));
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return 4;
}

function firstWords(s: string, n = 6): string {
  const words = s.trim().split(/\s+/).slice(0, n).join(" ");
  return words.length > 0 ? words : "Untitled note";
}

export function buildClassifyPrompt(rawInput: string, branches: string[]) {
  const system = [
    "You are the librarian for a UK dental practice's internal knowledge hub.",
    "Classify the note as ONE JSON object and output nothing else.",
    "Rules:",
    "- Pick the single best branch from the provided list, or propose a new short branch name. Set branchIsNew true only if you propose a new one.",
    "- Assign a sensitivity tier: 1 General (all staff: scripts, public SOPs, pricing), 2 Operational (coordinators and up: internal workflows, follow-up cadences), 3 Management (managers and owner: performance, financials, HR-adjacent), 4 Confidential (owner only: commercials, contracts, strategy).",
    "- If you are unsure of the branch or tier, pick the higher (more restrictive) tier and lower your confidence.",
    "- Write a concise title (max 8 words) and a cleaned body that tidies the note while keeping every fact.",
    "- Extract 3 to 8 lowercase tags.",
    "- confidence is your certainty about branch and tier, from 0 to 1.",
    "- Never invent clinical content: no diagnosis, imaging, charting, or treatment decisions. Operations only.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    'Output ONLY: {"branch":"","branchIsNew":false,"title":"","body":"","tier":1,"tags":[],"confidence":0,"reasoning":""}',
  ].join("\n");

  const user = [
    `Existing branches: ${branches.join(", ")}`,
    "",
    "Note:",
    rawInput.trim(),
  ].join("\n");

  return { system, user };
}

export function failClosed(rawInput: string): ClassificationResult {
  return {
    branch: "",
    branchIsNew: false,
    title: stripEmDash(firstWords(rawInput)),
    body: stripEmDash(rawInput.trim()),
    tier: 4,
    tags: [],
    confidence: 0,
    reasoning: "Automatic fallback: classification could not be completed.",
    needsReview: true,
  };
}

export function parseClassification(text: string): ClassificationResult {
  let raw: Record<string, unknown>;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no json object");
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return failClosed(text);
  }

  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  const lowConfidence = confidence < CONFIDENCE_THRESHOLD || branch.length === 0;
  const tier = lowConfidence ? 4 : clampTier(raw.tier);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()).slice(0, 8)
    : [];

  return {
    branch,
    branchIsNew: raw.branchIsNew === true,
    title: stripEmDash(typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled note"),
    body: stripEmDash(typeof raw.body === "string" ? raw.body : ""),
    tier,
    tags,
    confidence,
    reasoning: typeof raw.reasoning === "string" ? stripEmDash(raw.reasoning) : "",
    needsReview: lowConfidence,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/practice-brain/classify.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/practice-brain/classify.ts src/lib/practice-brain/classify.test.ts
git commit -m "feat: practice brain classification prompt + fail-closed parser"
```

---

## Task 5: Classifier Claude call (TDD with injected client)

**Files:**
- Modify: `src/lib/practice-brain/classify.ts` (append `classifyKnowledge`)
- Modify: `src/lib/practice-brain/classify.test.ts` (append cases)

Mirrors `src/lib/coordinator/draft.ts`: the Anthropic client is a default parameter so tests pass a fake.

- [ ] **Step 1: Write the failing test (append)**

Append to `src/lib/practice-brain/classify.test.ts`:
```ts
import { classifyKnowledge } from "./classify";

function fakeClient(jsonText: string) {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: jsonText }] }),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

function throwingClient() {
  return {
    messages: { create: async () => { throw new Error("api down"); } },
  } as unknown as import("@anthropic-ai/sdk").default;
}

describe("classifyKnowledge", () => {
  it("returns a parsed result from the model output", async () => {
    const json = JSON.stringify({
      branch: "Reception", branchIsNew: false, title: "Greeting script",
      body: "Greet every caller by name.", tier: 1, tags: ["calls", "script"],
      confidence: 0.92, reasoning: "Front desk script.",
    });
    const r = await classifyKnowledge("Greet every caller by name", ["Reception"], fakeClient(json));
    expect(r.branch).toBe("Reception");
    expect(r.needsReview).toBe(false);
  });

  it("fails closed when the API throws", async () => {
    const r = await classifyKnowledge("anything", ["Reception"], throwingClient());
    expect(r.needsReview).toBe(true);
    expect(r.tier).toBe(4);
  });

  it("rejects empty input", async () => {
    await expect(classifyKnowledge("   ", ["Reception"], fakeClient("{}"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/practice-brain/classify.test.ts`
Expected: FAIL ("classifyKnowledge is not a function").

- [ ] **Step 3: Write minimal implementation (append to classify.ts)**

Add to the top of `src/lib/practice-brain/classify.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import { SONNET } from "@/lib/ai/models";
```

Append to the bottom of `src/lib/practice-brain/classify.ts`:
```ts
function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function classifyKnowledge(
  rawInput: string,
  branches: string[],
  client: Anthropic = new Anthropic(),
): Promise<ClassificationResult> {
  if (!rawInput.trim()) throw new Error("empty input");
  const { system, user } = buildClassifyPrompt(rawInput, branches);
  try {
    const msg = await client.messages.create({
      model: SONNET,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    });
    return parseClassification(extractText(msg));
  } catch {
    return failClosed(rawInput);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/practice-brain/classify.test.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/practice-brain/classify.ts src/lib/practice-brain/classify.test.ts
git commit -m "feat: practice brain Sonnet classifier call"
```

---

## Task 6: Constellation layout math (TDD)

**Files:**
- Create: `src/lib/practice-brain/layout.ts`
- Test: `src/lib/practice-brain/layout.test.ts`

Pure, deterministic positions for the SVG. Hubs ring the centre; each hub's leaves fan outward.

- [ ] **Step 1: Write the failing test**

`src/lib/practice-brain/layout.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { layoutConstellation } from "./layout";
import type { Tier } from "./types";

const hubs = [
  { id: "h1", title: "Reception", tier: 1 as Tier, leaves: [{ id: "l1", title: "Script", tier: 1 as Tier }] },
  { id: "h2", title: "Sales", tier: 2 as Tier, leaves: [] },
  { id: "h3", title: "Marketing", tier: 1 as Tier, leaves: [{ id: "l2", title: "Brand", tier: 1 as Tier }, { id: "l3", title: "Ads", tier: 1 as Tier }] },
];

describe("layoutConstellation", () => {
  it("places one hub per input and is deterministic", () => {
    const a = layoutConstellation(hubs, { width: 680, height: 560 });
    const b = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(a.hubs).toHaveLength(3);
    expect(a).toEqual(b);
  });

  it("keeps every placed point inside the canvas", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    for (const h of c.hubs) {
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.x).toBeLessThanOrEqual(680);
      expect(h.y).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeLessThanOrEqual(560);
    }
    for (const leaf of c.leaves) {
      expect(leaf.x).toBeGreaterThanOrEqual(0);
      expect(leaf.x).toBeLessThanOrEqual(680);
      expect(leaf.y).toBeGreaterThanOrEqual(0);
      expect(leaf.y).toBeLessThanOrEqual(560);
    }
  });

  it("emits leaves for hubs that have them", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(c.leaves.filter((l) => l.hubId === "h3")).toHaveLength(2);
    expect(c.leaves.filter((l) => l.hubId === "h2")).toHaveLength(0);
  });

  it("centres the core", () => {
    const c = layoutConstellation(hubs, { width: 680, height: 560 });
    expect(c.center).toEqual({ x: 340, y: 280 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/practice-brain/layout.test.ts`
Expected: FAIL ("Failed to resolve import ./layout").

- [ ] **Step 3: Write minimal implementation**

`src/lib/practice-brain/layout.ts`:
```ts
import type { Tier } from "./types";

export interface HubInput {
  id: string;
  title: string;
  tier: Tier;
  leaves: { id: string; title: string; tier: Tier }[];
}

export interface PlacedHub {
  id: string;
  title: string;
  tier: Tier;
  x: number;
  y: number;
  angle: number;
  leafCount: number;
}

export interface PlacedLeaf {
  id: string;
  hubId: string;
  title: string;
  tier: Tier;
  x: number;
  y: number;
}

export interface Constellation {
  center: { x: number; y: number };
  hubs: PlacedHub[];
  leaves: PlacedLeaf[];
}

const MAX_LEAVES = 10;

/** Deterministic radial layout: hubs on a ring, leaves fanned outward from each hub. */
export function layoutConstellation(
  hubsIn: HubInput[],
  opts: { width: number; height: number },
): Constellation {
  const { width, height } = opts;
  const center = { x: width / 2, y: height / 2 };
  const ringRadius = Math.min(width, height) * 0.3;
  const leafRadius = Math.min(width, height) * 0.18;
  const n = Math.max(hubsIn.length, 1);

  const clampX = (x: number) => Math.max(0, Math.min(width, x));
  const clampY = (y: number) => Math.max(0, Math.min(height, y));

  const hubs: PlacedHub[] = [];
  const leaves: PlacedLeaf[] = [];

  hubsIn.forEach((hub, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const hx = clampX(center.x + Math.cos(angle) * ringRadius);
    const hy = clampY(center.y + Math.sin(angle) * ringRadius);
    hubs.push({ id: hub.id, title: hub.title, tier: hub.tier, x: hx, y: hy, angle, leafCount: hub.leaves.length });

    const shown = hub.leaves.slice(0, MAX_LEAVES);
    const spread = Math.PI / 3;
    const m = shown.length;
    shown.forEach((leaf, j) => {
      const offset = m > 1 ? spread * (j / (m - 1) - 0.5) : 0;
      const la = angle + offset;
      const lx = clampX(hx + Math.cos(la) * leafRadius);
      const ly = clampY(hy + Math.sin(la) * leafRadius);
      leaves.push({ id: leaf.id, hubId: hub.id, title: leaf.title, tier: leaf.tier, x: lx, y: ly });
    });
  });

  return { center, hubs, leaves };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/practice-brain/layout.test.ts`
Expected: PASS (4 passing). Note `center` is `{x:340,y:280}` for 680x560.

- [ ] **Step 5: Commit**

```bash
git add src/lib/practice-brain/layout.ts src/lib/practice-brain/layout.test.ts
git commit -m "feat: practice brain constellation layout math"
```

---

## Task 6b: Session cookie helper (TDD)

**Files:**
- Create: `src/lib/practice-brain/session.ts`
- Test: `src/lib/practice-brain/session.test.ts`

Pure HMAC sign/verify for the `pb_session` cookie. Uses Node `crypto` (available in route handlers and vitest).

- [ ] **Step 1: Write the failing test**

`src/lib/practice-brain/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { signSession, verifySession, type PbSession } from "./session";

const SECRET = "test-secret-please-rotate";
const future = 10_000_000_000_000;

describe("session cookie", () => {
  const payload: PbSession = { credentialId: "cred-1", maxTier: 4, exp: future };

  it("round-trips a valid token", () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, SECRET)).toEqual(payload);
  });

  it("rejects a tampered token", () => {
    const token = signSession(payload, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = signSession(payload, "other-secret");
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signSession({ ...payload, exp: 1 }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects missing/garbage input", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("nope", SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/practice-brain/session.test.ts`
Expected: FAIL ("Failed to resolve import ./session").

- [ ] **Step 3: Write minimal implementation**

`src/lib/practice-brain/session.ts`:
```ts
import { createHmac, timingSafeEqual } from "crypto";

export interface PbSession {
  credentialId: string;
  maxTier: number;
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSession(payload: PbSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): PbSession | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as PbSession;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (typeof payload.credentialId !== "string" || typeof payload.maxTier !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/practice-brain/session.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/practice-brain/session.ts src/lib/practice-brain/session.test.ts
git commit -m "feat: practice brain signed session cookie helper"
```

---

## Task 7: Supabase repository

**Files:**
- Create: `src/lib/practice-brain/repository.ts`

Data access only (reuses `serviceClient`). Pilot scale: load all active nodes for a client and build the tree in memory. Verified through the API in Task 8, not unit-tested (it talks to Supabase).

- [ ] **Step 1: Write the repository**

`src/lib/practice-brain/repository.ts`:
```ts
import { serviceClient } from "@/lib/supabase/server";
import type {
  ClassificationMeta, KnowledgeNode, KnowledgeStatus, Tier,
} from "./types";

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
      source: "manual_note",
      status: input.status,
      classification: input.classification,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return toNode(data as Row);
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/practice-brain/repository.ts
git commit -m "feat: practice brain supabase repository"
```

---

## Task 8: API route

**Files:**
- Create: `src/app/api/practice-brain/[action]/route.ts`

Follows the `src/app/api/coordinator/[action]/route.ts` dispatch pattern. `unlock` verifies a per-user password and sets the signed `pb_session` cookie; every other action derives `maxTier` from that cookie (server-side) and applies the deterministic clearance filter, returning 401 when locked.

- [ ] **Step 1: Write the route**

`src/app/api/practice-brain/[action]/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { classifyKnowledge } from "@/lib/practice-brain/classify";
import { visibleNodes } from "@/lib/practice-brain/clearance";
import { signSession, verifySession } from "@/lib/practice-brain/session";
import type { ClassificationResult, Tier } from "@/lib/practice-brain/types";
import {
  createItem, ensureBranch, listActiveNodes, listBranchNames, listNeedsReview, resolveReview, verifyCredential,
} from "@/lib/practice-brain/repository";

const CLIENT_ID = "vitality";
const COOKIE = "pb_session";
const SESSION_MS = 1000 * 60 * 60 * 8;

function ok<T>(data: T) {
  return NextResponse.json({ success: true, data });
}
function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const secret = process.env.PRACTICE_BRAIN_SESSION_SECRET ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    // Unlock: verify a per-user password and issue the signed session cookie.
    if (action === "unlock") {
      const password = String(body.password ?? "");
      if (!password) return fail("Password required.");
      if (!secret) return fail("Server missing PRACTICE_BRAIN_SESSION_SECRET.", 500);
      const cred = await verifyCredential(CLIENT_ID, password);
      if (!cred) return fail("Incorrect password.", 401);
      const token = signSession({ credentialId: cred.id, maxTier: cred.tier, exp: Date.now() + SESSION_MS }, secret);
      const res = ok({ label: cred.label, maxTier: cred.tier });
      res.cookies.set(COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_MS / 1000,
      });
      return res;
    }

    // Every other action requires a valid unlock cookie. maxTier comes from it, not the client.
    const session = verifySession(req.cookies.get(COOKIE)?.value, secret);
    if (!session) return fail("Locked. Unlock Practice Brain first.", 401);
    const maxTier = session.maxTier as Tier;

    if (action === "tree") {
      const all = await listActiveNodes(CLIENT_ID);
      return ok({ nodes: visibleNodes(all, maxTier), maxTier });
    }

    if (action === "classify") {
      const rawInput = String(body.rawInput ?? "").trim();
      if (!rawInput) return fail("Note is empty.");
      const branches = await listBranchNames(CLIENT_ID);
      const result = await classifyKnowledge(rawInput, branches);
      return ok(result);
    }

    if (action === "create") {
      const result = body.result as ClassificationResult | undefined;
      const rawInput = String(body.rawInput ?? "").trim();
      if (!result || !rawInput) return fail("Missing classification or note.");
      const tier = result.tier as Tier;
      const classification = {
        reasoning: result.reasoning,
        confidence: result.confidence,
        branchIsNew: result.branchIsNew,
      };
      const parentId = result.needsReview || !result.branch
        ? null
        : await ensureBranch(CLIENT_ID, result.branch, tier);
      const node = await createItem({
        clientId: CLIENT_ID,
        parentId,
        title: result.title,
        body: result.body,
        rawInput,
        tier,
        tags: result.tags,
        status: result.needsReview ? "needs_review" : "active",
        classification,
        createdBy: session.credentialId,
      });
      return ok(node);
    }

    if (action === "needs-review") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      return ok({ nodes: await listNeedsReview(CLIENT_ID) });
    }

    if (action === "resolve-review") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      const id = String(body.id ?? "");
      const branch = String(body.branch ?? "");
      const tier = Number(body.tier) as Tier;
      if (!id || !branch) return fail("Missing id or branch.");
      const parentId = await ensureBranch(CLIENT_ID, branch, tier);
      await resolveReview(id, { tier, parentId });
      return ok({ id });
    }

    return fail(`Unknown action: ${action}`, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return fail(message, 500);
  }
}
```

- [ ] **Step 2: Smoke test the route**

Start the dev server with the `preview_start` tool. Then verify with `preview_eval`.

First confirm the gate blocks unauthenticated reads:
```js
await fetch("/api/practice-brain/tree", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
}).then((r) => r.status);
```
Expected: `401` (locked).

Now unlock (the browser stores the `pb_session` cookie automatically), then read the tree:
```js
await fetch("/api/practice-brain/unlock", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "vitality-owner-2026" }),
}).then((r) => r.json());
// then:
await fetch("/api/practice-brain/tree", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
}).then((r) => r.json());
```
Expected: unlock returns `{ success: true, data: { label: "Owner", maxTier: 4 } }`; tree returns `{ success: true, data: { nodes: [6 seed branches...], maxTier: 4 } }`.

Then test classification (uses the real Anthropic key, requires the cookie from unlock):
```js
await fetch("/api/practice-brain/classify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ rawInput: "Always confirm implant consults by phone the day before." }),
}).then((r) => r.json());
```
Expected: `{ success: true, data: { branch: <one of the hubs>, tier: <1-4>, title, body, tags, confidence, needsReview } }`.

Also confirm a wrong password is rejected:
```js
await fetch("/api/practice-brain/unlock", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "wrong" }),
}).then((r) => r.status);
```
Expected: `401`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/practice-brain/[action]/route.ts
git commit -m "feat: practice brain API (tree, classify, create, review)"
```

---

## Task 9: Constellation component

**Files:**
- Create: `src/components/client/practice-brain/constellation.tsx`

Client component. Renders the navy SVG from visible nodes: dense core, hubs from `layoutConstellation`, leaves, labels, gold active hub, search highlight. Drill-in is handled by the parent (which changes the focus node).

- [ ] **Step 1: Write the component**

`src/components/client/practice-brain/constellation.tsx`:
```tsx
"use client";

import { useMemo } from "react";
import type { KnowledgeNode } from "@/lib/practice-brain/types";
import { childrenOf } from "@/lib/practice-brain/clearance";
import { layoutConstellation, type HubInput } from "@/lib/practice-brain/layout";

const W = 680;
const H = 560;

interface Props {
  nodes: KnowledgeNode[];
  focusId: string | null;
  activeHubId: string | null;
  query: string;
  onSelectHub: (id: string) => void;
  onSelectItem: (id: string) => void;
}

export function Constellation({ nodes, focusId, activeHubId, query, onSelectHub, onSelectItem }: Props) {
  const layout = useMemo(() => {
    const hubsRaw = childrenOf(nodes, focusId);
    const hubs: HubInput[] = hubsRaw.map((h) => ({
      id: h.id,
      title: h.title,
      tier: h.tier,
      leaves: childrenOf(nodes, h.id).map((l) => ({ id: l.id, title: l.title, tier: l.tier })),
    }));
    return layoutConstellation(hubs, { width: W, height: H });
  }, [nodes, focusId]);

  const q = query.trim().toLowerCase();
  const matches = (title: string) => q.length > 0 && title.toLowerCase().includes(q);

  const core = useMemo(() => {
    const arr: { x2: number; y2: number; r: number; op: number }[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2;
      const L = rnd() * 42 + 6;
      arr.push({ x2: 340 + Math.cos(a) * L, y2: 280 + Math.sin(a) * L, r: rnd() * 1.1 + 0.5, op: 0.7 - L / 70 });
    }
    return arr;
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", background: "#0A0E1A", borderRadius: 12, overflow: "hidden", border: "0.5px solid rgba(150,170,210,0.18)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Practice brain constellation">
        {core.map((c, i) => (
          <line key={`c${i}`} x1={340} y1={280} x2={c.x2.toFixed(1)} y2={c.y2.toFixed(1)} stroke={`rgba(150,200,255,${c.op.toFixed(2)})`} strokeWidth={0.6} />
        ))}
        <circle cx={340} cy={280} r={7} fill="#BFE0FF" opacity={0.25} />
        <circle cx={340} cy={280} r={3} fill="#FFFFFF" />

        {layout.hubs.map((h) => {
          const active = h.id === activeHubId;
          const hit = matches(h.title);
          const stroke = active ? "#F4C451" : hit ? "#5BC4F7" : "rgba(190,205,235,0.55)";
          return (
            <g key={h.id} style={{ cursor: "pointer" }} onClick={() => onSelectHub(h.id)}>
              <line x1={340} y1={280} x2={h.x} y2={h.y} stroke={active ? "rgba(244,196,81,0.5)" : "rgba(124,166,226,0.22)"} strokeWidth={active ? 1.1 : 0.7} />
              {active && <circle cx={h.x} cy={h.y} r={22} fill="none" stroke="rgba(244,196,81,0.25)" strokeWidth={6} />}
              <circle cx={h.x} cy={h.y} r={15} fill="#12224A" stroke={stroke} strokeWidth={active ? 1.6 : 1} />
              <text x={h.x} y={h.y - 24} textAnchor="middle" fontSize={13} letterSpacing={2} fill={active ? "#F4C451" : "#C8D4F0"} style={{ textTransform: "uppercase" }}>{h.title}</text>
              <text x={h.x} y={h.y - 10} textAnchor="middle" fontSize={9} fill="#7081AC">{h.leafCount} items</text>
            </g>
          );
        })}

        {layout.leaves.map((l) => {
          const hit = matches(l.title);
          return (
            <g key={l.id} style={{ cursor: "pointer" }} onClick={() => onSelectItem(l.id)}>
              <circle cx={l.x} cy={l.y} r={hit ? 4 : 2.6} fill={hit ? "#FFFFFF" : "#79ADE8"} opacity={hit ? 1 : 0.85} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/client/practice-brain/constellation.tsx
git commit -m "feat: practice brain constellation SVG component"
```

---

## Task 10: Capture panel component

**Files:**
- Create: `src/components/client/practice-brain/capture-panel.tsx`

Paste a note → classify (preview the branch/tier/tags) → confirm or edit tier → save.

- [ ] **Step 1: Write the component**

`src/components/client/practice-brain/capture-panel.tsx`:
```tsx
"use client";

import { useState } from "react";
import { TIER_LABELS, type ClassificationResult, type Tier } from "@/lib/practice-brain/types";

interface Props {
  onSaved: () => void;
}

export function CapturePanel({ onSaved }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function classify() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawInput: text }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Classification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result, rawInput: text }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      setText("");
      setResult(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line-strong bg-card p-4">
      <h3 className="text-sm font-semibold text-ink">Add knowledge</h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Paste an SOP, script, protocol or note. The classifier files it on the right branch."
        className="mt-2 w-full rounded-lg border border-line bg-card-muted p-2 text-sm text-ink"
      />
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {!result && (
        <button
          onClick={classify}
          disabled={busy || text.trim().length === 0}
          className="mt-2 rounded-lg bg-blue-dark px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Classifying..." : "Classify"}
        </button>
      )}

      {result && (
        <div className="mt-3 rounded-lg border border-line bg-card-muted p-3 text-sm">
          <p className="font-medium text-ink">{result.title}</p>
          <p className="mt-1 text-xs text-muted">{result.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-line-strong px-2 py-0.5">Branch: {result.branch || "unsorted"}{result.branchIsNew ? " (new)" : ""}</span>
            <label className="flex items-center gap-1">
              Tier:
              <select
                value={result.tier}
                onChange={(e) => setResult({ ...result, tier: Number(e.target.value) as Tier })}
                className="rounded border border-line bg-card px-1 py-0.5"
              >
                {[1, 2, 3, 4].map((t) => (
                  <option key={t} value={t}>{t} {TIER_LABELS[t as Tier]}</option>
                ))}
              </select>
            </label>
            {result.tags.map((t) => (
              <span key={t} className="rounded-full bg-blue-light/20 px-2 py-0.5 text-blue-dark">{t}</span>
            ))}
          </div>
          {result.needsReview && (
            <p className="mt-2 text-xs text-amber-600">Low confidence. This will be saved to the review queue at the most restrictive tier.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button onClick={save} disabled={busy} className="rounded-lg bg-blue-dark px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
            <button onClick={() => setResult(null)} disabled={busy} className="rounded-lg border border-line px-3 py-1.5 text-sm">Re-do</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (If any Tailwind class token like `border-line-strong` or `blue-dark` is unknown, check `src/app/globals.css` for the project's actual token names and adjust — the coordinator components use the same tokens.)

- [ ] **Step 3: Commit**

```bash
git add src/components/client/practice-brain/capture-panel.tsx
git commit -m "feat: practice brain capture panel with classify preview"
```

---

## Task 10b: Password gate component

**Files:**
- Create: `src/components/client/practice-brain/password-gate.tsx`

The unlock screen, styled on the navy constellation canvas. On success it hands the caller the label + maxTier.

- [ ] **Step 1: Write the component**

`src/components/client/practice-brain/password-gate.tsx`:
```tsx
"use client";

import { useState, type FormEvent } from "react";

interface Props {
  onUnlocked: (label: string, maxTier: number) => void;
}

export function PasswordGate({ onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      onUnlocked(res.data.label as string, res.data.maxTier as number);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: 420, background: "#0A0E1A", borderRadius: 12,
        border: "0.5px solid rgba(150,170,210,0.18)",
      }}
    >
      <form onSubmit={submit} style={{ width: 300, textAlign: "center" }}>
        <div style={{ color: "#5BC4F7", fontSize: 13, letterSpacing: 3, textTransform: "uppercase", marginBottom: 8 }}>
          Practice brain
        </div>
        <p style={{ color: "#C8D4F0", fontSize: 14, margin: "0 0 16px" }}>Enter your password to unlock.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{
            width: "100%", padding: "10px 12px", borderRadius: 8,
            border: "0.5px solid rgba(150,170,210,0.35)", background: "#12224A",
            color: "#FFFFFF", fontSize: 14,
          }}
        />
        {error && <p style={{ color: "#F09595", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          style={{
            marginTop: 12, width: "100%", padding: "10px 12px", borderRadius: 8,
            border: "none", background: "#2B8AC0", color: "#FFFFFF", fontSize: 14,
            fontWeight: 500, cursor: "pointer", opacity: busy || !password ? 0.5 : 1,
          }}
        >
          {busy ? "Unlocking..." : "Unlock"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/client/practice-brain/password-gate.tsx
git commit -m "feat: practice brain password gate screen"
```

---

## Task 11: Item detail + needs-review + barrel

**Files:**
- Create: `src/components/client/practice-brain/item-detail.tsx`
- Create: `src/components/client/practice-brain/needs-review.tsx`
- Create: `src/components/client/practice-brain/index.ts`

- [ ] **Step 1: Write the item detail component**

`src/components/client/practice-brain/item-detail.tsx`:
```tsx
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
```

- [ ] **Step 2: Write the needs-review component**

`src/components/client/practice-brain/needs-review.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { TIER_LABELS, type KnowledgeNode, type Tier } from "@/lib/practice-brain/types";

const HUBS = ["Back office", "Sales", "Reception", "Marketing", "Operations", "Intelligence"];

export function NeedsReview({ onResolved }: { onResolved: () => void }) {
  const [items, setItems] = useState<KnowledgeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/practice-brain/needs-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (res.success) setItems(res.data.nodes);
    else setError(res.error);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolve(id: string, branch: string, tier: Tier) {
    const res = await fetch("/api/practice-brain/resolve-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, branch, tier }),
    }).then((r) => r.json());
    if (res.success) {
      await load();
      onResolved();
    } else {
      setError(res.error);
    }
  }

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (items.length === 0) return <p className="text-xs text-muted">Nothing waiting for review.</p>;

  return (
    <div className="space-y-2">
      {items.map((n) => (
        <ReviewRow key={n.id} node={n} onResolve={resolve} />
      ))}
    </div>
  );
}

function ReviewRow({ node, onResolve }: { node: KnowledgeNode; onResolve: (id: string, branch: string, tier: Tier) => void }) {
  const [branch, setBranch] = useState(HUBS[0]);
  const [tier, setTier] = useState<Tier>(node.tier);
  return (
    <div className="rounded-lg border border-line bg-card-muted p-3 text-sm">
      <p className="font-medium text-ink">{node.title}</p>
      <p className="mt-1 text-xs text-muted">{node.body}</p>
      {node.classification && (
        <p className="mt-1 text-xs text-amber-600">Classifier: {node.classification.reasoning} (confidence {Math.round(node.classification.confidence * 100)}%)</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded border border-line bg-card px-1 py-0.5">
          {HUBS.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <select value={tier} onChange={(e) => setTier(Number(e.target.value) as Tier)} className="rounded border border-line bg-card px-1 py-0.5">
          {[1, 2, 3, 4].map((t) => <option key={t} value={t}>{t} {TIER_LABELS[t as Tier]}</option>)}
        </select>
        <button onClick={() => onResolve(node.id, branch, tier)} className="rounded bg-blue-dark px-2 py-1 font-medium text-white">Approve</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the barrel**

`src/components/client/practice-brain/index.ts`:
```ts
export { PracticeBrainView } from "./practice-brain-view";
export { PasswordGate } from "./password-gate";
export { Constellation } from "./constellation";
export { CapturePanel } from "./capture-panel";
export { ItemDetail } from "./item-detail";
export { NeedsReview } from "./needs-review";
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/client/practice-brain/item-detail.tsx src/components/client/practice-brain/needs-review.tsx src/components/client/practice-brain/index.ts
git commit -m "feat: practice brain item detail + needs-review queue"
```

---

## Task 12: View component + owner wiring

**Files:**
- Create: `src/components/client/practice-brain/practice-brain-view.tsx`
- Modify: `src/app/owner/[client]/[module]/page.tsx`
- Modify: `src/components/owner/owner-sidebar.tsx`
- Modify: `src/lib/nav.ts`
- Delete: `src/app/c/[client]/practice-brain/page.tsx`

- [ ] **Step 1: Write the view component (gate + constellation orchestration)**

`src/components/client/practice-brain/practice-brain-view.tsx`:
```tsx
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
```

- [ ] **Step 2: Render the view in the owner module route**

Replace `src/app/owner/[client]/[module]/page.tsx` with:
```tsx
import { notFound } from "next/navigation";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { PracticeBrainView } from "@/components/client/practice-brain";
import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";

export const dynamic = "force-dynamic";

export default async function OwnerModulePage({
  params,
}: {
  params: Promise<{ client: string; module: string }>;
}) {
  const { client, module } = await params;

  if (module === "overview") {
    return <OverviewDashboard />;
  }

  if (module === "treatment-coordinator") {
    return <TreatmentCoordinatorView clientSlug={client} />;
  }

  if (module === "practice-brain") {
    return <PracticeBrainView />;
  }

  if (module !== "" && CLIENT_MODULE_SLUGS.includes(module)) {
    return <ModulePlaceholder slug={module} />;
  }

  notFound();
}
```

- [ ] **Step 3: Add the Practice brain link to the owner sidebar**

In `src/components/owner/owner-sidebar.tsx`, add `BrainCircuit` to the lucide import:
```ts
import { Gauge, LogOut, BrainCircuit } from "lucide-react";
```
Then add a second `<li>` inside the "Practice" group's `<ul>`, right after the Management `<li>`:
```tsx
            <li>
              <Link
                href={`${base}/practice-brain`}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive("practice-brain")
                    ? "bg-navy-soft text-on-navy"
                    : "text-on-navy-muted hover:bg-navy-soft/60 hover:text-on-navy",
                )}
              >
                {isActive("practice-brain") ? (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-blue-light" />
                ) : null}
                <BrainCircuit size={16} className="shrink-0" />
                <span className="truncate">Practice brain</span>
              </Link>
            </li>
```

- [ ] **Step 4: Remove Practice brain from the staff nav and delete the staff route**

In `src/lib/nav.ts`: delete the entire `practice-brain` item object from the "Staff & Ops" group (leaving `daily-brief`), and remove `BrainCircuit` from the lucide import at the top of the file (it is no longer used there). This removes it from the staff (`/c/[client]`) sidebar automatically; the owner sidebar adds it back explicitly (Step 3).

Then delete the now-dead staff route:
```bash
git rm src/app/c/[client]/practice-brain/page.tsx
```

- [ ] **Step 5: Verify it compiles and renders**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (in particular, no "unused BrainCircuit" in `nav.ts`).

Then with the dev server running (`preview_start`): log in as owner (`localStorage.setItem("azen.mockauth.role","client_owner")`), navigate via `preview_eval` to `window.location.href = "/owner/vitality/practice-brain"`. Confirm the password screen shows. Use `preview_fill` to enter `vitality-owner-2026` and submit, then `preview_screenshot` to confirm the constellation renders with six hubs on the navy canvas. Use `preview_console_logs` to confirm no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/owner/[client]/[module]/page.tsx src/components/owner/owner-sidebar.tsx src/lib/nav.ts src/components/client/practice-brain/practice-brain-view.tsx
git commit -m "feat: practice brain owner-dashboard view behind password gate"
```

---

## Task 13: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all suites pass, including the new `clearance`, `classify`, and `layout` tests, and the existing coordinator/dentally tests.

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no type errors, no lint errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: End-to-end manual check via preview**

With the dev server running, logged in as `client_owner`, at `/owner/vitality/practice-brain`:
1. Unlock with the owner password `vitality-owner-2026`. Confirm the constellation loads.
2. Add a note in the capture panel (e.g. "Send the Invisalign price list to enquiries within the hour"). Confirm it classifies, shows a branch + tier + tags, and saves.
3. Reload; confirm the relevant hub's item count increased and the new item appears as a leaf when you drill into that hub.
4. Clear the cookie (`document.cookie = "pb_session=; Max-Age=0; path=/"` via `preview_eval`) and reload; confirm the password screen returns. Unlock with the coordinator password `vitality-coord-2026` and confirm tier 3/4 items are absent and the needs-review panel is hidden (maxTier 2).
5. `preview_screenshot` the final state for the user.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore: practice brain foundation verification fixes"
```

---

## Self-review notes (author)

- **Spec coverage:** store + hierarchy (Task 1, 7), classifier branch/tier/tags + propose-new-branch (Task 4, 5, 8), deterministic clearance + fail-closed (Task 3, 4), per-user password gate + credentials + session cookie (Task 1, 6b, 7, 8, 10b), owner-only placement (Task 12), constellation UI + drill-in + search (Task 6, 9, 12), capture confirm/override (Task 10), needs-review queue (Task 11), graceful behaviour and no-clinical/no-em-dash rules (Task 4 prompt + parser). All in scope; co-pilot, embeddings, file ingest, cross-module feeds, self-learning loop, real auth/RLS, in-app credential manager, and motion polish remain explicitly deferred (not in any task).
- **Access model:** `maxTier` is derived only from the verified `pb_session` cookie set by `unlock`; the data actions return 401 without it and never trust a client-sent role. `maxTierForRole` (Task 3) remains for future co-pilot/staff use but is not on the request path for this owner view.
- **Degraded mode:** the spec mentions a demo fallback when env is absent. Since `.env.local` has all keys set (plus the new `PRACTICE_BRAIN_SESSION_SECRET`), this plan builds the live path. If keys are later removed, the API returns a 500/`Server missing PRACTICE_BRAIN_SESSION_SECRET` surfaced in the UI error states; a dedicated seeded demo mode is a small follow-up, not built here.
- **Type consistency:** `ClassificationResult`, `KnowledgeNode`, `Tier`, `visibleNodes`, `childrenOf`, `layoutConstellation`/`HubInput`, `PbSession`, `signSession`/`verifySession`, `verifyCredential` names are used identically across tasks.
- **Tailwind tokens:** capture/detail/review components assume the app's existing token names (`bg-card`, `border-line`, `text-ink`, `text-muted`, `blue-dark`, `blue-light`). Verify against `src/app/globals.css` / existing coordinator components during Task 10 and adjust if a name differs. The password gate and constellation use inline hex (intentional dark scene), so they are token-independent.
