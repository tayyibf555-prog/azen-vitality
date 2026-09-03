import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { ApprovedAuthority, AuthorityKind, AuthorityStatus } from "./types";
import type { ValidAuthority } from "./authorities";

/**
 * The only file in src/lib/knowledge that touches the database. The rules live in
 * ./authorities.ts precisely so vitest can run them without any of this.
 *
 * EVERY QUERY IS CLIENT-SCOPED, reads included, and every WRITE carries
 * `.eq("client_id", clientId)` ALONGSIDE `.eq("id", id)`. An id on its own must
 * never address a row: ids are uuids and therefore hard to guess, but "hard to
 * guess" is not an authorisation model, and a route that resolves the client from
 * the session and then updates by id alone is one leaked id away from letting one
 * practice rewrite another's list. The pair is the lock.
 */

const TABLE = "approved_authority";

interface Row {
  id: string;
  client_id: string;
  name: string;
  kind: AuthorityKind;
  publisher: string | null;
  reference: string | null;
  summary: string | null;
  principles: string | null;
  status: AuthorityStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toAuthority(r: Row): ApprovedAuthority {
  return {
    id: r.id,
    clientId: r.client_id,
    name: r.name,
    kind: r.kind,
    publisher: r.publisher ?? "",
    reference: r.reference ?? "",
    summary: r.summary ?? "",
    principles: r.principles ?? "",
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The ACTIVE list — what may reach a prompt. Archived rows are excluded here
 * rather than filtered by the caller, so a caller that forgets loses nothing
 * except rows it should not have had.
 */
export async function listActiveAuthorities(clientId: string): Promise<ApprovedAuthority[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toAuthority);
}

/** Everything, archived included: the owner's panel, which has to show both. */
export async function listAllAuthorities(clientId: string): Promise<ApprovedAuthority[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toAuthority);
}

/**
 * `value` is a ValidAuthority, which only `validateAuthority` can produce — so the
 * ceilings cannot be skipped by calling the repository directly. (The migration's
 * CHECK constraints are the second, independent enforcement.)
 */
export async function createAuthority(
  clientId: string,
  value: ValidAuthority,
  createdBy: string | null,
): Promise<ApprovedAuthority> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .insert({
      client_id: clientId,
      name: value.name,
      kind: value.kind,
      publisher: value.publisher,
      reference: value.reference,
      summary: value.summary,
      principles: value.principles,
      status: "active",
      created_by: createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return toAuthority(data as Row);
}

/**
 * Returns null when no row matched — which covers both "no such id" and "that id
 * belongs to another practice", deliberately indistinguishable to the caller.
 */
export async function updateAuthority(
  clientId: string,
  id: string,
  value: ValidAuthority,
): Promise<ApprovedAuthority | null> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .update({
      name: value.name,
      kind: value.kind,
      publisher: value.publisher,
      reference: value.reference,
      summary: value.summary,
      principles: value.principles,
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", clientId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toAuthority(data as Row) : null;
}

/**
 * Archive, never delete. An answer the co-pilot gave last month cited this row by
 * name; deleting it would make that citation unreadable. Archived rows stay in the
 * owner's panel and are excluded from `listActiveAuthorities`, so they reach no
 * prompt.
 */
export async function archiveAuthority(clientId: string, id: string): Promise<ApprovedAuthority | null> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toAuthority(data as Row) : null;
}
