import { serviceClient } from "@/lib/supabase/server";
import { COLLECTION_CADENCE } from "./cadence";
import type { CollectionDiscardOutcome, CollectionDiscardReason } from "./discard";
import type {
  CollectionEscalationReason,
  CollectionOutboxItem,
  CollectionState,
  CollectionStateStatus,
  CollectionStopReason,
  CollectionTouch,
  CollectionTouchStatus,
  TouchChannel,
} from "./types";

// Persistence for the outstanding-balance collection agent (migration 0090:
// collection_state, collection_touch, collection_outbox). Service-role only,
// RLS-on with no anon / authenticated grants, matching the post-0012 posture.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a draft never reaches the outbox.
// insertDraft writes collection_touch ONLY. The single function that writes a
// collection_outbox row is approveDraft, and it does so only when it has itself
// just transitioned the touch out of 'draft'. The shared messaging drain lists
// collection_outbox rows with status 'queued', so an unapproved draft is invisible
// to it by construction rather than by convention. That is reason 2 of the three
// in migration 0090's header; the other two are the outbox check constraint (which
// has no 'draft' value) and the drain's own filter.

interface StateRow {
  patient_id: string;
  site_id: string;
  status: string;
  step: number | string;
  stop_reason: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  first_qualified_at: string;
  last_touch_at: string | null;
  last_drafted_at: string | null;
  retry_not_before: string | null;
  consecutive_failures: number | string;
  consecutive_blocks: number | string;
  updated_at: string;
}

interface TouchRow {
  id: string;
  patient_id: string;
  site_id: string;
  step: number | string;
  channel: string;
  direction: string;
  body: string;
  drafted_by: string;
  status: string;
  approved_by: string | null;
  discard_reason: string | null;
  amount_pence: number | string | null;
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
 * Every column of collection_touch the mapper reads, named once.
 *
 * Written out rather than `select("*")` so a column added to the table is not
 * silently pulled into every read, and kept in ONE constant so a column added to
 * the MAPPER cannot be forgotten in four of the five queries. That is exactly how
 * the closer's `discard_reason` came back null on the read path while being written
 * correctly on the write path, and here the equivalent column is `amount_pence` —
 * the figure a human's edit is re-scanned against.
 */
const TOUCH_COLUMNS =
  "id, patient_id, site_id, step, channel, direction, body, drafted_by, status, approved_by, discard_reason, amount_pence, created_at, sent_at";

const STATE_COLUMNS =
  "patient_id, site_id, status, step, stop_reason, escalated_at, escalation_reason, first_qualified_at, last_touch_at, last_drafted_at, retry_not_before, consecutive_failures, consecutive_blocks, updated_at";

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

/** Pence, or null. Distinct from num(): a NULL amount means "this draft quotes no
 *  figure", which must never collapse to the number 0 (a real, quotable £0.00). */
function pence(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToState(r: StateRow): CollectionState {
  return {
    patientId: r.patient_id,
    siteId: r.site_id,
    status: r.status as CollectionStateStatus,
    step: num(r.step),
    stopReason: (r.stop_reason as CollectionStopReason | null) ?? null,
    escalatedAt: r.escalated_at,
    escalationReason: (r.escalation_reason as CollectionEscalationReason | null) ?? null,
    firstQualifiedAt: r.first_qualified_at,
    lastTouchAt: r.last_touch_at,
    lastDraftedAt: r.last_drafted_at,
    retryNotBefore: r.retry_not_before,
    consecutiveFailures: num(r.consecutive_failures),
    consecutiveBlocks: num(r.consecutive_blocks),
    updatedAt: r.updated_at,
  };
}

function rowToTouch(r: TouchRow): CollectionTouch {
  return {
    id: r.id,
    patientId: r.patient_id,
    siteId: r.site_id,
    step: num(r.step),
    channel: r.channel as TouchChannel,
    direction: r.direction as CollectionTouch["direction"],
    body: r.body,
    draftedBy: r.drafted_by as CollectionTouch["draftedBy"],
    status: r.status as CollectionTouchStatus,
    approvedBy: r.approved_by,
    discardReason: r.discard_reason ?? null,
    amountPence: pence(r.amount_pence),
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function rowToOutbox(r: OutboxRow): CollectionOutboxItem {
  return {
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    status: r.status as CollectionOutboxItem["status"],
    provider: r.provider,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

/** Every state row for a set of patient ids, keyed by patient id. Chunked so a
 *  large sweep cannot build an unbounded `in` list. */
export async function listStatesByPatient(patientIds: string[]): Promise<Map<string, CollectionState>> {
  const out = new Map<string, CollectionState>();
  if (patientIds.length === 0) return out;
  const db = serviceClient();
  const CHUNK = 200;
  for (let i = 0; i < patientIds.length; i += CHUNK) {
    const slice = patientIds.slice(i, i + CHUNK);
    const { data, error } = await db.from("collection_state").select(STATE_COLUMNS).in("patient_id", slice);
    if (error) throw error;
    for (const r of (data ?? []) as StateRow[]) out.set(r.patient_id, rowToState(r));
  }
  return out;
}

export async function getState(patientId: string): Promise<CollectionState | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_state")
    .select(STATE_COLUMNS)
    .eq("patient_id", patientId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToState(data as StateRow) : null;
}

async function patchState(
  patientId: string,
  siteId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("collection_state").upsert(
    {
      patient_id: patientId,
      site_id: siteId,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "patient_id" },
  );
  if (error) throw error;
}

/**
 * Record a terminal stop, and raise an escalation when the stop needs a person.
 *
 * Idempotent: re-stopping rewrites the reason. The escalation stamp is written in
 * the SAME upsert as the stop, so a patient can never be recorded as stopped for a
 * reason that needs a human while the work item that summons the human is missing.
 */
export async function stopTarget(
  patientId: string,
  siteId: string,
  reason: CollectionStopReason,
  escalate: CollectionEscalationReason | null = null,
  now: Date = new Date(),
): Promise<void> {
  const status: CollectionStateStatus = reason === "exhausted" ? "exhausted" : "stopped";
  const patch: Record<string, unknown> = { status, stop_reason: reason };
  if (escalate) {
    patch.escalated_at = now.toISOString();
    patch.escalation_reason = escalate;
  }
  await patchState(patientId, siteId, patch);
}

/** Raise a work item without stopping anything. Used by the sweep for the balance
 *  refusals that mean "a person should look at this account" while the cadence
 *  itself simply waits (a credit, an unreadable invoice, a balance too large). */
export async function escalate(
  patientId: string,
  siteId: string,
  reason: CollectionEscalationReason,
  now: Date = new Date(),
): Promise<void> {
  await patchState(patientId, siteId, {
    escalated_at: now.toISOString(),
    escalation_reason: reason,
  });
}

/** A person has picked the account up. Clears the work item, leaving the stop and
 *  its reason exactly as they were: the escalation is the flag, not the history. */
export async function clearEscalation(patientId: string, siteId: string): Promise<void> {
  await patchState(patientId, siteId, { escalated_at: null, escalation_reason: null });
}

/**
 * The balance is gone: close this conversation and reset it.
 *
 * WHY A RESET RATHER THAN A TERMINAL STOP. The verification read found no provable
 * debt, which almost always means the patient paid. That ends THIS conversation,
 * and it is the outcome the whole module is for. But a patient who settles today
 * may be invoiced again next year, and a terminal stop would mean the practice
 * never mentions that one either: the state row is keyed on the patient, not on
 * the invoice, so "stopped forever" would be a permanent silent exclusion earned
 * by paying a bill. So the cadence position goes back to zero and the row returns
 * to `active`. A future balance then has to clear every gate again from scratch —
 * the age floor, the value floor, the double verification — before a word is
 * drafted, so restarting is bounded rather than eager.
 *
 * The cool-off is what stops it flapping: if the practice-wide scan keeps listing
 * a patient this read says owes nothing, that pair costs ONE verification read a
 * day rather than one per sweep tick.
 *
 * An ESCALATION IS NOT CLEARED HERE. If a person was asked to look at this account,
 * a balance movement is not them having looked.
 */
export async function settleTarget(
  patientId: string,
  siteId: string,
  until: Date,
): Promise<void> {
  await patchState(patientId, siteId, {
    status: "active",
    step: 0,
    stop_reason: null,
    last_touch_at: null,
    consecutive_failures: 0,
    consecutive_blocks: 0,
    retry_not_before: until.toISOString(),
  });
}

/** Push the next possible draft out to `until`, leaving the patient active. */
export async function coolOff(
  patientId: string,
  siteId: string,
  until: Date,
  opts: { status?: CollectionStateStatus } = {},
): Promise<void> {
  await patchState(patientId, siteId, {
    status: opts.status ?? "active",
    retry_not_before: until.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Touches.
// ---------------------------------------------------------------------------

/**
 * Store an AI draft and mark the patient as awaiting a human.
 *
 * Writes collection_touch ONLY. Nothing here, and nothing reachable from here,
 * touches collection_outbox: that is what makes "a draft can never be sent" a
 * property of the schema rather than a promise in a comment.
 */
export async function insertDraft(input: {
  patientId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
  /** Whole pence the draft was written against, or null when it quotes no figure. */
  amountPence: number | null;
}): Promise<CollectionTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .insert({
      patient_id: input.patientId,
      site_id: input.siteId,
      step: input.step,
      channel: input.channel,
      body: input.body,
      drafted_by: "claude",
      status: "draft",
      amount_pence: input.amountPence,
    })
    .select(TOUCH_COLUMNS)
    .single();
  if (error) throw error;
  await patchState(input.patientId, input.siteId, {
    status: "awaiting_approval",
    last_drafted_at: new Date().toISOString(),
    retry_not_before: null,
  });
  return rowToTouch(data as TouchRow);
}

/** One touch by id, whatever its status. The approval route's starting point: the
 *  site, the patient, the channel and the AMOUNT all come from HERE, never from
 *  the caller's request body. */
export async function getTouch(touchId: string): Promise<CollectionTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .select(TOUCH_COLUMNS)
    .eq("id", touchId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTouch(data as TouchRow) : null;
}

export async function listTouches(patientId: string): Promise<CollectionTouch[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .select(TOUCH_COLUMNS)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as TouchRow[]).map(rowToTouch);
}

/** Every drafted touch still waiting on a human, for a set of sites. */
export async function listAwaitingApproval(siteIds: string[]): Promise<CollectionTouch[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .select(TOUCH_COLUMNS)
    .in("site_id", siteIds)
    .eq("status", "draft")
    .eq("direction", "outbound")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as TouchRow[]).map(rowToTouch);
}

/** The accounts a person has to look at: every escalated state row for a set of
 *  sites, newest work item first. */
export async function listEscalated(siteIds: string[]): Promise<CollectionState[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_state")
    .select(STATE_COLUMNS)
    .in("site_id", siteIds)
    .not("escalated_at", "is", null)
    .order("escalated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as StateRow[]).map(rowToState);
}

export interface CollectionQueueCounts {
  /** Drafts waiting on a human right now. */
  awaiting: number;
  /** Reminders confirmed sent, ever. */
  sent: number;
  /** Accounts flagged for a person and not yet picked up. */
  escalated: number;
}

/**
 * The three numbers the approval panel's status strip shows.
 *
 * Counts, not rows: `head: true` asks PostgREST for the count alone, so the strip
 * costs three cheap queries rather than pulling every touch a practice has ever
 * sent into memory to call `.length` on it.
 */
export async function collectionQueueCounts(siteIds: string[]): Promise<CollectionQueueCounts> {
  const empty: CollectionQueueCounts = { awaiting: 0, sent: 0, escalated: 0 };
  if (siteIds.length === 0) return empty;
  const db = serviceClient();

  const touches = () =>
    db.from("collection_touch").select("id", { count: "exact", head: true }).in("site_id", siteIds);

  const [awaitingRes, sentRes, escalatedRes] = await Promise.all([
    touches().eq("status", "draft").eq("direction", "outbound"),
    touches().eq("status", "sent").eq("direction", "outbound"),
    db
      .from("collection_state")
      .select("patient_id", { count: "exact", head: true })
      .in("site_id", siteIds)
      .not("escalated_at", "is", null),
  ]);
  for (const res of [awaitingRes, sentRes, escalatedRes]) {
    if (res.error) throw res.error;
  }
  return {
    awaiting: awaitingRes.count ?? 0,
    sent: sentRes.count ?? 0,
    escalated: escalatedRes.count ?? 0,
  };
}

/** Inbound reply bodies for a set of patients, from this module's OWN touches.
 *  Deliberately NOT pooled with other modules' inbound: a reply to a recall invite
 *  is not a reply about an invoice, and treating it as one would stop a balance
 *  conversation that the patient never actually answered — and, worse, would file
 *  it under a reason nobody could stand behind. */
export async function listInboundBodiesByPatient(patientIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (patientIds.length === 0) return out;
  const db = serviceClient();
  const CHUNK = 200;
  for (let i = 0; i < patientIds.length; i += CHUNK) {
    const slice = patientIds.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("collection_touch")
      .select("patient_id, body")
      .in("patient_id", slice)
      .eq("direction", "inbound");
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ patient_id: string; body: string }>) {
      const list = out.get(r.patient_id);
      if (list) list.push(r.body ?? "");
      else out.set(r.patient_id, [r.body ?? ""]);
    }
  }
  return out;
}

/**
 * Approve a draft and queue it for the shared drain, in that order.
 *
 * The transition is CONDITIONAL on the row still being 'draft', so a double click,
 * a retry, or two staff acting at once cannot produce two outbox rows for one
 * message. Returns null when no row transitioned; the caller must then not enqueue
 * anything.
 *
 * `body` lets a human edit the message before releasing it. The edit is written in
 * the SAME conditional update as the transition, so an edited body and the
 * approval can never come apart, and the outbox row is built from the row the
 * database returned rather than from anything the caller held.
 */
export async function approveDraft(
  touchId: string,
  approvedBy: string,
  opts: { body?: string; toRef: string },
): Promise<{ touch: CollectionTouch; outbox: CollectionOutboxItem } | null> {
  const db = serviceClient();
  const patch: Record<string, unknown> = { status: "approved", approved_by: approvedBy };
  if (opts.body !== undefined) {
    patch.body = opts.body;
    patch.drafted_by = "human";
  }
  const { data, error } = await db
    .from("collection_touch")
    .update(patch)
    .eq("id", touchId)
    .eq("status", "draft")
    .select(TOUCH_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);

  const { data: obData, error: obErr } = await db
    .from("collection_outbox")
    .insert({
      touch_id: touch.id,
      site_id: touch.siteId,
      channel: touch.channel,
      to_ref: opts.toRef,
      body: touch.body,
    })
    .select("id, touch_id, site_id, channel, to_ref, body, status, provider, created_at, sent_at")
    .single();
  if (obErr) throw obErr;

  await patchState(touch.patientId, touch.siteId, { status: "in_flight", retry_not_before: null });
  return { touch, outbox: rowToOutbox(obData as OutboxRow) };
}

/**
 * A human rejected the draft, and said why.
 *
 * The touch becomes 'discarded' — a real terminal state, so the patient is not left
 * holding a touch that is neither sent nor failed — and the REASON decides what
 * happens next. `collectionDiscardOutcome` (pure, in discard.ts) is the only thing
 * that makes that decision; this function applies it.
 *
 * The transition is CONDITIONAL on the row still being 'draft', exactly like
 * approveDraft, so a double-clicked discard cannot stop a patient twice and cannot
 * discard a draft somebody else has just approved.
 */
export async function discardDraft(
  touchId: string,
  discardedBy: string,
  reason: CollectionDiscardReason,
  outcome: CollectionDiscardOutcome,
  now: Date = new Date(),
): Promise<CollectionTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .update({ status: "discarded", approved_by: discardedBy, discard_reason: reason })
    .eq("id", touchId)
    .eq("status", "draft")
    .select(TOUCH_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);
  if (outcome.kind === "stop") {
    await stopTarget(touch.patientId, touch.siteId, outcome.stopReason, outcome.escalate, now);
  } else {
    await coolOff(
      touch.patientId,
      touch.siteId,
      new Date(now.getTime() + outcome.coolOffHours * 3_600_000),
    );
  }
  return touch;
}

/**
 * The verification read found nothing owed while a draft was sitting with a human.
 *
 * The draft dies and the conversation resets, in one place, because the two must
 * not come apart: a discarded draft whose patient is still `awaiting_approval`
 * would be a conversation nobody can ever move, and a settled patient whose draft
 * is still live would be a reminder somebody could approve tomorrow for a balance
 * that was paid today. That second one is the whole failure this module exists to
 * make impossible.
 *
 * The reason written to the row is 'balance_settled', which is deliberately NOT a
 * member of CollectionDiscardReason: nobody chose it, the machine established it,
 * and the human reasons are a closed set precisely so that each of them means a
 * person said so. Conditional on the row still being 'draft', like every other
 * transition here.
 */
export async function discardSettledDraft(
  touchId: string,
  until: Date,
): Promise<CollectionTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_touch")
    .update({
      status: "discarded",
      approved_by: "system:verification",
      discard_reason: "balance_settled",
    })
    .eq("id", touchId)
    .eq("status", "draft")
    .select(TOUCH_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);
  await settleTarget(touch.patientId, touch.siteId, until);
  return touch;
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
 * Queued rows for the drain. `status = 'queued'` is the load-bearing filter: a
 * draft has no row here at all, and even an approved row that has been claimed
 * ('sending') is excluded, which is what makes the send at-most-once.
 */
export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
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
    .from("collection_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A confirmed send: the touch is sent, the cadence advances, and BOTH counters
 *  reset. This is the ONLY place `step` moves forward. */
export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("collection_outbox")
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
    .from("collection_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId)
    .select("patient_id, site_id, step")
    .maybeSingle();
  if (tErr) throw tErr;
  const touch = data as { patient_id: string; site_id: string; step: number | string } | null;
  if (!touch) return;

  const step = num(touch.step);
  const lastStep = COLLECTION_CADENCE[COLLECTION_CADENCE.length - 1]?.step ?? 0;
  await patchState(touch.patient_id, touch.site_id, {
    status: step >= lastStep ? "exhausted" : "active",
    stop_reason: step >= lastStep ? "exhausted" : null,
    step,
    last_touch_at: nowIso,
    consecutive_failures: 0,
    consecutive_blocks: 0,
    retry_not_before: null,
  });
}

/**
 * Shared tail for a non-delivery: fail the touch, count it on the RIGHT counter,
 * and cool the patient off. The step is deliberately NOT advanced, because nothing
 * was delivered.
 *
 * `counter` is the whole point of this function taking an argument at all. A
 * failure is the provider telling us it could not deliver; a BLOCK is this
 * platform declining to send, and three of the four things the drain blocks for
 * are policy (an opt-out, the output guardrail, the cross-module once-per-day cap)
 * rather than anything wrong with the recipient. Counting a frequency-cap block as
 * a delivery failure retires a perfectly reachable patient as "undeliverable",
 * which is a false statement in the record about a real person.
 */
async function recordNonDelivery(
  outboxId: string,
  cooldownHours: number,
  counter: "consecutive_failures" | "consecutive_blocks",
): Promise<void> {
  const db = serviceClient();
  const { data } = await db.from("collection_outbox").select("touch_id").eq("id", outboxId).maybeSingle();
  const touchId = (data as { touch_id: string } | null)?.touch_id;
  if (!touchId) return;
  const { data: tData } = await db
    .from("collection_touch")
    .update({ status: "failed" })
    .eq("id", touchId)
    .select("patient_id, site_id")
    .maybeSingle();
  const touch = tData as { patient_id: string; site_id: string } | null;
  if (!touch) return;
  const current = await getState(touch.patient_id);
  const next =
    (counter === "consecutive_failures"
      ? current?.consecutiveFailures ?? 0
      : current?.consecutiveBlocks ?? 0) + 1;
  await patchState(touch.patient_id, touch.site_id, {
    status: "active",
    [counter]: next,
    retry_not_before: new Date(Date.now() + cooldownHours * 3_600_000).toISOString(),
  });
}

function cooldownHours(): number {
  const n = Number(process.env.COLLECTION_COOLDOWN_HOURS ?? "24");
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("collection_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, cooldownHours(), "consecutive_failures");
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("collection_outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, cooldownHours(), "consecutive_blocks");
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
    .from("collection_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** The most recent collection outbound to an address, resolved back to its patient. */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ patientId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("collection_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("collection_touch")
    .select("patient_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return { patientId: (touch as { patient_id: string }).patient_id, siteId: row.site_id };
}

/**
 * Log a patient reply.
 *
 * The reply is recorded as an inbound touch, and the caller stops the conversation
 * immediately rather than waiting for the next sweep tick: the gap between a reply
 * landing and the sweep running is exactly the window in which a drafted reminder
 * could be approved and sent to somebody who has just said "I already paid this".
 */
export async function insertInboundTouch(input: {
  patientId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("collection_touch").insert({
    patient_id: input.patientId,
    site_id: input.siteId,
    step: 0,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
    amount_pence: null,
  });
  if (error) throw error;
}
