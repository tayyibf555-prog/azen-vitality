import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { META_PIXEL_OFF, metaPixelConfig, type MetaPixelConfig } from "./meta-pixel";

// Server-only CRUD for `client_meta_pixel` (migration 0083): whether a practice's
// public assessment pages report conversions to Meta.
//
// SERVICE-ROLE, like every sibling in this schema (0012 locked the database to
// server-only access). The tenancy boundary is therefore the `.eq("client_id", …)`
// on every single query in this file, and the ROLE boundary is at the API layer.
// There is no read here that is not scoped to one practice.
//
// TWO READ POSTURES, AND THE SPLIT IS THE SAME ONE custom-theme-repository.ts
// MAKES, for the same reason:
//
//   THE OWNER'S SCREEN asks about tracking because tracking is the subject. If the
//   table is missing (0083 not applied yet) it is TOLD, with the filename, so a
//   switch that will not save is explicable rather than mysterious.
//
//   THE PUBLIC PAGE AND THE SUBMIT ROUTE ask in passing, while rendering a paid ad
//   destination and while recording a patient's enquiry. Nothing there is worth a
//   500, so `resolveMetaPixel` never throws at all: any failure resolves to
//   META_PIXEL_OFF, which is byte-for-byte the behaviour of a practice that never
//   switched tracking on.
//
// THE FAILURE DIRECTION IS ALWAYS "NO TRACKING". A missing table, a transient
// error, a deleted row, a row whose pixel id is no longer an id — every one of
// them lands on META_PIXEL_OFF. There is no error path in this file that produces
// a config with `enabled: true` in it.

const TABLE = "client_meta_pixel";

/** Migration 0083 has not been applied to this database yet. */
export class MetaPixelTableMissingError extends Error {
  constructor() {
    super("Meta conversion tracking needs migration 0083_assess_meta_pixel.sql to be applied.");
    this.name = "MetaPixelTableMissingError";
  }
}

/**
 * Postgres/PostgREST both have a way of saying "no such table". Catch either.
 *
 * Narrowed to THIS table's name in the message-text fallback for the same reason
 * custom-theme-repository's isMissingTable is: so it cannot swallow a genuinely
 * broken query somewhere else and report it as an un-applied migration.
 */
function isMissingTable(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return new RegExp(`relation .*${TABLE}.* does not exist`, "i").test(error.message ?? "");
}

interface PixelRow {
  id: string;
  client_id: string;
  enabled: boolean | null;
  pixel_id: string | null;
  advanced_matching: boolean | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A row as a config.
 *
 * THE SINGLE PLACE A ROW BECOMES A CONFIG, and it goes through `metaPixelConfig`
 * — the same pure collapse the API route validates with — rather than copying
 * three columns across. That is what makes the read-back re-validation
 * unavoidable rather than remembered: a row whose `pixel_id` is no longer digits
 * comes back OFF, and the page renders no script tag, whatever put it there.
 */
function rowToConfig(row: PixelRow | null): MetaPixelConfig {
  if (!row) return META_PIXEL_OFF;
  return metaPixelConfig({
    enabled: row.enabled,
    pixelId: row.pixel_id,
    advancedMatching: row.advanced_matching,
  });
}

/** The settings row for the owner's screen, plus who last touched it. */
export interface MetaPixelSettings extends MetaPixelConfig {
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * This practice's tracking settings, for the SETTINGS SCREEN.
 *
 * THROWS MetaPixelTableMissingError when 0083 is not applied: the caller is an
 * owner's screen whose subject is tracking.
 */
export async function getMetaPixelSettings(clientId: string): Promise<MetaPixelSettings> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new MetaPixelTableMissingError();
    throw error;
  }
  const row = (data as PixelRow | null) ?? null;
  return {
    ...rowToConfig(row),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * This practice's tracking config, for RENDERING and for the submit path. NEVER
 * throws.
 *
 * The public /assess pages' and the public submit route's only entry point. Every
 * failure — 0083 not applied, no row, a transient read error, a row whose pixel id
 * is no longer an id — resolves to META_PIXEL_OFF, and the page renders exactly
 * what it renders today. A tracking pixel is not worth a 500 on a page that ad
 * spend points at, and it is certainly not worth failing a patient's submission.
 */
export async function resolveMetaPixel(clientId: string): Promise<MetaPixelConfig> {
  if (!clientId) return META_PIXEL_OFF;
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) {
      // A missing table is the ordinary pre-migration state and is not worth a
      // line in the log on every public page view; anything else is.
      if (!isMissingTable(error)) {
        console.warn(`[assess] could not read Meta tracking for ${clientId}; treating it as off`, error);
      }
      return META_PIXEL_OFF;
    }
    return rowToConfig((data as PixelRow | null) ?? null);
  } catch (err) {
    console.warn(`[assess] could not read Meta tracking for ${clientId}; treating it as off`, err);
    return META_PIXEL_OFF;
  }
}

export interface WritePixelInput {
  clientId: string;
  config: MetaPixelConfig;
  updatedBy?: string | null;
}

/**
 * Store this practice's settings. The config must already have passed
 * `validatePixelConfig`.
 *
 * AN UPSERT ON client_id, which the unique constraint makes atomic: one practice,
 * one answer, no read-modify-write race between two managers on the settings
 * screen at once.
 *
 * `pixel_id` IS CLEARED WHEN TRACKING IS OFF, not merely ignored. The alternative
 * — keeping the id around so it is there if they switch back — leaves a live
 * dataset id in a row that claims to be off, which is exactly the shape a later
 * bug turns into an unexpected pixel. If they switch back on, they type it again;
 * it is fifteen digits and it is in their Events Manager.
 */
export async function upsertMetaPixelSettings(input: WritePixelInput): Promise<MetaPixelSettings> {
  const { config } = input;
  const { data, error } = await serviceClient()
    .from(TABLE)
    .upsert(
      {
        client_id: input.clientId,
        enabled: config.enabled,
        pixel_id: config.enabled ? config.pixelId : null,
        advanced_matching: config.enabled ? config.advancedMatching : false,
        updated_by: input.updatedBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" },
    )
    .select("*")
    .single();
  if (error) {
    if (isMissingTable(error)) throw new MetaPixelTableMissingError();
    throw error;
  }
  const row = data as PixelRow;
  return { ...rowToConfig(row), updatedBy: row.updated_by, updatedAt: row.updated_at };
}
