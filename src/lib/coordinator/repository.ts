import { serviceClient } from "@/lib/supabase/server";
import type {
  CoordinatorTouch,
  DraftedBy,
  OpportunityStatus,
  OutboxItem,
  TouchChannel,
  TouchStatus,
  TreatmentOpportunity,
} from "./types";

// ---------------------------------------------------------------------------
// DB row shapes (snake_case, as stored in Postgres / returned by supabase-js).
// ---------------------------------------------------------------------------

interface OpportunityRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  dentally_plan_id: string;
  patient_name: string;
  treatment: string;
  planned_value: number | string;
  amount_outstanding: number | string;
  accepted_at: string | null;
  status: string;
  finance_presented: boolean;
  last_touch_at: string | null;
  priority_score: number | string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  updated_from_dentally_at: string;
}

interface TouchRow {
  id: string;
  opportunity_id: string;
  site_id: string;
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

interface SyncStateRow {
  site_id: string;
  resource: string;
  high_water_mark: string | null;
  last_run_at: string | null;
}

// ---------------------------------------------------------------------------
// Mappers (row <-> domain).
// ---------------------------------------------------------------------------

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function rowToOpportunity(row: OpportunityRow): TreatmentOpportunity {
  return {
    id: row.id,
    siteId: row.site_id,
    dentallyPatientId: row.dentally_patient_id,
    dentallyPlanId: row.dentally_plan_id,
    patientName: row.patient_name,
    treatment: row.treatment,
    plannedValue: toNumber(row.planned_value),
    amountOutstanding: toNumber(row.amount_outstanding),
    acceptedAt: row.accepted_at ?? "",
    status: row.status as OpportunityStatus,
    financePresented: row.finance_presented,
    lastTouchAt: row.last_touch_at,
    priorityScore: toNumber(row.priority_score),
    consent: {
      sms: row.consent?.sms ?? false,
      email: row.consent?.email ?? false,
      marketing: row.consent?.marketing ?? false,
    },
    updatedFromDentallyAt: row.updated_from_dentally_at,
  };
}

function opportunityToRow(opp: TreatmentOpportunity): OpportunityRow {
  return {
    id: opp.id,
    site_id: opp.siteId,
    dentally_patient_id: opp.dentallyPatientId,
    dentally_plan_id: opp.dentallyPlanId,
    patient_name: opp.patientName,
    treatment: opp.treatment,
    planned_value: opp.plannedValue,
    amount_outstanding: opp.amountOutstanding,
    accepted_at: opp.acceptedAt || null,
    status: opp.status,
    finance_presented: opp.financePresented,
    last_touch_at: opp.lastTouchAt,
    priority_score: opp.priorityScore,
    consent: opp.consent,
    updated_from_dentally_at: opp.updatedFromDentallyAt,
  };
}

function rowToTouch(row: TouchRow): CoordinatorTouch {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    siteId: row.site_id,
    channel: row.channel as TouchChannel,
    direction: row.direction as CoordinatorTouch["direction"],
    body: row.body,
    draftedBy: row.drafted_by as DraftedBy,
    status: row.status as TouchStatus,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function rowToOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    touchId: row.touch_id,
    siteId: row.site_id,
    channel: row.channel as TouchChannel,
    toRef: row.to_ref,
    body: row.body,
    status: row.status as OutboxItem["status"],
    provider: row.provider,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

// ---------------------------------------------------------------------------
// Opportunities.
// ---------------------------------------------------------------------------

export async function upsertOpportunities(
  opps: TreatmentOpportunity[],
): Promise<void> {
  if (opps.length === 0) return;
  const db = serviceClient();

  // The sync builds every opportunity with lastTouchAt:null, status:'accepted' and
  // financePresented:false — Dentally does not own the cadence/engagement state. A
  // blind full-row upsert would therefore WIPE that state on every re-sync, collapsing
  // the cadence (steps fire early and bunched, because a null last_touch_at reads as
  // "due now") and silently reverting a coordinator's manually set 'stalled'/'completed'
  // status. Preserve the workflow-owned columns for opportunities that already exist;
  // only the Dentally-owned columns (values, consent, plan) are refreshed.
  const ids = opps.map((o) => o.id);
  const existing = new Map<string, { status: string; finance_presented: boolean; last_touch_at: string | null }>();
  const CHUNK = 200; // bound the id list per request
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("treatment_opportunity")
      .select("id, status, finance_presented, last_touch_at")
      .in("id", slice);
    if (error) throw error;
    for (const r of (data as Array<{ id: string; status: string; finance_presented: boolean; last_touch_at: string | null }>) ?? []) {
      existing.set(r.id, { status: r.status, finance_presented: r.finance_presented, last_touch_at: r.last_touch_at });
    }
  }

  const rows = opps.map((opp) => {
    const row = opportunityToRow(opp);
    const prev = existing.get(opp.id);
    if (prev) {
      row.status = prev.status;
      row.finance_presented = prev.finance_presented;
      row.last_touch_at = prev.last_touch_at;
    }
    return row;
  });

  const { error } = await db
    .from("treatment_opportunity")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function listOpportunities(args: {
  siteIds: string[];
  statuses?: OpportunityStatus[];
}): Promise<TreatmentOpportunity[]> {
  const db = serviceClient();
  let query = db
    .from("treatment_opportunity")
    .select("*")
    .in("site_id", args.siteIds);
  if (args.statuses && args.statuses.length > 0) {
    query = query.in("status", args.statuses);
  }
  // PAGE EXPLICITLY. This select used to be unbounded, which quietly relied on
  // PostgREST's default max-rows: past that ceiling it returns a truncated set with no
  // error and no signal. That was survivable while nothing depended on completeness,
  // but the coordinator's retire step and re-check rotation now do, and a silently
  // short list would retire opportunities that are still open. Paging in fixed blocks
  // makes the read complete, with an absolute ceiling so a runaway table cannot
  // exhaust memory, and a loud warning if that ceiling is ever reached.
  // ONE ROW UNDER THE SERVER'S CEILING (ruling W3/32). `batch.length < PAGE` is
  // what this loop treats as "the whole table", and Supabase clips every response
  // at a max-rows ceiling measured at 1,000 (POSTGREST_MAX_ROWS in
  // src/lib/test-support/fake-supabase.ts). At exactly 1,000 a clipped page and a
  // final page are the same observation, so a server cap below the page size
  // would RETURN EARLY with a truncated list that claims to be complete — and the
  // retire step would then retire opportunities that are still open. At 999 a
  // short page can only mean the rows ran out.
  const PAGE = 999;
  const MAX_ROWS = 50_000;
  const rows: OpportunityRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await query
      .order("priority_score", { ascending: false })
      .order("id", { ascending: true }) // tiebreak, so paging cannot repeat or skip a row
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as OpportunityRow[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows.map(rowToOpportunity);
  }
  console.warn(
    `[coordinator] listOpportunities hit the ${MAX_ROWS} row ceiling for sites ${args.siteIds.join(", ")}; the result is truncated`,
  );
  return rows.map(rowToOpportunity);
}

export async function getOpportunity(
  id: string,
): Promise<TreatmentOpportunity | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("treatment_opportunity")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToOpportunity(data as OpportunityRow);
}

export async function setFinancePresented(
  opportunityId: string,
  value: boolean,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("treatment_opportunity")
    .update({ finance_presented: value })
    .eq("id", opportunityId);
  if (error) throw error;
}

export async function setLastTouchAt(
  opportunityId: string,
  iso: string,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("treatment_opportunity")
    .update({ last_touch_at: iso })
    .eq("id", opportunityId);
  if (error) throw error;
}

/** Move an opportunity to a new lifecycle status (e.g. 'completed' once its plan
 * is paid/terminal), so the sweep stops targeting it. */
export async function setOpportunityStatus(
  opportunityId: string,
  status: OpportunityStatus,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("treatment_opportunity")
    .update({ status })
    .eq("id", opportunityId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches.
// ---------------------------------------------------------------------------

export async function insertTouch(input: {
  opportunityId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<CoordinatorTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("coordinator_touch")
    .insert({
      opportunity_id: input.opportunityId,
      site_id: input.siteId,
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

export async function listTouches(
  opportunityId: string,
): Promise<CoordinatorTouch[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("coordinator_touch")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

/**
 * Approve a touch, transitioning it draft -> approved. Conditional on the row still
 * being 'draft' so a double-clicked / retried approve does NOT re-transition and let
 * the caller enqueue a SECOND outbox row (double send). Returns null when zero rows
 * transition (already approved/queued/sent); the caller must then skip enqueue.
 */
export async function approveTouch(
  touchId: string,
  approvedBy: string,
): Promise<CoordinatorTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("coordinator_touch")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", touchId)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTouch(data as TouchRow) : null;
}

// ---------------------------------------------------------------------------
// Outbox.
// ---------------------------------------------------------------------------

export async function enqueueOutbox(input: {
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
}): Promise<OutboxItem> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outbox")
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

// ---------------------------------------------------------------------------
// Drain-facing helpers. The coordinator reuses the generic `outbox` table, so
// these correlate outbox rows back to a coordinator_touch (and from there to an
// opportunity) by touch_id / opportunity_id. Shapes mirror recall/repository so
// the shared messaging drain, status webhook and inbound webhook handle the
// coordinator with the same logic.
// ---------------------------------------------------------------------------

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
    .from("outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    // Batch cap: bound a drain run so a large backlog cannot push it past
    // maxDuration; the next 5-minute tick picks up the rest (oldest first).
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
    .from("outbox")
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
    .from("coordinator_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

/** Mark the linked coordinator_touch failed too, so the sweep's pending-guard
 * does not treat a permanently-failed 'approved' touch as still in flight (which
 * would wedge the opportunity and never retry/advance the cadence). */
async function failLinkedTouch(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { data } = await db.from("outbox").select("touch_id").eq("id", outboxId).maybeSingle();
  const touchId = (data as { touch_id: string } | null)?.touch_id;
  if (touchId) await db.from("coordinator_touch").update({ status: "failed" }).eq("id", touchId);
}

/** Atomically claim a queued row for sending (queued -> sending); true only if THIS
 *  call transitioned it. See the drain: prevents a mid-run kill after dispatch from
 *  re-sending the row on the next tick. At-most-once. */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(outboxId);
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(outboxId);
}

export async function updateOutboxStatusByMessageId(
  providerMessageId: string,
  status: string,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** Find the most recent coordinator outbound to an address, with its opportunity (via the touch). */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ opportunityId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("coordinator_touch")
    .select("opportunity_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return { opportunityId: (touch as { opportunity_id: string }).opportunity_id, siteId: row.site_id };
}

export async function insertInboundTouch(input: {
  opportunityId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("coordinator_touch").insert({
    opportunity_id: input.opportunityId,
    site_id: input.siteId,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Sync state.
// ---------------------------------------------------------------------------

export async function getSyncState(
  siteId: string,
  resource: string,
): Promise<{ highWaterMark: string | null } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("sync_state")
    .select("*")
    .eq("site_id", siteId)
    .eq("resource", resource)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as SyncStateRow;
  return { highWaterMark: row.high_water_mark };
}

export async function setSyncState(
  siteId: string,
  resource: string,
  highWaterMark: string,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("sync_state").upsert(
    {
      site_id: siteId,
      resource,
      high_water_mark: highWaterMark,
      last_run_at: new Date().toISOString(),
    },
    { onConflict: "site_id,resource" },
  );
  if (error) throw error;
}

/**
 * One-time historical-backfill cursor for a (site, resource). Lives in dedicated
 * sync_state columns (backfill_page is an integer page number, backfill_done a flag)
 * — high_water_mark is a timestamptz and cannot hold a page number. `done=false`
 * (the default on any existing row) means the full pass has not finished yet.
 *
 * THOSE TWO COLUMNS ARE NOT IN 0001, WHICH CREATES THE REST OF sync_state. They
 * were added straight in Supabase by commit e28db19 and no migration carried
 * them, so production had six columns and a database replayed from
 * supabase/migrations had four — this read then threw 42703 on the first tick of
 * all three syncs that call it (coordinator, recall, reactivation). Declared by
 * 0106_sync_state_backfill_cursor_columns.sql; the drift is pinned for the class,
 * not just for these two names, by sync-state-backfill-columns.test.ts. The fake
 * client cannot catch it: it ignores the select projection, so a sync_state with
 * neither column answers `undefined` for both and reads as "not started yet".
 */
export async function getBackfillCursor(
  siteId: string,
  resource: string,
): Promise<{ page: number | null; done: boolean }> {
  const db = serviceClient();
  const { data, error } = await db
    .from("sync_state")
    .select("backfill_page, backfill_done")
    .eq("site_id", siteId)
    .eq("resource", resource)
    .maybeSingle();
  if (error) throw error;
  const row = data as { backfill_page: number | null; backfill_done: boolean } | null;
  return { page: row?.backfill_page ?? null, done: row?.backfill_done ?? false };
}

/**
 * Persist the backfill cursor. On completion pass highWaterMark to seed the
 * incremental mark in the SAME upsert, so done + the mark are set atomically (a
 * partial write can never leave done=true with an unset mark).
 */
export async function setBackfillCursor(
  siteId: string,
  resource: string,
  opts: { page: number | null; done: boolean; highWaterMark?: string },
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = {
    site_id: siteId,
    resource,
    backfill_page: opts.page,
    backfill_done: opts.done,
    last_run_at: new Date().toISOString(),
  };
  if (opts.highWaterMark !== undefined) row.high_water_mark = opts.highWaterMark;
  const { error } = await db.from("sync_state").upsert(row, { onConflict: "site_id,resource" });
  if (error) throw error;
}
