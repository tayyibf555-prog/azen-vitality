import { serviceClient } from "@/lib/supabase/server";
import { londonDayKey } from "@/lib/time/london";
import type {
  DraftedBy,
  ReactivationOutboxItem,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "@/lib/reactivation/types";
import type {
  OutreachBuildCursor,
  OutreachCampaign,
  OutreachCampaignStatus,
  OutreachFilters,
  OutreachTarget,
  OutreachTargetStatus,
} from "./types";

// Outreach owns its touch + outbox tables (outreach_touch / outreach_outbox) so the
// shared messaging drain / status webhook / inbound webhook handle it with the same
// logic as recall + reactivation. There is NO cadence table: a target row carries
// its own cadence position (current_step / next_due_at).

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  client_id: string;
  site_id: string;
  name: string;
  status: string;
  filters: OutreachFilters | null;
  practitioner_id: string | null;
  practitioner_name: string | null;
  message_angle: string | null;
  daily_cap: number | string;
  build_cursor: OutreachBuildCursor | null;
  counts: Record<string, number> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetRow {
  id: string;
  campaign_id: string;
  patient_id: string;
  name: string;
  phone: string | null;
  site_id: string;
  matched_reason: string | null;
  status: string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  current_step: number | string;
  next_due_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TouchRow {
  id: string;
  target_id: string;
  campaign_id: string | null;
  site_id: string;
  step: number | string;
  channel: string;
  direction: string;
  body: string;
  drafted_by: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  sent_at: string | null;
}

interface OutboxRow {
  id: string;
  touch_id: string;
  site_id: string;
  channel: string;
  to_ref: string;
  body: string;
  status: string;
  provider: string | null;
  created_at: string;
  sent_at: string | null;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function rowToCampaign(r: CampaignRow): OutreachCampaign {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    name: r.name,
    status: r.status as OutreachCampaignStatus,
    filters: r.filters ?? {},
    practitionerId: r.practitioner_id,
    practitionerName: r.practitioner_name,
    messageAngle: r.message_angle,
    dailyCap: num(r.daily_cap),
    buildCursor: r.build_cursor,
    counts: r.counts,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTarget(r: TargetRow): OutreachTarget {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    patientId: r.patient_id,
    name: r.name,
    phone: r.phone,
    siteId: r.site_id,
    matchedReason: r.matched_reason,
    status: r.status as OutreachTargetStatus,
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    currentStep: num(r.current_step),
    nextDueAt: r.next_due_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTouch(r: TouchRow): ReactivationTouch {
  return {
    id: r.id,
    targetId: r.target_id,
    cadenceId: "", // outreach has no cadence table
    siteId: r.site_id,
    step: num(r.step),
    channel: r.channel as TouchChannel,
    direction: r.direction as ReactivationTouch["direction"],
    body: r.body,
    draftedBy: r.drafted_by as DraftedBy,
    status: r.status as TouchStatus,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function rowToOutbox(r: OutboxRow): ReactivationOutboxItem {
  return {
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    status: r.status as ReactivationOutboxItem["status"],
    provider: r.provider,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

// ---------------------------------------------------------------------------
// Campaigns.
// ---------------------------------------------------------------------------

export async function createCampaign(input: {
  clientId: string;
  siteId: string;
  name: string;
  filters: OutreachFilters;
  practitionerId?: string | null;
  practitionerName?: string | null;
  messageAngle?: string | null;
  dailyCap?: number;
  createdBy?: string | null;
}): Promise<OutreachCampaign> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_campaign")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      name: input.name,
      filters: input.filters,
      practitioner_id: input.practitionerId ?? null,
      practitioner_name: input.practitionerName ?? null,
      message_angle: input.messageAngle ?? null,
      ...(input.dailyCap !== undefined ? { daily_cap: input.dailyCap } : {}),
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCampaign(data as CampaignRow);
}

export async function getCampaign(id: string): Promise<OutreachCampaign | null> {
  const db = serviceClient();
  const { data, error } = await db.from("outreach_campaign").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToCampaign(data as CampaignRow) : null;
}

export async function listCampaigns(args: {
  clientId: string;
  statuses?: OutreachCampaignStatus[];
}): Promise<OutreachCampaign[]> {
  const db = serviceClient();
  let q = db.from("outreach_campaign").select("*").eq("client_id", args.clientId);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

/** Running campaigns across all clients, for the cron sweep. */
export async function listRunningCampaigns(): Promise<OutreachCampaign[]> {
  const db = serviceClient();
  const { data, error } = await db.from("outreach_campaign").select("*").eq("status", "running");
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

/**
 * Campaigns still BUILDING their target list, for the cron build-continuation pass.
 * A campaign created via the co-pilot runs a single bounded build tick at creation, so
 * a large base is left mid-build; without this the only thing that finishes it is the
 * Campaigns UI loop. The sweep advances these on the 24/7 schedule instead. Oldest-
 * updated first so every building campaign gets a fair turn across ticks, bounded so one
 * sweep never pulls an unbounded set.
 */
export async function listBuildingCampaigns(limit = 10): Promise<OutreachCampaign[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_campaign")
    .select("*")
    .eq("status", "building")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

export async function updateCampaign(
  id: string,
  fields: Partial<{
    status: OutreachCampaignStatus;
    buildCursor: OutreachBuildCursor | null;
    counts: Record<string, number> | null;
    dailyCap: number;
    practitionerId: string | null;
    practitionerName: string | null;
    messageAngle: string | null;
    filters: OutreachFilters;
  }>,
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.status !== undefined) row.status = fields.status;
  if (fields.buildCursor !== undefined) row.build_cursor = fields.buildCursor;
  if (fields.counts !== undefined) row.counts = fields.counts;
  if (fields.dailyCap !== undefined) row.daily_cap = fields.dailyCap;
  if (fields.practitionerId !== undefined) row.practitioner_id = fields.practitionerId;
  if (fields.practitionerName !== undefined) row.practitioner_name = fields.practitionerName;
  if (fields.messageAngle !== undefined) row.message_angle = fields.messageAngle;
  if (fields.filters !== undefined) row.filters = fields.filters;
  const { error } = await db.from("outreach_campaign").update(row).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

export interface NewTarget {
  campaignId: string;
  patientId: string;
  name: string;
  phone: string | null;
  siteId: string;
  matchedReason: string | null;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  nextDueAt: string;
}

/**
 * Enrol matched patients. INSERT with do-nothing on (campaign_id, patient_id): a
 * patient already enrolled from an earlier build tick must never be reset back to
 * 'pending'/step 0 (that would restart their cadence and re-message them). New rows
 * start 'pending' at the given next_due_at (the build enrolls them due immediately;
 * the daily cap paces the first burst). Returns how many rows were newly inserted.
 */
export async function insertTargets(targets: NewTarget[]): Promise<number> {
  if (targets.length === 0) return 0;
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const rows = targets.map((t) => ({
    campaign_id: t.campaignId,
    patient_id: t.patientId,
    name: t.name,
    phone: t.phone,
    site_id: t.siteId,
    matched_reason: t.matchedReason,
    status: "pending",
    consent: t.consent,
    current_step: 0,
    next_due_at: t.nextDueAt,
    started_at: nowIso,
  }));
  const { data, error } = await db
    .from("outreach_target")
    .upsert(rows, { onConflict: "campaign_id,patient_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function getTarget(id: string): Promise<OutreachTarget | null> {
  const db = serviceClient();
  const { data, error } = await db.from("outreach_target").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function listTargetsByCampaign(
  campaignId: string,
  opts: { limit?: number } = {},
): Promise<OutreachTarget[]> {
  const db = serviceClient();
  let q = db
    .from("outreach_target")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  // Bound the read for a UI preview so a large campaign cannot pull thousands of
  // rows into a page render; omit for the full set.
  if (typeof opts.limit === "number" && opts.limit > 0) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export interface CampaignStatusCounts {
  /** Total enrolled targets (every status). */
  built: number;
  contacted: number;
  replied: number;
  booked: number;
  /**
   * Sends stopped BEFORE dispatch, so never charged: an undeliverable number (Twilio
   * Lookup), missing consent/suppression, or the output safety guard. One honest total,
   * NOT a per-reason breakdown - the drain records every pre-send stop the same way (see
   * campaignBlockedCount).
   */
  blocked: number;
}

/**
 * Live headline counts for a campaign's list card: total enrolled ("built") plus the
 * contacted / replied / booked buckets and the blocked-before-sending total. Uses
 * head-count reads (COUNT with head:true) so nothing but the numbers crosses the wire,
 * run concurrently. Single-client pilot scale: a handful of campaigns, so a few cheap
 * counts per row is fine.
 */
export async function campaignStatusCounts(campaignId: string): Promise<CampaignStatusCounts> {
  const db = serviceClient();
  const count = async (status?: OutreachTargetStatus): Promise<number> => {
    let q = db.from("outreach_target").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    if (status) q = q.eq("status", status);
    const { count: n, error } = await q;
    if (error) throw error;
    return n ?? 0;
  };
  const [built, contacted, replied, booked, blocked] = await Promise.all([
    count(),
    count("contacted"),
    count("replied"),
    count("booked"),
    campaignBlockedCount(campaignId),
  ]);
  return { built, contacted, replied, booked, blocked };
}

/**
 * How many of a campaign's sends were BLOCKED BEFORE dispatch (never charged). The
 * shared drain marks EVERY pre-send stop - undeliverable number (Twilio Lookup), missing
 * consent/suppression, or the output safety guard - identically, by setting the outbox
 * row to status='failed' with provider='suppressed' (see markOutboxBlocked). That
 * provider marker is what distinguishes a deliberate block from a genuine provider send
 * failure, which leaves provider null. There is NO per-reason column, so this is a
 * single honest "blocked before sending" total, not a breakdown. Scoped to the campaign
 * via the touch, because the outbox has no campaign_id but the touch does.
 */
export async function campaignBlockedCount(campaignId: string): Promise<number> {
  const db = serviceClient();
  const { data: touches, error: tErr } = await db
    .from("outreach_touch")
    .select("id")
    .eq("campaign_id", campaignId);
  if (tErr) throw tErr;
  const touchIds = (touches as Array<{ id: string }>).map((t) => t.id);
  if (touchIds.length === 0) return 0;
  const { count, error } = await db
    .from("outreach_outbox")
    .select("id", { count: "exact", head: true })
    .in("touch_id", touchIds)
    .eq("status", "failed")
    .eq("provider", "suppressed");
  if (error) throw error;
  return count ?? 0;
}

/**
 * Targets whose next cadence step is due for a running campaign: an active cadence
 * status ('pending' = awaiting step 1, 'contacted' = mid-cadence) with next_due_at
 * in the past. Oldest-due first, bounded so a huge campaign cannot make one sweep
 * unbounded (the daily cap trims it further; the rest wait for the next tick).
 */
export async function listDueTargets(campaignId: string, nowIso: string, limit = 500): Promise<OutreachTarget[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_target")
    .select("*")
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "contacted"])
    .lte("next_due_at", nowIso)
    .order("next_due_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export async function setTargetStatus(
  id: string,
  status: OutreachTargetStatus,
  fields: Partial<{ nextDueAt: string | null; endedAt: string | null }> = {},
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (fields.nextDueAt !== undefined) row.next_due_at = fields.nextDueAt;
  if (fields.endedAt !== undefined) row.ended_at = fields.endedAt;
  const { error } = await db.from("outreach_target").update(row).eq("id", id);
  if (error) throw error;
}

/** Advance a target's cadence after a step has been queued. */
export async function advanceTarget(
  id: string,
  fields: { currentStep: number; status: OutreachTargetStatus; nextDueAt: string | null; endedAt: string | null },
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("outreach_target")
    .update({
      current_step: fields.currentStep,
      status: fields.status,
      next_due_at: fields.nextDueAt,
      ended_at: fields.endedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Daily cap. Counts today's OUTBOUND touches for a campaign (each queued send
// inserts exactly one), so the per-campaign daily_cap can be enforced before
// drafting. Mirrors recall.countContactedToday but scoped to the campaign.
// ---------------------------------------------------------------------------

/**
 * The UTC instant of today's Europe/London midnight, as ISO. DST-correct: tries
 * both possible UK offsets and keeps the one that renders as 00:00 on today's
 * London date. Mirrors recall's londonDayStartIso so every daily cap buckets
 * "today" by exactly the same London-day definition.
 */
function londonDayStartIso(now: Date): string {
  const day = londonDayKey(now);
  for (const offset of ["+01:00", "+00:00"]) {
    const candidate = new Date(`${day}T00:00:00${offset}`);
    const rendered = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const d = `${rendered.find((p) => p.type === "year")?.value}-${rendered.find((p) => p.type === "month")?.value}-${rendered.find((p) => p.type === "day")?.value}`;
    const h = rendered.find((p) => p.type === "hour")?.value;
    if (d === day && (h === "00" || h === "24")) return candidate.toISOString();
  }
  return new Date(`${day}T00:00:00Z`).toISOString();
}

/**
 * How many outreach messages this campaign has queued so far today (Europe/London):
 * counts today's OUTBOUND outreach_touch rows for the campaign. On error returns 0
 * (the cap still applies from zero; a read blip never blocks the sweep).
 */
export async function countContactedToday(campaignId: string, now: Date): Promise<number> {
  try {
    const { count, error } = await serviceClient()
      .from("outreach_touch")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("direction", "outbound")
      .gte("created_at", londonDayStartIso(now));
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    console.error("[outreach] countContactedToday failed; assuming 0 used (cap still applies)", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Touches + outbox (outreach_touch / outreach_outbox). Shapes mirror recall.
// ---------------------------------------------------------------------------

export async function insertTouch(input: {
  targetId: string;
  campaignId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_touch")
    .insert({
      target_id: input.targetId,
      campaign_id: input.campaignId,
      site_id: input.siteId,
      step: input.step,
      channel: input.channel,
      body: input.body,
      drafted_by: input.draftedBy,
      ...(input.status ? { status: input.status } : {}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToTouch(data as TouchRow);
}

export async function listTouches(targetId: string): Promise<ReactivationTouch[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_touch")
    .select("*")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_touch")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", touchId)
    .select("*")
    .single();
  if (error) throw error;
  return rowToTouch(data as TouchRow);
}

export async function enqueueOutbox(input: {
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
}): Promise<ReactivationOutboxItem> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_outbox")
    .insert({
      touch_id: input.touchId,
      site_id: input.siteId,
      channel: input.channel,
      to_ref: input.toRef,
      body: input.body,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToOutbox(data as OutboxRow);
}

export interface QueuedOutbox {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
  createdAt: string;
}

export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    // Batch cap: bound a drain run so a large backlog cannot push it past
    // maxDuration; the next tick picks up the rest (oldest first). Mirrors recall.
    .limit(100);
  if (error) throw error;
  return (data as Array<{
    id: string; touch_id: string; site_id: string; channel: string; to_ref: string; body: string; created_at: string;
  }>).map((r) => ({
    id: r.id, touchId: r.touch_id, siteId: r.site_id, channel: r.channel as TouchChannel, toRef: r.to_ref, body: r.body, createdAt: r.created_at,
  }));
}

export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("outreach_outbox")
    .update({
      status: "sent",
      provider: fields.provider,
      provider_message_id: fields.providerMessageId,
      to_address: fields.toAddress,
      sent_at: nowIso,
    })
    .eq("id", outboxId);
  if (oErr) throw oErr;
  const { error: tErr } = await db
    .from("outreach_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

/** Atomically claim a queued row for sending (queued -> sending); true only if THIS
 *  call transitioned it. At-most-once; mirrors recall.claimOutbox. */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// A failed/blocked outbox row must ALSO fail its outreach_touch, so a target is not
// frozen mid-cadence: the sweep's hasPending predicate treats anything other than
// 'sent'/'failed' as pending and would skip the target forever. Mirrors recall.
async function failLinkedTouch(db: ReturnType<typeof serviceClient>, outboxId: string): Promise<void> {
  const { data } = await db.from("outreach_outbox").select("touch_id").eq("id", outboxId).maybeSingle();
  const touchId = (data as { touch_id?: string } | null)?.touch_id;
  if (touchId) {
    const { error } = await db.from("outreach_touch").update({ status: "failed" }).eq("id", touchId);
    if (error) throw error;
  }
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("outreach_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("outreach_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("outreach_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** The most recent outreach outbound to an address, with its target (via the touch).
 *  Mirrors recall.findTargetByAddress so the inbound webhook correlates a reply to
 *  the exact address it messaged. */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ targetId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outreach_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("outreach_touch")
    .select("target_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return { targetId: (touch as { target_id: string }).target_id, siteId: row.site_id };
}

export async function insertInboundTouch(input: {
  targetId: string;
  campaignId: string | null;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("outreach_touch").insert({
    target_id: input.targetId,
    campaign_id: input.campaignId,
    site_id: input.siteId,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
  });
  if (error) throw error;
}

/** The campaign id a target belongs to (for inbound reply linkage / agent context). */
export async function getCampaignIdForTarget(targetId: string): Promise<string | null> {
  const db = serviceClient();
  const { data, error } = await db.from("outreach_target").select("campaign_id").eq("id", targetId).maybeSingle();
  if (error) throw error;
  return data ? (data as { campaign_id: string }).campaign_id : null;
}
