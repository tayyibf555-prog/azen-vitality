import { DentallyClient } from "./client";

// Gated real-write path for the booking agent.
//
// The agent's find_slots (availability read) and book/reschedule/cancel (writes) share
// ONE client, so availability and the booking always hit the SAME Dentally instance and
// the agent can never book a phantom slot. By DEFAULT that client is byte-for-byte the
// one the inbound route built before this change (DENTALLY_API_KEY / DENTALLY_BASE_URL,
// which in the pilot points at the mock), so nothing changes until the write path is
// deliberately enabled with a dedicated read-write / sandbox key. This is the safety
// valve: real appointment writes cannot happen until DENTALLY_WRITE_ENABLED === "true"
// AND a DENTALLY_WRITE_API_KEY is set (validate against a Dentally sandbox first).

/**
 * True only when the write path is explicitly enabled AND a dedicated write key AND an
 * explicit write base URL are all set. Requiring the base URL is deliberate: it means
 * enabling writes can never silently default to production Dentally (api.dentally.co) if
 * the operator forgot to point at the sandbox. All three must be provided on purpose.
 */
export function isDentallyWriteEnabled(): boolean {
  return (
    process.env.DENTALLY_WRITE_ENABLED === "true" &&
    Boolean(process.env.DENTALLY_WRITE_API_KEY) &&
    Boolean(process.env.DENTALLY_WRITE_BASE_URL)
  );
}

// The `reason` values real Dentally accepts on POST /v1/appointments (calibrated
// against developer.dentally.co). Anything else is rejected with a 422.
const BOOKING_REASONS = new Set([
  "Exam",
  "Scale & Polish",
  "Exam + Scale & Polish",
  "Continuing Treatment",
  "Emergency",
  "Review",
  "Other",
]);

/**
 * Whitelisted payload for a manual dashboard booking (recall / reactivation /
 * coordinator "book" actions). NEVER forwards the raw request body to Dentally —
 * a caller could smuggle arbitrary fields or another patient's id. patient_id
 * always comes from OUR record of the target; the time/practitioner fields are
 * validated against what real Dentally requires so an invalid write is refused
 * here with a clear message instead of a Dentally 422.
 */
export function buildManualBookingPayload(
  body: Record<string, unknown>,
  patientId: string,
): { payload: Record<string, unknown> } | { error: string } {
  const start =
    typeof body.start_time === "string" && body.start_time
      ? body.start_time
      : typeof body.start === "string"
        ? body.start
        : "";
  const finish = typeof body.finish_time === "string" ? body.finish_time : "";
  const practitionerId =
    typeof body.practitioner_id === "number" || (typeof body.practitioner_id === "string" && body.practitioner_id)
      ? body.practitioner_id
      : "";
  if (!start) return { error: "start (ISO time) is required" };
  if (!finish) return { error: "finish_time is required (Dentally rejects a booking without an end time)" };
  if (!practitionerId) {
    return { error: "practitioner_id is required (Dentally rejects a booking without a practitioner)" };
  }
  const reason = typeof body.reason === "string" && BOOKING_REASONS.has(body.reason) ? body.reason : "Other";
  const notes = typeof body.notes === "string" && body.notes ? body.notes : "Booked via dashboard";
  return {
    payload: {
      patient_id: patientId,
      start_time: start,
      finish_time: finish,
      practitioner_id: practitionerId,
      reason,
      notes,
      booked_via_api: true,
    },
  };
}

/**
 * Whether a base URL points at REAL Dentally (api.dentally.co, or any subdomain of
 * dentally.co such as api.sandbox.dentally.co) rather than at our local mock.
 *
 * Pure and exported because it is the testable half of the belt below. An
 * unparseable URL is treated as real: the safe answer to "I cannot tell where this
 * points" is "assume the live patient book".
 *
 * Matches on the HOSTNAME, never on a substring of the whole URL, so
 * http://localhost:3000/api/mock-dentally.co/... cannot masquerade as the mock and
 * an attacker-shaped host like dentally.co.evil.test cannot masquerade as Dentally.
 */
export function targetsRealDentally(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return true;
  }
  return /(^|\.)dentally\.co$/i.test(hostname);
}

/**
 * The Dentally client the agent uses for find_slots + book/reschedule/cancel/register.
 * Enabled: targets the dedicated write instance (sandbox or real) via DENTALLY_WRITE_*.
 * Disabled (default): identical config to what the inbound route used before, so the
 * default behaviour is unchanged and no write can reach a real book.
 *
 * BOTH branches now state readOnly explicitly, because DentallyClient defaults to
 * read-only: this file is where "writable" is decided, so it is where the word
 * belongs. The DISABLED branch is the one that mattered. It used to return a fully
 * writable client whose base URL falls back to https://api.dentally.co whenever
 * DENTALLY_BASE_URL is unset — so "writes are disabled" built a client pointed at
 * the live practice book and armed. Now the disabled branch is writable ONLY while
 * it targets the local mock (which is a real write path: the agent books into
 * /api/mock-dentally in dev, and that must keep working). The instant it would
 * point at dentally.co, it is latched shut.
 */
export function dentallyAgentClient(): DentallyClient {
  if (isDentallyWriteEnabled()) {
    return new DentallyClient({
      apiKey: process.env.DENTALLY_WRITE_API_KEY ?? "",
      baseUrl: process.env.DENTALLY_WRITE_BASE_URL ?? "https://api.dentally.co",
      readOnly: false,
    });
  }
  const baseUrl = process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co";
  return new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl,
    readOnly: targetsRealDentally(baseUrl),
  });
}
