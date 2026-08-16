-- 0083_assess_meta_pixel.sql
-- META PIXEL + CONVERSIONS API: one row per practice saying whether the public
-- assessment pages report conversions to Meta, and to which dataset.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- Same reason as 0078, 0079, 0081 and 0082, and no other: this repo's convention
-- is that a migration file is written by the build and applied by a human who has
-- read it. Do not apply this file to demonstrate the feature. What makes that safe
-- is the second half of this header.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE, AND SWITCHES NOTHING ON. One new table,
-- empty. No column is added to an existing table, nothing is backfilled, nothing
-- is seeded, and no existing row is read differently afterwards. A practice has no
-- tracking until an owner switches it on and types a pixel id in, and `enabled`
-- defaults to false so even a row inserted by hand is inert until somebody means
-- it.
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS — in both directions:
--
--   READS   resolveMetaPixel (src/lib/assess/meta-pixel-repository.ts) recognises
--           "no such table" and answers META_PIXEL_OFF. The public /assess pages
--           render byte-for-byte what they render today: no pixel, no consent
--           prompt, no third-party request, and the submit route sends no event.
--   WRITES  the settings route reports the missing table as a 503 NAMING THIS
--           FILE, exactly as 0081's theme routes do. Here the setting IS the
--           request, so silently succeeding at nothing would be a lie.
--
-- So the deploy order is free: the code can ship first and nothing changes until
-- someone applies this and an owner then switches tracking on.
-- ============================================================================
--
-- WHAT IS DELIBERATELY *NOT* IN THIS TABLE: the Conversions API access token.
--
-- It is a bearer credential over a practice's ad dataset, and it is read from the
-- environment (META_CAPI_ACCESS_TOKEN) inside a server-only module, exactly as the
-- rest of the Meta credentials already are (src/lib/meta-ads/connection.ts). Three
-- consequences follow, and all three are the point:
--
--   * it is not in a row, so it is not in a backup, a CSV export, a support query
--     or a `select *` on somebody's screen;
--   * it has no field on MetaPixelConfig, so there is no object anywhere in the
--     tree that could carry it to a browser by accident; and
--   * rotating it is an environment change, not a database write.
--
-- The COST of that choice is stated rather than hidden: one token per deployment,
-- so a multi-practice deployment shares one Meta system user. That is what the
-- platform does today for the ad account itself, and moving to per-practice tokens
-- is a credential-storage decision (encryption at rest, rotation, who may read it)
-- that deserves its own migration rather than being smuggled in beside a boolean.
--
-- WHY THE PIXEL ID IS STORED WHEN THE TOKEN IS NOT. It is not a secret: it is
-- printed into the page for anyone to read, it is what identifies the dataset, and
-- it differs per practice. It is also validated on the way IN (digits only, 8-20)
-- and AGAIN on the way OUT, before it reaches a <script> body or a URL path, by
-- the same `normalisePixelId` in src/lib/assess/meta-pixel.ts. A hand-edited row
-- therefore cannot inject script: the worst it can do is fail the read-back and
-- switch tracking off.
--
-- WHY NO CHECK CONSTRAINT ON `pixel_id`. The same call 0059 made about `goal`,
-- 0078 about `flow`, 0079 about `theme` and 0081 about `vars`: the grammar lives
-- in one place, in TypeScript, with a test. A second, weaker copy expressed as a
-- CHECK would only ever drift from the real one.

create table if not exists client_meta_pixel (
  id                 uuid primary key default gen_random_uuid(),
  -- SOFT reference, like every other client_id in this schema: practices are
  -- configuration (src/lib/mock/clients.ts), not a table.
  --
  -- UNIQUE, because this is a setting and not a list. One practice has one answer
  -- to "do we report conversions to Meta"; two rows would be two answers, and the
  -- reader would have to invent a tie-break nobody chose.
  client_id          text not null unique,
  -- OFF, and the default is the whole safety story. A row that exists for any
  -- reason at all -- a partial write, a restored backup, a hand insert -- tracks
  -- nobody until this is explicitly true.
  enabled            boolean not null default false,
  -- The Meta pixel / dataset id: digits only, validated in TypeScript both ways.
  -- Nullable, because "switched off and not yet configured" is the state every
  -- practice starts in.
  pixel_id           text,
  -- May a CONSENTING submitter's hashed email/phone ride along on the server-side
  -- event? A SECOND switch, defaulting off, because it is a second decision:
  -- reporting that a conversion happened and disclosing who it was are not the
  -- same act. Both this AND the visitor's own on-device consent are required
  -- before a single hash leaves (src/lib/assess/meta-capi.ts, capiUserData).
  advanced_matching  boolean not null default false,
  -- Who last changed it. Text rather than a uuid FK, matching created_by on
  -- smile_assessment_campaign (0018), onboarding_form (0032) and client_theme
  -- (0081). This one is worth having: switching tracking on is a decision a
  -- practice may later have to account for to its own regulator.
  updated_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The settings screen and the public page both look this up by practice, always.
-- (The unique constraint above already provides the index; this is not repeated.)

-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (which bypasses RLS), consistent with
-- 0018/0032/0034/0072/0081. The read is owner-gated at the API layer; the public
-- page reads it through the service-role client on the server and sends only the
-- pixel id to the browser.
alter table client_meta_pixel enable row level security;
revoke all on client_meta_pixel from anon, authenticated;

-- NO SEED. Running this switches tracking on for nobody. The first pixel is an act
-- an owner performs on purpose, in the Meta Ads section, and every visitor it
-- affects is still asked before a single byte goes to Meta.
