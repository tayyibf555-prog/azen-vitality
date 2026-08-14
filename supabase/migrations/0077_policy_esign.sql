-- 0077_policy_esign.sql
-- The practice policy library, and the record of who signed which VERSION of what.
--
-- WHAT THIS PRODUCES, STATED HONESTLY, because an inspector will ask and because the
-- UI copy has to match the schema:
--
--   Evidence that a NAMED LOGIN, at a RECORDED TIME, was shown VERSION N of a NAMED
--   document and affirmed it.
--
-- That is all. It is NOT a qualified electronic signature. There is no witness and no
-- identity verification beyond the practice's own login. The ip_hash and user_agent
-- below are WEAK corroboration and are labelled as such everywhere they appear. Under
-- the UK Electronic Communications Act 2000 this is generally admissible, and it is
-- materially stronger than a paper folder in a drawer, but the platform says what it
-- is rather than implying more. Same posture the compliance module already takes:
-- decision support and an organiser, not legal advice.
--
-- POLICIES ARE UPLOADED PDFs, NOT GENERATED ONES. There is no PDF library in this
-- codebase (no pdf-lib, jspdf, puppeteer) and adding one is out of scope, so the
-- practice uploads the policy document it already has and this table versions it.
-- The bytes live in the private `staff-docs` bucket, exactly as the document vault's
-- do, under a policies/ prefix.
--
-- POST-0012 LOCKED POSTURE, matching 0067 / 0068 / 0071 / 0076: RLS enabled, no
-- policy and no grant to anon/authenticated, service-role access only behind the API
-- guards.
--
-- NOT YET APPLIED. Written for the orchestrator to apply. Every read degrades to
-- "not ready" on a missing relation and says so.
--
-- British English throughout. No dash characters in copy.

-- ---------------------------------------------------------------------------
-- The policy, versioned. A new version is a NEW ROW, never an edit.
-- ---------------------------------------------------------------------------
create table if not exists staff_policy (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- Stable identity of the policy across versions ("infection-control"). The pair
  -- (slug, version) is what a signature binds to.
  slug text not null,
  title text not null,
  -- Monotonic per (client, slug), allocated server-side by nextPolicyVersion.
  version int not null check (version >= 1),
  -- staff-docs/<clientSlug>/policies/<uuid>/<safeName>: the PDF exactly as issued.
  storage_path text not null,
  mime text not null,
  size_bytes int not null check (size_bytes > 0),

  effective_from date not null,
  -- Set when a later version supersedes this one, or when the practice withdraws it.
  -- A retired version is never deleted: people signed it, and the evidence is the
  -- point.
  retired_at timestamptz,

  created_by uuid references app_user (id) on delete set null,
  created_at timestamptz default now(),

  unique (client_id, slug, version)
);

-- "What is current for this practice" and "every version of this policy" are the two
-- reads, and both are client-scoped.
create index if not exists idx_staff_policy_client_slug
  on staff_policy (client_id, slug, version desc);

-- ---------------------------------------------------------------------------
-- The signature. One per person per policy.
-- ---------------------------------------------------------------------------
create table if not exists staff_policy_signature (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  staff_id uuid not null,

  -- ON DELETE RESTRICT IS THE POINT OF THIS TABLE. A signed policy version must not
  -- be deletable, or the evidence evaporates the moment somebody tidies up the
  -- library. Cascading here would let a single delete erase the proof that thirty
  -- people were shown the infection control policy.
  policy_id uuid not null references staff_policy (id) on delete restrict,
  -- DENORMALISED ON PURPOSE: the signature binds to the VERSION, not to the policy.
  -- If the practice publishes v3, everyone's v2 signature is still a true record of
  -- what they were shown, and `outstandingPolicies` correctly asks them to sign again
  -- rather than silently treating the old affirmation as covering new wording.
  policy_version int not null check (policy_version >= 1),

  -- {method:'typed'|'drawn', value, signedAt}. Same shape as 0070/0071 store for a
  -- patient signature, and the same caps are applied before the write (120 chars for
  -- a typed name, 250,000 bytes for a drawn data-URL) by lib/hr/esign.ts, which
  -- imports those numbers from lib/fp17/validate.ts so the two cannot drift.
  signature jsonb not null,
  signed_at timestamptz not null default now(),

  -- WEAK CORROBORATION, HONESTLY LABELLED. A hashed IP and a user-agent string are
  -- not identity verification: an IP is shared and spoofable and a user-agent is
  -- self-reported. They are stored because they make a later denial harder, and every
  -- surface that shows them says exactly that. The IP is HASHED, never stored raw.
  ip_hash text,
  user_agent text,

  -- One signature per person per policy. Re-signing after a new version is published
  -- UPDATES this row's version + signature (the previous affirmation was of wording
  -- that is no longer in force), which is why this is a unique and not an append log.
  unique (client_id, staff_id, policy_id),

  constraint staff_policy_sig_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade
);

-- "Who has signed this policy" (the compliance question) and "what is outstanding for
-- this person" (the staff question) are the two reads.
create index if not exists idx_staff_policy_sig_policy
  on staff_policy_signature (client_id, policy_id);
create index if not exists idx_staff_policy_sig_staff
  on staff_policy_signature (client_id, staff_id);

-- ---------------------------------------------------------------------------
-- KILL-SWITCH SEED — SHIPS GATED OFF (the 0071 FP17 precedent, campaign 6 decision 9).
--
-- system_toggle is DEFAULT-ON by absence of a row, so without this seed e-sign would
-- be live the moment the code deploys. The legal framing of an attestation has to be
-- signed off by the practice before a single person is asked to sign anything, so
-- this ships DORMANT: the owner turns it on from System controls when they are ready.
-- Switching it on is a business decision, not a build step.
--
-- `do nothing on conflict` so re-running the migration never re-arms a switch the
-- owner has since toggled.
--
-- The matching SystemDef ('staff-esign', group Operations) is added to
-- lib/systems/catalog.ts in the integration phase; until it is, the switch exists in
-- the table but has no control in the panel.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled)
values ('vitality', 'staff-esign', false)
on conflict (client_id, module_slug) do nothing;

-- Server-only: RLS on, no policies/grants (consistent with 0012 / 0067 / 0071 / 0076).
alter table staff_policy enable row level security;
alter table staff_policy_signature enable row level security;
revoke all on staff_policy from anon, authenticated;
revoke all on staff_policy_signature from anon, authenticated;
