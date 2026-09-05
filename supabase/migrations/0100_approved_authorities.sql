-- 0100_approved_authorities.sql
-- The approved-authorities seam: the one table this module owns.
--
-- ===========================================================================
-- WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT.
--
-- It is an OWNER-MANAGED LIST of external sources the practice has decided its
-- co-pilot may lean on: the GDC's standards, a faculty guideline, a textbook, a
-- course the principal sat. Each row holds the practice's OWN summary of that
-- source and the principles the practice takes from it, plus a citation string so
-- a human can go and read the original. When one of these informs an answer, the
-- co-pilot names it.
--
-- It is NOT internet access. `reference` is a citation stored as text — a URL, an
-- ISBN, an edition and page range — and NOTHING IN THE PLATFORM FETCHES IT. There
-- is no browsing in this product and this table does not add any. A URL here is a
-- citation in exactly the way an ISBN is: something a person follows, not
-- something a machine retrieves.
--
-- It is NOT ingestion of copyrighted text. See the ceilings below: `summary` and
-- `principles` are capped so that pasting a chapter or a standard into them is
-- structurally impossible rather than merely discouraged.
--
-- It is NOT a clinical authority and it does not overrule anything. The practice's
-- own records remain what the co-pilot answers from; these rows are context the
-- practice has chosen, labelled as such in the prompt, and cited in the answer.
--
-- It is NOT the practice brain. `knowledge_node` (migrations 0049 and its
-- successors) holds the practice's INTERNAL knowledge with its own clearance
-- tiers — what the practice knows. This table is who the practice trusts. They are
-- deliberately separate tables with separate lifecycles, and this one carries no
-- tier because an external source the owner has published to the co-pilot is not a
-- confidentiality question.
--
-- THE DEFAULT IS AN EMPTY TABLE, and an empty table must contribute NOTHING: the
-- brief builder (src/lib/knowledge/authorities.ts) returns "" for an empty list,
-- so a practice that never adds a source has a co-pilot that runs on practice data
-- only and a system prompt with no reference section in it at all. "Practice data
-- only" is not a setting anybody has to choose; it is what happens until an owner
-- deliberately adds a row.
--
-- ===========================================================================
-- NO system_toggle SEED ROW, AND THAT IS A DECISION, NOT AN OVERSIGHT.
--
-- Every SENDING surface in this platform is default-OFF twice (catalog
-- `defaultEnabled:false` plus an explicit disabled `system_toggle` row, because an
-- ABSENT row means ENABLED — see 0093's header for the full argument). That rule
-- exists because a send surface switched on by accident reaches a patient.
--
-- This is not a send surface. It writes no outbox row, registers no source with the
-- shared messaging drain, runs no sweep, has no cron entry and no scheduled work of
-- any kind. Nothing here can reach a patient, and there is nothing to halt. It is a
-- passive list an owner types into, read only when the co-pilot builds a prompt.
--
-- ---------------------------------------------------------------------------
-- CORRECTION, MADE AFTER THIS MIGRATION WAS APPLIED (programme ruling W3/18).
--
-- This paragraph used to finish by saying that the co-pilot "has its own kill
-- switch", quoting a system slug for it, and that switching that off already
-- stopped every read of this table. It was false, and it is deleted here rather
-- than softened, because a comment describing a safety control the reader cannot
-- find is worse than no comment at all: an owner goes hunting for the lever in
-- System controls, an auditor records a control that is not there, and the next
-- engineer reasons from it.
--
-- `co-pilot` is a NAV MODULE slug (src/lib/nav.ts). It is not, and never was, a
-- SYSTEMS slug: it is absent from SYSTEMS (src/lib/systems/catalog.ts), whose own
-- header gives the reason — owner tools have no sweep, queue or send to halt, so
-- there is no switch for them. `isControllableSystem` therefore rejects it, POST
-- /api/systems answers "Unknown system" for it, and no surface in this platform
-- can create that row. A row inserted by hand would still stop nothing here:
-- `defaultEnabledFor` treats a slug that is not in the catalog as default-ON, and
-- neither /api/copilot nor src/lib/knowledge consults a switch before the brief is
-- built.
--
-- The CONCLUSION was right and stands — no toggle. Only the stated reason was
-- wrong. Editing a comment does not alter applied state: 0100 is already applied,
-- this file is not re-run, and nothing in the schema below changes.
-- ---------------------------------------------------------------------------
--
-- THE CONTROLS THAT DO EXIST HERE, none of them a switch:
--   * The door is OWNER ONLY, on the read as well as the writes:
--     /api/authorities/[action] runs requireUser -> requireClientAccess ->
--     requireModuleApiAccess -> requireOwnerRole. Nobody but the principal can put
--     words into every answer the co-pilot gives the practice.
--   * The single reader is /api/copilot (listActiveAuthorities, then
--     authoritiesBrief), behind the module guard AND the per-person
--     `system.copilot.ask` capability. Revoking that grant is how a PERSON is
--     stopped from asking, which is the granularity that actually fits here.
--   * Archiving a row excludes it from every prompt at once (listActiveAuthorities
--     filters on status), which is the lever an owner actually wants: stop leaning
--     on ONE source without stopping the brain.
--
-- Adding a toggle would therefore be a switch that turns off a list nobody is being
-- sent, i.e. a control that reads as a safety control and is not one, and one more
-- row in the owner's System controls panel to be understood and ignored. The safety
-- story here is the ceilings, the citation, the empty default and the owner-only
-- door — all of it pinned by src/lib/knowledge/gating.test.ts, which also sweeps
-- every migration in the tree for the mistake this correction fixes.
--
-- ===========================================================================
-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with
-- 0026/0034/0049/0085/0090/0091/0093. The repository
-- (src/lib/knowledge/repository.ts) scopes every read AND every write by
-- client_id, so an id alone never addresses a row.

-- ---------------------------------------------------------------------------
-- One row per source the practice has approved.
-- ---------------------------------------------------------------------------
create table if not exists approved_authority (
  id uuid primary key default gen_random_uuid(),

  -- The practice. Client-level, not site-level: which books and standards a
  -- practice works to is a practice fact, not a per-surgery one.
  client_id text not null,

  -- What the source is called, e.g. 'Standards for the Dental Team'.
  name text not null check (char_length(name) between 1 and 200),

  -- A small closed set, mirrored by AUTHORITY_KINDS in src/lib/knowledge/types.ts.
  -- The CHECK is what stops a typo ('regulaor') becoming a category of its own —
  -- it reaches the model in the prompt brief, so a misspelt kind is not cosmetic.
  kind text not null check (kind in (
    'regulator',
    'professional-body',
    'guideline',
    'textbook',
    'course',
    'internal-policy',
    'other'
  )),

  -- Who publishes it, e.g. 'General Dental Council'. Appears in the citation.
  publisher text not null default '' check (char_length(publisher) <= 200),

  -- A citation string. STORED AS TEXT, NEVER FETCHED. See the header.
  reference text not null default '' check (char_length(reference) <= 500),

  -- -------------------------------------------------------------------------
  -- THE TWO BODIES, AND WHY THEY ARE CAPPED IN THE DATABASE AS WELL AS IN CODE.
  --
  -- A box marked 'summary of the source' is a box somebody will paste the source
  -- into. A textbook chapter is 8,000-20,000 words; pasted whole, the platform
  -- would be storing and then reciting a copyrighted work. A line of guidance
  -- asking the owner to summarise is a REQUEST and fails silently in exactly the
  -- case that matters. A hard ceiling is a CONTROL: at 2,000 characters a summary
  -- is ~300 words — a genuine precis, and nowhere near enough to hold the chapter.
  -- At 4,000 the principles field takes ~25-40 distilled bullets.
  --
  -- The application refuses over-length input with a sentence naming the limit and
  -- the count (validateAuthority; it never truncates, because a silent truncation
  -- would quietly change what the practice said). These CHECKs are the second,
  -- independent enforcement, for anything that reaches the table by another door.
  -- The numbers are mirrored by AUTHORITY_BODY_MAX_CHARS in
  -- src/lib/knowledge/authorities.ts; change one and change the other.
  -- -------------------------------------------------------------------------
  summary text not null default '' check (char_length(summary) <= 2000),
  principles text not null default '' check (char_length(principles) <= 4000),

  -- A row with neither body is a bookmark, and a bookmark is what this list is not
  -- for: the co-pilot can do nothing with 'the GDC website exists'.
  constraint approved_authority_has_a_body
    check (char_length(summary) > 0 or char_length(principles) > 0),

  -- ARCHIVED, NEVER DELETED. An answer the co-pilot gave last month cited this row
  -- by name; a hard delete would make that citation unreadable. Archived rows stay
  -- in the owner's panel and are excluded from every prompt.
  status text not null default 'active' check (status in ('active', 'archived')),

  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The prompt builder's read: the active list for one practice, oldest first (the
-- order the owner entered them, which is the order they read in).
create index if not exists idx_approved_authority_active
  on approved_authority (client_id, status, created_at);

alter table approved_authority enable row level security;
revoke all on approved_authority from anon, authenticated;
