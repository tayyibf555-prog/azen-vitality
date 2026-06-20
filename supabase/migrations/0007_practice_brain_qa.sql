-- 0007_practice_brain_qa.sql
-- Conversation capture: every co-pilot Q&A, for the correction/feedback loop and later tuning.
create table practice_brain_qa (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  question text not null,
  answer text not null,
  grounded_in smallint not null default 0,
  asker_tier smallint not null,
  cited_ids text[] not null default '{}',
  feedback smallint,
  created_at timestamptz not null default now()
);
create index practice_brain_qa_client_idx on practice_brain_qa (client_id, created_at desc);
alter table practice_brain_qa enable row level security;
create policy practice_brain_qa_pilot_all on practice_brain_qa for all using (true) with check (true);
