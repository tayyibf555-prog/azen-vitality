-- 0028_onboarding_config.sql
-- Onboarding form CONFIG: the per-practice configuration that makes the public
-- new-patient onboarding form (/onboard/<client>) configurable. The owner (or a
-- coordinator) picks which pre-loaded library questions to include, marks which are
-- required, and adds their own custom questions. The public form reads this config and
-- resolves it into the steps it renders; the submit endpoint validates answers against
-- the same resolved steps.
--
-- One row per client. `config` is the whole OnboardingConfig as jsonb:
--   {
--     "enabledKeys": [ "first_name", ... ],         -- library question keys switched on
--     "required":    { "date_of_birth": true, ... },-- required overrides by key
--     "custom":      [ { key, label, type, options?, required, category }, ... ]
--   }
-- A missing row means "use the default flow" (the library's default-enabled questions).
--
-- Created in the POST-0012 locked posture: RLS enabled, NO grants/policies for
-- anon/authenticated (0012 revoked those across the schema; 0013 / 0018 / 0026 / 0027
-- follow the same shape). All access is server-only via the service-role client: the
-- public form reads the config server-side, and the management API is requireUser +
-- client-scoped.

create table if not exists onboarding_config (
  client_id text primary key,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0027).
alter table onboarding_config enable row level security;
