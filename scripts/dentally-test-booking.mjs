#!/usr/bin/env node
// One-off LIVE Dentally booking validation. It reads your practitioners + availability
// from your real Dentally, then makes ONE real booking with the EXACT payload the
// booking agent uses (src/lib/agent/tools.ts), and prints Dentally's response at every
// step. If the write succeeds it creates a REAL appointment (its notes flag it as a
// test) — DELETE it from your diary afterwards. Read/write via the documented API only.
//
// Run locally (your key stays in your shell, never committed):
//   DENTALLY_WRITE_API_KEY=YOUR_KEY \
//   DENTALLY_WRITE_BASE_URL=https://api.dentally.co \
//   TEST_PATIENT_ID=123456 \
//   node scripts/dentally-test-booking.mjs
//
// Optional overrides if auto-discovery cannot find a slot (read them off an open slot
// in your Dentally diary): TEST_PRACTITIONER_ID, TEST_START_TIME, TEST_FINISH_TIME,
// TEST_SITE_ID. Times are ISO 8601, e.g. 2026-07-10T09:00:00Z.

const KEY = process.env.DENTALLY_WRITE_API_KEY || process.env.DENTALLY_API_KEY;
const BASE = (process.env.DENTALLY_WRITE_BASE_URL || process.env.DENTALLY_BASE_URL || "https://api.dentally.co").replace(/\/+$/, "");
const PATIENT_ID = process.env.TEST_PATIENT_ID || "";
const SITE_ID = process.env.TEST_SITE_ID || "";
let PRACTITIONER_ID = process.env.TEST_PRACTITIONER_ID || "";
let START_TIME = process.env.TEST_START_TIME || "";
let FINISH_TIME = process.env.TEST_FINISH_TIME || "";

if (!KEY) {
  console.error("Set DENTALLY_WRITE_API_KEY (or DENTALLY_API_KEY) in the environment.");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json", "Content-Type": "application/json" };

async function request(method, path, { params = {}, payload } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}
const get = (path, params) => request("GET", path, { params });
const post = (path, payload) => request("POST", path, { payload });

function log(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof obj === "string" ? obj.slice(0, 2000) : JSON.stringify(obj, null, 2));
}
const dayStr = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

(async () => {
  console.log(`Dentally target: ${BASE}   (key ${KEY.slice(0, 4)}...${KEY.slice(-2)})`);

  // 1. Practitioner id.
  if (!PRACTITIONER_ID) {
    const pr = await get("/v1/practitioners", { per_page: 100, ...(SITE_ID ? { site_id: SITE_ID } : {}) });
    log(`GET /v1/practitioners -> ${pr.status}`, pr.body);
    const list = pr.ok && pr.body && Array.isArray(pr.body.practitioners) ? pr.body.practitioners : [];
    PRACTITIONER_ID = list[0]?.id ?? "";
    console.log(`\n-> practitioner_id = ${PRACTITIONER_ID || "(none found; set TEST_PRACTITIONER_ID)"}`);
  }

  // 2. An open slot (unless supplied). Calibrated to the documented availability params.
  if ((!START_TIME || !FINISH_TIME) && PRACTITIONER_ID) {
    const av = await get("/v1/appointments/availability", {
      start_time: `${dayStr(1)}T08:00:00Z`,
      finish_time: `${dayStr(8)}T18:00:00Z`,
      duration: 30,
      "practitioner_ids[]": PRACTITIONER_ID,
    });
    log(`GET /v1/appointments/availability -> ${av.status}`, av.body);
    const slots = av.ok && av.body && Array.isArray(av.body.availability) ? av.body.availability : [];
    const slot = slots[0];
    if (slot) {
      START_TIME = slot.start_time || START_TIME;
      FINISH_TIME = slot.finish_time || FINISH_TIME;
      if (slot.practitioner_id) PRACTITIONER_ID = slot.practitioner_id;
      console.log(`\n-> slot: ${START_TIME} to ${FINISH_TIME} (practitioner ${PRACTITIONER_ID})`);
    }
  }

  // Preconditions for the write.
  if (!PATIENT_ID) {
    console.error("\nSet TEST_PATIENT_ID to a real test patient in your Dentally (a dummy/staff record you can delete the appointment from).");
    process.exit(1);
  }
  if (!PRACTITIONER_ID || !START_TIME || !FINISH_TIME) {
    console.error("\nCould not auto-resolve a practitioner + slot. Read an open slot off your Dentally diary and re-run with TEST_PRACTITIONER_ID, TEST_START_TIME and TEST_FINISH_TIME set.");
    process.exit(1);
  }

  // 3. THE TEST WRITE — byte-for-byte the booking agent's calibrated payload.
  const payload = {
    appointment: {
      patient_id: PATIENT_ID,
      start_time: START_TIME,
      finish_time: FINISH_TIME,
      practitioner_id: PRACTITIONER_ID,
      reason: "Other",
      notes: "TEST booking via Azen assistant validation - please delete",
      booked_via_api: true,
      // TEST-ONLY: suppress double-booking errors so a scheduling clash cannot mask a
      // payload success. NOT part of the real agent payload.
      ...(process.env.TEST_FORCE === "true" ? { force_changes: true } : {}),
    },
  };
  log("POST /v1/appointments  (payload we are sending)", payload);
  const res = await post("/v1/appointments", payload);
  log(`POST /v1/appointments -> ${res.status}`, res.body);

  if (res.ok) {
    const id = res.body?.appointment?.id ?? "?";
    console.log(`\n[OK] SUCCESS - a REAL appointment was created (id ${id}).`);
    console.log("     >>> DELETE it from your Dentally diary now (it is flagged 'TEST ... please delete').");
  } else {
    console.log(`\n[X] Dentally REJECTED the booking (HTTP ${res.status}). The error body above shows exactly which field to fix. Nothing was created. Send me the output.`);
  }
})().catch((e) => {
  console.error("\nScript error:", e);
  process.exit(1);
});
