import { serviceClient } from "@/lib/supabase/server";
import type {
  CadenceStatus,
  DraftedBy,
  ReactivationOutboxItem,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "@/lib/reactivation/types";
import type { RecallCadence, RecallStatus, RecallTarget, RecallType } from "./types";

// Re-export shared sync_state helpers (DRY: identical, resource-generic).
export { getSyncState, setSyncState } from "@/lib/coordinator/repository";

// Recall owns its touch + outbox tables (recall_touch / recall_outbox) because
// reactivation_touch has FKs to reactivation_target/cadence and cannot hold
// recall rows. The shapes mirror reactivation exactly, so the shared messaging
// drain / status webhook / inbound webhook handle both with the same logic.

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  recall_type: string;
  due_at: string;
  overdue_days: number | string;
  last_visit_at: string | null;
  prior_attempts: number | string;
  status: string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  updated_from_dentally_at: string;
}

interface CadenceRow {
  id: string;
  target_id: string;
  site_id: string;
  current_step: number | string;
  status: string;
  next_due_at: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function rowToTarget(r: TargetRow): RecallTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    recallType: r.recall_type as RecallType,
    dueAt: r.due_at,
    overdueDays: num(r.overdue_days),
    lastVisitAt: r.last_visit_at,
    priorAttempts: num(r.prior_attempts),
    status: r.status as RecallStatus,
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    updatedFromDentallyAt: r.updated_from_dentally_at,
  };
}

function targetToRow(t: RecallTarget): TargetRow {
  return {
    id: t.id,
    site_id: t.siteId,
    dentally_patient_id: t.dentallyPatientId,
    patient_name: t.patientName,
    recall_type: t.recallType,
    due_at: t.dueAt,
    overdue_days: t.overdueDays,
    last_visit_at: t.lastVisitAt,
    prior_attempts: t.priorAttempts,
    status: t.status,
    consent: t.consent,
    updated_from_dentally_at: t.updatedFromDentallyAt,
  };
}

function rowToCadence(r: CadenceRow): RecallCadence {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    currentStep: num(r.current_step),
    status: r.status as CadenceStatus,
    nextDueAt: r.next_due_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

export async function upsertTargets(targets: RecallTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const db = serviceClient();
  const { error } = await db
    .from("recall_target")
    .upsert(targets.map(targetToRow), { onConflict: "id" });
  if (error) throw error;
}

export async function listTargets(args: {
  siteIds: string[];
  recallTypes?: RecallType[];
  statuses?: RecallStatus[];
}): Promise<RecallTarget[]> {
  const db = serviceClient();
  let q = db.from("recall_target").select("*").in("site_id", args.siteIds);
  if (args.recallTypes && args.recallTypes.length > 0) q = q.in("recall_type", args.recallTypes);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("due_at", { ascending: true });
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export async function getTarget(id: string): Promise<RecallTarget | null> {
  const db = serviceClient();
  const { data, error } = await db.from("recall_target").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function setTargetStatus(id: string, status: RecallStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_target").update({ status }).eq("id", id);
  if (error) throw error;
}

/** A recall that aged past the grace boundary hands off to reactivation. */
export async function markGraduated(id: string): Promise<void> {
  await setTargetStatus(id, "graduated");
}

export async function incrementPriorAttempts(id: string): Promise<void> {
  const db = serviceClient();
  const current = await getTarget(id);
  if (!current) return;
  const { error } = await db
    .from("recall_target")
    .update({ prior_attempts: current.priorAttempts + 1 })
    .eq("id", id);
  if (error) throw error;
}

/**
 * The `${siteId}:${patientId}` keys of patients with an OPEN recall target
 * (status `due` or `in_cadence`), whether or not a cadence has been enrolled.
 * Reactivation uses this to avoid double-messaging a patient the recall module
 * still owns. Graduated/converted/exhausted recalls are excluded, so reactivation
 * correctly adopts a recall once it has been handed off past the grace boundary.
 */
export async function listOpenRecallPatientKeys(siteIds: string[]): Promise<Set<string>> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_target")
    .select("site_id, dentally_patient_id")
    .in("site_id", siteIds)
    .in("status", ["due", "in_cadence"]);
  if (error) throw error;
  const keys = new Set<string>();
  for (const r of (data as { site_id: string; dentally_patient_id: string }[]) ?? []) {
    keys.add(`${r.site_id}:${r.dentally_patient_id}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Cadences.
// ---------------------------------------------------------------------------

export async function createCadence(input: {
  targetId: string;
  siteId: string;
  nextDueAt: string;
}): Promise<RecallCadence> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_cadence")
    .insert({ target_id: input.targetId, site_id: input.siteId, next_due_at: input.nextDueAt })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCadence(data as CadenceRow);
}

export async function getCadenceByTarget(targetId: string): Promise<RecallCadence | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_cadence")
    .select("*")
    .eq("target_id", targetId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCadence(data as CadenceRow) : null;
}

export async function listCadences(siteIds: string[]): Promise<RecallCadence[]> {
  const db = serviceClient();
  const { data, error } = await db.from("recall_cadence").select("*").in("site_id", siteIds);
  if (error) throw error;
  return (data as CadenceRow[]).map(rowToCadence);
}

export async function listDueCadences(nowIso: string): Promise<RecallCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_cadence")
    .select("*")
    .eq("status", "active")
    .lte("next_due_at", nowIso);
  if (error) throw error;
  return (data as CadenceRow[]).map(rowToCadence);
}

export async function updateCadence(
  id: string,
  fields: Partial<{
    currentStep: number;
    status: CadenceStatus;
    nextDueAt: string | null;
    endedAt: string | null;
  }>,
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.currentStep !== undefined) row.current_step = fields.currentStep;
  if (fields.status !== undefined) row.status = fields.status;
  if (fields.nextDueAt !== undefined) row.next_due_at = fields.nextDueAt;
  if (fields.endedAt !== undefined) row.ended_at = fields.endedAt;
  const { error } = await db.from("recall_cadence").update(row).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches + outbox (recall_touch / recall_outbox). Shapes mirror reactivation.
// ---------------------------------------------------------------------------

interface TouchRow {
  id: string;
  target_id: string;
  cadence_id: string | null;
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

function rowToTouch(r: TouchRow): ReactivationTouch {
  return {
    id: r.id,
    targetId: r.target_id,
    cadenceId: r.cadence_id ?? "",
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

export async function insertTouch(input: {
  targetId: string;
  cadenceId?: string | null;
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_touch")
    .insert({
      target_id: input.targetId,
      cadence_id: input.cadenceId || null,
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
    .from("recall_touch")
    .select("*")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_touch")
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
    .from("recall_outbox")
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

export async function markTouchSent(touchId: string): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: tErr } = await db
    .from("recall_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
  const { error: oErr } = await db
    .from("recall_outbox")
    .update({ status: "sent", provider: "stub", sent_at: nowIso })
    .eq("touch_id", touchId);
  if (oErr) throw oErr;
}

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
    .from("recall_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .order("created_at", { ascending: true });
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
    .from("recall_outbox")
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
    .from("recall_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("recall_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** Find the most recent recall outbound to an address, with its target (via the touch). */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ targetId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("recall_touch")
    .select("target_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return { targetId: (touch as { target_id: string }).target_id, siteId: row.site_id };
}

export async function insertInboundTouch(input: {
  targetId: string;
  cadenceId: string | null;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_touch").insert({
    target_id: input.targetId,
    cadence_id: input.cadenceId,
    site_id: input.siteId,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
  });
  if (error) throw error;
}
