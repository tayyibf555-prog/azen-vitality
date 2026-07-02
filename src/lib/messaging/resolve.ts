import type { DentallyClient } from "@/lib/dentally/client";
import { normaliseEmail, toE164 } from "./phone";
import type { MessageChannel } from "./types";

export interface PatientContact {
  mobile_phone?: string;
  email_address?: string;
}

export function parsePatientRef(toRef: string): string | null {
  const m = /^patient:(.+)$/.exec(toRef);
  return m ? m[1] : null;
}

/**
 * The channel address for a patient, normalised to its canonical form:
 *   - sms/whatsapp -> E.164 (`+447700900123`),
 *   - email        -> trimmed + lowercased.
 * Dentally returns numbers in national format (`07700 900123`) and mixed-case
 * emails. Without this, Twilio rejects the national number AND a suppression
 * entry (always stored E.164, from the inbound STOP path) would never match, so
 * a patient who texted STOP could still be messaged. Returns null for an
 * implausible number/email so the drain records it undeliverable rather than
 * handing garbage to the provider.
 */
export function recipientFromPatient(p: PatientContact, channel: MessageChannel): string | null {
  if (channel === "email") return normaliseEmail(p.email_address);
  return toE164(p.mobile_phone); // sms + whatsapp
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

export async function resolveRecipient(
  toRef: string,
  channel: MessageChannel,
  client: Pick<DentallyClient, "getPatient">,
): Promise<string | null> {
  const id = parsePatientRef(toRef);
  if (!id) return null;
  const res = await client.getPatient(id);
  const p = asRecord((res as { patient?: unknown }).patient);
  return recipientFromPatient(
    {
      mobile_phone: pickString(p, "mobile_phone", "mobilePhone", "phone"),
      email_address: pickString(p, "email_address", "emailAddress", "email"),
    },
    channel,
  );
}
