import type { DentallyClient } from "@/lib/dentally/client";
import type { MessageChannel } from "./types";

export interface PatientContact {
  mobile_phone?: string;
  email_address?: string;
}

export function parsePatientRef(toRef: string): string | null {
  const m = /^patient:(.+)$/.exec(toRef);
  return m ? m[1] : null;
}

export function recipientFromPatient(p: PatientContact, channel: MessageChannel): string | null {
  if (channel === "email") return p.email_address ?? null;
  return p.mobile_phone ?? null; // sms + whatsapp
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
