import { serviceClient } from "@/lib/supabase/server";
import { londonDayKey } from "@/lib/time/london";
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
export { getSyncState, setSyncState, getBackfillCursor, setBackfillCursor } from "@/lib/coordinator/repository";

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

  // Cadence progress (status, prior_attempts) is owned by the recall ENGINE, not by
  // Dentally. A periodic re-sync re-classifies every re-pulled patient and hands us a
  // FRESH target that always carries status='due', prior_attempts=0 (classifyRecall).
  // A blind full-row upsert would reset an already-enrolled, mid-cadence target to
  // due/0 on every Dentally-side edit — restarting the cadence, erasing the attempt
  // audit, and (worse) flipping an 'exhausted' target back to 'due' so the sync then
  // graduates a fully-messaged patient across to reactivation. So preserve the
  // engine-owned columns on conflict; refresh only the Dentally-owned facts. This
  // mirrors reactivation.upsertTargets, which already fixed this exact bug.
  const ids = targets.map((t) => t.id);
  const { data: existingData, error: selErr } = await db
    .from("recall_target")
    .select("id, status, prior_attempts")
    .in("id", ids);
  if (selErr) throw selErr;
  const existing = new Map(
    (existingData as Array<{ id: string; status: string; prior_attempts: number | string }> | null ?? []).map(
      (r) => [r.id, r] as const,
    ),
  );

  const rows = targets.map((t) => {
    const row = targetToRow(t);
    const prior = existing.get(t.id);
    if (prior) {
      row.status = prior.status as TargetRow["status"];
      row.prior_attempts = Number(prior.prior_attempts);
    }
    return row;
  });

  const { error } = await db
    .from("recall_target")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function listTargets(args: {
  siteIds: string[];
  recallTypes?: RecallType[];
  statuses?: RecallStatus[];
  /** One patient's targets only. Added for the patient record's Recalls tab, which
   *  wants at most two rows: without it, opening a record read the whole site's
   *  recall worklist and threw away everything but this patient. Filtered in the
   *  query, not after it. */
  dentallyPatientId?: string;
}): Promise<RecallTarget[]> {
  const db = serviceClient();
  let q = db.from("recall_target").select("*").in("site_id", args.siteIds);
  if (args.recallTypes && args.recallTypes.length > 0) q = q.in("recall_type", args.recallTypes);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  if (args.dentallyPatientId) q = q.eq("dentally_patient_id", args.dentallyPatientId);
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
  const keys = new Set<string>();
  // Page to exhaustion: this is the double-messaging guard between recall and
  // reactivation. A single unranged select is capped at PostgREST's 1000-row default,
  // so a practice with >1000 open recalls would silently lose the rows past 1000 and
  // reactivation would double-chase those patients. Range past the cap in a loop.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("recall_target")
      .select("site_id, dentally_patient_id")
      .in("site_id", siteIds)
      .in("status", ["due", "in_cadence"])
      .order("dentally_patient_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data as { site_id: string; dentally_patient_id: string }[]) ?? [];
    for (const r of rows) keys.add(`${r.site_id}:${r.dentally_patient_id}`);
    if (rows.length < PAGE) break;
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

/**
 * The UTC instant of today's Europe/London midnight, as ISO. DST-correct: tries
 * both possible UK offsets and keeps the one that renders as 00:00 on today's
 * London date. Mirrors reactivation's settings.londonDayStartIso so the two daily
 * caps bucket "today" by exactly the same London-day definition.
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
  // Unreachable for the UK, but never throw over a date computation.
  return new Date(`${day}T00:00:00Z`).toISOString();
}

/**
 * How many recall messages have been queued so far today (Europe/London): counts
 * recall_outbox rows created since London midnight. recall_outbox rows carry no
 * origin marker and the sweep is the only automated writer, so counting ALL of
 * today's inserts is the conservative measure — a manual/coordinator send tightens
 * the remaining automated budget rather than bypassing it. On error returns 0 (the
 * cap still applies from zero; a read blip never blocks the sweep). Mirrors
 * reactivation.countContactedToday.
 */
export async function countContactedToday(now: Date): Promise<number> {
  try {
    const { count, error } = await serviceClient()
      .from("recall_outbox")
      .select("id", { count: "exact", head: true })
      .gte("created_at", londonDayStartIso(now));
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    console.error("[recall] countContactedToday failed; assuming 0 used (cap still applies)", err);
    return 0;
  }
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

/**
 * True when an outbox row already exists for this touch that has not failed.
 * recall_outbox has no unique constraint on touch_id (schema changes are out of
 * scope), so the approve→enqueue path enforces idempotency here: a double-click /
 * retry / concurrent approve must not enqueue a second patient message for the
 * same touch. A failed row is not counted (a genuine re-attempt is allowed).
 */
export async function hasPendingOutboxForTouch(touchId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_outbox")
    .select("id")
    .eq("touch_id", touchId)
    .neq("status", "failed")
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
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
  createdAt: string;
}

export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_outbox")
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

/** Atomically claim a queued row for sending (queued -> sending); true only if THIS
 *  call transitioned it. See the drain: prevents a mid-run kill after dispatch from
 *  re-sending the row on the next tick. At-most-once. */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("recall_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// A failed/blocked outbox row must ALSO fail its recall_touch. Otherwise the touch is
// stranded at 'approved', and the sweep's hasPending predicate (which treats anything
// other than 'sent'/'failed' as pending) skips that target on EVERY future run — the
// patient is frozen mid-cadence, never retried, never settled, and (because the target
// stays 'in_cadence') never adopted by reactivation either. Failing the touch clears
// hasPending so the sweep can retry the step or settle it via the normal path.
async function failLinkedTouch(db: ReturnType<typeof serviceClient>, outboxId: string): Promise<void> {
  const { data } = await db.from("recall_outbox").select("touch_id").eq("id", outboxId).maybeSingle();
  const touchId = (data as { touch_id?: string } | null)?.touch_id;
  if (touchId) {
    const { error } = await db.from("recall_touch").update({ status: "failed" }).eq("id", touchId);
    if (error) throw error;
  }
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("recall_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
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
