-- 0005_knowledge_gap.sql
-- Co-pilot gap log: questions the brain could not answer, for owners/managers to fill.
create table practice_brain_gap (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  question text not null,
  asker_tier smallint not null,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now()
);
create index practice_brain_gap_client_status_idx on practice_brain_gap (client_id, status);
alter table practice_brain_gap enable row level security;
create policy practice_brain_gap_pilot_all on practice_brain_gap for all using (true) with check (true);
