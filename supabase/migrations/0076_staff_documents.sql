-- 0076_staff_documents.sql
-- The staff document vault: the employee file's paperwork. Right to work, passport,
-- DBS, GDC registration, indemnity, qualifications, the signed contract, training
-- certificates. What CQC asks for by name, in one place, with an expiry date on the
-- ones that expire.
--
-- METADATA ONLY. The BYTES live in the private Storage bucket `staff-docs`, never in
-- Postgres. This row holds the reference, the practice's own label, the MIME type and
-- size we validated at upload, and the expiry. `storage_path` is generated
-- server-side from a random token and a sanitised leaf name (see lib/hr/documents.ts
-- safeDocPath) — the uploader's filename is never trusted for anything structural.
--
-- THE BUCKET IS NOT CREATED HERE, AND CANNOT BE. A migration cannot create a Storage
-- bucket. The `onboarding` bucket was created out of band with no record anywhere,
-- and a fresh environment therefore fails at first upload with an opaque message. So
-- this one is recorded in three places instead: the settings integration-status panel
-- names it and says whether it is reachable, .env.example carries a note, and the
-- orchestrator creates it as a checked-in integration step. `staff-docs` is SEPARATE
-- from `onboarding` deliberately: the tenancy prefix guard is per-bucket, and the
-- audiences are different people (patients vs employees).
--
-- SENSITIVITY. A passport scan, a right-to-work check and a DBS certificate are
-- employee personal data under UK GDPR, and some of it is identity-document grade.
-- POST-0012 LOCKED POSTURE, matching 0067 (absence), 0068 (clocking) and 0071
-- (FP17): RLS is ENABLED with NO policy and NO grant to anon/authenticated. Every
-- read and write goes through the service-role client behind
-- requireUser -> requireClientAccess -> requireModuleApiAccess("staff-hr") -> a role
-- guard. Files are only ever served as a 120-second signed URL; `getPublicUrl`
-- appears nowhere in this codebase and must stay that way.
--
-- THE FK IS COMPOSITE, the 0031 lesson (0067:11-16, 0068:73-77 precedent). A bare
-- `staff_id references rota_staff (id)` is NOT tenant-scoped: a row could point at
-- another practice's staff member while carrying our own client_id. The composite
-- (client_id, staff_id) -> rota_staff (client_id, id) makes the tenant boundary a
-- schema guarantee rather than an application convention. It depends on the
-- `rota_staff_client_id_id_key` unique added by 0031_rota_tenant_hardening.sql:19.
--
-- NOT YET APPLIED. Written for the orchestrator to apply. Nothing in the app may
-- assume this table exists yet — every read degrades to "not ready" on a missing
-- relation and the surface says so in plain words rather than showing an empty vault.
--
-- British English throughout. No NHS vs private framing. No dash characters in copy.

create table if not exists staff_document (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  staff_id uuid not null,

  -- A CLOSED list. "other" exists so a practice is never forced to mislabel a file,
  -- but every kind that carries a compliance meaning is named, because
  -- `documentsMissing` in lib/hr/documents.ts answers "what is this person missing"
  -- from these values and a free-text kind would make that question unanswerable.
  kind text not null check (kind in (
    'passport',
    'right-to-work',
    'gdc-registration',
    'dbs',
    'indemnity',
    'qualification',
    'contract',
    'training-certificate',
    'other'
  )),
  -- The practice's own words for this file ("DBS certificate 2026"). Shown in the
  -- vault list; never used to build the storage path.
  label text not null,

  -- staff-docs/<clientSlug>/<staffId>/<uuid>/<safeName>. Generated server-side:
  -- the random token directory makes the path unguessable, and the leaf is forced to
  -- the extension of the VALIDATED content-type, so a file called
  -- "cv.pdf.exe" is stored as "cv.pdf".
  storage_path text not null,
  -- The content-type we validated against the allow-list at upload, and the size we
  -- measured after parsing the body (not the declared Content-Length).
  mime text not null,
  size_bytes int not null check (size_bytes > 0),

  -- Indemnity, DBS and GDC registration all expire, and an inspector asks about the
  -- expired ones. Nullable: a passport scan filed as evidence may have no expiry the
  -- practice wants tracked, and `expiryState` answers "no-expiry" for those rather
  -- than pretending they are valid forever.
  expires_on date,

  -- DOCUMENTED RETENTION, NOT ENFORCED (campaign 6 decision 10). Employee documents
  -- should not outlive employment by more than the statutory window, and the practice
  -- needs that in their ROPA. Nothing in v1 deletes on this date: it is recorded, it
  -- is displayed, and a person decides. An automatic deleter that quietly destroyed a
  -- right-to-work check would be far worse than a date nobody actioned.
  retain_until date,

  uploaded_by uuid references app_user (id) on delete set null,
  created_at timestamptz default now(),

  constraint staff_document_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade
);

-- The vault list is always "this client, this person".
create index if not exists idx_staff_document_client_staff
  on staff_document (client_id, staff_id);
-- "What expires in the next 90 days across the practice" is the compliance question,
-- so the expiry sweep is client + date, not per person.
create index if not exists idx_staff_document_expiry
  on staff_document (client_id, expires_on);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0067 /
-- 0068 / 0071). There is deliberately no policy: nothing should reach this table
-- except the service-role client behind the API guards.
alter table staff_document enable row level security;
revoke all on staff_document from anon, authenticated;
