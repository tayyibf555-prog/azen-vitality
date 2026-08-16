-- 0081_assessment_custom_theme.sql
-- YOUR THEMES: colour schemes a practice defines for itself, alongside the seven
-- named ones in src/lib/assess/palette.ts.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- Same reason as 0078 and 0079, and no other: this repo's convention is that a
-- migration file is written by the build and applied by a human who has read it.
-- Do not apply this file to demonstrate the feature. What makes that safe is the
-- second half of this header.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. One new table, empty. No column is
-- added to an existing table, nothing is backfilled, nothing is seeded, and no
-- existing row is read differently afterwards. A practice has no custom themes
-- until an owner builds one on purpose, and until then every picker shows exactly
-- the seven presets it shows today.
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS — in both directions:
--
--   READS   listCustomThemes / resolveCustomTheme
--           (src/lib/assess/custom-theme-repository.ts) recognise "no such table"
--           and answer with an empty list / null. The picker shows the presets and
--           no "Your themes" group; the public page falls through to paletteVars,
--           which is byte-for-byte what it renders today.
--   WRITES  the create/rename/delete routes report the missing table as a 503
--           NAMING THIS FILE, exactly as 0079's setCampaignTheme does. Here the
--           theme IS the request, so silently succeeding at nothing would be a lie.
--
-- So the deploy order is free: the code can ship first and nothing changes until
-- someone applies this and an owner then builds a theme.
-- ============================================================================
--
-- WHY THE COLOURS THEMSELVES ARE STORED HERE, WHEN 0079 DELIBERATELY DID NOT.
--
-- 0079 stores a KEY ('landing-blue'), not eighteen hex values, and its header
-- explains why: a palette can be corrected without a backfill, a brand tweak
-- reaches every campaign that never chose a scheme, and nothing arbitrary is ever
-- read out of the database and injected into a public page's style attribute.
--
-- The first two arguments do not transfer — there is no catalogue entry to correct
-- and no brand to track, because these colours ARE the practice's own decision. The
-- THIRD one does transfer, completely, and it is answered rather than dropped:
--
--   * every value is validated on the way IN against a strict colour grammar
--     (hex or rgb()/rgba() only, anchored) plus a server-side WCAG AA gate, in
--     src/lib/assess/custom-theme.ts;
--   * every value is validated AGAIN on the way OUT, on the public page, before a
--     single character reaches the stylesheet (readbackVars);
--   * and the renderer iterates the closed PALETTE_TOKENS list, never the row's own
--     keys, so a row carrying an unexpected key cannot put an unexpected custom
--     property into the page.
--
-- A hand-edited row therefore cannot inject CSS; the worst it can do is fail the
-- read-back and render the shipped default look.
--
-- WHY NO CHECK CONSTRAINT ON `vars`. The same call 0059 made about `goal`, 0078
-- about `flow` and 0079 about `theme`: the shape and the AA thresholds live in one
-- place, in TypeScript, with a test each. A second, weaker copy expressed as a
-- CHECK would only ever drift from the real one — and would turn tightening the
-- contrast bar into a migration.
--
-- WHY THE CAMPAIGN'S REFERENCE IS NOT A FOREIGN KEY.
--
-- smile_assessment_campaign.theme is a text column holding either a preset key
-- ('deep-plum') or a reference to a row here ('custom:<uuid>'). One column cannot
-- be a foreign key to a table for some of its values and a free key for others, so
-- the link is SOFT — the house pattern for client_id everywhere else in this
-- schema. Two things make that safe rather than sloppy:
--   1. deleting a theme that a campaign is using is REFUSED at the API layer, with
--      the campaigns named (theme/[id]/route.ts), so the dangling reference is not
--      supposed to happen; and
--   2. if one exists anyway, the public page falls back to the shipped default
--      rather than failing — the same fallback paletteFor already makes for a
--      retired preset key.

create table if not exists client_theme (
  id          uuid primary key default gen_random_uuid(),
  -- SOFT reference, like every other client_id in this schema: practices are
  -- configuration (src/lib/mock/clients.ts), not a table.
  client_id   text not null,
  -- The owner's own label for the scheme. INTERNAL: it appears in their picker and
  -- is never rendered on a public page, so it is not patient-facing copy.
  name        text not null,
  -- The complete token map: { "cream": "#...", "navy": "#...", ... }, exactly the
  -- closed PALETTE_TOKENS set. Deliberately unconstrained here (see above).
  vars        jsonb not null,
  -- Who built it. Text rather than a uuid FK, matching created_by on
  -- smile_assessment_campaign (0018) and onboarding_form (0032).
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- No two themes in one practice share a name: the picker shows names alone, and
  -- two identical entries would be a control an owner cannot use.
  unique (client_id, name)
);

-- The picker and every write scope by practice, always.
create index if not exists idx_client_theme_client on client_theme (client_id, created_at desc);

-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (which bypasses RLS), consistent with
-- 0018/0032/0034/0072. Reads and writes are owner/manager-gated at the API layer,
-- not here.
alter table client_theme enable row level security;
revoke all on client_theme from anon, authenticated;

-- NO SEED. Running this gives nobody a new colour. The first custom theme is an
-- act an owner performs on purpose, in the builder, and it has to clear the same
-- WCAG AA bar the five tuned presets clear before it can be stored at all.
