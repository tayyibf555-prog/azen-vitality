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

/** True only when the write path is explicitly enabled AND a dedicated write key is set. */
export function isDentallyWriteEnabled(): boolean {
  return process.env.DENTALLY_WRITE_ENABLED === "true" && Boolean(process.env.DENTALLY_WRITE_API_KEY);
}

/**
 * The Dentally client the agent uses for find_slots + book/reschedule/cancel/register.
 * Enabled: targets the dedicated write instance (sandbox or real) via DENTALLY_WRITE_*.
 * Disabled (default): identical config to what the inbound route used before, so the
 * default behaviour is unchanged and no write can reach a real book.
 */
export function dentallyAgentClient(): DentallyClient {
  if (isDentallyWriteEnabled()) {
    return new DentallyClient({
      apiKey: process.env.DENTALLY_WRITE_API_KEY ?? "",
      baseUrl: process.env.DENTALLY_WRITE_BASE_URL ?? "https://api.dentally.co",
    });
  }
  return new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
}
