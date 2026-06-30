-- 0029_onboarding_custom.sql
-- Persist answers to a practice's own custom onboarding questions.
--
-- The form builder (0028) lets a practice add custom questions, keyed custom-<kebab>.
-- Until now the public submit route mapped only the library answers into their
-- dedicated columns/jsonb and dropped anything keyed custom-. This adds a `custom`
-- jsonb group on onboarding_submission so custom answers are stored alongside the
-- library ones, keyed by their custom- key. Validated upstream against the practice's
-- resolved form, so only questions the patient was actually shown can land here.
--
-- Idempotent and additive: a plain jsonb column, nullable (null = no custom answers),
-- no default needed. RLS posture is inherited from 0027 (server-only, no grants).

alter table onboarding_submission
  add column if not exists custom jsonb;
