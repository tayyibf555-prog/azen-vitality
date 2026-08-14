-- 0072_user_capability.sql
-- Per-person GRANT/REVOKE on top of the role's default capability set.
--
-- SEMANTICS: the ABSENCE of a row means "ask the role". A row with granted=true
-- is an explicit GRANT, granted=false an explicit REVOKE. Shipping this table
-- therefore changes nothing at all until somebody ticks a box -- the same
-- default-inert posture as 0034_system_toggle.sql (whose "absence = enabled" this
-- mirrors in spirit, not in value: here absence means "ask the role", not "yes").
--
-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (which bypasses RLS), consistent
-- with 0034/0067/0068/0071. Reads and writes are owner-gated at the API layer,
-- not here.
--
-- ---------------------------------------------------------------------------
-- THE FOREIGN KEY IS COMPOSITE, AND THAT IS THE 0031 LESSON.
-- ---------------------------------------------------------------------------
-- A bare `app_user_id references app_user (id)` is NOT tenant-scoped: a row could
-- carry client_id 'vitality' while pointing at another practice's login, and
-- nothing in the schema would object. 0031_rota_tenant_hardening.sql fixed
-- exactly this shape on the rota tables, and the reasoning is the same here --
-- application filters are a control, not a boundary. The composite
-- (client_id, app_user_id) -> app_user (client_id, id) makes the tenant boundary
-- a schema guarantee. It needs the composite unique added in step 1, mirroring
-- 0031's step 1 on rota_staff.
--
-- A CONSEQUENCE, AND IT IS INTENDED: app_user.client_id is NULL for agency_admin
-- (0011_app_user.sql:14), and a NULL can never satisfy this FK. So an agency_admin
-- can never receive an override row. The platform administrator is not something
-- a practice may edit, and that is now enforced by the schema rather than by a
-- check somebody could forget. src/lib/capabilities/repository.ts short-circuits
-- for them rather than issuing a query that must return nothing.
--
-- NO SEED. Nobody gains or loses a single permission by running this migration
-- (0069's and 0073's posture). Everything the practice can do today, they can do
-- after it, until an owner decides otherwise on the People & logins screen.

-- 1) Composite unique on app_user so it can be an FK target (mirrors 0031:19-20).
--    Additive: (client_id, id) is unique for free given id is already the primary
--    key, so this constrains nothing new and only makes the pair referenceable.
alter table app_user drop constraint if exists app_user_client_id_id_key;
alter table app_user add constraint app_user_client_id_id_key unique (client_id, id);

create table if not exists user_capability (
  client_id   text not null,
  app_user_id uuid not null,
  -- Matches a key in src/lib/capabilities/keys.ts. Deliberately NOT a CHECK
  -- constraint: the catalog is versioned in TypeScript and a key retired there
  -- must fail SAFE (resolveCapabilities ignores an unknown key, so a stale row
  -- stops doing anything) rather than block a deploy on a constraint violation.
  capability  text not null,
  granted     boolean not null,          -- true = GRANT, false = REVOKE
  updated_at  timestamptz not null default now(),
  -- WHO decided. This is the audit trail the practice needs when the question is
  -- later "who let Sarah retract a clinical record". `on delete set null` keeps
  -- the decision readable after the decider's own login is removed (0067's
  -- reasoning): the fact that somebody authorised it does not stop being true.
  updated_by  uuid references app_user (id) on delete set null,
  primary key (client_id, app_user_id, capability),
  constraint user_capability_client_user_fkey
    foreign key (client_id, app_user_id) references app_user (client_id, id) on delete cascade
);

-- The grid reads one practice's whole overlay; the guard reads one person's.
create index if not exists idx_user_capability_client on user_capability (client_id);
create index if not exists idx_user_capability_user on user_capability (client_id, app_user_id);

alter table user_capability enable row level security;
revoke all on user_capability from anon, authenticated;
