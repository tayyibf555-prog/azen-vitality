-- In-app "Report an issue" feedback: a lightweight bug/idea/question note a
-- signed-in user submits from anywhere in the authed shells (src/components/
-- platform/feedback-widget.tsx), reviewed newest-first in the agency console.
-- user_id/user_email/role are stamped from the verified session server-side
-- (never trusted from the request body), and are nullable because the pilot
-- can run with auth enforcement off (src/lib/auth/guard.ts authEnforced()).

create table if not exists public.feedback_item (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  user_id text,
  user_email text,
  role text,
  page_path text not null,
  note text not null,
  severity text not null default 'bug',
  status text not null default 'new',
  created_at timestamptz not null default now(),
  constraint feedback_item_severity_chk check (severity in ('bug', 'idea', 'question'))
);

-- Agency console reads every client's feedback newest-first in one query.
create index if not exists feedback_item_created_idx
  on public.feedback_item (created_at desc);

-- Locked to server-only (post-0012 posture, consistent with 0035 / 0037): RLS on,
-- no policies, so only the service role (serviceClient) can read/write. Every
-- access path is a guarded server route (requireUser on submit, agency_admin on
-- the list + mark-done).
alter table public.feedback_item enable row level security;
