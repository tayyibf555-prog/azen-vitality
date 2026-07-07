-- Practice-authored patient notes: staff notes captured by typing or voice
-- dictation, stored in OUR platform. Dentally stays read-only (its existing notes
-- are shown live in the drawer, never copied here). These are special-category
-- health data, so: server-only, RLS enabled, NO anon/authenticated grants
-- (POST-0012 locked posture, consistent with 0026 / 0032 / 0034 — all access is
-- via the service-role server client behind requireUser + site access checks).

create table if not exists public.patient_note (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  dentally_patient_id text not null,
  author_id text,
  author_name text not null default 'Team',
  body text not null,
  source text not null default 'typed',
  created_at timestamptz not null default now(),
  constraint patient_note_source_chk check (source in ('typed', 'voice'))
);

-- Fast lookup of a patient's notes, newest first.
create index if not exists patient_note_lookup_idx
  on public.patient_note (site_id, dentally_patient_id, created_at desc);

alter table public.patient_note enable row level security;
