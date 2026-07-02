import { serviceClient } from "@/lib/supabase/server";
import type {
  CadenceStatus,
  DraftedBy,
  ReactivationCadence,
  ReactivationOutboxItem,
  ReactivationReason,
  ReactivationStatus,
  ReactivationTarget,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "./types";

// Re-export shared sync_state helpers (DRY: identical, resource-generic).
export { getSyncState, setSyncState } from "@/lib/coordinator/repository";

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  reason: string;
  dentally_plan_id: string | null;
  treatment: string | null;
  recoverable_value: number | string;
  last_visit_at: string | null;
  recall_due_at: string | null;
  prior_attempts: number | string;
  status: string;
  reactivation_score: number | string;
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

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function rowToTarget(r: TargetRow): ReactivationTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    reason: r.reason as ReactivationReason,
    dentallyPlanId: r.dentally_plan_id,
    treatment: r.treatment,
    recoverableValue: num(r.recoverable_value),
    lastVisitAt: r.last_visit_at,
    recallDueAt: r.recall_due_at,
    priorAttempts: num(r.prior_attempts),
    status: r.status as ReactivationStatus,
    reactivationScore: num(r.reactivation_score),
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    updatedFromDentallyAt: r.updated_from_dentally_at,
  };
}

function targetToRow(t: ReactivationTarget): TargetRow {
  return {
    id: t.id,
    site_id: t.siteId,
    dentally_patient_id: t.dentallyPatientId,
    patient_name: t.patientName,
    reason: t.reason,
    dentally_plan_id: t.dentallyPlanId,
    treatment: t.treatment,
    recoverable_value: t.recoverableValue,
    last_visit_at: t.lastVisitAt,
    recall_due_at: t.recallDueAt,
    prior_attempts: t.priorAttempts,
    status: t.status,
    reactivation_score: t.reactivationScore,
    consent: t.consent,
    updated_from_dentally_at: t.updatedFromDentallyAt,
  };
}

function rowToCadence(r: CadenceRow): ReactivationCadence {
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

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

export async function upsertTargets(targets: ReactivationTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const db = serviceClient();

  // Cadence progress (status, prior_attempts) is owned by the reactivation
  // engine, NOT by Dentally. A periodic re-sync re-classifies every re-pulled
  // patient and hands us a FRESH target that always carries status='dormant',
  // prior_attempts=0 (see normalise.toReactivationTarget). If we let the upsert
  // overwrite those columns on an already-enrolled, mid-cadence target, the row
  // is reset to dormant/0 — restarting the cadence and re-contacting the
  // patient. So: only set status/prior_attempts on INSERT; on conflict, keep the
  // existing in-flight values. All other columns (fresh Dentally facts) are
  // refreshed as normal.
  const ids = targets.map((t) => t.id);
  const { data: existingData, error: selErr } = await db
    .from("reactivation_target")
    .select("id, status, prior_attempts")
    .in("id", ids);
  if (selErr) throw selErr;
  const existing = new Map(
    (existingData as Array<{ id: string; status: string; prior_attempts: number | string }> | null ?? []).map(
      (r) => [r.id, r],
    ),
  );

  const rows = targets.map((t) => {
    const row = targetToRow(t);
    const prior = existing.get(t.id);
    if (prior) {
      // Preserve engine-owned cadence progress; do not clobber with dormant/0.
      row.status = prior.status;
      row.prior_attempts = prior.prior_attempts;
    }
    return row;
  });

  const { error } = await db
    .from("reactivation_target")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function listTargets(args: {
  siteIds: string[];
  reasons?: ReactivationReason[];
  statuses?: ReactivationStatus[];
}): Promise<ReactivationTarget[]> {
  const db = serviceClient();
  let q = db.from("reactivation_target").select("*").in("site_id", args.siteIds);
  if (args.reasons && args.reasons.length > 0) q = q.in("reason", args.reasons);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("reactivation_score", { ascending: false });
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export async function getTarget(id: string): Promise<ReactivationTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_target")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function setTargetStatus(id: string, status: ReactivationStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_target").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function incrementPriorAttempts(id: string): Promise<void> {
  const db = serviceClient();
  const current = await getTarget(id);
  if (!current) return;
  const { error } = await db
    .from("reactivation_target")
    .update({ prior_attempts: current.priorAttempts + 1 })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Cadences.
// ---------------------------------------------------------------------------

export async function createCadence(input: {
  targetId: string;
  siteId: string;
  nextDueAt: string;
}): Promise<ReactivationCadence> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .insert({ target_id: input.targetId, site_id: input.siteId, next_due_at: input.nextDueAt })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCadence(data as CadenceRow);
}

export async function getCadenceByTarget(targetId: string): Promise<ReactivationCadence | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .select("*")
    .eq("target_id", targetId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCadence(data as CadenceRow) : null;
}

export async function listCadences(siteIds: string[]): Promise<ReactivationCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .select("*")
    .in("site_id", siteIds);
  if (error) throw error;
  return (data as CadenceRow[]).map(rowToCadence);
}

export async function listDueCadences(nowIso: string): Promise<ReactivationCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
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
  const { error } = await db.from("reactivation_cadence").update(row).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches + outbox.
// ---------------------------------------------------------------------------

export async function insertTouch(input: {
  targetId: string;
  cadenceId?: string | null;   // null when drafted before enrolment
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_touch")
    .insert({
      target_id: input.targetId,
      cadence_id: input.cadenceId || null, // empty/missing -> SQL NULL (column is a nullable uuid)
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
    .from("reactivation_touch")
    .select("*")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_touch")
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
    .from("reactivation_outbox")
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
    .from("reactivation_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
  const { error: oErr } = await db
    .from("reactivation_outbox")
    .update({ status: "sent", provider: "stub", sent_at: nowIso })
    .eq("touch_id", touchId);
  if (oErr) throw oErr;
}

// ---------------------------------------------------------------------------
// Outbox drain + inbound correlation (messaging layer).
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
    .from("reactivation_outbox")
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
    .from("reactivation_outbox")
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
    .from("reactivation_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

/**
 * Atomically claim a queued row for sending (queued -> sending). Returns true only
 * if THIS call transitioned the row. The drain claims immediately before dispatch
 * so a mid-run kill AFTER the send but BEFORE recordSent cannot leave the row
 * 'queued' for the next tick to re-list and re-send (double-text). At-most-once:
 * a row stranded in 'sending' (killed between claim and record) is left for ops,
 * never silently re-sent.
 */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("reactivation_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** Find the most recent outbound row sent to an address, with its target (via the touch). */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ targetId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("reactivation_touch")
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
  const { error } = await db.from("reactivation_touch").insert({
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

export async function getTargetContext(
  targetId: string,
): Promise<{ patientName: string; treatment: string | null; fundingType: "nhs" | "private" | null } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_target")
    .select("patient_name, treatment, reason")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { patient_name: string; treatment: string | null; reason: string };
  // Funding type is not modelled on the target yet; default null (Phase 2 wires NHS/private).
  return { patientName: row.patient_name, treatment: row.treatment, fundingType: null };
}
