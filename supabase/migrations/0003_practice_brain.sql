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

-- Seed pilot credentials.
--
-- CORRECTED IN PLACE 6 September 2026 (wave 3 review; comments do not alter
-- applied state — the W3/18 precedent — and the statement below is untouched).
-- This comment used to read "Documented pilot passwords (rotate after
-- handover)" and then list the three in plaintext. Rotating after handover was
-- advice, never a control, and the handover has not happened, so the sentence
-- read as reassurance for something that is still open. What is actually true:
--
-- THESE THREE PASSWORDS ARE PUBLISHED, AND ONE OF THEM IS STILL LIVE. They are
-- compiled into the `crypt('…')` calls of the insert below, repeated in
-- docs/superpowers/plans/2026-06-19-practice-brain-foundation.md, and present in
-- every clone, worktree and git object of this repository — so everyone who can
-- read the repo holds them. Of the three rows seeded here, the manager and
-- coordinator rows were later deleted and the Owner row (tier 4) was not: it is
-- the ONE credential row that exists for `vitality` in production, and its hash
-- still answers to the password printed below (row count recorded under ruling
-- W3/35; the surviving row identified during wave-3 verification, 6 Sep 2026).
--
-- WHAT THAT REACHES, STATED PLAINLY. POST /api/practice-brain/unlock takes a
-- password and nothing else — no platform account, no session — and src/proxy.ts
-- excludes `api` from its matcher, so the endpoint is internet-reachable. A
-- correct password mints an 8-hour signed `pb_session` carrying maxTier 4, and
-- the `tree` and `ask` actions then serve every tier of the practice's knowledge
-- base to it. The unlock caps (20 per IP per hour, 100 per hour shared) exist to
-- stop guessing and do nothing whatever about a password that is already known.
--
-- WHY THE PLAINTEXT IS STILL SITTING HERE. Deleting it from this comment would
-- rotate nothing: the passwords are in the statement itself and in this file's
-- history, and stripping them would remove the only in-tree record of which
-- password the live hash answers to while making the file look clean. The fix is
-- a rotation in the LIVE database — a new hash for the surviving Owner row, or a
-- fresh row and the deletion of that one — and only then the stripping of this
-- file and the plan doc. That changes the security posture of a live gate, which
-- charter §0 item 12 says a lane does not guess at, so it is raised as a BLOCKED
-- question for Fable rather than done here.
--
-- PINNED: src/lib/migration-seeded-secret.test.ts refuses a plaintext password
-- compiled into any migration and carries this file as a named, cited exemption
-- whose recorded shape is this seed. Change the seed and that test goes red —
-- which is how the exemption gets deleted deliberately, by whoever rotates.
insert into practice_brain_credential (client_id, label, password_hash, tier) values
  ('vitality', 'Owner',            crypt('vitality-owner-2026',   gen_salt('bf')), 4),
  ('vitality', 'Practice manager', crypt('vitality-manager-2026', gen_salt('bf')), 3),
  ('vitality', 'Coordinator',      crypt('vitality-coord-2026',   gen_salt('bf')), 2);
