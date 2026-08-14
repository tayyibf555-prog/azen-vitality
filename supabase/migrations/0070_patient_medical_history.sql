-- 0070_patient_medical_history.sql
-- Medical history: the patient-completed questionnaire, and the "reviewed at this
-- appointment" clinical event.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- THIS IS NOT A MIRROR OF DENTALLY. Dentally's /v1/medical_histories endpoint
-- EXISTS but is permanently empty for this practice: a read-only GET returns
-- {"medical_histories":[],"meta":{"total":0}} globally, for a real patient, with
-- updated_since=2000-01-01, and sorted by updated_at — 0 rows across 51k patients.
-- There is nothing to mirror. The ONE populated Dentally medical signal is the
-- patient object's own `medical_alert` boolean + `medical_alert_text`, which we
-- read on the patient payload (PatientRecord.medicalAlert) and which is a DIFFERENT
-- FACT from the questionnaire these tables hold. Every row here is AUTHORED in this
-- platform, which makes this platform the system of record for it the moment the
-- feature is switched on, while Dentally's own medical history and alert still exist
-- and still work.
--
-- SO IT SHIPS SWITCHED OFF. isMedicalHistoryEnabled() reads MEDICAL_HISTORY_ENABLED
-- and defaults FALSE; with it unset every route under /api/medical-history answers
-- 503 with an explanation and nothing renders. Turning it on is the practice's
-- decision, in writing, not this migration's and not a developer's. Two live
-- medical records for one patient is the worst outcome available. Do not apply this
-- file to demonstrate the feature.
--
-- DCB0129 applies to a live switch-on: this is health IT informing treatment
-- decisions (a clinician reads this before treating), so it needs a Clinical Safety
-- Officer, a hazard log and a safety case. None of that can come out of this repo.
-- ============================================================================
--
-- APPEND-ONLY, ENFORCED BY TRIGGER RATHER THAN BY CONVENTION.
--
-- GDC Standard 4.1.4 requires the treating clinician on the record and 4.1.5
-- requires amendments to be clearly marked and dated. RLS does not help: every
-- write goes through serviceClient(), which holds the service role and bypasses
-- RLS entirely. Triggers do NOT get bypassed, so the append-only rule is a trigger:
--   * an amendment INSERTS a new questionnaire version pointing at the one it amends;
--   * a mistake is RETRACTED with a reason, never deleted;
--   * a review is immutable outright — a correction is a new review.
--
-- SIGNATURES AND FREE TEXT ARE PATIENT-IDENTIFYING AND SENSITIVE. The signature
-- jsonb, patient_name, medications_text and allergies_text carry identifying
-- clinical data, so RLS is enabled with NO policy and NO grant, matching 0064/0065/
-- 0066: unreachable by any anon or authenticated key, server-only through
-- serviceClient() behind requireUser + client/site/patient-belongs-to-site checks.
-- The public capture path writes through the same serviceClient() after verifying a
-- signed per-patient token; it never opens a client-reachable door to these tables.

-- ---------------------------------------------------------------------------
-- 1. The questionnaire
-- ---------------------------------------------------------------------------

create table if not exists public.patient_medical_history (
  id                    uuid primary key default gen_random_uuid(),
  site_id               text not null,
  dentally_patient_id   text not null,

  -- Assigned by medical_history_assign_version() on insert, never by the client.
  -- 1-based, per (site, patient). An amendment is version n+1, not an edit of n.
  version               integer not null,

  -- Which questions.ts bank these answers were given against, so a record read
  -- years later is understood against the exact wording the patient saw.
  question_bank_version text not null,

  -- The patient's name as they signed it / as staff recorded it. Identifying.
  patient_name          text,

  -- [{ key, answer:'yes'|'no'|'unknown', detail? }]. The keys are validated against
  -- the current bank in the application before this is written; a jsonb column keeps
  -- the shape flexible as the bank versions, and the version above says which one.
  answers               jsonb not null,

  medications_text      text,
  allergies_text        text,

  -- { method:'drawn'|'typed'|'ipad', value, signedAt }. A drawn signature's value is
  -- a data-url, a typed one is the name — both identifying, hence the locked table.
  signature             jsonb,

  captured_via          text not null default 'staff'
                          check (captured_via in ('public-link', 'ipad', 'staff')),

  -- When the questionnaire was completed, which is not always when the row landed.
  recorded_at           timestamptz not null,
  created_at            timestamptz not null default now(),

  -- NULL for a patient self-capture over the public link (the patient authored it,
  -- not a clinician). Set for a staff-entered fallback. The authoring API refuses a
  -- null-author write; only the public route writes one, which is the truthful case.
  author_user_id        uuid references public.app_user (id) on delete restrict,
  author_name           text,

  -- GDC 4.1.5: an amendment is a NEW ROW carrying a reason and pointing at the
  -- version it amends; the amended row is left exactly as written.
  supersedes_id         uuid references public.patient_medical_history (id) on delete restrict,
  amendment_reason      text,

  -- A record entered in error is retracted, with a reason and a name, and stays
  -- readable. Nothing here is ever removed.
  retracted_at          timestamptz,
  retracted_by          uuid references public.app_user (id) on delete restrict,
  retraction_reason     text,

  -- An amendment without a reason is not a marked amendment, and a retraction
  -- without a reason is a deletion wearing a timestamp.
  constraint pmh_amend_chk   check ((supersedes_id is null) = (amendment_reason is null)),
  constraint pmh_retract_chk check ((retracted_at is null) = (retraction_reason is null))
);

-- ---------------------------------------------------------------------------
-- 2. The review — the "reviewed at this appointment" clinical event
-- ---------------------------------------------------------------------------
--
-- A separate table from the questionnaire because a review is a distinct clinical
-- act with its own author and instant: the questionnaire is what the patient said,
-- the review is a clinician confirming they read it before treating. GDC 4.1.4
-- puts the clinician on the record, so author_user_id is NOT NULL here (unlike the
-- questionnaire, which a patient may author). A review is immutable — a correction
-- is a new review, not an edit.

create table if not exists public.patient_medical_review (
  id                    uuid primary key default gen_random_uuid(),
  site_id               text not null,
  dentally_patient_id   text not null,

  -- The Dentally appointment this review was done at, when known. Nullable: a review
  -- can be recorded off-appointment (e.g. a phone update), and a made-up appointment
  -- id would be worse than none.
  dentally_appointment_id text,
  -- The questionnaire that was current when reviewed, when there was one.
  questionnaire_id      uuid references public.patient_medical_history (id) on delete restrict,

  outcome               text not null check (outcome in ('no-changes', 'updated')),

  reviewed_at           timestamptz not null,
  created_at            timestamptz not null default now(),

  -- GDC 4.1.4: the reviewing clinician is on the record, and the FK means a real
  -- person. The route REFUSES a review it cannot attribute rather than writing 'Team'.
  author_user_id        uuid not null references public.app_user (id) on delete restrict,
  author_name           text not null,
  author_gdc_number     text
);

-- ---------------------------------------------------------------------------
-- 3. Version assignment (questionnaire only)
-- ---------------------------------------------------------------------------
--
-- Assigned here rather than by the application so two clients cannot both believe
-- they are writing version 3. Concurrent inserts can still read the same max under
-- read-committed; the unique index below turns that into a 23505 the repository
-- retries once.

create or replace function public.medical_history_assign_version()
returns trigger
language plpgsql
as $$
declare
  next_version integer;
begin
  select coalesce(max(version), 0) + 1
    into next_version
    from public.patient_medical_history
   where site_id = new.site_id and dentally_patient_id = new.dentally_patient_id;
  new.version := next_version;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Append-only enforcement
-- ---------------------------------------------------------------------------
--
-- The questionnaire: everything except the retraction fields is frozen the moment
-- the row exists; a delete is forbidden; a retracted row cannot be re-retracted.

create or replace function public.medical_history_append_only()
returns trigger
language plpgsql
as $$
declare
  frozen_old jsonb;
  frozen_new jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception
      'medical-history records are never deleted (GDC 4.1.5): retract with a reason instead';
  end if;

  frozen_old := to_jsonb(old) - 'retracted_at' - 'retracted_by' - 'retraction_reason';
  frozen_new := to_jsonb(new) - 'retracted_at' - 'retracted_by' - 'retraction_reason';
  if frozen_old is distinct from frozen_new then
    raise exception
      'medical-history records are append-only (GDC 4.1.5): record an amendment as a new version';
  end if;

  if old.retracted_at is not null then
    raise exception 'this medical-history record has already been retracted';
  end if;

  return new;
end;
$$;

-- The review is immutable outright: there is no field on it a later correction
-- should move. A corrected review is a new review.

create or replace function public.medical_review_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'medical-history reviews are immutable (GDC 4.1.5): record a corrected review as a new one';
end;
$$;

drop trigger if exists patient_medical_history_version on public.patient_medical_history;
create trigger patient_medical_history_version
  before insert on public.patient_medical_history
  for each row execute function public.medical_history_assign_version();

drop trigger if exists patient_medical_history_append_only on public.patient_medical_history;
create trigger patient_medical_history_append_only
  before update or delete on public.patient_medical_history
  for each row execute function public.medical_history_append_only();

drop trigger if exists patient_medical_review_immutable on public.patient_medical_review;
create trigger patient_medical_review_immutable
  before update or delete on public.patient_medical_review
  for each row execute function public.medical_review_immutable();

-- ---------------------------------------------------------------------------
-- 5. Indexes -- for the queries that will actually run
-- ---------------------------------------------------------------------------
--
-- The record screen and the header ask "this patient's latest questionnaire" and
-- "this patient's reviews". The task queue asks, per site, "which patients have a
-- questionnaire not yet reviewed" — a site-scoped scan of the standing (not
-- retracted) questionnaires. Those are the three below.

create unique index if not exists patient_medical_history_version_uniq
  on public.patient_medical_history (site_id, dentally_patient_id, version);

create index if not exists patient_medical_history_latest_idx
  on public.patient_medical_history (site_id, dentally_patient_id, recorded_at desc, version desc)
  where retracted_at is null;

-- The task-queue's site-level "awaiting review" scan.
create index if not exists patient_medical_history_site_idx
  on public.patient_medical_history (site_id, recorded_at desc)
  where retracted_at is null;

create index if not exists patient_medical_review_latest_idx
  on public.patient_medical_review (site_id, dentally_patient_id, reviewed_at desc);

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
-- On, with no policy and no grant: unreachable by any anon or authenticated key.
-- Access is server-only, through serviceClient(), behind requireUser plus the
-- client / site / patient-belongs-to-site checks in the route (or, for the public
-- capture path, a verified signed per-patient token).

alter table public.patient_medical_history enable row level security;
alter table public.patient_medical_review  enable row level security;
