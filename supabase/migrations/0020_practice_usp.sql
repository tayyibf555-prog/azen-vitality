-- 0020_practice_usp.sql
-- USPs (Unique Selling Points): the practice's differentiators that the owner
-- configures and the AI agents weave into conversion messaging across every
-- patient-facing channel (the WhatsApp booking agent, Speed-to-lead first contact,
-- recall, reactivation and treatment-coordinator drafts).
--
-- Practice-wide (client-scoped, not per-site). Each USP is a short, patient-safe
-- statement (e.g. "0% finance available", "Free on-site parking", "Saturday
-- appointments"). The agents are instructed to mention them naturally where
-- relevant and NEVER as a clinical guarantee or over-promise.
--
-- Created in the POST-0012 locked posture: RLS on, NO anon/authenticated grants;
-- all access is server-only via the service-role client, and the internal CRUD is
-- requireUser + requireClientAccess. 0019 set ALTER DEFAULT PRIVILEGES so this
-- table also inherits the revoke automatically.

create table if not exists practice_usp (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  text text not null,                       -- the selling point, patient-safe, no em-dash
  category text,                            -- optional: finance | convenience | expertise | comfort | other
  priority integer not null default 0,      -- higher shows / is mentioned first
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_practice_usp_client_active_priority
  on practice_usp (client_id, active, priority desc);

alter table practice_usp enable row level security;
