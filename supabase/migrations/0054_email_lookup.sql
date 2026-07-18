-- 0054_email_lookup.sql
-- Email deliverability pre-send validation cache ("never pay to email an
-- undeliverable address"). The exact email mirror of phone_lookup (migration
-- 0045): before the send path emails a resolved address, it can ask NeverBounce
-- whether that address is real. An invalid or disposable address is blocked
-- BEFORE the send, so we never spend on a message that can never arrive.
--
-- DORMANT BY DEFAULT. The whole feature is double-gated in code on
-- NEVERBOUNCE_API_KEY *and* EMAIL_LOOKUP_ENABLED=true. With either unset (the
-- current state, and email is not configured in prod at all yet) validateEmail is
-- a no-op that returns valid=true, so the send path behaves EXACTLY as before.
-- This seam ships switched off and is turned on deliberately.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (like 0045 / 0034 / 0036 / 0044).
-- British English, GBP, no NHS vs private framing anywhere.

-- ---------------------------------------------------------------------------
-- Email Lookup cache.
--
-- One row per normalised (trimmed + lowercased) address we have validated, so a
-- repeat send NEVER re-calls the paid NeverBounce API. `valid` is OUR
-- deliverability verdict (a real, reachable mailbox): an invalid or disposable
-- address is stored valid=false; a catchall/unknown is stored valid=true (a
-- fail-open, cost-saving posture, not a hard delivery block). `verdict` keeps
-- NeverBounce's raw result (valid/invalid/disposable/catchall/unknown) for logs.
-- `checked_at` drives a 90-day TTL in code (a row older than that is treated as a
-- miss and re-validated). The normalised email itself is the primary key.
-- ---------------------------------------------------------------------------
create table if not exists public.email_lookup (
  email text primary key,
  valid boolean not null,
  verdict text,
  checked_at timestamptz not null default now()
);

-- Server-only: written and read exclusively by the service-role send path.
alter table public.email_lookup enable row level security;
