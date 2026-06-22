-- Phone -> patient identity directory used by the SMS agent to recognise any
-- inbound number (not just reactivation targets). Acts as a cache of the
-- patient record keyed by the number that texts us: name, site, treatment,
-- funding, last visit and recall-due. Populated from reactivation, a Dentally
-- phone search, or seeded manually for a known contact.
create table if not exists agent_phone_identity (
  phone text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  treatment text,
  funding_type text check (funding_type in ('nhs','private')),
  last_visit_at timestamptz,
  recall_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table agent_phone_identity enable row level security;

-- Pilot-permissive RLS (consistent with the other pilot tables).
drop policy if exists agent_phone_identity_pilot_all on agent_phone_identity;
create policy agent_phone_identity_pilot_all on agent_phone_identity
  for all using (true) with check (true);
