import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import {
  customThemeRef,
  parseCustomThemeRef,
  readbackVars,
  type CustomTheme,
} from "./custom-theme";

// Server-only CRUD for `client_theme` (migration 0081): the colour schemes a
// practice defines for itself.
//
// SERVICE-ROLE, like every sibling in this schema (0012 locked the database to
// server-only access). The tenancy boundary is therefore the `.eq("client_id", …)`
// on every single query in this file, and the ROLE boundary is at the API layer.
// There is no read here that is not scoped to one practice.
//
// TWO READ POSTURES, AND THE SPLIT IS DELIBERATE — the same split 0079 made
// between insertCampaign (swallow) and setCampaignTheme (report):
//
//   THE OWNER'S SCREENS ask about themes because themes are the subject. If the
//   table is missing (0081 not applied yet) they are TOLD, with the filename, so a
//   picker that will not save is explicable rather than mysterious.
//
//   THE PUBLIC PAGE asks about a theme in passing, while rendering a paid ad
//   destination. Nothing there is worth a 500, so `resolveCustomTheme` never
//   throws at all: any failure resolves to null and the page wears the shipped
//   default, which is exactly what it wears for a retired preset key today.

const TABLE = "client_theme";

/** Migration 0081 has not been applied to this database yet. */
export class CustomThemeTableMissingError extends Error {
  constructor() {
    super("Your own colour schemes need migration 0081_assessment_custom_theme.sql to be applied.");
    this.name = "CustomThemeTableMissingError";
  }
}

/** Two themes in one practice may not share a name (the picker shows names alone). */
export class ThemeNameTakenError extends Error {
  constructor(name: string) {
    super(`This practice already has a colour scheme called "${name}".`);
    this.name = "ThemeNameTakenError";
  }
}

/** The theme is in use, so deleting it would re-colour a live page. Names them. */
export class ThemeInUseError extends Error {
  constructor(readonly campaignNames: string[]) {
    super(
      `That colour scheme is in use by ${campaignNames.length} assessment${
        campaignNames.length === 1 ? "" : "s"
      }: ${campaignNames.join(", ")}. Move ${
        campaignNames.length === 1 ? "it" : "them"
      } to another scheme first.`,
    );
    this.name = "ThemeInUseError";
  }
}

/**
 * Postgres/PostgREST both have a way of saying "no such table". Catch either.
 *
 * Narrowed to THIS table's name in the message-text fallback for the same reason
 * campaign-repository's isMissingColumn narrows to its column list: so it cannot
 * swallow a genuinely broken query somewhere else and report it as an un-applied
 * migration.
 */
function isMissingTable(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return new RegExp(`relation .*${TABLE}.* does not exist`, "i").test(error.message ?? "");
}

interface ThemeRow {
  id: string;
  client_id: string;
  name: string;
  vars: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * A row as a theme, or null if its `vars` no longer read as a token map.
 *
 * THE READ-BACK CHECK, applied at the ONE place rows become themes. Every caller
 * — the owner's picker and the public page alike — goes through here, so there is
 * no path by which an unvalidated blob becomes a CSS custom property. A row that
 * fails is dropped rather than repaired: a half-map would be a half-themed page,
 * which is the failure the closed token set exists to prevent.
 */
function rowToTheme(row: ThemeRow): CustomTheme | null {
  const vars = readbackVars(row.vars);
  if (!vars) {
    console.warn(`[assess] client_theme ${row.id} holds values that are not colours; ignoring it`);
    return null;
  }
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    vars,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every theme this practice has, newest first.
 *
 * THROWS CustomThemeTableMissingError when 0081 is not applied: the caller is an
 * owner's screen whose subject is themes.
 */
export async function listCustomThemes(clientId: string): Promise<CustomTheme[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error)) throw new CustomThemeTableMissingError();
    throw error;
  }
  return (data as ThemeRow[]).map(rowToTheme).filter((t): t is CustomTheme => t !== null);
}

/** One theme of this practice, or null. Throws if 0081 is not applied. */
export async function getCustomTheme(clientId: string, id: string): Promise<CustomTheme | null> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId) // tenancy: an id alone is never enough
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new CustomThemeTableMissingError();
    throw error;
  }
  return data ? rowToTheme(data as ThemeRow) : null;
}

/**
 * The theme a stored campaign value names, for RENDERING. Never throws.
 *
 * The public /assess page's only entry point. Every failure — 0081 not applied, a
 * deleted theme, another practice's id, a transient read error, a row whose values
 * are no longer colours — resolves to null, and the page wears the shipped default.
 * A colour is not worth a 500 on a page that ad spend points at.
 */
export async function resolveCustomTheme(
  clientId: string,
  storedTheme: string | null | undefined,
): Promise<CustomTheme | null> {
  const id = parseCustomThemeRef(storedTheme);
  // Not a custom reference at all: no query, which is why the prefix exists.
  if (!id) return null;
  try {
    return await getCustomTheme(clientId, id);
  } catch (err) {
    console.warn(`[assess] could not resolve custom theme ${id} for ${clientId}; using the default look`, err);
    return null;
  }
}

/**
 * Does THIS practice own the custom theme this stored value names?
 *
 * The second half of "may this campaign wear this theme", the first half being
 * `isPaletteKey`. The two routes that write the column compose them in that order
 * — catalogue first, so a preset costs no database read at all, and only a
 * `custom:` reference is looked up.
 *
 * IT IS ALSO THE TENANCY CHECK, and that is not a side effect. The query is scoped
 * by client_id, so another practice's theme id is not "a theme you may not use", it
 * is simply not one of your themes — which is what stops a campaign being pointed
 * at a scheme belonging to somebody else's brand.
 *
 * A missing table means no practice has any custom themes at all, so the answer is
 * an honest false. A REAL read error propagates: refusing a legitimate theme with a
 * 400 because the database blinked would be a lie about what the owner sent.
 */
export async function ownsCustomTheme(clientId: string, storedTheme: string): Promise<boolean> {
  const id = parseCustomThemeRef(storedTheme);
  if (!id) return false;
  try {
    return (await getCustomTheme(clientId, id)) !== null;
  } catch (err) {
    if (err instanceof CustomThemeTableMissingError) return false;
    throw err;
  }
}

export interface WriteThemeInput {
  clientId: string;
  name: string;
  vars: CustomTheme["vars"];
  createdBy?: string | null;
}

/** Store a new theme. The vars must already have passed validateThemeVars. */
export async function insertCustomTheme(input: WriteThemeInput): Promise<CustomTheme> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .insert({
      client_id: input.clientId,
      name: input.name,
      vars: input.vars,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (isMissingTable(error)) throw new CustomThemeTableMissingError();
    if (error.code === "23505") throw new ThemeNameTakenError(input.name); // unique (client_id, name)
    throw error;
  }
  const theme = rowToTheme(data as ThemeRow);
  // Unreachable in practice — the row was just written from validated values — but
  // rowToTheme is nullable and a silent `!` here would be the one place an invalid
  // map could be asserted into existence.
  if (!theme) throw new Error("The colour scheme was stored but could not be read back.");
  return theme;
}

/** Rename and/or re-colour an existing theme. Returns null if it is not theirs. */
export async function updateCustomTheme(
  clientId: string,
  id: string,
  patch: { name?: string; vars?: CustomTheme["vars"] },
): Promise<CustomTheme | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.vars !== undefined) row.vars = patch.vars;

  const { data, error } = await serviceClient()
    .from(TABLE)
    .update(row)
    .eq("client_id", clientId) // tenancy, on the write as well as the read
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new CustomThemeTableMissingError();
    if (error.code === "23505") throw new ThemeNameTakenError(String(patch.name ?? ""));
    throw error;
  }
  return data ? rowToTheme(data as ThemeRow) : null;
}

/**
 * The campaigns of this practice currently wearing a theme, by NAME.
 *
 * Used to refuse a delete that would re-colour a live page (and to say which pages).
 * An un-applied 0079 means no campaign can be wearing anything, so a missing
 * `theme` column answers "none" rather than failing the delete.
 */
export async function campaignsUsingTheme(clientId: string, id: string): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from("smile_assessment_campaign")
    .select("name")
    .eq("client_id", clientId)
    .eq("theme", customThemeRef(id));
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") return []; // 0079 not applied
    throw error;
  }
  return (data as { name: string }[]).map((r) => r.name);
}

/** Remove a theme. Returns false if this practice does not have one with that id. */
export async function deleteCustomTheme(clientId: string, id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .delete()
    .eq("client_id", clientId)
    .eq("id", id)
    .select("id");
  if (error) {
    if (isMissingTable(error)) throw new CustomThemeTableMissingError();
    throw error;
  }
  return (data as { id: string }[] | null)?.length === 1;
}
