-- 0027_onboarding.sql
-- Onboarding: a public, branded, multi-step new-patient onboarding form filled in by
-- new customers at a custom URL (e.g. /onboard/<client>). One row per completed
-- onboarding submission. It captures contact, address, a brief medical intake (free
-- text only, never clinical advice), the reason for joining, attribution, optional
-- uploaded documents (referral letters, previous records, insurance) and the
-- patient's consent choices. Staff review the submissions from an internal worklist.
--
-- Files are NOT stored inline: each entry in `files` is a reference to an object in
-- the private `onboarding` Storage bucket ({ path, name, size, type }). The path is
-- always under onboarding/<clientSlug>/ so a signed-URL read can be scoped to the
-- client and never leaks across tenants.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies are
-- issued to anon/authenticated (0012 revoked those across the schema, 0013/0026 follow
-- the same shape). All access is server-only via the service-role client: the public
-- submit + upload endpoints validate + rate-limit before writing; the internal list +
-- file endpoints are requireUser + client-scoped.

create table if not exists onboarding_submission (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- The chosen practice site, if the form asked. Nullable: a patient may pick "any".
  site_id text,
  first_name text,
  last_name text,
  -- ISO date string (yyyy-mm-dd). Stored as text: it is intake data, not a clinical
  -- record, and we never do date arithmetic on it.
  date_of_birth text,
  phone text,
  email text,
  -- { line1, line2, city, postcode }
  address jsonb,
  -- { conditions, medications, allergies, gp } — free-text intake fields only.
  -- Captured for the practice to review; never used to give clinical advice.
  medical jsonb,
  -- { reason, last_visit, concerns }
  dental jsonb,
  -- How they heard about us — feeds attribution.
  heard_about text,
  -- Array of { path, name, size, type } referencing objects in the `onboarding` bucket.
  files jsonb not null default '[]'::jsonb,
  -- { sms, email, marketing, data } booleans.
  consent jsonb,
  status text not null default 'new'
    check (status in ('new', 'reviewed', 'registered', 'archived')),
  created_at timestamptz not null default now()
);

-- Newest-first worklist for a client.
create index if not exists idx_onboarding_client_created
  on onboarding_submission (client_id, created_at desc);
-- Filter the worklist by status (new / reviewed / registered / archived).
create index if not exists idx_onboarding_client_status
  on onboarding_submission (client_id, status);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0013 / 0026).
alter table onboarding_submission enable row level security;
