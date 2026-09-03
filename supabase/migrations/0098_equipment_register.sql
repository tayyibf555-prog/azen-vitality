-- 0098_equipment_register.sql
-- The equipment agent: the asset register, and the manuals it answers from.
--
-- ===========================================================================
-- WHAT THIS IS.
--
-- The register a practice already keeps in a spreadsheet — the one the CQC
-- inspector asks to see and the insurer asks for after a flood — held in the
-- platform, plus the searchable TEXT of each asset's manual so a narrow agent can
-- answer "what does E04 mean on the autoclave" from the manufacturer's own words
-- rather than from a general model's recollection of autoclaves.
--
-- WHAT THIS IS NOT.
--
-- Not a sending surface. There is no touch table and no outbox here, this module
-- registers NO source with the shared messaging drain, and no row written here
-- can reach a patient. Not a clinical record: no patient identifier, no clinical
-- data and no staff personal data appears in any column below. Not a maintenance
-- SYSTEM either — it schedules nothing, reminds nobody and calls no engineer. It
-- holds what the practice tells it and answers questions about it.
--
-- ===========================================================================
-- WHY THE MANUAL'S BYTES ARE NOT STORED.
--
-- Only the extracted text is kept, in equipment_manual_chunk. Two reasons, both
-- deliberate.
--
-- COPYRIGHT. A manufacturer's manual is their copyright. Indexing its text so we
-- can tell a nurse what it says about a fault code is a different act from
-- re-hosting the whole document for download, and only the first is clearly ours
-- to do. If the practice later wants the original PDF back out of the platform,
-- that is a decision plus a private bucket plus a signed-URL read — not something
-- to acquire by accident because the bytes happened to be in hand.
--
-- OPERATIONAL. Bytes would need a new private Storage bucket, and in this
-- platform buckets are provisioned OUT OF BAND (see 0076's note about the
-- `onboarding` bucket, which was created with no record anywhere). Ingestion that
-- depends on a bucket somebody remembered to create is ingestion that fails in
-- every environment where nobody did.
--
-- ===========================================================================
-- SAFE GATING (two independent OFFs, the house pattern).
--   1. CODE: 'equipment' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED for EVERY client, in every environment, including one where this
--      migration has not run.
--   2. DATA: the explicit seed row at the foot of this file, for parity with
--      0041 / 0047 / 0071 / 0077 / 0085 / 0090 / 0091 / 0093.
--      `on conflict do nothing` is essential: re-running this migration must
--      never stamp OFF over an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it covers one client, once), which
-- is exactly why mechanism 1 exists.
--
-- WHAT THE SWITCH ACTUALLY HALTS, and what it deliberately does not. Switching
-- 'equipment' OFF stops the AGENT: the chat refuses to run and no model call is
-- made. It does NOT hide the register, because the register is the management
-- surface for this system and an owner has to be able to load their assets and
-- their manuals BEFORE switching the agent on — the same reasoning that put
-- 'outreach' in NAV_SWITCH_EXEMPT_SLUGS (src/lib/nav.ts), and stated here so the
-- two halves of the decision are not a mile apart.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with
-- 0026/0034/0049/0085/0090/0091/0093.

-- ---------------------------------------------------------------------------
-- 1. THE REGISTER.
-- ---------------------------------------------------------------------------
create table if not exists equipment_asset (
  id uuid primary key default gen_random_uuid(),

  -- The practice. Client-level with an OPTIONAL site, rather than site-level:
  -- plenty of kit (a defibrillator, a server, a fire alarm panel) belongs to the
  -- practice rather than to one surgery, and forcing a site would make the
  -- register lie about where things are.
  client_id text not null,
  site_id text,

  -- What the practice calls it. The only required field: a register row with no
  -- name is not a row, and the CSV importer skips one rather than inventing a
  -- name from the serial number.
  name text not null,

  -- CLOSED vocabulary, mirrored by ASSET_CATEGORIES in src/lib/equipment/types.ts.
  -- Free text here would make "Autoclave", "autoclaves" and "Steriliser" three
  -- different categories and the register unable to answer "show me every
  -- steriliser" — which is most of what a category is for. The importer maps the
  -- practice's own words onto these and falls back to 'other'.
  category text not null default 'other' check (category in (
    'sterilisation',
    'imaging',
    'surgery',
    'handpieces',
    'compressed_air_suction',
    'water',
    'it_hardware',
    'facilities',
    'emergency',
    'other'
  )),

  make text,
  model text,
  serial text,
  room text,

  -- The supplier and their number. This pair is the ESCALATION: when the manual's
  -- troubleshooting is exhausted the agent's whole job is to hand over the right
  -- number, and it will say plainly that it does not have one rather than invent
  -- a plausible number, which is why both are nullable and neither is defaulted.
  supplier text,
  supplier_phone text,

  -- Dates as DATE, never text. The importer refuses anything it cannot read
  -- rather than guessing (a misread 03/04 costs a service visit), so a null here
  -- means "not known", never "not parsed and quietly stored as something else".
  purchased_on date,
  last_serviced_on date,
  next_service_due date,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text
);

-- The register's own read: one practice, ordered for the table.
create index if not exists idx_equipment_asset_client
  on equipment_asset (client_id, category, name);

-- "What is due?" — the question the register exists to answer.
create index if not exists idx_equipment_asset_due
  on equipment_asset (client_id, next_service_due)
  where next_service_due is not null;

-- ---------------------------------------------------------------------------
-- ONE ASSET PER SERIAL, PER PRACTICE — and only where a serial exists.
--
-- A PARTIAL, case-insensitive unique index rather than a plain constraint,
-- because both halves matter. Plenty of assets have no serial (a cabinet, a
-- water softener), and a plain unique index would let exactly one of them exist;
-- meanwhile a re-imported spreadsheet must not create a second copy of the
-- autoclave because somebody typed the serial in lower case the second time.
-- The importer's upsert keys on exactly this.
-- ---------------------------------------------------------------------------
create unique index if not exists idx_equipment_asset_serial
  on equipment_asset (client_id, lower(serial))
  where serial is not null and serial <> '';

alter table equipment_asset enable row level security;
revoke all on equipment_asset from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE MANUAL (metadata only — see the copyright note above).
-- ---------------------------------------------------------------------------
create table if not exists equipment_manual (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE: a manual with no asset is unreachable by every read path
  -- in the module and would sit in the table for ever. Deleting the asset is the
  -- practice saying the machine is gone.
  asset_id uuid not null references equipment_asset (id) on delete cascade,
  client_id text not null,

  filename text not null,
  byte_size integer not null,
  page_count integer not null,

  -- WHICH EXTRACTOR PRODUCED THIS TEXT. Recorded per manual, not assumed
  -- globally: when the extractor is swapped, this column is what says which
  -- manuals were indexed by the old one and therefore which are worth re-reading.
  extractor text not null,
  extracted_chars integer not null default 0,

  -- 'ready'   searchable text was recovered.
  -- 'no_text' the PDF carried none — it is a SCAN. Recorded as its own state
  --           rather than as a manual with zero chunks, because the practice
  --           needs telling that the file they uploaded cannot be read, and the
  --           agent needs to know the difference between "no manual" and "a
  --           manual I cannot read".
  status text not null default 'ready' check (status in ('ready', 'no_text')),

  uploaded_at timestamptz not null default now(),
  uploaded_by text
);

create index if not exists idx_equipment_manual_asset
  on equipment_manual (asset_id, uploaded_at desc);

alter table equipment_manual enable row level security;
revoke all on equipment_manual from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE SEARCHABLE TEXT.
--
-- One row per passage. `page_from`/`page_to` are what lets an answer say "page
-- 14", which is the difference between a claim a nurse can check against the
-- book in the drawer and one she has to take on trust.
--
-- Ranked in application code (src/lib/equipment/chunk.ts), keyword-only,
-- deliberately: there is no embedding call anywhere in the ingestion path, so
-- uploading a manual costs nothing but the PDF parse and the module works with
-- no VOYAGE_API_KEY set — which is the state production is in.
-- ---------------------------------------------------------------------------
create table if not exists equipment_manual_chunk (
  id uuid primary key default gen_random_uuid(),
  manual_id uuid not null references equipment_manual (id) on delete cascade,

  -- Denormalised from the manual so the agent's per-asset search is one indexed
  -- read rather than a join, and so a chunk can never be orphaned from its
  -- practice even if a future manual row is rewritten.
  asset_id uuid not null references equipment_asset (id) on delete cascade,
  client_id text not null,

  page_from integer not null,
  page_to integer not null,
  ordinal integer not null,
  body text not null,

  created_at timestamptz not null default now(),

  -- Re-ingesting the same manual replaces its chunks; this makes a double-write
  -- an error rather than a silent duplicate in every future search result.
  unique (manual_id, ordinal)
);

create index if not exists idx_equipment_chunk_asset
  on equipment_manual_chunk (asset_id, ordinal);

alter table equipment_manual_chunk enable row level security;
revoke all on equipment_manual_chunk from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed the switch OFF for the pilot client. Mechanism 2 of the two above.
-- `on conflict do nothing` so re-running never overrides a deliberate ON.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'equipment', false, 'migration:0098')
on conflict (client_id, module_slug) do nothing;
