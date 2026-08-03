-- 0066_perio.sql
-- Periodontal records: the BPE screening exam, and the full 6-point chart.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- THIS IS NOT A MIRROR OF DENTALLY. It is the opposite of 0065. The FDI chart is
-- a read-only mirror because Dentally holds the data; perio cannot be, because
-- Dentally's API exposes NO periodontal resource of any kind -- no BPE, no pocket
-- depths, no recession, no bleeding index, no furcation, no mobility, no
-- stage/grade. There is nothing to mirror. Every row in these tables is AUTHORED
-- HERE, which makes this platform the system of record for that data from the
-- moment a hygienist first types into it, while Dentally's own Perio tab still
-- exists and still works.
--
-- SO IT SHIPS SWITCHED OFF. isPerioEnabled() reads PERIO_ENABLED and defaults
-- FALSE; with it unset every route under /api/perio answers 503 with an
-- explanation and nothing renders. Turning it on is the practice's decision, in
-- writing, not this migration's and not a developer's. Do not apply this file to
-- demonstrate the feature.
--
-- AND THERE IS A CLAIM CONSEQUENCE, which is why the decision is not ours to
-- make. BPE has been a MANDATORY FIELD ON THE NHS FP17 CLAIM SINCE 1 OCTOBER
-- 2022. If a hygienist records a BPE here while FP17s still go out of Dentally,
-- the score is entered TWICE -- double entry on a mandatory claim field, which is
-- exactly where a claim is rejected or two records quietly diverge. This is
-- "better charting, same claim process", never "perio moves off Dentally", until
-- the claim chain moves too.
--
-- DCB0129 applies to a live switch-on: this is health IT informing treatment
-- decisions, so it needs a Clinical Safety Officer, a hazard log and a safety
-- case. None of that can come out of this repository.
-- ============================================================================
--
-- APPEND-ONLY, ENFORCED BY TRIGGER RATHER THAN BY CONVENTION.
--
-- GDC Standard 4.1.4 requires the treating clinician on the record and 4.1.5
-- requires amendments to be clearly marked and dated. A clinical record that a
-- later UPDATE can silently overwrite cannot satisfy 4.1.5, and RLS does not
-- help here: every write goes through serviceClient(), which holds the service
-- role and bypasses RLS entirely. Triggers do NOT get bypassed, so the
-- append-only rule is written as a trigger:
--   * an amendment INSERTS a new version pointing at the one it amends;
--   * a mistake is RETRACTED with a reason, never deleted;
--   * measurement rows are immutable from the moment their chart is finalised.
-- The only DELETE any of this allows is of a chart that was never finalised --
-- the debris of a multi-statement write that failed part way through, which was
-- never a clinical record at all. See public.perio_chart.finalised_at.
--
-- THE VOCABULARY IS NOT INVENTED HERE. Every enumerated value below --
-- sextants, site ids, probe names, statuses, stage, grade, extent -- is the one
-- src/lib/perio/types.ts already speaks, so a row round-trips through the pure
-- clinical modules without translation. A schema that spelled a site "MB" while
-- the tested code spells it "mb" would need a mapping layer, and a mapping layer
-- between a clinical record and the code that reads it is a place for a reading
-- to change on the way past.
--
-- RLS is enabled with NO policy and NO grant, matching the posture of 0064 and
-- 0065: every read and write goes through serviceClient() on the server, behind
-- requireUser plus the client, site and patient-belongs-to-site checks in
-- src/app/api/perio/[action]/route.ts. A table with RLS on and no policy is
-- unreachable by any anon or authenticated key, which is the intent.

-- ---------------------------------------------------------------------------
-- 1. BPE -- the screening exam
-- ---------------------------------------------------------------------------
--
-- SIX SEXTANTS AS SIX SETS OF COLUMNS, not one jsonb blob. The set is fixed by
-- clinical convention and will never grow (UR 17-14, UA 13-23, UL 24-27,
-- LL 34-37, LA 33-43, LR 44-47), and columns buy two things a blob does not:
-- the 0-4 range is enforced by the database rather than hoped for, and "which
-- patients have a 4 anywhere" stays an ordinary indexable query rather than a
-- jsonb walk over 51k patients.
--
-- THREE COLUMNS PER SEXTANT, because a sextant has three distinguishable states
-- and collapsing any two of them loses clinical meaning:
--   code      0-4, the HIGHEST code found in that sextant. NULL when unscored.
--   furcation the additive '*' (so "3*" is code 3 with furcation true)
--   status    scorable / insufficient-teeth / no-teeth
--
-- STATUS IS A THREE-WAY, NOT A BOOLEAN, and the third value is why. A sextant
-- with one tooth and a sextant with none are both unscorable, but they are not
-- the same finding, and neither of them is a code of 0. Collapsing any of the
-- three into another is how an unexamined sextant comes to render as healthy.

create table if not exists public.perio_bpe_exam (
  id                  uuid primary key default gen_random_uuid(),
  site_id             text not null,
  dentally_patient_id text not null,

  -- Assigned by perio_assign_version() on insert, never sent by the client.
  -- 1-based, per (site, patient). An amendment is version n+1, not an edit of n.
  version             integer not null,

  -- When the EXAMINATION happened, which is not always when it was typed. Both
  -- are kept: recorded_at is the clinical fact, created_at is the audit fact.
  recorded_at         timestamptz not null,
  created_at          timestamptz not null default now(),

  -- GDC 4.1.4: the clinician is on the record, and the FK means a real person.
  -- No robot authorship and no shared identity: the route REFUSES the write when
  -- it cannot identify the author, rather than writing 'Team'.
  author_user_id      uuid not null references public.app_user (id) on delete restrict,
  -- Captured at the time of writing rather than joined at read time, so renaming
  -- a user later cannot silently rewrite who signed a historical record.
  author_name         text not null,
  -- ClinicianRef.gdcNumber. Null is allowed where the practice does not hold it;
  -- a fabricated one is not, so nothing defaults this.
  author_gdc_number   text,

  -- "Record the probe used" -- WHO 621, 0.5mm ball end, black band 3.5-5.5mm,
  -- 20-25g. Defaulted, not assumed: a reading taken with a different probe means
  -- something different.
  probe               text not null default 'who-621'
                        check (probe in ('who-621', 'who-cpi', 'other')),
  -- Free text only when the probe is 'other'. A reading means nothing without
  -- the probe: the 3.5-5.5mm black band that separates code 3 from code 4 is a
  -- property of the WHO 621, not of the mouth.
  probe_note          text,

  ur_code             smallint check (ur_code between 0 and 4),
  ur_furcation        boolean  not null default false,
  ur_status           text     not null default 'scorable'
                         check (ur_status in ('scorable', 'insufficient-teeth', 'no-teeth')),
  ua_code             smallint check (ua_code between 0 and 4),
  ua_furcation        boolean  not null default false,
  ua_status           text     not null default 'scorable'
                         check (ua_status in ('scorable', 'insufficient-teeth', 'no-teeth')),
  ul_code             smallint check (ul_code between 0 and 4),
  ul_furcation        boolean  not null default false,
  ul_status           text     not null default 'scorable'
                         check (ul_status in ('scorable', 'insufficient-teeth', 'no-teeth')),
  ll_code             smallint check (ll_code between 0 and 4),
  ll_furcation        boolean  not null default false,
  ll_status           text     not null default 'scorable'
                         check (ll_status in ('scorable', 'insufficient-teeth', 'no-teeth')),
  la_code             smallint check (la_code between 0 and 4),
  la_furcation        boolean  not null default false,
  la_status           text     not null default 'scorable'
                         check (la_status in ('scorable', 'insufficient-teeth', 'no-teeth')),
  lr_code             smallint check (lr_code between 0 and 4),
  lr_furcation        boolean  not null default false,
  lr_status           text     not null default 'scorable'
                         check (lr_status in ('scorable', 'insufficient-teeth', 'no-teeth')),

  notes               text,

  -- GDC 4.1.5. An amendment is a NEW ROW carrying a reason and pointing at the
  -- version it amends; the amended row is left exactly as it was written.
  -- PerioEntryMeta.supersedesId, spelled the way types.ts spells it.
  supersedes_id       uuid references public.perio_bpe_exam (id) on delete restrict,
  amendment_reason    text,

  -- A record entered in error is retracted, with a reason and a name, and stays
  -- readable. Nothing here is ever removed.
  retracted_at        timestamptz,
  retracted_by        uuid references public.app_user (id) on delete restrict,
  retraction_reason   text,

  -- Set in the same statement as the insert for a BPE (one row, so the write is
  -- already atomic). It exists on both record tables so one trigger can serve
  -- both; on perio_chart it does real work. Reads ignore unfinalised rows.
  finalised_at        timestamptz,

  -- A sextant that cannot be scored carries no score, and an unscored sextant
  -- cannot carry a furcation. Written six times rather than in a loop because a
  -- check constraint is the only thing standing between a bad write and a record
  -- that renders as healthy.
  constraint perio_bpe_ur_chk check (
    (ur_code is null or ur_status = 'scorable') and (ur_code is not null or not ur_furcation)),
  constraint perio_bpe_ua_chk check (
    (ua_code is null or ua_status = 'scorable') and (ua_code is not null or not ua_furcation)),
  constraint perio_bpe_ul_chk check (
    (ul_code is null or ul_status = 'scorable') and (ul_code is not null or not ul_furcation)),
  constraint perio_bpe_ll_chk check (
    (ll_code is null or ll_status = 'scorable') and (ll_code is not null or not ll_furcation)),
  constraint perio_bpe_la_chk check (
    (la_code is null or la_status = 'scorable') and (la_code is not null or not la_furcation)),
  constraint perio_bpe_lr_chk check (
    (lr_code is null or lr_status = 'scorable') and (lr_code is not null or not lr_furcation)),

  -- An amendment without a reason is not a marked amendment, and a retraction
  -- without a reason is a deletion wearing a timestamp.
  constraint perio_bpe_amend_chk  check ((supersedes_id is null) = (amendment_reason is null)),
  constraint perio_bpe_retract_chk check ((retracted_at is null) = (retraction_reason is null))
);

-- ---------------------------------------------------------------------------
-- 2. The 6-point chart -- header
-- ---------------------------------------------------------------------------
--
-- Split header / per-tooth / per-site because the three carry different facts:
-- mobility and furcation are properties of a TOOTH (stages 1-3, grades 1-4),
-- while depth, recession, bleeding, suppuration and plaque are properties of a
-- SITE. Folding them together would make 192 rows carry six copies of one
-- mobility grade and invite them to disagree.

create table if not exists public.perio_chart (
  id                  uuid primary key default gen_random_uuid(),
  site_id             text not null,
  dentally_patient_id text not null,
  version             integer not null,

  recorded_at         timestamptz not null,
  created_at          timestamptz not null default now(),
  author_user_id      uuid not null references public.app_user (id) on delete restrict,
  author_name         text not null,
  author_gdc_number   text,
  probe               text not null default 'who-621'
                        check (probe in ('who-621', 'who-cpi', 'other')),
  probe_note          text,

  -- What this chart CLAIMS to cover. A sextant-scoped chart is the normal
  -- follow-up to a BPE 3 ("6-point chart of that sextant, after initial
  -- therapy"); a 4 anywhere means full mouth from the outset. The route refuses
  -- a chart that claims a sextant it holds no teeth for, because a claim of
  -- coverage that is not backed by measurements reads to the next clinician as
  -- "this sextant was examined and was fine".
  --
  -- NO SEPARATE "scope" COLUMN. Coverage is DERIVED from this list (all six
  -- sextants is a full-mouth chart, fewer is a partial one), the way
  -- describeCoverage does it in src/lib/perio/pocket-chart.ts. A stored scope
  -- would be a second copy of a fact this array already carries, free to
  -- disagree with it.
  --
  -- cardinality(), NOT array_length(). array_length('{}', 1) is NULL, NULL >= 1
  -- is NULL, and a check constraint treats NULL as satisfied -- so the obvious
  -- spelling would have let a chart covering no sextants at all straight through.
  sextants            text[] not null
                        check (cardinality(sextants) >= 1
                               and sextants <@ array['UR','UA','UL','LL','LA','LR']::text[]),

  -- Why this chart was taken. 'bpe-3' and 'bpe-4' are the protocol triggers;
  -- 'maintenance-annual' is the yearly re-chart for anyone in periodontal
  -- maintenance, which is the obligation most often missed.
  trigger             text check (trigger in ('bpe-3', 'bpe-4', 'maintenance-annual', 'other')),
  bpe_exam_id         uuid references public.perio_bpe_exam (id) on delete restrict,

  -- The clinician's OWN 2017/18 diagnosis, when they have committed to one.
  -- Nothing in this platform writes these columns from a calculation. Staging
  -- and grading are offered on screen as decision support that shows its
  -- working; the diagnosis belongs to the clinician, and a stage that appeared
  -- by itself is a diagnosis nobody made.
  diagnosis_stage     text check (diagnosis_stage in ('I', 'II', 'III', 'IV')),
  diagnosis_grade     text check (diagnosis_grade in ('A', 'B', 'C')),
  diagnosis_extent    text check (diagnosis_extent in ('localised', 'generalised', 'molar-incisor')),

  notes               text,

  supersedes_id       uuid references public.perio_chart (id) on delete restrict,
  amendment_reason    text,

  retracted_at        timestamptz,
  retracted_by        uuid references public.app_user (id) on delete restrict,
  retraction_reason   text,

  -- THE ONLY REASON A PERIO ROW CAN EVER BE DELETED.
  --
  -- A chart is a header plus up to 32 tooth rows plus up to 192 site rows, and
  -- supabase-js cannot wrap those inserts in one transaction. If the site rows
  -- fail after the header lands, an append-only table would be left holding a
  -- chart with no measurements -- which reads as "charted, all sites blank", the
  -- single worst thing this feature could produce. So a chart is not a record
  -- until it is finalised: reads ignore finalised_at is null, and the trigger
  -- permits DELETE of an unfinalised chart (and its children) precisely so a
  -- failed write can be cleaned up. Once finalised, nothing deletes it.
  finalised_at        timestamptz,

  constraint perio_chart_amend_chk   check ((supersedes_id is null) = (amendment_reason is null)),
  constraint perio_chart_retract_chk check ((retracted_at is null) = (retraction_reason is null))
);

-- ---------------------------------------------------------------------------
-- 3. The 6-point chart -- per tooth
-- ---------------------------------------------------------------------------

create table if not exists public.perio_chart_tooth (
  id         uuid primary key default gen_random_uuid(),
  chart_id   uuid not null references public.perio_chart (id) on delete cascade,
  -- FDI two-digit notation, PERMANENT ONLY (11-48). Six-point charting is defined
  -- for the permanent dentition and validatePocketChart refuses a deciduous tooth
  -- by name, so the range here matches rather than quietly accepting a 55 the
  -- code above it would have rejected.
  tooth_fdi  smallint not null check (tooth_fdi between 11 and 48),

  -- DENTALLY'S SCALES: FURCATION GRADES 1-4, MOBILITY STAGES 1-3.
  --
  -- These ranges used to be Miller 0-III and Hamp I-III, taken from the clinical
  -- literature. Dentally's own help article for creating a perio exam says the
  -- `f` key "will cycle through furcation grades 1, 2, 3 and 4" and the `m` key
  -- through "mobility stages 1-3", so Dentally wins: the point of this module is
  -- that staff do not relearn a scale they use every day. A hygienist who types
  -- a grade 4 furcation and is refused by the database is a hygienist who stops
  -- trusting the screen -- which is precisely what `between 1 and 3` did here.
  --
  -- NULL IS THE ABSENCE OF A FINDING, and it is why neither column starts at 0.
  -- There is no grade 0 and no stage 0; giving "none found" a number would make
  -- it indistinguishable from "not assessed" once it is a row in a table. The
  -- old mobility range allowed a 0 for exactly that reason and it was wrong for
  -- exactly that reason.
  --
  -- Stored as smallints rather than roman numerals so "worse than last time" is
  -- a comparison and not a lookup.
  mobility   smallint check (mobility between 1 and 3),
  furcation  smallint check (furcation between 1 and 4),

  -- NO "absent" AND NO "implant" COLUMN, and their absence is deliberate.
  -- PerioToothRecord carries neither: a chart records the teeth that were
  -- charted, and which teeth exist or carry implants is a fact about the MOUTH,
  -- supplied per examination as BpeContext.presentTeeth / implantTeeth. Storing
  -- it again on every chart row would be a second copy of the dentition, free to
  -- age out of step with the first. An edentulous sextant is expressed by not
  -- declaring that sextant on the chart, which is also what stops it rendering
  -- as examined and healthy.

  constraint perio_chart_tooth_uniq unique (chart_id, tooth_fdi)
);

-- ---------------------------------------------------------------------------
-- 4. The 6-point chart -- per site (up to 192 rows per chart)
-- ---------------------------------------------------------------------------

create table if not exists public.perio_chart_site (
  id                uuid primary key default gen_random_uuid(),
  chart_id          uuid not null references public.perio_chart (id) on delete cascade,
  tooth_fdi         smallint not null check (tooth_fdi between 11 and 48),
  -- Mesiobuccal, buccal, distobuccal, mesiolingual, lingual, distolingual.
  site              text not null check (site in ('mb', 'b', 'db', 'ml', 'l', 'dl')),

  -- NULLABLE, and that is the clinical answer rather than a convenience. A site
  -- that was not probed is not a site with a depth of zero, and PerioSiteMeasurement
  -- in types.ts is nullable for the same reason. The generated CAL below then
  -- comes out null of its own accord, instead of being derived from a guess.
  --
  -- THE RANGES ARE THE APPLICATION'S, TO THE MILLIMETRE. They are
  -- MAX_PROBING_DEPTH_MM, MIN_RECESSION_MM and MAX_RECESSION_MM in
  -- src/lib/perio/pocket-chart.ts, and src/lib/perio/measurement-ranges.test.ts
  -- reads this file and fails if the two ever stop agreeing.
  --
  -- They did not agree before: this column allowed a recession of -10 to 20
  -- while the engine allowed -5 to 15. Nothing wrong could reach the table
  -- THROUGH THE APP, since the app was the stricter of the two — but one
  -- measurement with two definitions is a definition already drifting, and this
  -- constraint is the last line if anything ever writes directly.
  probing_depth_mm  smallint check (probing_depth_mm between 0 and 15),
  -- Signed on purpose. Recession is negative where the margin sits coronal to
  -- the CEJ (overgrowth, or a deep pocket with no recession at all), and
  -- clamping it at zero would inflate every CAL computed from it. -5mm of
  -- overgrowth is already florid; the old -10 bought nothing but room for a
  -- typo. The maximum is the instrument: a probe marked to 15mm cannot report 20.
  recession_mm      smallint check (recession_mm between -5 and 15),

  -- CAL IS COMPUTED AND CANNOT BE TYPED. depth + recession, enforced by the
  -- database itself, so no client, no future route and no manual SQL can store
  -- an attachment loss that disagrees with the two numbers it is derived from.
  -- The route refuses a payload that even CONTAINS a CAL field, and
  -- SiteMeasurementInput bans it at the type level, so a client sending one is
  -- told rather than silently ignored.
  --
  -- IT IS STORED RATHER THAN LEFT TO buildPocketChart BECAUSE OF ONE QUERY:
  -- "which patients have interdental attachment loss of 5mm or more" is the
  -- population question staging is built on, and it cannot be asked of 51k
  -- patients by loading every chart into Node. Reads still hand callers the raw
  -- depth and recession and let pocket-chart.ts derive the view.
  -- Cast written out rather than left to the operator's result type, so the
  -- column definition cannot depend on which int2/int4 addition Postgres picks.
  cal_mm            smallint generated always as ((probing_depth_mm + recession_mm)::smallint) stored,

  bleeding          boolean not null default false,
  suppuration       boolean not null default false,
  plaque            boolean not null default false,

  constraint perio_chart_site_uniq unique (chart_id, tooth_fdi, site)
);

-- ---------------------------------------------------------------------------
-- 5. Version assignment
-- ---------------------------------------------------------------------------
--
-- Assigned here rather than by the application so that two clients cannot both
-- believe they are writing version 3. Concurrent inserts can still both read the
-- same max under read-committed; the unique index below turns that into a
-- 23505 the repository retries once, rather than into two rows claiming to be
-- the same version of the same patient's exam.

create or replace function public.perio_assign_version()
returns trigger
language plpgsql
as $$
declare
  next_version integer;
begin
  execute format(
    'select coalesce(max(version), 0) + 1 from public.%I where site_id = $1 and dentally_patient_id = $2',
    tg_table_name
  )
  into next_version
  using new.site_id, new.dentally_patient_id;
  new.version := next_version;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Append-only enforcement
-- ---------------------------------------------------------------------------
--
-- Serves both record tables. Everything except the retraction fields and the
-- one-way finalisation flip is frozen the moment the row exists.

create or replace function public.perio_record_append_only()
returns trigger
language plpgsql
as $$
declare
  frozen_old jsonb;
  frozen_new jsonb;
begin
  if tg_op = 'DELETE' then
    -- Never finalised, so never a clinical record: this is the cleanup path for
    -- a multi-statement write that failed part way. See perio_chart.finalised_at.
    if old.finalised_at is null then
      return old;
    end if;
    raise exception
      'perio records are never deleted (GDC 4.1.5): retract with a reason instead';
  end if;

  frozen_old := to_jsonb(old) - 'retracted_at' - 'retracted_by' - 'retraction_reason' - 'finalised_at';
  frozen_new := to_jsonb(new) - 'retracted_at' - 'retracted_by' - 'retraction_reason' - 'finalised_at';
  if frozen_old is distinct from frozen_new then
    raise exception
      'perio records are append-only (GDC 4.1.5): record an amendment as a new version';
  end if;

  if old.finalised_at is not null and new.finalised_at is distinct from old.finalised_at then
    raise exception 'a finalised perio record cannot be re-finalised or unfinalised';
  end if;
  if old.retracted_at is not null then
    raise exception 'this perio record has already been retracted';
  end if;

  return new;
end;
$$;

-- Measurements are immutable outright: there is no field on them that a later
-- correction should move. A corrected reading is a new chart version.
create or replace function public.perio_measurement_immutable()
returns trigger
language plpgsql
as $$
declare
  parent_finalised timestamptz;
begin
  if tg_op = 'UPDATE' then
    raise exception
      'perio measurements are immutable (GDC 4.1.5): record a corrected chart as a new version';
  end if;
  -- DELETE. Allowed only while the parent chart was never finalised -- which is
  -- also the state during the cascade from cleaning up a failed write, where the
  -- parent row has already gone and this select finds nothing.
  select finalised_at into parent_finalised from public.perio_chart where id = old.chart_id;
  if parent_finalised is null then
    return old;
  end if;
  raise exception 'perio measurements are never deleted (GDC 4.1.5)';
end;
$$;

drop trigger if exists perio_bpe_exam_version on public.perio_bpe_exam;
create trigger perio_bpe_exam_version
  before insert on public.perio_bpe_exam
  for each row execute function public.perio_assign_version();

drop trigger if exists perio_bpe_exam_append_only on public.perio_bpe_exam;
create trigger perio_bpe_exam_append_only
  before update or delete on public.perio_bpe_exam
  for each row execute function public.perio_record_append_only();

drop trigger if exists perio_chart_version on public.perio_chart;
create trigger perio_chart_version
  before insert on public.perio_chart
  for each row execute function public.perio_assign_version();

drop trigger if exists perio_chart_append_only on public.perio_chart;
create trigger perio_chart_append_only
  before update or delete on public.perio_chart
  for each row execute function public.perio_record_append_only();

drop trigger if exists perio_chart_tooth_immutable on public.perio_chart_tooth;
create trigger perio_chart_tooth_immutable
  before update or delete on public.perio_chart_tooth
  for each row execute function public.perio_measurement_immutable();

drop trigger if exists perio_chart_site_immutable on public.perio_chart_site;
create trigger perio_chart_site_immutable
  before update or delete on public.perio_chart_site
  for each row execute function public.perio_measurement_immutable();

-- ---------------------------------------------------------------------------
-- 7. Indexes -- for the two queries that will actually run
-- ---------------------------------------------------------------------------
--
-- The screen asks exactly two things: "this patient's latest chart" and "the one
-- before it", because a single perio chart is nearly useless and the clinical
-- value is this visit against the last. Both are the same ordered scan with a
-- limit of 1 and 2, so one partial index serves both -- and it is partial on
-- (finalised and not retracted) because those are the only rows a comparison may
-- ever be built from.

create unique index if not exists perio_bpe_exam_version_uniq
  on public.perio_bpe_exam (site_id, dentally_patient_id, version);

create index if not exists perio_bpe_exam_latest_idx
  on public.perio_bpe_exam (site_id, dentally_patient_id, recorded_at desc, version desc)
  where finalised_at is not null and retracted_at is null;

create unique index if not exists perio_chart_version_uniq
  on public.perio_chart (site_id, dentally_patient_id, version);

create index if not exists perio_chart_latest_idx
  on public.perio_chart (site_id, dentally_patient_id, recorded_at desc, version desc)
  where finalised_at is not null and retracted_at is null;

-- Loading a chart pulls every measurement for one chart_id, so the unique
-- constraints above already lead on chart_id and no extra index is needed. The
-- amendment chain is walked one row at a time from a record already in hand, so
-- supersedes_id needs none either.

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------
-- On, with no policy and no grant: unreachable by any anon or authenticated key.
-- Access is server-only, through serviceClient(), behind requireUser plus the
-- client / site / patient-belongs-to-site checks in the route.

alter table public.perio_bpe_exam    enable row level security;
alter table public.perio_chart       enable row level security;
alter table public.perio_chart_tooth enable row level security;
alter table public.perio_chart_site  enable row level security;
