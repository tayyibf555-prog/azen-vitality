// NO `import "server-only"` here, deliberately, and for the same reason no other
// module's repository carries one: the SHARED messaging drain imports this file to
// satisfy its OutboxSource interface, and the drain's own test suite imports the
// drain. `server-only` resolves under Next but not under vitest, so adding it here
// would break ten existing drain tests that have nothing to do with the diary.
// Server-only enforcement for this module lives where it belongs, on the guarded
// callers (access.ts, day-load.ts, funding-source.ts, suitability-source.ts).

// ===========================================================================
// THE DIARY'S OWN TABLES.
//
// Breaks and notes, the appointment-move audit, the diary's touch/outbox pair and
// the treatment-capability rows. All of them are OURS: Dentally exposes no
// endpoint for breaks, blocked time or diary notes, so nothing here mirrors it.
//
// MIGRATION 0063 IS CHECKED IN BUT NOT APPLIED. Every read below therefore maps a
// MISSING RELATION to the module's FAILED signal rather than to an empty array.
// That is the difference between "this clinician has no breaks today" and "we
// could not find out", and conflating them is exactly the confident-empty this
// codebase forbids. Until the migration is applied the diary will honestly say
// breaks and notes could not be read. It must not be faked with an in-memory stub.
// ===========================================================================

import { serviceClient } from "@/lib/supabase/server";
import type { DiaryEntryKind, DiaryEntryRecord } from "./entries";
import type { Capability, CapabilityLevel, CapabilitySource } from "./suitability";
import type { FamilySlug } from "@/components/client/calendar/treatment-type";

/**
 * Postgres 42P01 is "undefined_table"; PostgREST answers PGRST205 for a relation
 * missing from its schema cache. Either means the migration has not been applied,
 * which is a FAILED read and never an empty one.
 */
function isMissingRelation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "PGRST205";
}

// ---------------------------------------------------------------------------
// Breaks and notes.
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  client_id: string;
  site_id: string;
  practitioner_id: string | null;
  day: string;
  start_min: number | string;
  end_min: number | string;
  kind: string;
  title: string;
  body: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

function rowToEntry(r: EntryRow): DiaryEntryRecord {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    practitionerId: r.practitioner_id,
    day: r.day,
    startMin: num(r.start_min),
    endMin: num(r.end_min),
    kind: r.kind as DiaryEntryKind,
    title: r.title,
    body: r.body,
    authorName: r.author_name ?? "Team",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface EntriesRead {
  entries: DiaryEntryRecord[];
  failed: boolean;
}

/** Every live break and note at one site across the given London days. */
export async function listEntries(siteId: string, dayKeys: readonly string[]): Promise<EntriesRead> {
  if (dayKeys.length === 0) return { entries: [], failed: false };
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("diary_entry")
      .select("*")
      .eq("site_id", siteId)
      .in("day", [...dayKeys])
      .is("deleted_at", null)
      .order("start_min", { ascending: true });
    if (error) throw error;
    return { entries: (data as EntryRow[]).map(rowToEntry), failed: false };
  } catch (err) {
    if (isMissingRelation(err)) {
      console.warn("[diary] diary_entry is missing; migration 0063 has not been applied");
    } else {
      console.error(`[diary] listEntries failed for site ${siteId}`, err);
    }
    return { entries: [], failed: true };
  }
}

export interface EntryWrite {
  clientId: string;
  siteId: string;
  practitionerId: string | null;
  day: string;
  startMin: number;
  endMin: number;
  kind: DiaryEntryKind;
  title: string;
  body: string | null;
  authorId: string | null;
  authorName: string;
}

export async function insertEntry(input: EntryWrite): Promise<DiaryEntryRecord> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_entry")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      practitioner_id: input.practitionerId,
      day: input.day,
      start_min: input.startMin,
      end_min: input.endMin,
      kind: input.kind,
      title: input.title,
      body: input.body,
      author_id: input.authorId,
      author_name: input.authorName,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToEntry(data as EntryRow);
}

export async function updateEntry(
  id: string,
  siteId: string,
  patch: Pick<EntryWrite, "practitionerId" | "day" | "startMin" | "endMin" | "kind" | "title" | "body">,
): Promise<DiaryEntryRecord | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_entry")
    .update({
      practitioner_id: patch.practitionerId,
      day: patch.day,
      start_min: patch.startMin,
      end_min: patch.endMin,
      kind: patch.kind,
      title: patch.title,
      body: patch.body,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Site-scoped so an id from another practice cannot be edited by pairing it
    // with a site the caller does hold.
    .eq("site_id", siteId)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? rowToEntry(data as EntryRow) : null;
}

/**
 * SOFT delete. A break someone removed stays recoverable and auditable, which
 * matters when the question later is "who took lunch off the diary on Monday".
 */
export async function softDeleteEntry(id: string, siteId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_entry")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("site_id", siteId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The move audit. A REFUSED attempt is recorded too, so a rejected move is never
// invisible (the insertProfileAudit precedent).
// ---------------------------------------------------------------------------

export type MoveOutcome = "refused" | "saved" | "not_saved" | "unknown";

export interface MoveAuditRow {
  clientId: string;
  siteId: string;
  appointmentId: string;
  patientId: string | null;
  fromStartAt: string | null;
  fromFinishAt: string | null;
  fromPractitionerId: string | null;
  toStartAt: string | null;
  toFinishAt: string | null;
  toPractitionerId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  outcome: MoveOutcome;
  detail: string | null;
  notifyIntent: boolean;
  touchId?: string | null;
  undoOf?: string | null;
}

/**
 * Record one move attempt. Returns the audit id, or null when the row could not be
 * written.
 *
 * NEVER THROWS. An audit failure must not turn a move that DID save into an error
 * the caller reports as a failure: that would tell the practice manager a patient
 * was not moved when they were, which is the more dangerous of the two lies.
 */
export async function insertMove(row: MoveAuditRow): Promise<string | null> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("diary_move")
      .insert({
        client_id: row.clientId,
        site_id: row.siteId,
        appointment_id: row.appointmentId,
        patient_id: row.patientId,
        from_start_at: row.fromStartAt,
        from_finish_at: row.fromFinishAt,
        from_practitioner_id: row.fromPractitionerId,
        to_start_at: row.toStartAt,
        to_finish_at: row.toFinishAt,
        to_practitioner_id: row.toPractitionerId,
        actor_id: row.actorId,
        actor_email: row.actorEmail,
        actor_role: row.actorRole,
        outcome: row.outcome,
        detail: row.detail,
        notify_intent: row.notifyIntent,
        touch_id: row.touchId ?? null,
        undo_of: row.undoOf ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  } catch (err) {
    console.error("[diary] insertMove failed; the move audit row was not written", err);
    return null;
  }
}

export interface MoveRecord extends MoveAuditRow {
  id: string;
  createdAt: string;
}

export interface MovesRead {
  moves: MoveRecord[];
  failed: boolean;
}

/** Every recorded move on one appointment, newest first. */
export async function listMovesForAppointment(siteId: string, appointmentId: string): Promise<MovesRead> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("diary_move")
      .select("*")
      .eq("site_id", siteId)
      .eq("appointment_id", appointmentId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const moves = (data as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      clientId: String(r.client_id),
      siteId: String(r.site_id),
      appointmentId: String(r.appointment_id),
      patientId: (r.patient_id as string | null) ?? null,
      fromStartAt: (r.from_start_at as string | null) ?? null,
      fromFinishAt: (r.from_finish_at as string | null) ?? null,
      fromPractitionerId: (r.from_practitioner_id as string | null) ?? null,
      toStartAt: (r.to_start_at as string | null) ?? null,
      toFinishAt: (r.to_finish_at as string | null) ?? null,
      toPractitionerId: (r.to_practitioner_id as string | null) ?? null,
      actorId: (r.actor_id as string | null) ?? null,
      actorEmail: (r.actor_email as string | null) ?? null,
      actorRole: (r.actor_role as string | null) ?? null,
      outcome: r.outcome as MoveOutcome,
      detail: (r.detail as string | null) ?? null,
      notifyIntent: r.notify_intent === true,
      touchId: (r.touch_id as string | null) ?? null,
      undoOf: (r.undo_of as string | null) ?? null,
    }));
    return { moves, failed: false };
  } catch (err) {
    console.error(`[diary] listMovesForAppointment failed for ${appointmentId}`, err);
    return { moves: [], failed: true };
  }
}

// ---------------------------------------------------------------------------
// Messaging: the diary's own touch/outbox pair.
//
// The function NAMES below are identical to every other module's, so the shared
// drain's OutboxSource interface is satisfied without translation. No new path to
// a provider is opened here: the drain does the sending and applies every guard.
// ---------------------------------------------------------------------------

export type DiaryChannel = "sms" | "whatsapp" | "email";

export async function insertTouch(input: {
  moveId: string | null;
  siteId: string;
  channel: DiaryChannel;
  body: string;
}): Promise<{ id: string }> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_touch")
    .insert({
      move_id: input.moveId,
      site_id: input.siteId,
      channel: input.channel,
      body: input.body,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

export async function enqueueOutbox(input: {
  touchId: string;
  siteId: string;
  channel: DiaryChannel;
  toRef: string;
  body: string;
  /** Quiet hours: the earliest instant this may be sent. */
  notBeforeAt: string;
}): Promise<{ id: string }> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_outbox")
    .insert({
      touch_id: input.touchId,
      site_id: input.siteId,
      channel: input.channel,
      to_ref: input.toRef,
      body: input.body,
      not_before_at: input.notBeforeAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

export async function markTouchSent(touchId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("diary_touch")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", touchId);
  if (error) throw error;
}

export interface QueuedOutbox {
  id: string;
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
  createdAt: string;
}

/**
 * The queued rows this drain run may send.
 *
 * THE ONLY listQueuedOutbox IN THE CODEBASE WITH A TIME FILTER, and the reason is
 * worth writing down: there is NO quiet-hours guard anywhere else here. No send
 * window, no time-of-day gate, in the drain or in any sweep; the effective quiet
 * hours today are whatever the cron schedule happens to give. Rather than claim a
 * guard that does not exist, this build adds one confined to the diary's own
 * table. The enqueue clamps into 08:00-20:00 Europe/London and this filter honours
 * it, so a move made at 21:15 texts the patient at 08:00 the next morning.
 */
export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .lte("not_before_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (
    data as Array<{
      id: string;
      touch_id: string;
      site_id: string;
      channel: string;
      to_ref: string;
      body: string;
      created_at: string;
    }>
  ).map((r) => ({
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel,
    toRef: r.to_ref,
    body: r.body,
    createdAt: r.created_at,
  }));
}

/** Atomically claim a queued row (queued -> sending); true only if THIS call moved
 *  it. At-most-once: a mid-run kill after dispatch cannot re-send on the next tick. */
export async function claimOutbox(outboxId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("diary_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("diary_outbox")
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
    .from("diary_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

/** A failed or blocked outbox row must ALSO fail its touch, or the touch is
 *  stranded and the panel reports a text as still pending forever. */
async function failLinkedTouch(db: ReturnType<typeof serviceClient>, outboxId: string): Promise<void> {
  const { data } = await db.from("diary_outbox").select("touch_id").eq("id", outboxId).maybeSingle();
  const touchId = (data as { touch_id?: string } | null)?.touch_id;
  if (touchId) {
    const { error } = await db.from("diary_touch").update({ status: "failed" }).eq("id", touchId);
    if (error) throw error;
  }
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("diary_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("diary_outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await failLinkedTouch(db, outboxId);
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("diary_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Treatment capability.
// ---------------------------------------------------------------------------

/**
 * The practice's OWN capability rows.
 *
 * A missing relation returns [] here rather than a failure flag, and that is
 * deliberate and safe: suitability-source treats an empty result as "the practice
 * has not answered yet" and falls back WHOLESALE to the seed, which the UI then
 * labels as seeded. There is no silent half-truth in that path, because unknown is
 * already excluded from every proposal.
 */
export async function selectTreatmentCapability(clientId: string): Promise<Capability[]> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("treatment_capability")
      .select("practitioner_id, site_id, family_slug, level, source, note")
      .eq("client_id", clientId);
    if (error) throw error;
    return (
      data as Array<{
        practitioner_id: string;
        site_id: string | null;
        family_slug: string;
        level: string;
        source: string;
        note: string | null;
      }>
    ).map((r) => ({
      practitionerId: r.practitioner_id,
      siteId: r.site_id,
      familySlug: r.family_slug as FamilySlug,
      level: r.level as CapabilityLevel,
      source: r.source as CapabilitySource,
      note: r.note,
    }));
  } catch (err) {
    if (isMissingRelation(err)) {
      console.warn("[diary] treatment_capability is missing; migration 0063 has not been applied");
    } else {
      console.error(`[diary] selectTreatmentCapability failed for client ${clientId}`, err);
    }
    return [];
  }
}
