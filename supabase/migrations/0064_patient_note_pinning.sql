-- 0064_patient_note_pinning.sql
-- Pinning and colour for practice notes, so the record can carry Dentally's
-- pinned sticky-note band across the top.
--
-- ALTER of the table created by 0035. RLS is already enabled there and default
-- privileges are already revoked by 0019, so this file issues NO policy and NO
-- grant: all access stays server-only through serviceClient() behind requireUser
-- plus the client and site checks.
--
-- PINNING APPLIES ONLY TO OUR OWN NOTES. Dentally's patient_notes are read-only:
-- DentallyClient has no create or update method for /v1/patient_notes, so a
-- Dentally note can never be pinned, coloured or edited here, and nothing in this
-- table mirrors one.
--
-- HIDE IS NOT MODELLED HERE ON PURPOSE. Dentally's Hide control is per-reader and
-- transient; it is held in the browser session, not in the database, so one
-- reader can never clear a clinical note off everyone else's screen.
--
-- THE 12-PIN CAP IS NOT A CONSTRAINT HERE EITHER. It is enforced in the PATCH
-- route, where it can return the plain sentence a receptionist needs ("this
-- patient already has 12 pinned notes; unpin one first") rather than a constraint
-- violation. A check constraint cannot count sibling rows without a trigger, and a
-- trigger that silently refuses a clinical write is worse than a refusal the
-- caller can read.

alter table public.patient_note
  add column if not exists pinned_at  timestamptz,
  add column if not exists pinned_by  text,
  add column if not exists colour     text,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by text;

-- pinned_at rather than a boolean: pin ORDER and "when was this pinned" come free,
-- and null means not pinned. Same nullable-timestamp-as-state pattern as
-- diary_entry.deleted_at and diary_outbox.sent_at in 0063.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'patient_note_colour_chk') then
    alter table public.patient_note
      add constraint patient_note_colour_chk
      check (colour is null or colour in ('yellow','green','orange','blue','pink','grey'));
  end if;
end $$;

-- The band asks for "the pinned ones for this patient" on every record open, while
-- the 0035 index serves the full history. Partial, matching 0063's diary_entry_lookup_idx.
create index if not exists patient_note_pinned_idx
  on public.patient_note (site_id, dentally_patient_id, pinned_at desc)
  where pinned_at is not null;

-- Every column added above is nullable, so Postgres adds them without a table
-- rewrite: no backfill, no lock concern, safe online.
