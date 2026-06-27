import { serviceClient } from "@/lib/supabase/server";
import { sanitiseUspText } from "./prompt";
import type { Usp, UspCategory } from "./types";

// Server-only CRUD for practice_usp (service-role; the owner manages USPs via a
// requireUser-guarded API, and the agents read the active texts to inject them).

interface UspRow {
  id: string;
  client_id: string;
  text: string;
  category: string | null;
  priority: number | string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUsp(r: UspRow): Usp {
  return {
    id: r.id,
    clientId: r.client_id,
    text: r.text,
    category: (r.category as UspCategory | null) ?? null,
    priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || 0,
    active: r.active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertUspInput {
  clientId: string;
  text: string;
  category?: UspCategory | null;
  priority?: number;
  createdBy?: string | null;
}

/** Thrown when the supplied USP text does not survive sanitisation. */
export class InvalidUspError extends Error {
  constructor() {
    super("USP text is empty after cleaning");
    this.name = "InvalidUspError";
  }
}

export async function insertUsp(input: InsertUspInput): Promise<Usp> {
  const text = sanitiseUspText(input.text);
  if (!text) throw new InvalidUspError();
  const db = serviceClient();
  const { data, error } = await db
    .from("practice_usp")
    .insert({
      client_id: input.clientId,
      text,
      category: input.category ?? null,
      priority: input.priority ?? 0,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToUsp(data as UspRow);
}

export async function listUsps(clientId: string, opts?: { activeOnly?: boolean }): Promise<Usp[]> {
  const db = serviceClient();
  let q = db.from("practice_usp").select("*").eq("client_id", clientId);
  if (opts?.activeOnly) q = q.eq("active", true);
  const { data, error } = await q
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as UspRow[]).map(rowToUsp);
}

// Tiny per-client memo so a sweep that drafts N messages for one client does not
// issue N identical practice_usp reads. Short TTL keeps a newly added/edited USP
// appearing within a minute; per-instance only (fine, it is just a read cache).
const uspCache = new Map<string, { texts: string[]; at: number }>();
const USP_CACHE_TTL_MS = 60_000;

/**
 * The active USP texts for a client, highest priority first. This is what the AI
 * agents inject into their prompts. Resilient: returns [] (or the last good value)
 * on any error so a USP read can never break a patient-facing send.
 */
export async function listActiveUspTexts(clientId: string): Promise<string[]> {
  const cached = uspCache.get(clientId);
  if (cached && Date.now() - cached.at < USP_CACHE_TTL_MS) return cached.texts;
  try {
    const usps = await listUsps(clientId, { activeOnly: true });
    const texts = usps.map((u) => u.text);
    uspCache.set(clientId, { texts, at: Date.now() });
    return texts;
  } catch {
    return cached?.texts ?? [];
  }
}

export interface UpdateUspInput {
  text?: string;
  category?: UspCategory | null;
  priority?: number;
  active?: boolean;
}

export async function updateUsp(id: string, clientId: string, fields: UpdateUspInput): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.text !== undefined) {
    const text = sanitiseUspText(fields.text);
    if (!text) throw new InvalidUspError();
    patch.text = text;
  }
  if (fields.category !== undefined) patch.category = fields.category;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.active !== undefined) patch.active = fields.active;

  const db = serviceClient();
  const { error } = await db
    .from("practice_usp")
    .update(patch)
    .eq("id", id)
    .eq("client_id", clientId); // scope the write to the caller's client
  if (error) throw error;
}

export async function deleteUsp(id: string, clientId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("practice_usp").delete().eq("id", id).eq("client_id", clientId);
  if (error) throw error;
}
