-- 0014_coordinator_messaging.sql
-- Give the shared `outbox` table the messaging columns the coordinator's 24/7
-- delivery path needs.
--
-- The Treatment Coordinator reuses the generic `outbox` table (it does not own a
-- per-module outbox like recall/reactivation/noshow do). For the shared messaging
-- drain, the Twilio status webhook and inbound correlation to work, every outbox
-- row needs to remember the address it went to and the provider message id it came
-- back with. Recall, reactivation and noshow outboxes already carry these columns;
-- this migration adds the same two columns (plus the message-id lookup index) to
-- the shared `outbox` so coordinator rows can be delivered, status-tracked and
-- correlated back on inbound exactly the same way. Ops-only, no clinical data.

alter table outbox add column if not exists to_address text;
alter table outbox add column if not exists provider_message_id text;
create index if not exists idx_outbox_msgid on outbox (provider_message_id);
