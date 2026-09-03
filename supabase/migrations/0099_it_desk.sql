-- 0099_it_desk.sql
-- The IT desk agent: the practice's named IT contact.
--
-- ===========================================================================
-- ONE TABLE, AND THE REASON THERE IS ONLY ONE.
--
-- The IT desk's KNOWLEDGE ships as source, not as rows: the five front-desk
-- playbooks (internet, printers, logins, Dentally access, iPads and form kiosks)
-- live in src/lib/itdesk/playbooks.ts. That is the same arrangement the
-- compliance module uses for the CQC framework (src/lib/compliance/knowledge.ts),
-- and for the same reason: knowledge that is true of every UK dental practice
-- belongs with the product, where it is versioned, reviewable and diffable, and
-- where improving it improves it for everyone rather than for whoever typed it
-- into one database.
--
-- PRACTICE-SPECIFIC playbooks — their broadband, their printer model, their own
-- "if the card machine drops, do this" — are a real and obvious next step, and
-- there is deliberately NO table for them yet. They are an OWNER-DEPENDENT item
-- (programme charter §3): we do not know what the practice's own procedures are
-- until the practice tells us, and shipping an empty editor invites somebody to
-- invent them. A table with no honest content is worse than no table.
--
-- ===========================================================================
-- WHAT THIS MODULE STRUCTURALLY CANNOT DO, and why there is no column for it.
--
--   NO CREDENTIALS. Nothing in this schema stores a password, a PIN, a Wi-Fi
--   key or a recovery code, and nothing ever should. The agent refuses to read
--   one out, set one, or be told one (src/lib/itdesk/topic-gate.ts), so there is
--   nothing for a column to hold. A practice that wants a shared password store
--   needs a password manager, not a chat agent's database.
--
--   NO ENDPOINT SOFTWARE, NO REMOTE ACCESS. The installed per-computer agent is
--   PARKED BY DECISION (charter §4). There is no device table, no enrolment
--   token, no agent heartbeat and no session record, because none of those things
--   exists — and the copy in the module must not imply that any of them is
--   coming.
--
-- ===========================================================================
-- SAFE GATING (two independent OFFs, the house pattern).
--   1. CODE: 'it-desk' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED for EVERY client, in every environment, including one where this
--      migration has not run.
--   2. DATA: the explicit seed row at the foot of this file.
--      `on conflict do nothing` so re-running never overrides a deliberate ON.
--
-- Switching it OFF stops the AGENT (the chat refuses and no model call is made).
-- The playbooks stay READABLE on the page, and so does the IT contact, because
-- both are reference material a receptionist may need at the exact moment the
-- owner has the agent switched off — and because the contact has to be settable
-- before the agent is switched on, or its escalation would have nowhere to go.
-- Same reasoning as 'outreach' in NAV_SWITCH_EXEMPT_SLUGS (src/lib/nav.ts).
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client.

-- ---------------------------------------------------------------------------
-- THE PRACTICE'S IT CONTACT.
--
-- One row per practice (the primary key IS the client id), because "who do we
-- ring about IT" has one answer and a table that allowed two would need a rule
-- for choosing between them.
--
-- EVERY FIELD IS NULLABLE, and that is the honest shape. An escalation that says
-- "ring your IT company" with no name attached is a shrug; one that invents a
-- plausible number is worse. Until the practice fills this in, the agent says in
-- as many words that no IT contact is set and that the owner can add one — which
-- is a useful thing to be told, and a nudge to do it.
-- ---------------------------------------------------------------------------
create table if not exists it_desk_contact (
  client_id text primary key,

  -- The person, and the company they are at. Both, because staff ring a person
  -- and the person may have left.
  name text,
  company text,
  phone text,
  email text,

  -- Free text: "Mon-Fri 8am-6pm, emergency line out of hours". Not modelled as
  -- structured opening hours on purpose — this is told to a human, never
  -- computed against, and structuring it would invite the agent to reason about
  -- whether the IT company is open, which it cannot know.
  hours text,

  -- Anything the practice wants staff told BEFORE they ring: a contract
  -- reference, "quote the site name", "log it on the portal first".
  notes text,

  updated_at timestamptz not null default now(),
  updated_by text
);

alter table it_desk_contact enable row level security;
revoke all on it_desk_contact from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed the switch OFF for the pilot client.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'it-desk', false, 'migration:0099')
on conflict (client_id, module_slug) do nothing;
