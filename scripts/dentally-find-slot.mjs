#!/usr/bin/env node
// READ-ONLY probe: which N15 practitioners have bookable availability, and the first
// open slot for each, over the next 30 days. No writes. Helps validate that the agent's
// find_slots will return slots, and surfaces a real free slot for a clean test booking.
//   DENTALLY_API_KEY=... node scripts/dentally-find-slot.mjs
const KEY = process.env.DENTALLY_API_KEY || process.env.DENTALLY_WRITE_API_KEY;
const BASE = (process.env.DENTALLY_BASE_URL || "https://api.dentally.co").replace(/\/+$/, "");
const SITE = process.env.SITE_ID || "3286d822-68c5-48ff-b1a2-065780dfcd15"; // N15 Vitality Dental
if (!KEY) { console.error("Set DENTALLY_API_KEY."); process.exit(1); }
const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json" };
async function get(path, params = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
}
const iso = (ms) => new Date(ms).toISOString();
(async () => {
  const pr = await get("/v1/practitioners", { per_page: 100, site_id: SITE });
  const active = (pr.body?.practitioners || []).filter((p) => p.active && p.site_id === SITE);
  console.log(`Active N15 practitioners (${active.length}): ${active.map((p) => `${p.id}:${p.user?.last_name || "?"}`).join(", ") || "none"}`);
  const start = iso(Date.now() + 86_400_000);
  const finish = iso(Date.now() + 30 * 86_400_000);
  for (const p of active.slice(0, 10)) {
    const av = await get("/v1/appointments/availability", { start_time: start, finish_time: finish, duration: 30, "practitioner_ids[]": p.id });
    const slots = av.body?.availability || [];
    const first = slots[0] ? ` | first: ${slots[0].start_time} -> ${slots[0].finish_time}` : "";
    console.log(`practitioner ${p.id} (${p.user?.last_name || "?"}): HTTP ${av.status}, ${slots.length} slots${first}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
