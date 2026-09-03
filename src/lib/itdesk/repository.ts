import "server-only";

import { serviceClient } from "@/lib/supabase/server";
import type { ItContact } from "./types";

// ---------------------------------------------------------------------------
// THE IT DESK'S ONLY TABLE: the practice's named IT contact (migration 0099).
//
// The playbooks are source, not rows — see the migration's own note on why.
// ---------------------------------------------------------------------------

interface ContactRow {
  client_id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  hours: string | null;
  notes: string | null;
  updated_at: string | null;
}

/** The empty contact: what a practice that has not set one has. */
export function emptyContact(clientId: string): ItContact {
  return {
    clientId,
    name: null,
    company: null,
    phone: null,
    email: null,
    hours: null,
    notes: null,
    updatedAt: null,
  };
}

/**
 * Read the practice's IT contact.
 *
 * Returns null on a read FAILURE and an EMPTY contact when none is set, and the
 * agent says something different for each. "No IT contact has been added yet —
 * the owner can add one on the IT contact tab" is useful and actionable; saying
 * it because the database was briefly unreachable is a lie that makes the
 * practice think they lost the record.
 */
export async function getItContact(clientId: string): Promise<ItContact | null> {
  try {
    const { data, error } = await serviceClient()
      .from("it_desk_contact")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return emptyContact(clientId);
    const row = data as ContactRow;
    return {
      clientId: row.client_id,
      name: row.name,
      company: row.company,
      phone: row.phone,
      email: row.email,
      hours: row.hours,
      notes: row.notes,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    console.error(`[itdesk] getItContact(${clientId}) failed`, err);
    return null;
  }
}

/** Field length cap. Free text told to a human, never parsed. */
const MAX = 400;

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().slice(0, MAX);
  return v.length > 0 ? v : null;
}

/**
 * Set the practice's IT contact. One row per practice, so this is an upsert on
 * the primary key.
 */
export async function setItContact(
  clientId: string,
  input: Partial<Record<"name" | "company" | "phone" | "email" | "hours" | "notes", unknown>>,
  actor: string | null,
): Promise<boolean> {
  try {
    const { error } = await serviceClient()
      .from("it_desk_contact")
      .upsert(
        {
          client_id: clientId,
          name: trimmed(input.name),
          company: trimmed(input.company),
          phone: trimmed(input.phone),
          email: trimmed(input.email),
          hours: trimmed(input.hours),
          notes: trimmed(input.notes),
          updated_at: new Date().toISOString(),
          updated_by: actor,
        },
        { onConflict: "client_id" },
      );
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[itdesk] setItContact(${clientId}) failed`, err);
    return false;
  }
}
