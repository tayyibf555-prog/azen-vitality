-- 0075_staff_hr_profile.sql
-- The employee file: non-pay HR facts, and pay rates kept deliberately apart.
--
-- ---------------------------------------------------------------------------
-- WHY PAY IS NOT A COLUMN ON rota_staff.
-- ---------------------------------------------------------------------------
-- The obvious shape is `alter table rota_staff add column hourly_pence int`. It
-- leaks on the day it is added, with no further code change and no review:
--   * lib/rota/repository.ts:56 reads `select("*")` and rowToStaff maps every
--     column it is given;
--   * GET /api/rota/staff returns that array wholesale to the browser;
--   * GET /api/absence returns the SAME staff array to the browser as well.
-- So one column would ship every person's pay to every owner and practice
-- manager through two endpoints nobody would think to re-read. A separate table
-- cannot be reached by accident: a query has to name it.
--
-- The practice's own requirement is the reason this matters. The assistant
-- manager runs the rota, the holiday and the month's hours, and must NOT see
-- what individuals are paid. That is expressed here as a table she is never
-- queried for, and in src/lib/hr/access.ts as fields OMITTED from the server
-- response, never as a column hidden in the browser.
--
-- ---------------------------------------------------------------------------
-- WHY RATES ARE APPENDED, NEVER UPDATED.
-- ---------------------------------------------------------------------------
-- staff_pay_rate is effective-dated and append-only by convention: a pay rise is
-- a NEW ROW with a new effective_from, not an edit of the old one. Updating in
-- place would silently re-price every hour already worked at the old rate, and
-- the previous rate (which somebody was actually paid) would be gone. The month
-- report prices each DAY at the rate in force on that day
-- (src/lib/hours/cost.ts), which is only possible because the history survives.
--
-- Money is INTEGER PENCE. Never a float, never pounds: 0.1 + 0.2 is not 0.3 and
-- an hourly rate multiplied by minutes is exactly where that shows up.
--
-- ---------------------------------------------------------------------------
-- DATA PROTECTION.
-- ---------------------------------------------------------------------------
-- Date of birth, home address, emergency contacts and an NI fragment are
-- employee personal data under UK GDPR. Two deliberate limits are in the schema
-- itself: only the LAST FOUR characters of the National Insurance number are
-- storable (enough to reconcile a payroll export, useless on its own), and there
-- is no passport or right-to-work document here at all (documents live in
-- 0076_staff_documents.sql, metadata only, bytes in private storage). The
-- practice still owes this data a retention period and a ROPA entry; the
-- platform does not enforce one.
--
-- Created in the POST-0012 locked posture: RLS enabled, NO grants or policies to
-- anon/authenticated (0012 revoked those across the schema), and an explicit
-- `revoke all` for the avoidance of doubt. Every read and write is server-only
-- via the service-role client, exactly like 0030 (rota), 0067 (absence) and
-- 0068 (clocking).
--
-- Both tenant FKs are COMPOSITE, the 0031 lesson: a bare
-- `staff_id references rota_staff (id)` is not tenant-scoped, so a row could
-- point at another practice's staff member while carrying our own client_id.
-- (client_id, staff_id) -> rota_staff (client_id, id) makes the tenant boundary
-- a schema guarantee. It depends on the rota_staff_client_id_id_key unique added
-- by 0031_rota_tenant_hardening.sql:19.
--
-- NOT APPLIED BY THIS BUILDER. Written only; the orchestrator applies it. Every
-- read in src/lib/hr/repository.ts degrades to "Staff HR is not set up on this
-- database yet" while it is unapplied, so nothing renders an empty file as
-- though the practice had no staff records.
--
-- British English throughout. No dash characters in copy.

-- ---------------------------------------------------------------------------
-- 1) The non-pay employee file. One row per staff member, hence the composite
--    primary key rather than a surrogate id: a person has one HR file.
-- ---------------------------------------------------------------------------
create table if not exists staff_hr_profile (
  client_id text not null,
  staff_id uuid not null,

  -- Contact and personal. All nullable: a practice fills this in over time and a
  -- half-complete file is the normal state, not an error.
  date_of_birth date,
  personal_email text,
  personal_phone text,
  address jsonb,                                 -- {line1, line2, town, postcode}
  emergency_contact jsonb,                       -- {name, relationship, phone}

  -- Employment.
  employment_start date,
  employment_end date,

  -- Holiday entitlement inputs. The default derivation counts the weekdays marked
  -- true on rota_staff.availability (the same map the absence rules use, so the
  -- two modules cannot disagree). These two columns are the overrides:
  --   contracted_days_per_week overrides the availability-derived count;
  --   entitlement_days_override overrides the computed entitlement outright.
  -- Both exist because the statutory formula is DECISION SUPPORT, not a legal
  -- answer: irregular-hours and part-year workers have their own rules, and the
  -- manager must always be able to have the last word.
  contracted_days_per_week numeric(3,1)
    check (contracted_days_per_week is null
           or (contracted_days_per_week >= 0 and contracted_days_per_week <= 7)),
  entitlement_days_override numeric(4,1)
    check (entitlement_days_override is null or entitlement_days_override >= 0),

  -- The leave year is configurable because practices differ; April is the common
  -- UK default and matches the tax year.
  leave_year_start_month int not null default 4
    check (leave_year_start_month between 1 and 12),

  -- Professional registration, and the NI FRAGMENT only (see the note above).
  gdc_number text,
  ni_number_last4 text check (ni_number_last4 is null or length(ni_number_last4) <= 4),

  updated_by uuid references app_user (id) on delete set null,
  updated_at timestamptz not null default now(),

  primary key (client_id, staff_id),
  constraint staff_hr_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade,
  constraint staff_hr_employment_dates_ordered
    check (employment_end is null or employment_start is null or employment_end >= employment_start)
);

-- The HR list reads one client's whole file set in one query.
create index if not exists idx_staff_hr_profile_client
  on staff_hr_profile (client_id);

-- ---------------------------------------------------------------------------
-- 2) Pay rates. SENSITIVE, effective-dated, and a separate table on purpose.
--
-- effective_to is nullable and usually stays null: appending a later row is how a
-- rise is recorded, and src/lib/hours/cost.ts resolves a day by taking the row
-- with the LATEST effective_from that still covers it. Closing the old row is
-- allowed (and then honoured) but never required, so a correct rate history
-- cannot depend on somebody remembering to close a row.
-- ---------------------------------------------------------------------------
create table if not exists staff_pay_rate (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  staff_id uuid not null,

  -- INTEGER PENCE per hour. 1 250 = twelve pounds fifty an hour.
  hourly_pence int not null check (hourly_pence >= 0),

  effective_from date not null,
  effective_to date,                             -- inclusive last day, or null = open

  note text,
  set_by uuid references app_user (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint staff_pay_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade,
  constraint staff_pay_dates_ordered
    check (effective_to is null or effective_to >= effective_from)
);

-- The month report reads every rate for a set of staff and resolves per day, so
-- the read is (client, staff, from) and wants them in date order.
create index if not exists idx_staff_pay_rate_client_staff
  on staff_pay_rate (client_id, staff_id, effective_from);

-- Two rows for the same person starting on the same day are ambiguous: the
-- per-day resolution would have to pick one arbitrarily, and a pay figure decided
-- by row order is worse than an error. A correction is a row with a LATER
-- effective_from, or a deliberate close of the old row.
create unique index if not exists uniq_staff_pay_rate_client_staff_from
  on staff_pay_rate (client_id, staff_id, effective_from);

-- ---------------------------------------------------------------------------
-- 3) Server-only posture.
-- ---------------------------------------------------------------------------
alter table staff_hr_profile enable row level security;
alter table staff_pay_rate enable row level security;

revoke all on staff_hr_profile from anon, authenticated;
revoke all on staff_pay_rate from anon, authenticated;

-- NO SEED. 0030 seeds rota_staff and 0067 seeds absences so those modules demo
-- with data; pay rates and dates of birth are not something to invent, even for a
-- demo, and a seeded rate would read as a real one to whoever opened the screen.
-- The surfaces state plainly that no rate is recorded rather than showing a zero.
