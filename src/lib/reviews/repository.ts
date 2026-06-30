import { serviceClient } from "@/lib/supabase/server";
import type {
  DraftedBy,
  ReactivationOutboxItem,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "@/lib/reactivation/types";
import type { ReviewRequest, ReviewStatus } from "./types";

// Reviews owns its own touch + outbox tables (review_touch / review_outbox), like
// no-show and recall, so the shared messaging drain / status webhook handle it with
// the same logic. The review_request table holds one row per attended appointment.

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Review requests.
// ---------------------------------------------------------------------------

interface RequestRow {
  id: string;
  site_id: string;
  dentally_appointment_id: string;
  dentally_patient_id: string;
  patient_name: string;
  channel: string;
  attended_at: string;
  send_at: string;
  status: string;
  created_at: string;
}

function rowToRequest(r: RequestRow): ReviewRequest {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyAppointmentId: r.dentally_appointment_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    channel: r.channel as TouchChannel,
    attendedAt: r.attended_at,
    sendAt: r.send_at,
    status: r.status as ReviewStatus,
    createdAt: r.created_at,
  };
}

/**
 * Create a scheduled review request for an attended appointment. Idempotent on the
 * appointment id: a second attend call returns the existing row rather than
 * inserting a duplicate (so a patient is only ever asked once per appointment).
 */
export async function createScheduled(input: {
  siteId: string;
  dentallyAppointmentId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: TouchChannel;
  attendedAt: string;
  sendAt: string;
}): Promise<ReviewRequest> {
  const db = serviceClient();
  const existing = await getByAppointment(input.dentallyAppointmentId);
  if (existing) return existing;

  const { data, error } = await db
    .from("review_request")
    .insert({
      site_id: input.siteId,
      dentally_appointment_id: input.dentallyAppointmentId,
      dentally_patient_id: input.dentallyPatientId,
      patient_name: input.patientName,
      channel: input.channel,
      attended_at: input.attendedAt,
      send_at: input.sendAt,
    })
    .select("*")
    .single();
  if (error) {
    // A concurrent attend may have inserted first (unique on appointment id):
    // fall back to the now-existing row so the call stays idempotent.
    const raced = await getByAppointment(input.dentallyAppointmentId);
    if (raced) return raced;
    throw error;
  }
  return rowToRequest(data as RequestRow);
}

export async function getByAppointment(
  dentallyAppointmentId: string,
): Promise<ReviewRequest | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("review_request")
    .select("*")
    .eq("dentally_appointment_id", dentallyAppointmentId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRequest(data as RequestRow) : null;
}

export async function getRequest(id: string): Promise<ReviewRequest | null> {
  const db = serviceClient();
  const { data, error } = await db.from("review_request").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToRequest(data as RequestRow) : null;
}

/** Scheduled requests due to send (send_at <= now), for the sweep. */
export async function listDue(nowIso: string): Promise<ReviewRequest[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("review_request")
    .select("*")
    .eq("status", "scheduled")
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true });
  if (error) throw error;
  return (data as RequestRow[]).map(rowToRequest);
}

/** Requests for the given appointments (for annotating today's attendance list). */
export async function listByAppointments(
  dentallyAppointmentIds: string[],
): Promise<ReviewRequest[]> {
  if (dentallyAppointmentIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("review_request")
    .select("*")
    .in("dentally_appointment_id", dentallyAppointmentIds);
  if (error) throw error;
  return (data as RequestRow[]).map(rowToRequest);
}

export async function markStatus(id: string, status: ReviewStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("review_request").update({ status }).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches + outbox (review_touch / review_outbox). Shapes mirror no-show.
// ---------------------------------------------------------------------------

interface TouchRow {
  id: string;
  request_id: string | null;
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
    targetId: r.request_id ?? "",
    cadenceId: "",
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
  requestId: string | null;
  siteId: string;
  step?: number;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("review_touch")
    .insert({
      request_id: input.requestId ?? null,
      site_id: input.siteId,
      step: input.step ?? 0,
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

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("review_touch")
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
    .from("review_outbox")
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
    .from("review_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
  const { error: oErr } = await db
    .from("review_outbox")
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
    .from("review_outbox")
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
    .from("review_outbox")
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
    .from("review_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("review_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("review_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("review_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}
