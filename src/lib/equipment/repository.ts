import "server-only";

import { serviceClient } from "@/lib/supabase/server";
import type { AssetCategory, EquipmentAsset, EquipmentManual } from "./types";
import type { ManualChunkDraft } from "./chunk";
import type { ParsedAssetRow } from "./csv";

// ---------------------------------------------------------------------------
// THE EQUIPMENT MODULE'S DATABASE ACCESS. Server-only, service-role, tables from
// migration 0098.
//
// EVERY READ IS SCOPED BY client_id AND EVERY READ IS BOUNDED. The register is
// the practice's own list — tens of rows, not thousands — but "tens" is an
// assumption about a table anybody can import a spreadsheet into, and an agent
// that pulls an unbounded table into a prompt is one bad CSV away from a
// four-figure token bill per question.
// ---------------------------------------------------------------------------

/** The most assets any single read will return. A practice past this has bigger news for us. */
export const ASSET_ROW_CAP = 400;
/** The most chunks a single manual search will consider. */
export const CHUNK_ROW_CAP = 1_200;

interface AssetRow {
  id: string;
  client_id: string;
  site_id: string | null;
  name: string;
  category: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  room: string | null;
  supplier: string | null;
  supplier_phone: string | null;
  purchased_on: string | null;
  last_serviced_on: string | null;
  next_service_due: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toAsset(row: AssetRow): EquipmentAsset {
  return {
    id: row.id,
    clientId: row.client_id,
    siteId: row.site_id,
    name: row.name,
    category: row.category as AssetCategory,
    make: row.make,
    model: row.model,
    serial: row.serial,
    room: row.room,
    supplier: row.supplier,
    supplierPhone: row.supplier_phone,
    purchasedOn: row.purchased_on,
    lastServicedOn: row.last_serviced_on,
    nextServiceDue: row.next_service_due,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The whole register for one practice.
 *
 * Returns null on a read FAILURE, and an empty array when the practice simply
 * has nothing registered. The two are different facts and the module treats them
 * differently: an empty register produces "add your equipment and I can answer
 * from it", while an unreadable one must never produce that sentence, because
 * telling a practice their register is empty when it is not is how they conclude
 * the platform lost it.
 */
export async function listAssets(clientId: string): Promise<EquipmentAsset[] | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_asset")
      .select("*")
      .eq("client_id", clientId)
      .order("category", { ascending: true })
      .order("name", { ascending: true })
      .limit(ASSET_ROW_CAP);
    if (error) throw error;
    return (data ?? []).map((r) => toAsset(r as AssetRow));
  } catch (err) {
    console.error(`[equipment] listAssets(${clientId}) failed`, err);
    return null;
  }
}

export async function getAsset(clientId: string, id: string): Promise<EquipmentAsset | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_asset")
      .select("*")
      .eq("client_id", clientId) // tenancy in the QUERY, not in a later check
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? toAsset(data as AssetRow) : null;
  } catch (err) {
    console.error(`[equipment] getAsset(${id}) failed`, err);
    return null;
  }
}

/** Shape one parsed CSV row (or a manual entry) into a database row. */
function assetPayload(clientId: string, row: Omit<ParsedAssetRow, "line" | "warnings">, actor: string | null) {
  return {
    client_id: clientId,
    site_id: row.siteId,
    name: row.name,
    category: row.category,
    make: row.make,
    model: row.model,
    serial: row.serial,
    room: row.room,
    supplier: row.supplier,
    supplier_phone: row.supplierPhone,
    purchased_on: row.purchasedOn,
    last_serviced_on: row.lastServicedOn,
    next_service_due: row.nextServiceDue,
    notes: row.notes,
    created_by: actor,
    updated_at: new Date().toISOString(),
  };
}

export interface ImportResult {
  inserted: number;
  updated: number;
  failed: { name: string; reason: string }[];
}

/**
 * Write an import plan's rows.
 *
 * SERIAL-KEYED UPSERT, which is the behaviour the practice expects even though
 * nobody asks for it by name: the register is imported once, corrected in the
 * spreadsheet, and imported again — and the second import must update the
 * autoclave, not create a second one. Rows WITHOUT a serial are always inserted,
 * because there is nothing to match them on and quietly merging two unnamed
 * cabinets would lose one.
 *
 * Written row by row rather than as one bulk upsert on purpose: a single bad row
 * in a 60-row spreadsheet must not reject the other 59, and the practice is told
 * exactly which ones did not land.
 */
export async function importAssets(
  clientId: string,
  rows: Omit<ParsedAssetRow, "line" | "warnings">[],
  actor: string | null,
): Promise<ImportResult> {
  const db = serviceClient();
  const result: ImportResult = { inserted: 0, updated: 0, failed: [] };

  for (const row of rows) {
    const payload = assetPayload(clientId, row, actor);
    try {
      const serial = row.serial?.trim();
      if (serial) {
        const { data: existing, error: findError } = await db
          .from("equipment_asset")
          .select("id")
          .eq("client_id", clientId)
          .ilike("serial", serial)
          .maybeSingle();
        if (findError) throw findError;
        if (existing) {
          const { error } = await db.from("equipment_asset").update(payload).eq("id", (existing as { id: string }).id);
          if (error) throw error;
          result.updated += 1;
          continue;
        }
      }
      const { error } = await db.from("equipment_asset").insert(payload);
      if (error) throw error;
      result.inserted += 1;
    } catch (err) {
      console.error(`[equipment] import row "${row.name}" failed`, err);
      result.failed.push({ name: row.name, reason: "could not be saved" });
    }
  }

  return result;
}

/** Create one asset by hand. Returns the id, or null on failure. */
export async function createAsset(
  clientId: string,
  row: Omit<ParsedAssetRow, "line" | "warnings">,
  actor: string | null,
): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_asset")
      .insert(assetPayload(clientId, row, actor))
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  } catch (err) {
    console.error("[equipment] createAsset failed", err);
    return null;
  }
}

/** Update one asset. Tenancy is in the WHERE clause, never in a prior read. */
export async function updateAsset(
  clientId: string,
  id: string,
  row: Omit<ParsedAssetRow, "line" | "warnings">,
  actor: string | null,
): Promise<boolean> {
  try {
    const { created_by: _ignored, ...payload } = assetPayload(clientId, row, actor);
    void _ignored; // created_by belongs to the row's author, not to whoever edits it
    const { error } = await serviceClient()
      .from("equipment_asset")
      .update(payload)
      .eq("client_id", clientId)
      .eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[equipment] updateAsset(${id}) failed`, err);
    return false;
  }
}

export async function deleteAsset(clientId: string, id: string): Promise<boolean> {
  try {
    const { error } = await serviceClient()
      .from("equipment_asset")
      .delete()
      .eq("client_id", clientId)
      .eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[equipment] deleteAsset(${id}) failed`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// MANUALS.
// ---------------------------------------------------------------------------

interface ManualRow {
  id: string;
  asset_id: string;
  client_id: string;
  filename: string;
  byte_size: number;
  page_count: number;
  extractor: string;
  extracted_chars: number;
  status: string;
  uploaded_at: string;
}

function toManual(row: ManualRow): EquipmentManual {
  return {
    id: row.id,
    assetId: row.asset_id,
    clientId: row.client_id,
    filename: row.filename,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    extractor: row.extractor,
    extractedChars: row.extracted_chars,
    status: row.status === "no_text" ? "no_text" : "ready",
    uploadedAt: row.uploaded_at,
  };
}

/** Every manual for a practice, so the table can show which assets have one. */
export async function listManuals(clientId: string): Promise<EquipmentManual[] | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_manual")
      .select("*")
      .eq("client_id", clientId)
      .order("uploaded_at", { ascending: false })
      .limit(ASSET_ROW_CAP);
    if (error) throw error;
    return (data ?? []).map((r) => toManual(r as ManualRow));
  } catch (err) {
    console.error(`[equipment] listManuals(${clientId}) failed`, err);
    return null;
  }
}

/**
 * Replace an asset's manual with a freshly ingested one.
 *
 * REPLACE, not append: an asset has ONE current manual, and a practice that
 * uploads a corrected PDF means "use this instead", not "search both and answer
 * from whichever wins". Two revisions of the same manual in the index is exactly
 * how an agent ends up quoting a superseded procedure.
 *
 * The old manual is deleted FIRST and its chunks go with it via the cascade in
 * 0098. Ordering matters: deleting after inserting would leave a window in which
 * a question is answered from both.
 */
export async function replaceManual(
  input: {
    clientId: string;
    assetId: string;
    filename: string;
    byteSize: number;
    pageCount: number;
    extractor: string;
    extractedChars: number;
    status: "ready" | "no_text";
    actor: string | null;
  },
  chunks: ManualChunkDraft[],
): Promise<{ ok: true; manualId: string } | { ok: false; reason: string }> {
  const db = serviceClient();
  try {
    const { error: deleteError } = await db
      .from("equipment_manual")
      .delete()
      .eq("client_id", input.clientId)
      .eq("asset_id", input.assetId);
    if (deleteError) throw deleteError;

    const { data, error } = await db
      .from("equipment_manual")
      .insert({
        asset_id: input.assetId,
        client_id: input.clientId,
        filename: input.filename,
        byte_size: input.byteSize,
        page_count: input.pageCount,
        extractor: input.extractor,
        extracted_chars: input.extractedChars,
        status: input.status,
        uploaded_by: input.actor,
      })
      .select("id")
      .single();
    if (error) throw error;
    const manualId = (data as { id: string }).id;

    if (chunks.length > 0) {
      const { error: chunkError } = await db.from("equipment_manual_chunk").insert(
        chunks.map((c) => ({
          manual_id: manualId,
          asset_id: input.assetId,
          client_id: input.clientId,
          page_from: c.pageFrom,
          page_to: c.pageTo,
          ordinal: c.ordinal,
          body: c.body,
        })),
      );
      // A manual whose chunks failed to write is a manual the agent cannot read,
      // and leaving the header row behind would tell the practice it has one.
      if (chunkError) {
        await db.from("equipment_manual").delete().eq("id", manualId);
        throw chunkError;
      }
    }

    return { ok: true, manualId };
  } catch (err) {
    console.error(`[equipment] replaceManual(${input.assetId}) failed`, err);
    return { ok: false, reason: "We could not store that manual. Please try again." };
  }
}

export async function deleteManualForAsset(clientId: string, assetId: string): Promise<boolean> {
  try {
    const { error } = await serviceClient()
      .from("equipment_manual")
      .delete()
      .eq("client_id", clientId)
      .eq("asset_id", assetId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[equipment] deleteManualForAsset(${assetId}) failed`, err);
    return false;
  }
}

/**
 * Every chunk of one asset's manual, bounded.
 *
 * Loaded whole and ranked in memory, the same shape as the practice brain's
 * retrieval: one manual is at most a few hundred passages, ranking is pure and
 * therefore unit-testable, and a Postgres full-text path can replace this
 * transparently later without changing a caller.
 */
export async function listChunksForAsset(
  clientId: string,
  assetId: string,
): Promise<ManualChunkDraft[] | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_manual_chunk")
      .select("page_from,page_to,ordinal,body")
      .eq("client_id", clientId)
      .eq("asset_id", assetId)
      .order("ordinal", { ascending: true })
      .limit(CHUNK_ROW_CAP);
    if (error) throw error;
    return (data ?? []).map((r) => {
      const row = r as { page_from: number; page_to: number; ordinal: number; body: string };
      return { pageFrom: row.page_from, pageTo: row.page_to, ordinal: row.ordinal, body: row.body };
    });
  } catch (err) {
    console.error(`[equipment] listChunksForAsset(${assetId}) failed`, err);
    return null;
  }
}
