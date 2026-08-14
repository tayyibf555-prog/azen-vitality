-- 0071_fp17_declaration.sql
-- NHS FP17 / PR consent + exemption declaration.
--
-- A patient-facing, tokenised, no-auth form captures the patient's consent to a
-- course of NHS treatment (the FRONT) and their NHS dental exemption declaration
-- (the BACK: one exemption category, or the "paying" opt-out, plus an evidence
-- acknowledgement, a declaration-truth tick and a signature). One row per completed
-- declaration.
--
-- THIS IS OUR OWN STORAGE. No Dentally endpoint exists for any of it (/v1/consents,
-- /v1/forms, /v1/nhs_exemptions, /v1/fp17s are all unmounted). It is NOT submitted
-- to the NHS (Compass) from here — /v1/nhs_claims is read for reporting only and is
-- not a submission path. Every UI surface says so in plain words.
--
-- SENSITIVITY. The signature (a typed name or a drawn/iPad data-URL) is patient
-- identifying data, and the exemption category can imply a patient's benefit status.
-- So this follows the POST-0012 locked posture (matches 0027 onboarding / 0041
-- outreach): RLS is ENABLED with NO policy/grant to anon/authenticated. All access is
-- server-only via the service-role client: the public submit endpoint validates +
-- kill-switches + rate-limits + budgets before writing; the internal list endpoint is
-- requireUser + client-scoped + module-guarded.
--
-- SEPARATE from onboarding's `medical` jsonb ON PURPOSE: onboarding captures free-text
-- medical intake; an FP17 consent/exemption declaration is a distinct legal artefact
-- and must never be conflated with intake notes.

create table if not exists fp17_declaration (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- The site whose patient this is, resolved from the signed link TOKEN, not the
  -- request body. Nullable for a generic (non-patient-bound) link.
  site_id text,
  -- The Dentally patient id, ALSO resolved from the token, never from the body.
  dentally_patient_id text,
  -- Identity the patient typed, for staff to match the record. Not authoritative.
  patient_name text,
  date_of_birth text,

  -- FRONT: consent. { treatment: bool, dataShare: bool, signedAt: text|null }
  consent jsonb,

  -- BACK: exemption declaration.
  -- One key from src/lib/fp17/exemptions.ts (a free-treatment claim) or the literal
  -- 'paying' opt-out. NOT NULL so a blank form can never be stored as exempt.
  exemption_category text not null,
  -- The penalty-charge / evidence acknowledgement. Required true for an exemption
  -- claim (enforced in validate.ts); false for the 'paying' opt-out.
  exemption_evidence_ack boolean not null default false,
  -- "The information I have given is correct." Required true (enforced in validate.ts).
  declaration_truth boolean not null,
  -- { method: 'typed'|'drawn'|'ipad', value, signedAt }. Never a public bucket URL —
  -- the value stays in this RLS-locked table and the list endpoint never returns it.
  signature jsonb,

  captured_via text check (captured_via in ('public-link', 'ipad')),
  status text not null default 'new' check (status in ('new', 'reviewed', 'archived')),
  created_at timestamptz not null default now()
);

-- Newest-first worklist for a client.
create index if not exists idx_fp17_client_created
  on fp17_declaration (client_id, created_at desc);
-- Filter the worklist / badge by status.
create index if not exists idx_fp17_client_status
  on fp17_declaration (client_id, status);

-- ---------------------------------------------------------------------------
-- Kill-switch seed — SHIP GATED OFF (perio precedent). system_toggle is DEFAULT-ON
-- by absence of a row, so without this seed the public form would be live the moment
-- the code ships. This is a clinical/records declaration feature whose wording must
-- be signed off before switch-on, so it must ship DORMANT: the owner turns it on from
-- System controls when the practice is ready. do-nothing on conflict so re-running the
-- migration never re-arms a switch the owner has since toggled.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled)
values ('vitality', 'fp17', false)
on conflict (client_id, module_slug) do nothing;

-- Server-only, matching 0027 / 0041: RLS on, no policies/grants.
alter table fp17_declaration enable row level security;
revoke all on fp17_declaration from anon, authenticated;
