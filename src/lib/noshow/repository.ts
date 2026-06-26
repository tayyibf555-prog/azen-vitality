import { serviceClient } from "@/lib/supabase/server";
import type {
  DraftedBy,
  ReactivationOutboxItem,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "@/lib/reactivation/types";
import type {
  NoshowCadence,
  NoshowCadenceStatus,
  NoshowStatus,
  NoshowTarget,
  RiskBand,
  SlotOffer,
  SlotOfferStatus,
  WaitlistEntry,
  WaitlistStatus,
} from "./types";

// Re-export shared sync_state helpers (DRY: identical, resource-generic).
export { getSyncState, setSyncState } from "@/lib/coordinator/repository";

// No-show owns its own touch + outbox tables (noshow_touch / noshow_outbox), like
// recall, so the shared messaging drain / status webhook / inbound webhook handle
// it with the same logic. It adds a waitlist + slot-offer model on top.

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  appointment_id: string;
  patient_name: string;
  appointment_start_at: string;
  appointment_state: string;
  duration_min: number | string;
  practitioner: string | null;
  risk_score: number | string;
  risk_band: string;
  status: string;
  prior_attempts: number | string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  updated_from_dentally_at: string;
}

function rowToTarget(r: TargetRow): NoshowTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    appointmentId: r.appointment_id,
    patientName: r.patient_name,
    appointmentStartAt: r.appointment_start_at,
    appointmentState: r.appointment_state,
    durationMin: num(r.duration_min),
    practitioner: r.practitioner,
    riskScore: num(r.risk_score),
    riskBand: r.risk_band as RiskBand,
    status: r.status as NoshowStatus,
    priorAttempts: num(r.prior_attempts),
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    updatedFromDentallyAt: r.updated_from_dentally_at,
  };
}

function targetToRow(t: NoshowTarget): TargetRow {
  return {
    id: t.id,
    site_id: t.siteId,
    dentally_patient_id: t.dentallyPatientId,
    appointment_id: t.appointmentId,
    patient_name: t.patientName,
    appointment_start_at: t.appointmentStartAt,
    appointment_state: t.appointmentState,
    duration_min: t.durationMin,
    practitioner: t.practitioner,
    risk_score: t.riskScore,
    risk_band: t.riskBand,
    status: t.status,
    prior_attempts: t.priorAttempts,
    consent: t.consent,
    updated_from_dentally_at: t.updatedFromDentallyAt,
  };
}

export async function upsertTargets(targets: NoshowTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const db = serviceClient();
  const { error } = await db.from("noshow_target").upsert(targets.map(targetToRow), { onConflict: "id" });
  if (error) throw error;
}

export async function listTargets(args: {
  siteIds: string[];
  statuses?: NoshowStatus[];
  riskBands?: RiskBand[];
}): Promise<NoshowTarget[]> {
  const db = serviceClient();
  let q = db.from("noshow_target").select("*").in("site_id", args.siteIds);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  if (args.riskBands && args.riskBands.length > 0) q = q.in("risk_band", args.riskBands);
  const { data, error } = await q.order("appointment_start_at", { ascending: true });
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export async function getTarget(id: string): Promise<NoshowTarget | null> {
  const db = serviceClient();
  const { data, error } = await db.from("noshow_target").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function setTargetStatus(id: string, status: NoshowStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_target").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function incrementPriorAttempts(id: string): Promise<void> {
  const db = serviceClient();
  const current = await getTarget(id);
  if (!current) return;
  const { error } = await db
    .from("noshow_target")
    .update({ prior_attempts: current.priorAttempts + 1 })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Cadences (mirror recall_cadence).
// ---------------------------------------------------------------------------

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

function rowToCadence(r: CadenceRow): NoshowCadence {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    currentStep: num(r.current_step),
    status: r.status as NoshowCadenceStatus,
    nextDueAt: r.next_due_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
  };
}

export async function createCadence(input: {
  targetId: string;
  siteId: string;
  nextDueAt: string;
  currentStep?: number;
}): Promise<NoshowCadence> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_cadence")
    .insert({
      target_id: input.targetId,
      site_id: input.siteId,
      next_due_at: input.nextDueAt,
      ...(input.currentStep !== undefined ? { current_step: input.currentStep } : {}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCadence(data as CadenceRow);
}

export async function getCadenceByTarget(targetId: string): Promise<NoshowCadence | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_cadence")
    .select("*")
    .eq("target_id", targetId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCadence(data as CadenceRow) : null;
}

export async function listDueCadences(nowIso: string): Promise<NoshowCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_cadence")
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
    status: NoshowCadenceStatus;
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
  const { error } = await db.from("noshow_cadence").update(row).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches + outbox (noshow_touch / noshow_outbox). Shapes mirror reactivation.
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
  targetId: string | null;
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
    .from("noshow_touch")
    .insert({
      target_id: input.targetId ?? null,
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
    .from("noshow_touch")
    .select("*")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_touch")
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
    .from("noshow_outbox")
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
    .from("noshow_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
  const { error: oErr } = await db
    .from("noshow_outbox")
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
    .from("noshow_outbox")
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
    .from("noshow_outbox")
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
    .from("noshow_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("noshow_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/**
 * The target behind the most recent confirmation/reminder sent to an address.
 * Scans several recent outbound rows and returns the newest whose touch has a
 * real target_id, so an interleaved waitlist-offer touch (target_id null) does
 * not blind a defended patient's confirm/cancel reply.
 */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ targetId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  const rows = (data as Array<{ touch_id: string; site_id: string }>) ?? [];
  for (const row of rows) {
    const { data: touch, error: tErr } = await db
      .from("noshow_touch")
      .select("target_id")
      .eq("id", row.touch_id)
      .maybeSingle();
    if (tErr) throw tErr;
    const tid = (touch as { target_id: string | null } | null)?.target_id;
    if (tid) return { targetId: tid, siteId: row.site_id };
  }
  return null;
}

export async function insertInboundTouch(input: {
  targetId: string;
  cadenceId: string | null;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_touch").insert({
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

// ---------------------------------------------------------------------------
// Waitlist.
// ---------------------------------------------------------------------------

interface WaitlistRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  treatment: string | null;
  practitioner_pref: string | null;
  earliest_at: string | null;
  latest_at: string | null;
  duration_min: number | string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  status: string;
  created_at: string;
}

function rowToWaitlist(r: WaitlistRow): WaitlistEntry {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    treatment: r.treatment,
    practitionerPref: r.practitioner_pref,
    earliestAt: r.earliest_at,
    latestAt: r.latest_at,
    durationMin: num(r.duration_min),
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    status: r.status as WaitlistStatus,
    createdAt: r.created_at,
  };
}

export async function listWaitlist(args: {
  siteIds: string[];
  statuses?: WaitlistStatus[];
}): Promise<WaitlistEntry[]> {
  const db = serviceClient();
  let q = db.from("noshow_waitlist").select("*").in("site_id", args.siteIds);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw error;
  return (data as WaitlistRow[]).map(rowToWaitlist);
}

export async function getWaitlistEntry(id: string): Promise<WaitlistEntry | null> {
  const db = serviceClient();
  const { data, error } = await db.from("noshow_waitlist").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToWaitlist(data as WaitlistRow) : null;
}

export async function addWaitlistEntry(input: {
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  treatment?: string | null;
  practitionerPref?: string | null;
  earliestAt?: string | null;
  latestAt?: string | null;
  durationMin?: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
}): Promise<WaitlistEntry> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_waitlist")
    .insert({
      site_id: input.siteId,
      dentally_patient_id: input.dentallyPatientId,
      patient_name: input.patientName,
      treatment: input.treatment ?? null,
      practitioner_pref: input.practitionerPref ?? null,
      earliest_at: input.earliestAt ?? null,
      latest_at: input.latestAt ?? null,
      duration_min: input.durationMin ?? 30,
      consent: input.consent,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToWaitlist(data as WaitlistRow);
}

export async function setWaitlistStatus(id: string, status: WaitlistStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_waitlist").update({ status }).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Slot offers.
// ---------------------------------------------------------------------------

interface OfferRow {
  id: string;
  site_id: string;
  waitlist_id: string;
  dentally_patient_id: string;
  freed_appointment_id: string;
  freed_start_at: string;
  duration_min: number | string;
  practitioner: string | null;
  touch_id: string | null;
  status: string;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

function rowToOffer(r: OfferRow): SlotOffer {
  return {
    id: r.id,
    siteId: r.site_id,
    waitlistId: r.waitlist_id,
    dentallyPatientId: r.dentally_patient_id,
    freedAppointmentId: r.freed_appointment_id,
    freedStartAt: r.freed_start_at,
    durationMin: num(r.duration_min),
    practitioner: r.practitioner,
    touchId: r.touch_id,
    status: r.status as SlotOfferStatus,
    offeredAt: r.offered_at,
    expiresAt: r.expires_at,
    respondedAt: r.responded_at,
  };
}

export async function createSlotOffer(input: {
  siteId: string;
  waitlistId: string;
  dentallyPatientId: string;
  freedAppointmentId: string;
  freedStartAt: string;
  durationMin: number;
  practitioner: string | null;
  touchId?: string | null;
  expiresAt: string;
}): Promise<SlotOffer> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .insert({
      site_id: input.siteId,
      waitlist_id: input.waitlistId,
      dentally_patient_id: input.dentallyPatientId,
      freed_appointment_id: input.freedAppointmentId,
      freed_start_at: input.freedStartAt,
      duration_min: input.durationMin,
      practitioner: input.practitioner,
      touch_id: input.touchId ?? null,
      expires_at: input.expiresAt,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToOffer(data as OfferRow);
}

export async function setOfferTouch(offerId: string, touchId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("noshow_slot_offer").update({ touch_id: touchId }).eq("id", offerId);
  if (error) throw error;
}

export async function setOfferStatus(
  id: string,
  status: SlotOfferStatus,
  respondedAt?: string,
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = { status };
  if (respondedAt) row.responded_at = respondedAt;
  const { error } = await db.from("noshow_slot_offer").update(row).eq("id", id);
  if (error) throw error;
}

export async function getOffer(id: string): Promise<SlotOffer | null> {
  const db = serviceClient();
  const { data, error } = await db.from("noshow_slot_offer").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToOffer(data as OfferRow) : null;
}

/**
 * Atomically claim an offer: transition 'offered' -> 'accepted' only if it is
 * still open, returning the row. Returns null if another reply already claimed
 * it, so two YES replies can never both proceed to a booking.
 */
export async function claimOffer(id: string): Promise<SlotOffer | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "offered")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? rowToOffer(data as OfferRow) : null;
}

/** Whether a freed slot has already been filled by some offer. */
export async function slotIsFilled(freedAppointmentId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .select("id")
    .eq("freed_appointment_id", freedAppointmentId)
    .eq("status", "filled")
    .limit(1);
  if (error) throw error;
  return (data as unknown[]).length > 0;
}

/** All offers ever made for a freed slot (to exclude already-tried waitlist entries). */
export async function listOffersForSlot(freedAppointmentId: string): Promise<SlotOffer[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .select("*")
    .eq("freed_appointment_id", freedAppointmentId)
    .order("offered_at", { ascending: true });
  if (error) throw error;
  return (data as OfferRow[]).map(rowToOffer);
}

/** Offers still open past their expiry, for the sweep to expire + re-offer. */
export async function listExpiredOffers(nowIso: string): Promise<SlotOffer[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .select("*")
    .eq("status", "offered")
    .lte("expires_at", nowIso);
  if (error) throw error;
  return (data as OfferRow[]).map(rowToOffer);
}

/** Whether the freed slot already has a live (offered/filled) offer, so we don't double-offer. */
export async function slotHasLiveOffer(freedAppointmentId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_slot_offer")
    .select("id")
    .eq("freed_appointment_id", freedAppointmentId)
    .in("status", ["offered", "filled"])
    .limit(1);
  if (error) throw error;
  return (data as unknown[]).length > 0;
}

/** The open offer whose offer SMS was delivered to this address, for inbound YES/NO. */
export async function findOpenOfferByAddress(toAddress: string): Promise<SlotOffer | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("noshow_outbox")
    .select("touch_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  const touchIds = (data as Array<{ touch_id: string }>).map((r) => r.touch_id);
  if (touchIds.length === 0) return null;
  const { data: offers, error: oErr } = await db
    .from("noshow_slot_offer")
    .select("*")
    .in("touch_id", touchIds)
    .eq("status", "offered")
    .order("offered_at", { ascending: false })
    .limit(1);
  if (oErr) throw oErr;
  const rows = offers as OfferRow[];
  return rows.length > 0 ? rowToOffer(rows[0]) : null;
}
