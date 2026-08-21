-- 0092_booking_reply_context.sql
--
-- Recall-aware booking replies: ship the switch OFF.
--
-- NO SCHEMA. This feature adds no tables and no columns. It reads the outbox and
-- target tables the lifecycle modules already own (recall_outbox / recall_touch /
-- recall_target, reactivation_*, closer_* / treatment_opportunity, collection_*)
-- and correlates them to an inbound number. The only thing it needs from the
-- database is its own kill switch, and that is what this file is.
--
-- WHY DEFAULT-OFF. The feature sends nothing, but it changes what the practice's
-- 24/7 booking agent SAYS to a patient: with a correlation resolved, a "yes please"
-- to a recall text goes straight to offering the right appointment instead of
-- asking what they need. The absence of a toggle row must never be the reason that
-- behaviour switches on, so the catalog declares `defaultEnabled: false` for
-- 'booking-reply-context' AND this migration seeds an explicit disabled row. The
-- two mechanisms are deliberately independent: the catalog covers every client and
-- every environment including one where this migration has not run, and the row
-- covers this database even if the catalog entry is ever edited.
--
-- SWITCHING IT OFF IS THE EXACT REVERT. With no context resolved the agent's system
-- prompt is byte-for-byte the one that shipped before this feature, pinned by
-- src/lib/agent/reply-context-prompt.test.ts.
--
-- The indexes the correlation needs already exist for the reply-linkage the inbound
-- webhook has always done (each outbox is looked up by to_address, newest first),
-- so nothing is added here for performance either.

insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'booking-reply-context', false, 'migration:0092')
on conflict (client_id, module_slug) do nothing;
