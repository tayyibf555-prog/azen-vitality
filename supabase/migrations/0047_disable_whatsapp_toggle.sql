-- 0047_disable_whatsapp_toggle.sql
-- Seed the WhatsApp system kill switch OFF.
--
-- system_toggle (migration 0034) is DEFAULT-ON by the ABSENCE of a row: a system
-- with no row is treated as enabled. The messaging drain's channel-preference gate
-- reads this toggle to decide whether a patient's 'whatsapp' preference may re-route
-- an SMS to WhatsApp. With no 'whatsapp' row the gate computed whatsappEnabled=true,
-- silently ARMING WhatsApp re-routing even though the WhatsApp agent/sender is not
-- live in the pilot.
--
-- Mirror how 0041 seeds 'outreach' OFF: insert an explicit disabled row so the
-- channel-preference gate (and any future WhatsApp send path) is fail-closed until
-- the owner turns WhatsApp on from the control panel. do-nothing on conflict so
-- re-running this migration never re-arms a system the owner has since enabled.
--
-- Defence in depth: even with this row present, the drain ALSO requires a configured
-- WhatsApp sender (TWILIO_WHATSAPP_FROM) before it will ever route to WhatsApp, so a
-- 'whatsapp' preference can never reach a dead channel regardless of the toggle.
insert into system_toggle (client_id, module_slug, enabled)
values ('vitality', 'whatsapp', false)
on conflict (client_id, module_slug) do nothing;
