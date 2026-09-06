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

/**
 * The most assets any single read will return.
 *
 * MUST equal `REGISTER_READ_CAP` in `./types` — the pure copy the prompt and the
 * tool results read, because neither may import this `server-only` module. The
 * literal is spelled out here rather than imported because two source scans read
 * this line as TEXT to prove their own bounds have not drifted from it:
 * `prompt.test.ts` ("the prompt's bound is the REPOSITORY's bound, read out of
 * its source") and `os-band.test.ts` ("the mock's bound drifted from the
 * repository's").
 *
 * A read AT this bound is a read that may be incomplete, and every count taken
 * off one says "at least N" rather than a bare figure (programme ruling W3/11).
 */
export const ASSET_ROW_CAP = 400;

/**
 * The most chunks a single manual search will consider.
 *
 * AND IT HAS TO SIT BELOW POSTGREST'S OWN CEILING, which is the whole reason for
 * this number. Supabase applies a server-side max-rows ceiling to every REST
 * request — measured at 1,000 on this project with the service-role key, by
 * asking for 1,500 and for 2,001 and receiving exactly 1,000 rows and
 * `content-range: 0-999/*` both times, with no error (see
 * `src/lib/dentally/sync-ledger.ts`, where the same measurement forced COUNT_CAP
 * from 2,000 to 900). A response clipped by that ceiling is indistinguishable
 * from a short one.
 *
 * This constant was 1,200, which is ABOVE the ceiling, so the extra 200 could
 * never arrive and `chunks.length >= CHUNK_ROW_CAP` — the only way a caller can
 * tell a partial read from a whole one — was structurally false. A dense manual
 * inside the 400-page/4MB ingest gates reaches four figures of chunks, and what
 * happened then was worse than a wrong number: `search_manual` ranked the first
 * thousand passages, found nothing, and told the practice "the manual does not
 * cover this" about a fault code printed in their own book. At 900 the bound is
 * observable, and `MANUAL_CHUNK_READ_CAP` in `./types` is the pure copy the
 * tool results read (they may not import this `server-only` module — the
 * dispatch's test mocks it wholesale, so the constant would resolve to
 * `undefined` and the honesty would evaporate with nothing going red).
 */
export const CHUNK_ROW_CAP = 900;

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

/**
 * THE SAME PAYLOAD, WITHOUT THE AUTHOR COLUMN — for every door that UPDATES.
 *
 * `created_by` belongs to the row's author, not to whoever edits it. It is the
 * register's only provenance column (0098 keeps it nullable precisely so "not
 * known" stays expressible) and this is a CQC/insurance artefact, where who
 * entered a row is part of what the register is FOR.
 *
 * IT IS A FUNCTION BECAUSE THE RULE WAS WRITTEN DOWN ONCE AND OBEYED ONCE. Two
 * doors write this table. `updateAsset` destructured the column out with that
 * sentence in a comment beside it; `importAssets`' serial-matched branch passed
 * the very same `assetPayload` object straight through — so correcting three
 * service dates in the spreadsheet and re-importing it rewrote the author of
 * every row the file matched, the whole register, unrecoverably, and reported
 * `updated: 47` with no hint that anything but the dates had moved. Editing an
 * asset by hand preserved authorship; re-importing the CSV did not. Two writers
 * to one table cannot be trusted to remember the same rule twice, so there is
 * now one place that knows it.
 */
function payloadWithoutAuthor(
  clientId: string,
  row: Omit<ParsedAssetRow, "line" | "warnings">,
  actor: string | null,
): Omit<ReturnType<typeof assetPayload>, "created_by"> {
  const { created_by: _author, ...payload } = assetPayload(clientId, row, actor);
  void _author;
  return payload;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  failed: { name: string; reason: string }[];
}

/**
 * The most existing serials one import will read before matching against them.
 *
 * Comfortably above ASSET_ROW_CAP — the register read is 400 — because this read
 * is two narrow columns rather than whole rows, and BELOW PostgREST's 1,000-row
 * ceiling, because a number above it is not a bound at all: it was 5,000, which
 * the server silently clipped to 1,000, so the constant said one thing and the
 * code did another.
 *
 * Being short here does not corrupt anything, which is why this is the smaller
 * of the two ceiling fixes: a serial the index did not cover simply misses, the
 * insert is attempted, and the database's own unique index (0098:
 * `unique (client_id, lower(serial))`) is what actually stops a duplicate. The
 * index below is an optimisation over that constraint, never a substitute for
 * it. The cost of the miss is the per-row sentence "another asset on the
 * register already has that serial number" instead of an update, on a re-import
 * by a practice with more than 900 serialled assets.
 */
export const SERIAL_INDEX_CAP = 900;

/**
 * The register's dedupe key, spelled exactly as the database spells it.
 *
 * `idx_equipment_asset_serial` is `unique (client_id, lower(serial))` — a plain
 * case-folded equality, nothing more. This function is the JavaScript half of
 * that same key, and the two must not drift: a match key that is LOOSER than the
 * constraint updates a row the constraint would have left alone, and a match key
 * that is TIGHTER inserts a row the constraint then rejects.
 *
 * WHY THIS IS A FUNCTION AND NOT AN `.ilike()`. It used to be
 * `.ilike("serial", serial)`, with the spreadsheet cell handed to PostgREST as
 * the pattern itself. `_` and `%` are wildcards in SQL LIKE and PostgREST reads
 * `*` as `%` besides, so an asset tag of "SN_1234" matched a REGISTERED
 * "SN-1234": one row came back, the importer updated it, and the autoclave
 * silently took on another machine's name, supplier and — the part that matters
 * — its next service date, reported to the practice as `updated: 1`. Two matches
 * were worse in a quieter way: `maybeSingle` errors, and a legitimate row was
 * reported as "could not be saved". Untrusted text is never a raw pattern
 * (programme ruling W3/12); it is matched with equality on a normalised value,
 * and this is that value.
 *
 * NOT trimmed, deliberately: `lower(serial)` in the index is not trimmed either,
 * so trimming here would make the two keys disagree on a stored value with
 * stray whitespace. The importer trims what it WRITES (csv.ts `clean()`), which
 * is the right end to fix it at.
 */
function serialKey(serial: string | null | undefined): string {
  return typeof serial === "string" ? serial.toLowerCase() : "";
}

/** A Postgres unique violation — the register's serial constraint, in practice. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
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

  // THE SERIAL INDEX, READ ONCE. Two narrow columns for the whole practice,
  // rather than one round trip per row — and, more to the point, matched in
  // memory with `serialKey` rather than by handing a spreadsheet cell to the
  // database as a LIKE pattern (see `serialKey` for what that used to do).
  //
  // A read FAILURE here is not fatal and is not swallowed either: the map stays
  // empty, every row is attempted as an insert, and the unique index catches the
  // duplicates and reports them per row. Better a re-import that says "another
  // asset already has that serial number" for the rows it could not match than
  // one that refuses the whole file because a lookup blinked.
  const serialToId = new Map<string, string>();
  try {
    const { data, error } = await db
      .from("equipment_asset")
      .select("id,serial")
      .eq("client_id", clientId)
      .not("serial", "is", null)
      .limit(SERIAL_INDEX_CAP);
    if (error) throw error;
    for (const raw of (data ?? []) as { id: string; serial: string | null }[]) {
      const key = serialKey(raw.serial);
      if (key && !serialToId.has(key)) serialToId.set(key, raw.id);
    }
  } catch (err) {
    console.error(`[equipment] import serial index for ${clientId} failed`, err);
  }

  for (const row of rows) {
    try {
      const key = serialKey(row.serial?.trim());
      const existingId = key ? serialToId.get(key) : undefined;
      if (existingId) {
        const { error } = await db
          .from("equipment_asset")
          // AN UPDATE, SO THE AUTHOR COLUMN DOES NOT TRAVEL — the same rule
          // `updateAsset` obeys, now obeyed from the same place. A re-import is
          // a correction to the practice's spreadsheet, not a change of who
          // first entered the machine.
          .update(payloadWithoutAuthor(clientId, row, actor))
          .eq("client_id", clientId) // tenancy in the WHERE clause, not in the map we built
          .eq("id", existingId);
        if (error) throw error;
        result.updated += 1;
        continue;
      }
      const { data: inserted, error } = await db
        .from("equipment_asset")
        .insert(assetPayload(clientId, row, actor))
        .select("id")
        .single();
      if (error) throw error;
      result.inserted += 1;
      // A spreadsheet that lists the same serial twice must update the row the
      // first line created, not fall foul of the constraint on the second.
      if (key) serialToId.set(key, (inserted as { id: string }).id);
    } catch (err) {
      console.error(`[equipment] import row "${row.name}" failed`, err);
      result.failed.push({
        name: row.name,
        // The one failure the practice can actually do something about gets its
        // own sentence. "Could not be saved" for a serial clash sends somebody
        // looking for a platform fault instead of at the duplicated cell.
        reason: isUniqueViolation(err)
          ? "another asset on the register already has that serial number"
          : "could not be saved",
      });
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
    const { error } = await serviceClient()
      .from("equipment_asset")
      // created_by belongs to the row's author, not to whoever edits it — see
      // `payloadWithoutAuthor`, which the importer's update branch shares.
      .update(payloadWithoutAuthor(clientId, row, actor))
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

/**
 * The most manual rows the per-asset manual index will read.
 *
 * IT IS NOT `ASSET_ROW_CAP`, WHICH IS WHAT IT USED TO BE, and the difference is
 * the whole point of this constant existing. Every consumer of `listManuals`
 * uses the result as an index keyed by asset id — the Register tab's Manual
 * column, the prompt's `manual: yes/NO`, the tools' `manualUploaded` — while the
 * ASSETS are read separately, ordered by category then name, and the manuals by
 * `uploaded_at desc`. Two differently-ordered pages of the same size do not
 * cover the same rows, so at 400 the index started missing assets that were on
 * screen and the answer for those was a hard `false`: "No manual uploaded" on
 * the Register tab and `manualUploaded: false` to the model, about a manual that
 * is stored, indexed and searchable — the exact false statement
 * MANUAL_INDEX_UNREADABLE_NOTE and the null-vs-[] work exist to make impossible,
 * and one `search_manual` call away from contradicting itself inside one turn.
 *
 * 999 rather than 1,000, per programme ruling W3/32: PostgREST clips every
 * request at 1,000 rows, so a cap ON the ceiling can never be observed —
 * `rows.length >= CAP` is structurally false and the read comes back clipped
 * wearing a whole read's clothes. At 999 the bound is observable, and it sits
 * far enough above `ASSET_ROW_CAP` that the degradation below is a backstop
 * rather than an everyday state: a manual is one hand-uploaded PDF per machine
 * (`replaceManual` keeps exactly one row per asset), so reaching it needs 999
 * individual uploads, where the asset cap is reachable by one 500-row CSV.
 */
export const MANUAL_INDEX_ROW_CAP = 999;

/**
 * Every manual for a practice, so the table can show which assets have one.
 *
 * NULL MEANS "WE CANNOT SAY WHICH MACHINES HAVE ONE", AND A TRUNCATED READ IS
 * ONE OF THE TWO WAYS THAT HAPPENS. The other is a failed read. They are the
 * same fact to every caller — the answer for any given asset is unknown, because
 * its absence from this page no longer distinguishes "no manual" from "past the
 * bound" — and this module already handles that fact properly everywhere:
 * `equipment-view.tsx` sets `manualsUnreadable` and the Register/Manuals tabs
 * stop claiming "none"; `route.ts` passes `assetIdsWithManual: null` and the
 * prompt emits no manual column at all; `tools.ts` omits `manualUploaded` from
 * every summary and carries MANUAL_INDEX_UNREADABLE_NOTE. Collapsing here rather
 * than adding a `capped` flag is deliberate: a flag is a thing three callers can
 * each forget, and the failure it guards is a confident false negative
 * (§0/5 — a truncated read never wears a complete one's clothes; W3/11).
 *
 * The two are still distinguishable in the log, because they need different
 * things doing about them.
 */
export async function listManuals(clientId: string): Promise<EquipmentManual[] | null> {
  try {
    const { data, error } = await serviceClient()
      .from("equipment_manual")
      .select("*")
      .eq("client_id", clientId)
      .order("uploaded_at", { ascending: false })
      .limit(MANUAL_INDEX_ROW_CAP);
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length >= MANUAL_INDEX_ROW_CAP) {
      console.warn(
        `[equipment] listManuals(${clientId}) came back at its ${MANUAL_INDEX_ROW_CAP}-row bound; ` +
          "reporting the index as unknown rather than as a complete list",
      );
      return null;
    }
    return rows.map((r) => toManual(r as ManualRow));
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
 * THE NEW REVISION IS WRITTEN FIRST AND THE OLD ONE IS RETIRED BY ID AFTERWARDS,
 * which is the reverse of the order this was written in (wave-3 review, 6
 * September 2026). Deleting first read well — it closed the window in which a
 * question could be answered from both revisions at once — but there is no
 * transaction here, only three separate PostgREST calls, so it made every
 * failure after that delete destructive. A chunk insert PostgREST rejects (a
 * 380-page manual is ~800 rows and over a megabyte in one body), a statement
 * timeout, a dropped connection: any of them landed in the catch below with the
 * practice's previously ingested manual and every one of its passages already
 * gone through 0098's cascade, while the screen said "We could not store that
 * manual. Please try again." — a sentence that states nothing changed. Nothing
 * could bring it back, either: the PDF's bytes are never stored (0098's
 * copyright note), so the extracted text was the only copy the platform ever
 * held, and the register then said "No manual uploaded" about a machine the desk
 * had been answering from minutes earlier, indistinguishable from a machine that
 * never had one.
 *
 * So the fail direction is closed the other way round, the way W3/6 rules it for
 * the pre-visit form ("never lose a patient's answers"): what is already stored
 * survives every failure, and what is half-written is rolled back. What that
 * trades for is the few milliseconds between the new passages landing and the
 * old row going, in which a search can see both revisions — a window that is
 * cheaper, and recoverable, in a way that destroying the only copy is not.
 *
 * It is legal because `equipment_manual` has no unique key on `asset_id` (0098
 * indexes `(asset_id, uploaded_at desc)` and nothing more), so two rows may
 * coexist for that window. The retire is still scoped by client and asset and
 * merely excludes the row just written, so it also sweeps up any older revision
 * an earlier failure left behind.
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
  // Held outside the try so the catch knows whether a half-written revision
  // exists to undo. Null means nothing of ours reached the table.
  let manualId: string | null = null;
  try {
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
    manualId = (data as { id: string }).id;

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
      // and leaving the header row behind would tell the practice it has one —
      // so the catch below removes it, along with nothing else.
      if (chunkError) throw chunkError;
    }

    // THE OLD REVISION GOES ONLY ONCE THE NEW ONE IS WHOLE — header row and
    // every passage written. Its chunks go with it through 0098's cascade.
    const { error: retireError } = await db
      .from("equipment_manual")
      .delete()
      .eq("client_id", input.clientId)
      .eq("asset_id", input.assetId)
      .neq("id", manualId);
    if (retireError) throw retireError;

    return { ok: true, manualId };
  } catch (err) {
    console.error(`[equipment] replaceManual(${input.assetId}) failed`, err);
    // UNDO OUR HALF, NEVER THEIRS. Deleting the new manual takes its passages
    // with it (0098's cascade) and leaves the practice with exactly what it had
    // before it pressed upload — which is what the sentence below claims.
    if (manualId) {
      const { error: rollbackError } = await db
        .from("equipment_manual")
        .delete()
        .eq("client_id", input.clientId)
        .eq("id", manualId);
      if (rollbackError) {
        // Both revisions are in the index now and a search can mix them, which is
        // the one thing this function exists to prevent. "Nothing was stored"
        // would be the same lie in the other direction, so the sentence names the
        // state and the one action that clears it: the Manuals tab's delete is
        // scoped by asset, so it removes both.
        console.error(
          `[equipment] replaceManual(${input.assetId}) could not roll back manual ${manualId}`,
          rollbackError,
        );
        return {
          ok: false,
          reason:
            "That manual was stored, but the previous version could not be removed, so the desk can now see both. Remove the manual on the Manuals tab and upload it again before relying on its answers.",
        };
      }
    }
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
