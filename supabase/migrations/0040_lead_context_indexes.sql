-- Outreach context lookups run on hot paths (every inbound agent turn resolves
-- lead-by-conversation, then assessment-by-lead; every first contact resolves
-- assessment-by-lead). Neither column had an index, so both were table scans
-- that would degrade as leads/assessments grow. Partial indexes: most lead rows
-- have no conversation yet and most assessment rows no lead.

create index if not exists idx_stl_lead_conversation
  on public.speed_to_lead_lead (conversation_id, created_at desc)
  where conversation_id is not null;

create index if not exists idx_sa_response_lead
  on public.smile_assessment_response (lead_id, created_at desc)
  where lead_id is not null;
