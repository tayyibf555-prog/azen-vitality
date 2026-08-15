import { serviceClient } from "@/lib/supabase/server";
import type { Campaign, CampaignStatus } from "./campaign";
import type { FlowGraph } from "./flow";
import { describeFlowFailures, validateFlow, type FlowValidationFailure } from "./flow-validate";
import { describeFlowCopyHits, scanFlowCopy, type FlowCopyHit } from "./flow-copy";

// Server-only CRUD for smile_assessment_campaign (service-role; the public landing
// reads via a safe-field GET, the internal management UI is requireUser-scoped).

// Thrown when a (client, slug) already exists — the API maps this to 409 so the
// owner can pick a different URL.
export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`The URL "${slug}" is already in use for this practice.`);
    this.name = "SlugTakenError";
  }
}

interface CampaignRow {
  id: string;
  client_id: string;
  site_id: string;
  slug: string;
  name: string;
  goal: string;
  goal_note: string | null;
  ideal_customer: string | null;
  target_budget: string;
  headline: string | null;
  intro: string | null;
  status: string;
  // 0078. Optional in the TYPE on purpose, because they are optional in reality:
  // 0078 is written but not applied, so `select("*")` against today's table simply
  // does not return these three keys. Marking them required would be a lie the
  // compiler happily believes, and the first campaign read would hand the runtime
  // `flowVersion: undefined`. See the defaulting in rowToCampaign.
  flow?: unknown;
  flow_version?: number | null;
  flow_published?: boolean | null;
  // 0079, optional for exactly the reason the three above are: the migration is
  // written and not applied, so select("*") does not return this key today.
  theme?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCampaign(r: CampaignRow): Campaign {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    slug: r.slug,
    name: r.name,
    goal: r.goal,
    goalNote: r.goal_note,
    idealCustomer: r.ideal_customer,
    targetBudget: r.target_budget,
    headline: r.headline,
    intro: r.intro,
    status: (r.status as CampaignStatus) ?? "active",
    // The pre-0078 defaults, and the ONLY place they are decided. All three point
    // the same way: no funnel, never saved, not published, i.e. the adaptive quiz
    // this campaign already runs. A practice on an un-migrated database sees
    // exactly today's behaviour rather than an error.
    flow: r.flow ?? null,
    flowVersion: typeof r.flow_version === "number" ? r.flow_version : 0,
    flowPublished: r.flow_published === true,
    // The pre-0079 default, decided once, here. null is "the default look", and
    // it is what an un-migrated row, an un-migrated database and an owner who
    // never opened the picker all produce — three roads to the same pixels.
    // Empty string normalises to null too: "" is not a palette key, and letting
    // it through would make paletteFor do the same work again downstream.
    theme: typeof r.theme === "string" && r.theme.trim() !== "" ? r.theme : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertCampaignInput {
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  goal: string;
  goalNote?: string | null;
  idealCustomer?: string | null;
  targetBudget: string;
  headline?: string | null;
  intro?: string | null;
  /**
   * A PALETTES key (0079), or null for the default look. Validated at the route
   * against the closed list, exactly as `goal` is against GOAL_KEYS.
   */
  theme?: string | null;
  createdBy?: string | null;
}

export async function insertCampaign(input: InsertCampaignInput): Promise<Campaign> {
  const db = serviceClient();
  const base = {
    client_id: input.clientId,
    site_id: input.siteId,
    slug: input.slug,
    name: input.name,
    goal: input.goal,
    goal_note: input.goalNote ?? null,
    ideal_customer: input.idealCustomer ?? null,
    target_budget: input.targetBudget,
    headline: input.headline ?? null,
    intro: input.intro ?? null,
    created_by: input.createdBy ?? null,
  };

  const create = (row: Record<string, unknown>) =>
    db.from("smile_assessment_campaign").insert(row).select("*").single();

  let { data, error } = await create({ ...base, theme: input.theme ?? null });

  // 0079 IS WRITTEN AND NOT APPLIED, AND THIS IS WHAT MAKES THAT SAFE.
  //
  // Creating an assessment is the practice's live front door. If this code
  // deploys before someone runs 0079, an insert naming a column the table does
  // not have would 500 EVERY create — a colour picker taking the create path
  // down with it. So on exactly that error, and no other, the same insert is
  // retried without the column. The campaign is created unthemed, which is the
  // honest thing an un-migrated database can store, and it starts rendering its
  // scheme the moment the migration lands and the owner re-picks.
  //
  // Note this cannot mask a real failure: a duplicate slug is 23505 and falls
  // straight through to SlugTakenError below, and the retry runs the identical
  // row minus one key.
  if (error && isMissingColumn(error, THEME_COLUMNS)) {
    ({ data, error } = await create(base));
  }

  if (error) {
    if (error.code === "23505") throw new SlugTakenError(input.slug); // unique (client_id, slug)
    throw error;
  }
  return rowToCampaign(data as CampaignRow);
}

/** A campaign by (client, slug), any status. Used by submit attribution. */
export async function getCampaignBySlug(clientId: string, slug: string): Promise<Campaign | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_campaign")
    .select("*")
    .eq("client_id", clientId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCampaign(data as CampaignRow) : null;
}

/** Active campaign by (client, slug). The public landing 404s on null/paused. */
export async function getActiveCampaignBySlug(clientId: string, slug: string): Promise<Campaign | null> {
  const c = await getCampaignBySlug(clientId, slug);
  return c && c.status === "active" ? c : null;
}

export async function listCampaigns(clientId: string): Promise<Campaign[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_campaign")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

export async function setCampaignStatus(id: string, clientId: string, status: CampaignStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("smile_assessment_campaign")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId); // scope the write to the caller's client
  if (error) throw error;
}

/** Migration 0079 has not been applied to this database yet. */
export class ThemeColumnMissingError extends Error {
  constructor() {
    super("Colour schemes need migration 0079_assessment_theme.sql to be applied.");
    this.name = "ThemeColumnMissingError";
  }
}

/**
 * Re-colour an existing assessment. `theme` is a PALETTES key, or null for the
 * default look.
 *
 * WHY THIS ONE REPORTS THE MISSING COLUMN AND insertCampaign SWALLOWS IT. There,
 * the theme is a garnish on a request whose real subject is "create this
 * assessment", and failing the whole create over a colour would be absurd. Here
 * the theme IS the request: quietly succeeding at nothing would leave an owner
 * clicking a swatch that never takes, with no way to find out why. The route
 * turns this into a 503 naming the migration, the same shape the funnel PUT uses
 * for 0078 (flow/route.ts:151).
 */
export async function setCampaignTheme(
  id: string,
  clientId: string,
  theme: string | null,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("smile_assessment_campaign")
    .update({ theme, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId); // scope the write to the caller's client
  if (error) {
    if (isMissingColumn(error, THEME_COLUMNS)) throw new ThemeColumnMissingError();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The authored funnel (0078).
//
// THIS FUNCTION IS THE CHOKE POINT, and that is its whole design.
//
// A funnel graph is the only thing in this module that can put NEW WORDS in front
// of a patient and can silently change how leads are scored. Both checks therefore
// live here, on the single path that writes the column, rather than at each call
// site: the PUT route runs them too (so it can answer 400 with the list rather
// than a 500), and the AI generator will want them as well, and "everyone
// remembers to call the validator" is not a guarantee, it is a hope.
//
// The two failures are DIFFERENT ERRORS on purpose. "This graph is not a valid
// funnel" and "this wording is not allowed in front of a patient" need different
// wording back to the owner, and only the first is something the AI repair pass
// can be asked to fix by re-routing.
// ---------------------------------------------------------------------------

/** The graph broke one or more of the eleven rules. Carries all of them. */
export class FlowInvalidError extends Error {
  constructor(readonly failures: FlowValidationFailure[]) {
    super(`The funnel is not valid:\n${describeFlowFailures(failures)}`);
    this.name = "FlowInvalidError";
  }
}

/** Authored copy in the graph is non-compliant. Carries every offending string. */
export class FlowCopyRejectedError extends Error {
  constructor(readonly hits: FlowCopyHit[]) {
    super(`The funnel's wording cannot be published:\n${describeFlowCopyHits(hits)}`);
    this.name = "FlowCopyRejectedError";
  }
}

/** Someone else saved this funnel since it was loaded. The caller re-reads. */
export class FlowVersionConflictError extends Error {
  constructor(readonly storedVersion: number) {
    super("This funnel was saved by someone else. Reload it and try again.");
    this.name = "FlowVersionConflictError";
  }
}

/** Migration 0078 has not been applied to this database yet. */
export class FlowColumnsMissingError extends Error {
  constructor() {
    super("The funnel builder needs migration 0078_assessment_flow.sql to be applied.");
    this.name = "FlowColumnsMissingError";
  }
}

/**
 * Postgres/PostgREST both have a way of saying "no such column". Catch either.
 *
 * `columns` narrows the message-text fallback so this cannot swallow a genuine
 * typo somewhere else in the same query. 0078's three flow columns were the
 * original caller; 0079's `theme` is the second.
 */
function isMissingColumn(
  error: { code?: string | null; message?: string | null } | null,
  columns: string[],
): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const named = columns.join("|");
  return new RegExp(`column .*(${named}).* does not exist`, "i").test(error.message ?? "");
}

const FLOW_COLUMNS = ["flow", "flow_version", "flow_published"];
const THEME_COLUMNS = ["theme"];

export interface UpdateCampaignFlowInput {
  id: string;
  /** Scopes the write to the caller's practice, exactly as setCampaignStatus does. */
  clientId: string;
  /** The graph to store. Omit to leave the stored graph untouched. */
  flow?: FlowGraph;
  /** Publish state to set. Omit to leave it unchanged. */
  published?: boolean;
  /**
   * The flow_version the caller believes is current. When supplied and it is not,
   * the write is refused rather than silently overwriting a colleague's save. The
   * builder sends the version it loaded; a publish-only toggle can omit it.
   */
  expectedVersion?: number;
}

export interface CampaignFlowState {
  flowVersion: number;
  flowPublished: boolean;
}

/**
 * Save and/or publish a campaign's authored funnel. Returns the state afterwards.
 *
 * The version is bumped ONLY when the graph itself changes: publishing what is
 * already stored is not a new version of the funnel, and treating it as one would
 * make flow_version useless for attributing a response to the funnel that produced
 * it (0078, smile_assessment_response.flow_version).
 */
export async function updateCampaignFlow(input: UpdateCampaignFlowInput): Promise<CampaignFlowState> {
  if (input.flow) {
    const result = validateFlow(input.flow);
    if (!result.ok) throw new FlowInvalidError(result.failures);
    const hits = scanFlowCopy(input.flow);
    if (hits.length > 0) throw new FlowCopyRejectedError(hits);
  }

  const db = serviceClient();
  const { data: current, error: readError } = await db
    .from("smile_assessment_campaign")
    .select("flow_version, flow_published")
    .eq("id", input.id)
    .eq("client_id", input.clientId)
    .maybeSingle();
  if (readError) {
    if (isMissingColumn(readError, FLOW_COLUMNS)) throw new FlowColumnsMissingError();
    throw readError;
  }
  if (!current) throw new FlowVersionConflictError(0); // gone, or not this client's

  const storedVersion = typeof current.flow_version === "number" ? current.flow_version : 0;
  if (typeof input.expectedVersion === "number" && input.expectedVersion !== storedVersion) {
    throw new FlowVersionConflictError(storedVersion);
  }

  const nextVersion = input.flow ? storedVersion + 1 : storedVersion;
  const nextPublished =
    typeof input.published === "boolean" ? input.published : current.flow_published === true;

  const patch: Record<string, unknown> = {
    flow_version: nextVersion,
    flow_published: nextPublished,
    updated_at: new Date().toISOString(),
  };
  if (input.flow) patch.flow = input.flow;

  // Guarded on the version we just read, so two simultaneous saves cannot both
  // land: the loser matches no row and is told to reload. Postgres gives no
  // read-then-write atomicity here otherwise, and a lost funnel edit is invisible.
  const { data: written, error: writeError } = await db
    .from("smile_assessment_campaign")
    .update(patch)
    .eq("id", input.id)
    .eq("client_id", input.clientId)
    .eq("flow_version", storedVersion)
    .select("flow_version, flow_published")
    .maybeSingle();
  if (writeError) {
    if (isMissingColumn(writeError, FLOW_COLUMNS)) throw new FlowColumnsMissingError();
    throw writeError;
  }
  if (!written) throw new FlowVersionConflictError(storedVersion);

  return {
    flowVersion: typeof written.flow_version === "number" ? written.flow_version : nextVersion,
    flowPublished: written.flow_published === true,
  };
}

/** Response counts per campaign id, for the internal management list. */
export async function countResponsesByCampaign(campaignIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (campaignIds.length === 0) return out;
  const db = serviceClient();
  // One exact head-count per campaign rather than fetching one row per response:
  // the row-fetch was capped at PostgREST's 1000-row default, so a popular campaign's
  // count silently stopped at 1000. Campaign counts are few, so N small count queries.
  await Promise.all(
    campaignIds.map(async (id) => {
      const { count, error } = await db
        .from("smile_assessment_response")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", id);
      if (error) throw error;
      out[id] = count ?? 0;
    }),
  );
  return out;
}
