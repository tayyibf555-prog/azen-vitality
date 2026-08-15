import "server-only";
import { randomUUID } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import {
  STAFF_DOCS_BUCKET,
  type StaffDocument,
  type StaffDocumentKind,
} from "./documents";

// ===========================================================================
// public.staff_document — server-only reads and writes (service role).
//
// METADATA HERE, BYTES IN STORAGE. This module writes the row and mints the
// short-lived signed URL; it never returns a public URL, because there is no such
// thing in this codebase and there must not be (`getPublicUrl` appears nowhere).
//
// LOUD ON FAILURE. A read error THROWS rather than returning []. An empty vault and
// a broken read are different facts, and the historical worst defect class in this
// repo is a screen that says "no documents" when it means "I could not look". The
// one exception is a MISSING RELATION: 0076 is written by one builder and applied by
// another, so until it lands the honest answer is "not set up yet", which the caller
// distinguishes with `ready: false` and says out loud.
//
// Every read and write is scoped by client_id, and the composite FK on
// (client_id, staff_id) means the database refuses a cross-tenant staff id even if a
// guard above ever missed one.
// ===========================================================================

const TABLE = "staff_document";

interface DocumentRow {
  id: string;
  client_id: string;
  staff_id: string;
  kind: string;
  label: string;
  storage_path: string;
  mime: string;
  size_bytes: number;
  expires_on: string | null;
  retain_until: string | null;
  uploaded_by: string | null;
  created_at: string;
}

function rowToDocument(r: DocumentRow): StaffDocument {
  return {
    id: r.id,
    clientId: r.client_id,
    staffId: r.staff_id,
    kind: r.kind as StaffDocumentKind,
    label: r.label,
    storagePath: r.storage_path,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    expiresOn: r.expires_on,
    retainUntil: r.retain_until,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

/** "This table does not exist yet" — see the clock repository's note on 0068. */
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "42703";
}

/** A read result that can say "not set up yet" without lying about emptiness. */
export interface DocumentReadResult {
  ready: boolean;
  documents: StaffDocument[];
}

/**
 * Every document for one staff member, newest first.
 *
 * THROWS on a real read error (the route turns that into an honest failure panel).
 * Returns `{ready:false}` only when the migration has not been applied.
 */
export async function listStaffDocuments(
  clientId: string,
  staffId: string,
): Promise<DocumentReadResult> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("staff_id", staffId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingRelation(error)) return { ready: false, documents: [] };
    throw error;
  }
  return { ready: true, documents: (data ?? []).map((r) => rowToDocument(r as DocumentRow)) };
}

export interface CreateDocumentInput {
  clientId: string;
  staffId: string;
  kind: StaffDocumentKind;
  label: string;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  expiresOn: string | null;
  retainUntil: string | null;
  uploadedBy: string | null;
}

/**
 * Record an uploaded document. THROWS on failure — a write that silently did not
 * happen would leave an orphaned object in Storage and a practice believing a DBS
 * certificate is on file.
 */
export async function createStaffDocument(input: CreateDocumentInput): Promise<StaffDocument> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .insert({
      client_id: input.clientId,
      staff_id: input.staffId,
      kind: input.kind,
      label: input.label,
      storage_path: input.storagePath,
      mime: input.mime,
      size_bytes: input.sizeBytes,
      expires_on: input.expiresOn,
      retain_until: input.retainUntil,
      uploaded_by: input.uploadedBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToDocument(data as DocumentRow);
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

/** A server-generated, unguessable path token. Never anything caller-supplied. */
export function newPathToken(): string {
  return randomUUID();
}

/**
 * Put the bytes in the private bucket. Returns null on success, or a short reason.
 *
 * Never throws: the route answers a friendly message and, crucially, does NOT write
 * a metadata row for an object that failed to store.
 */
export async function putStaffDocObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> {
  try {
    const { error } = await serviceClient()
      .storage.from(STAFF_DOCS_BUCKET)
      .upload(path, bytes, { contentType, upsert: false });
    if (error) return error.message || "upload-failed";
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "upload-failed";
  }
}

/**
 * A SHORT-LIVED signed URL for one object. A view, never a shareable link.
 *
 * Mirrors `signFileUrl` in lib/onboarding/repository.ts. Returns null when the
 * object is not there, which the route answers as 404 rather than 500.
 */
export async function signStaffDocUrl(
  path: string,
  expiresInSeconds: number,
): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .storage.from(STAFF_DOCS_BUCKET)
      .createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Remove an object we just stored. Used ONLY to clean up after a failed metadata
 * write, so a rejected upload does not leave an orphan in the bucket. Best effort
 * and deliberately silent: the caller has already decided what to tell the user, and
 * a failed cleanup must not turn into a second error message.
 */
export async function removeStaffDocObject(path: string): Promise<void> {
  try {
    await serviceClient().storage.from(STAFF_DOCS_BUCKET).remove([path]);
  } catch {
    // best effort
  }
}

