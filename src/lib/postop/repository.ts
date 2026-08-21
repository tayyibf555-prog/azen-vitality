import { serviceClient } from "@/lib/supabase/server";
import type {
  PostopEscalationRecord,
  PostopOutboxItem,
  PostopStatus,
  PostopStopReason,
  PostopTarget,
  PostopTouch,
  PostopTouchStatus,
  ProcedureFlag,
  TouchChannel,
} from "./types";

// Persistence for the post-op check-in (migration 0091: postop_target,
// postop_touch, postop_outbox, postop_escalation). Service-role only, RLS-on with
// no anon / authenticated grants, matching the post-0012 posture.
//
// THE TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. A DRAFT NEVER REACHES THE OUTBOX. insertDraft writes postop_touch ONLY. The
//    single function that writes a postop_outbox row is approveDraft, and it does
//    so only when it has itself just transitioned the touch out of 'draft'. The
//    shared drain lists postop_outbox rows with status 'queued', so an unapproved
//    draft is invisible to it by construction rather than by convention. The
//    outbox CHECK constraint has no 'draft' value at all, so even a hand-written
//    insert could not put one there.
//
// 2. AN ESCALATION IS NEVER LOST. recordEscalation writes the escalation row FIRST
//    and only then moves the target's status. If the status write fails, the
//    escalation still exists and still surfaces on the worklist; the reverse order
//    would give us a target marked 'escalated' with nothing for anybody to act on.

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  appointment_id: string;
  patient_name: string;
  procedure_flag: string;
  procedure_source: string | null;
  procedure_at: string;
  due_at: string;
  status: string;
  stop_reason: string | null;
  consent_sms: boolean | null;
  consent_email: boolean | null;
  created_at: string;
  updated_at: string;
}

interface TouchRow {
  id: string;
  target_id: string;
  site_id: string;
  channel: string;
  direction: string;
  body: string;
  status: string;
  actioned_by: string | null;
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

/**
 * Every column each mapper reads, named once.
 *
 * Written out rather than `select("*")` so a column added to the table is not
 * silently pulled into every read, and kept in ONE constant per table so a column
 * added to the MAPPER cannot be forgotten in four of the five queries.
 */
const TARGET_COLUMNS =
  "id, site_id, dentally_patient_id, appointment_id, patient_name, procedure_flag, procedure_source, procedure_at, due_at, status, stop_reason, consent_sms, consent_email, created_at, updated_at";
const TOUCH_COLUMNS =
  "id, target_id, site_id, channel, direction, body, status, actioned_by, created_at, sent_at";
const OUTBOX_COLUMNS =
  "id, touch_id, site_id, channel, to_ref, body, status, provider, created_at, sent_at";

function rowToTarget(r: TargetRow): PostopTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    appointmentId: r.appointment_id,
    patientName: r.patient_name,
    procedureFlag: r.procedure_flag as ProcedureFlag,
    procedureSource: r.procedure_source ?? "",
    procedureAt: r.procedure_at,
    dueAt: r.due_at,
    status: r.status as PostopStatus,
    stopReason: (r.stop_reason as PostopStopReason | null) ?? null,
    consentSms: Boolean(r.consent_sms),
    consentEmail: Boolean(r.consent_email),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTouch(r: TouchRow): PostopTouch {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    direction: r.direction as PostopTouch["direction"],
    body: r.body,
    status: r.status as PostopTouchStatus,
    actionedBy: r.actioned_by,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function rowToOutbox(r: OutboxRow): PostopOutboxItem {
  return {
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    status: r.status as PostopOutboxItem["status"],
    provider: r.provider,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

/** The stable id for a flagged appointment. Derivable with no database read, so
 *  the sweep's upsert is idempotent over the same day's book. */
export function postopTargetId(siteId: string, appointmentId: string): string {
  return `${siteId}:${appointmentId}`;
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

export interface UpsertTargetInput {
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  procedureFlag: ProcedureFlag;
  procedureSource: string;
  procedureAt: string;
  dueAt: string;
  consentSms: boolean;
  consentEmail: boolean;
}

/**
 * Record a flagged procedure, or leave an existing record alone.
 *
 * `ignoreDuplicates` is the load-bearing option. A plain upsert would rewrite the
 * status of a target that has already been sent, replied to, or escalated every
 * time the sweep re-read the same day's appointments — resurrecting a closed
 * check-in and, worse, re-arming one whose reply is already on somebody's
 * worklist. The row is written ONCE, when the procedure is first seen, and every
 * later transition is an explicit call below.
 */
export async function upsertTargetIfNew(input: UpsertTargetInput): Promise<PostopTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_target")
    .upsert(
      {
        id: postopTargetId(input.siteId, input.appointmentId),
        site_id: input.siteId,
        dentally_patient_id: input.dentallyPatientId,
        appointment_id: input.appointmentId,
        patient_name: input.patientName,
        procedure_flag: input.procedureFlag,
        procedure_source: input.procedureSource,
        procedure_at: input.procedureAt,
        due_at: input.dueAt,
        consent_sms: input.consentSms,
        consent_email: input.consentEmail,
      },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select(TARGET_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function getTarget(id: string): Promise<PostopTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_target")
    .select(TARGET_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

/** Targets in the given statuses for a set of sites, oldest procedure first. */
export async function listTargets(args: {
  siteIds: string[];
  statuses: PostopStatus[];
  limit?: number;
}): Promise<PostopTarget[]> {
  if (args.siteIds.length === 0 || args.statuses.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_target")
    .select(TARGET_COLUMNS)
    .in("site_id", args.siteIds)
    .in("status", args.statuses)
    .order("procedure_at", { ascending: true })
    .limit(args.limit ?? 500);
  if (error) throw error;
  return ((data ?? []) as TargetRow[]).map(rowToTarget);
}

async function patchTarget(id: string, patch: Record<string, unknown>): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("postop_target")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function setTargetStatus(id: string, status: PostopStatus): Promise<void> {
  await patchTarget(id, { status });
}

/** Terminal, with a reason. Idempotent: re-stopping rewrites the reason. */
export async function stopTarget(id: string, reason: PostopStopReason): Promise<void> {
  await patchTarget(id, { status: "stopped", stop_reason: reason });
}

// ---------------------------------------------------------------------------
// Touches.
// ---------------------------------------------------------------------------

/**
 * Store the composed check-in as a DRAFT and mark the target as awaiting a human.
 *
 * Writes postop_touch ONLY. Nothing here, and nothing reachable from here, touches
 * postop_outbox: that is what makes "a draft can never be sent" a property of the
 * schema rather than a promise in a comment.
 */
export async function insertDraft(input: {
  targetId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<PostopTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_touch")
    .insert({
      target_id: input.targetId,
      site_id: input.siteId,
      channel: input.channel,
      body: input.body,
      status: "draft",
    })
    .select(TOUCH_COLUMNS)
    .single();
  if (error) throw error;
  await patchTarget(input.targetId, { status: "awaiting_approval" });
  return rowToTouch(data as TouchRow);
}

export async function getTouch(touchId: string): Promise<PostopTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_touch")
    .select(TOUCH_COLUMNS)
    .eq("id", touchId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTouch(data as TouchRow) : null;
}

/** Every drafted check-in still waiting on a human, for a set of sites. */
export async function listAwaitingApproval(siteIds: string[]): Promise<PostopTouch[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_touch")
    .select(TOUCH_COLUMNS)
    .in("site_id", siteIds)
    .eq("status", "draft")
    .eq("direction", "outbound")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as TouchRow[]).map(rowToTouch);
}

/**
 * Approve a draft and queue it for the shared drain, in that order.
 *
 * The transition is CONDITIONAL on the row still being 'draft', so a double click,
 * a retry, or two staff acting at once cannot produce two outbox rows for one
 * message. Returns null when no row transitioned; the caller must then not enqueue
 * anything.
 *
 * `notBeforeAt` is the quiet-hours clamp (src/lib/postop/schedule.ts). The drain
 * has no time-of-day gate of its own, so approving at 22:30 must queue a row that
 * cannot be picked up until 08:00 rather than one that texts a recovering patient
 * in the middle of the night.
 *
 * THE BODY IS NOT EDITABLE. Unlike the closer, whose drafts a receptionist may
 * reword, a post-op check-in is a fixed template: the approval decides WHETHER
 * this patient is checked on, never WHAT is said to them. Removing the edit field
 * removes the one way a well-meaning human could type aftercare advice into a
 * message the practice then sends automatically.
 */
export async function approveDraft(
  touchId: string,
  approvedBy: string,
  opts: { toRef: string; notBeforeAt: string },
): Promise<{ touch: PostopTouch; outbox: PostopOutboxItem } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_touch")
    .update({ status: "approved", actioned_by: approvedBy })
    .eq("id", touchId)
    .eq("status", "draft")
    .select(TOUCH_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);

  const { data: obData, error: obErr } = await db
    .from("postop_outbox")
    .insert({
      touch_id: touch.id,
      site_id: touch.siteId,
      channel: touch.channel,
      to_ref: opts.toRef,
      body: touch.body,
      not_before_at: opts.notBeforeAt,
    })
    .select(OUTBOX_COLUMNS)
    .single();
  if (obErr) throw obErr;

  await patchTarget(touch.targetId, { status: "in_flight" });
  return { touch, outbox: rowToOutbox(obData as OutboxRow) };
}

/**
 * A human rejected the draft. The touch becomes 'discarded' — a real terminal
 * state, so the target is not left holding a touch that is neither sent nor failed
 * — and the target is stopped 'staff_stopped'.
 *
 * `staff_stopped` rather than the nearest fact-shaped reason, for the same reason
 * the closer records it: nobody could stand behind a claim that the patient opted
 * out or is excluded, and the record must not contain one.
 *
 * The transition is CONDITIONAL on the row still being 'draft', exactly like
 * approveDraft, so a double-clicked discard cannot stop a target twice and cannot
 * discard a draft somebody else has just approved.
 */
export async function discardDraft(
  touchId: string,
  discardedBy: string,
): Promise<PostopTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_touch")
    .update({ status: "discarded", actioned_by: discardedBy })
    .eq("id", touchId)
    .eq("status", "draft")
    .select(TOUCH_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);
  await stopTarget(touch.targetId, "staff_stopped");
  return touch;
}

/** Log a patient reply as an inbound touch. Never advances anything on its own:
 *  the triage verdict decides what happens next. */
export async function insertInboundTouch(input: {
  targetId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("postop_touch").insert({
    target_id: input.targetId,
    site_id: input.siteId,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    status: "sent",
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Escalations. The output of the module.
// ---------------------------------------------------------------------------

interface EscalationRow {
  id: string;
  target_id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  channel: string;
  reply_body: string;
  triage_reason: string;
  matched: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const ESCALATION_COLUMNS =
  "id, target_id, site_id, dentally_patient_id, patient_name, channel, reply_body, triage_reason, matched, created_at, resolved_at, resolved_by";

function rowToEscalation(r: EscalationRow): PostopEscalationRecord {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    channel: r.channel as TouchChannel,
    replyBody: r.reply_body,
    triageReason: r.triage_reason,
    matched: r.matched,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
  };
}

/**
 * Record an escalation, then mark the target.
 *
 * THE ORDER IS THE SAFETY PROPERTY. The escalation row is written first, so a
 * failure on the status update leaves an escalation somebody will see rather than
 * a target flagged 'escalated' with nothing behind it. A second escalation for the
 * same target is a NEW ROW, not an update: a patient who says "it hurts" and then
 * "now my face is swollen" has told us two things and a person must see both.
 */
export async function recordEscalation(input: {
  targetId: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: TouchChannel;
  replyBody: string;
  triageReason: string;
  matched: string | null;
}): Promise<PostopEscalationRecord> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_escalation")
    .insert({
      target_id: input.targetId,
      site_id: input.siteId,
      dentally_patient_id: input.dentallyPatientId,
      patient_name: input.patientName,
      channel: input.channel,
      reply_body: input.replyBody,
      triage_reason: input.triageReason,
      matched: input.matched,
    })
    .select(ESCALATION_COLUMNS)
    .single();
  if (error) throw error;
  await patchTarget(input.targetId, { status: "escalated" });
  return rowToEscalation(data as EscalationRow);
}

/** Every unresolved escalation for a set of sites, oldest first. */
export async function listOpenEscalations(siteIds: string[]): Promise<PostopEscalationRecord[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_escalation")
    .select(ESCALATION_COLUMNS)
    .in("site_id", siteIds)
    .is("resolved_at", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as EscalationRow[]).map(rowToEscalation);
}

export async function resolveEscalation(id: string, resolvedBy: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("postop_escalation")
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq("id", id)
    .is("resolved_at", null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Drain-facing contract. These five function shapes are what the shared messaging
// drain imports; every module exports the same five.
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

/**
 * Queued rows for the drain.
 *
 * TWO load-bearing filters. `status = 'queued'` is what makes the send at-most-once
 * (a draft has no row here at all, and an approved row already claimed is
 * 'sending'). `not_before_at <= now()` is this module's QUIET HOURS, and it lives
 * here rather than in the drain because the drain has no time-of-day gate: the
 * diary does exactly the same thing for exactly the same reason.
 */
export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .lte("not_before_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    touch_id: string;
    site_id: string;
    channel: string;
    to_ref: string;
    body: string;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    createdAt: r.created_at,
  }));
}

/** Atomically claim a queued row (queued -> sending). True only if THIS call
 *  transitioned it, so a killed run cannot re-send after dispatch. */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A confirmed send: the touch is sent and the target moves to 'sent', which is
 *  the state that makes an inbound from that number a REPLY. */
export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("postop_outbox")
    .update({
      status: "sent",
      provider: fields.provider,
      provider_message_id: fields.providerMessageId,
      to_address: fields.toAddress,
      sent_at: nowIso,
    })
    .eq("id", outboxId);
  if (oErr) throw oErr;

  const { data, error: tErr } = await db
    .from("postop_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId)
    .select("target_id")
    .maybeSingle();
  if (tErr) throw tErr;
  const touch = data as { target_id: string } | null;
  if (!touch) return;
  await patchTarget(touch.target_id, { status: "sent" });
}

/**
 * Shared tail for a non-delivery: fail the touch and stop the target.
 *
 * STOPPED, NOT RETRIED, and that is the difference from every other module. The
 * others re-draft on a later tick because a recall or a follow-up is just as valid
 * tomorrow. A post-op check-in is not: by the time a retry would fire, the
 * staleness ceiling has passed or is about to, and a check-in sent late is worse
 * than none. One attempt, then a human is the fallback.
 */
async function recordNonDelivery(outboxId: string, reason: PostopStopReason): Promise<void> {
  const db = serviceClient();
  const { data } = await db
    .from("postop_outbox")
    .select("touch_id")
    .eq("id", outboxId)
    .maybeSingle();
  const touchId = (data as { touch_id: string } | null)?.touch_id;
  if (!touchId) return;
  const { data: tData } = await db
    .from("postop_touch")
    .update({ status: "failed" })
    .eq("id", touchId)
    .select("target_id")
    .maybeSingle();
  const touch = tData as { target_id: string } | null;
  if (!touch) return;
  await stopTarget(touch.target_id, reason);
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("postop_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, "undeliverable");
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("postop_outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, "opted_out");
}

// ---------------------------------------------------------------------------
// Webhook-facing.
// ---------------------------------------------------------------------------

export async function updateOutboxStatusByMessageId(
  providerMessageId: string,
  status: string,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("postop_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

export interface PostopAddressMatch {
  targetId: string;
  siteId: string;
  /** ISO instant the check-in was sent, for the reply-window guard. */
  sentAt: string | null;
}

/**
 * The most recent post-op check-in SENT to an address, resolved back to its target.
 *
 * `.not("sent_at", "is", null)` matters: a row that was queued and never delivered
 * is not something the patient can be replying to, and matching on it would take an
 * unrelated inbound away from the booking agent.
 *
 * The caller applies the RECENCY window (postopConfig().replyWindowHours) on the
 * returned `sentAt`. That guard is not optional: without it, every message this
 * patient ever sends the practice again, for the rest of time, address-matches this
 * row and is swallowed into a post-op conversation that ended months ago.
 */
export async function findTargetByAddress(toAddress: string): Promise<PostopAddressMatch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("postop_outbox")
    .select("touch_id, site_id, sent_at")
    .eq("to_address", toAddress)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string; sent_at: string | null };
  const { data: touch, error: tErr } = await db
    .from("postop_touch")
    .select("target_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return {
    targetId: (touch as { target_id: string }).target_id,
    siteId: row.site_id,
    sentAt: row.sent_at,
  };
}
