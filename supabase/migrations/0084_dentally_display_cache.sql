-- 0084_dentally_display_cache.sql
-- CROSS-INSTANCE DISPLAY CACHE: one row per (practice, read) holding the computed
-- result of an EXPENSIVE, LIVE Dentally DISPLAY read, so that a cold serverless
-- instance can serve it from here instead of re-paging Dentally.
--
-- ============================================================================
-- WHY THIS EXISTS.
--
-- src/lib/dentally/read.ts already has an in-process Map cache (cachedRead, 60s)
-- in front of the display reads (listPatients / listAppointments / listOutstanding
-- / getPatientDetail / the diary's appointments+practitioners+availability). It
-- turns REPEAT reads on ONE warm instance into instant hits. But Fluid Compute
-- runs many instances, each with its OWN Map: a navigation that lands on a cold
-- instance re-pages the whole book, and a tab walk across a few cold instances can
-- burn a real slice of the 3,600 requests/hour Dentally rate budget. This table is
-- the SHARED layer the per-instance Map sits in front of: the first instance to
-- compute a read writes the result here; every other instance, cold or warm, reads
-- it back and calls Dentally zero times until the row expires.
--
-- WHAT IS AND IS NOT ALLOWED IN HERE. DISPLAY reads only. The three reads that must
-- always reflect this exact second -- online-booking AVAILABILITY, the 24/7 SYNC /
-- backfill, and the read-back that CONFIRMS a write actually landed -- deliberately
-- do NOT go through cachedRead and so never touch this table (they use the raw
-- DentallyClient, or pass their own client via opts.client). Serving any of those
-- from a 60-second-old blob would be a correctness bug, not a slow page.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- Same convention as 0062, 0078-0083: a migration file is written by the build and
-- applied by a human who has read it. Do not apply this file to demonstrate the
-- feature.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. One new table, empty. No column is added
-- to an existing table, nothing is backfilled or seeded, and no existing row is read
-- differently afterwards. It only ever holds a COPY of data Dentally already served,
-- with an expiry; deleting every row at any moment costs one slow page, never a
-- wrong answer.
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS. The cache layer FAILS OPEN: a
-- missing table, a permissions error or any Supabase blip is treated as a cache
-- MISS, so read.ts computes the value live exactly as it does today and simply does
-- not get the cross-instance speed-up. A cache is a performance optimisation and is
-- never a correctness dependency -- so the deploy order is free.
-- ============================================================================

create table if not exists dentally_display_cache (
  -- TENANCY BOUNDARY. Soft reference, like every other client_id in this schema:
  -- practices are configuration (src/lib/mock/clients.ts), not a table. It is part
  -- of the PRIMARY KEY *and* every read filters on it, so a read issued for one
  -- practice can never be answered with another practice's cached blob: a different
  -- client_id is a different row the WHERE clause never selects.
  client_id   text not null,
  -- The read's identity: the read type plus its parameters (the sorted site set and
  -- any range), e.g. 'appts:site-cc|site-ng::' or 'outstanding:site-cc'. Built in
  -- one place (src/lib/dentally/read.ts) and never contains the client_id -- the
  -- column above carries tenancy, so two practices asking the "same" read still land
  -- on two different rows.
  cache_key   text not null,
  -- The computed read result, JSON-serialised. Every shape stored here is JSON-safe
  -- by construction (ISO date STRINGS, numbers, booleans, null -- no Date objects,
  -- no undefined), and a round-trip test pins each one so a future field that would
  -- not survive jsonb (a real Date, say) fails the suite instead of silently
  -- deserialising to the wrong type.
  value       jsonb not null,
  -- When the value was computed and when it stops being served. expires_at is
  -- computed_at + the per-read TTL (60s for most, 30s for patient search / detail,
  -- 5m for the headline patient count) so different reads can age at different
  -- rates in the same table. Readers select on expires_at > now(); a background
  -- deletion of expired rows is optional housekeeping, not correctness.
  computed_at timestamptz not null default now(),
  expires_at  timestamptz not null,

  primary key (client_id, cache_key)
);

-- The reader's access pattern is an exact PK lookup with a freshness predicate; the
-- PK already indexes (client_id, cache_key). This partial index only serves the
-- optional sweep that reclaims expired rows, kept cheap by excluding live ones is
-- not possible with now() (not immutable), so it is a plain index on expires_at.
create index if not exists idx_dentally_display_cache_expires
  on dentally_display_cache (expires_at);

-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (which bypasses RLS), consistent with
-- 0018/0032/0034/0062/0072/0081/0083. Nothing here is written by, or readable from,
-- the browser. The cached blobs can contain patient-identifying display data (names,
-- appointment times), so the browser anon key must be able to neither read nor write
-- this table -- exactly what "RLS on, no policies" gives.
alter table dentally_display_cache enable row level security;
revoke all on dentally_display_cache from anon, authenticated;

-- NO SEED. The first row appears the first time a display read is computed against a
-- live Dentally; until then, and if this is never applied, the app behaves exactly
-- as it does today.
