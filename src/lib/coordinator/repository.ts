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
  const rows = opps.map(opportunityToRow);
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
  const { data, error } = await query.order("priority_score", {
    ascending: false,
  });
  if (error) throw error;
  return (data as OpportunityRow[]).map(rowToOpportunity);
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

export async function approveTouch(
  touchId: string,
  approvedBy: string,
): Promise<CoordinatorTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("coordinator_touch")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", touchId)
    .select("*")
    .single();
  if (error) throw error;
  return rowToTouch(data as TouchRow);
}

export async function markTouchSent(touchId: string): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: touchError } = await db
    .from("coordinator_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (touchError) throw touchError;
  const { error: outboxError } = await db
    .from("outbox")
    .update({ status: "sent", provider: "stub", sent_at: nowIso })
    .eq("touch_id", touchId);
  if (outboxError) throw outboxError;
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
}

export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("outbox")
    .select("id, touch_id, site_id, channel, to_ref, body")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    // Batch cap: bound a drain run so a large backlog cannot push it past
    // maxDuration; the next 5-minute tick picks up the rest (oldest first).
    .limit(100);
  if (error) throw error;
  return (data as Array<{
    id: string; touch_id: string; site_id: string; channel: string; to_ref: string; body: string;
  }>).map((r) => ({
    id: r.id, touchId: r.touch_id, siteId: r.site_id, channel: r.channel as TouchChannel, toRef: r.to_ref, body: r.body,
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
