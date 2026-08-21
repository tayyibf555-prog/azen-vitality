import { serviceClient } from "@/lib/supabase/server";
import { CLOSER_CADENCE } from "./cadence";
import type { CloserDiscardOutcome, CloserDiscardReason } from "./discard";
import type {
  CloserOutboxItem,
  CloserState,
  CloserStateStatus,
  CloserStopReason,
  CloserTouch,
  CloserTouchStatus,
  TouchChannel,
} from "./types";

// Persistence for the treatment-plan closer (migration 0085: closer_state,
// closer_touch, closer_outbox). Service-role only, RLS-on with no anon /
// authenticated grants, matching the post-0012 posture.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a draft never reaches the outbox.
// insertDraft writes closer_touch ONLY. The single function that writes a
// closer_outbox row is approveDraft, and it does so only when it has itself just
// transitioned the touch out of 'draft'. The shared messaging drain lists
// closer_outbox rows with status 'queued', so an unapproved draft is invisible to
// it by construction rather than by convention.

interface StateRow {
  opportunity_id: string;
  site_id: string;
  status: string;
  step: number | string;
  stop_reason: string | null;
  first_qualified_at: string;
  last_touch_at: string | null;
  last_drafted_at: string | null;
  retry_not_before: string | null;
  consecutive_failures: number | string;
  updated_at: string;
}

interface TouchRow {
  id: string;
  opportunity_id: string;
  site_id: string;
  step: number | string;
  channel: string;
  direction: string;
  body: string;
  drafted_by: string;
  status: string;
  approved_by: string | null;
  discard_reason?: string | null;
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
 * Every column of closer_touch the mapper reads, named once.
 *
 * Written out rather than `select("*")` so a column added to the table is not
 * silently pulled into every read, and kept in ONE constant so a column added to
 * the MAPPER cannot be forgotten in four of the five queries — which is exactly
 * how `discard_reason` would have come back null on the read path while being
 * written correctly on the write path.
 */
const TOUCH_COLUMNS =
  "id, opportunity_id, site_id, step, channel, direction, body, drafted_by, status, approved_by, discard_reason, created_at, sent_at";

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

function rowToState(r: StateRow): CloserState {
  return {
    opportunityId: r.opportunity_id,
    siteId: r.site_id,
    status: r.status as CloserStateStatus,
    step: num(r.step),
    stopReason: (r.stop_reason as CloserStopReason | null) ?? null,
    firstQualifiedAt: r.first_qualified_at,
    lastTouchAt: r.last_touch_at,
    lastDraftedAt: r.last_drafted_at,
    retryNotBefore: r.retry_not_before,
    consecutiveFailures: num(r.consecutive_failures),
    updatedAt: r.updated_at,
  };
}

function rowToTouch(r: TouchRow): CloserTouch {
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    siteId: r.site_id,
    step: num(r.step),
    channel: r.channel as TouchChannel,
    direction: r.direction as CloserTouch["direction"],
    body: r.body,
    draftedBy: r.drafted_by as CloserTouch["draftedBy"],
    status: r.status as CloserTouchStatus,
    approvedBy: r.approved_by,
    discardReason: r.discard_reason ?? null,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function rowToOutbox(r: OutboxRow): CloserOutboxItem {
  return {
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    status: r.status as CloserOutboxItem["status"],
    provider: r.provider,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

/** Every closer state row for a set of opportunity ids, keyed by opportunity id.
 *  Chunked so a large sweep cannot build an unbounded `in` list. */
export async function listStatesByOpportunity(
  opportunityIds: string[],
): Promise<Map<string, CloserState>> {
  const out = new Map<string, CloserState>();
  if (opportunityIds.length === 0) return out;
  const db = serviceClient();
  const CHUNK = 200;
  for (let i = 0; i < opportunityIds.length; i += CHUNK) {
    const slice = opportunityIds.slice(i, i + CHUNK);
    const { data, error } = await db.from("closer_state").select(
      "opportunity_id, site_id, status, step, stop_reason, first_qualified_at, last_touch_at, last_drafted_at, retry_not_before, consecutive_failures, updated_at",
    ).in("opportunity_id", slice);
    if (error) throw error;
    for (const r of (data ?? []) as StateRow[]) out.set(r.opportunity_id, rowToState(r));
  }
  return out;
}

export async function getState(opportunityId: string): Promise<CloserState | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_state")
    .select(
      "opportunity_id, site_id, status, step, stop_reason, first_qualified_at, last_touch_at, last_drafted_at, retry_not_before, consecutive_failures, updated_at",
    )
    .eq("opportunity_id", opportunityId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToState(data as StateRow) : null;
}

async function patchState(
  opportunityId: string,
  siteId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("closer_state").upsert(
    {
      opportunity_id: opportunityId,
      site_id: siteId,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "opportunity_id" },
  );
  if (error) throw error;
}

/** Record a terminal stop. Idempotent: re-stopping simply rewrites the reason. */
export async function stopOpportunity(
  opportunityId: string,
  siteId: string,
  reason: CloserStopReason,
): Promise<void> {
  const status: CloserStateStatus = reason === "exhausted" ? "exhausted" : "stopped";
  await patchState(opportunityId, siteId, { status, stop_reason: reason });
}

/** Push the next possible draft out to `until`, leaving the opportunity active. */
export async function coolOff(
  opportunityId: string,
  siteId: string,
  until: Date,
  opts: { status?: CloserStateStatus } = {},
): Promise<void> {
  await patchState(opportunityId, siteId, {
    status: opts.status ?? "active",
    retry_not_before: until.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Touches.
// ---------------------------------------------------------------------------

/**
 * Store an AI draft and mark the opportunity as awaiting a human.
 *
 * Writes closer_touch ONLY. Nothing here, and nothing reachable from here,
 * touches closer_outbox: that is what makes "a draft can never be sent" a
 * property of the schema rather than a promise in a comment.
 */
export async function insertDraft(input: {
  opportunityId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
}): Promise<CloserTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_touch")
    .insert({
      opportunity_id: input.opportunityId,
      site_id: input.siteId,
      step: input.step,
      channel: input.channel,
      body: input.body,
      drafted_by: "claude",
      status: "draft",
    })
    .select(
      TOUCH_COLUMNS,
    )
    .single();
  if (error) throw error;
  await patchState(input.opportunityId, input.siteId, {
    status: "awaiting_approval",
    last_drafted_at: new Date().toISOString(),
    retry_not_before: null,
  });
  return rowToTouch(data as TouchRow);
}

export async function listTouches(opportunityId: string): Promise<CloserTouch[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_touch")
    .select(
      TOUCH_COLUMNS,
    )
    .eq("opportunity_id", opportunityId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as TouchRow[]).map(rowToTouch);
}

/** One touch by id, whatever its status. The approval route's starting point:
 *  the site, the opportunity and the channel all come from HERE, never from the
 *  caller's request body. */
export async function getTouch(touchId: string): Promise<CloserTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_touch")
    .select(TOUCH_COLUMNS)
    .eq("id", touchId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTouch(data as TouchRow) : null;
}

export interface CloserQueueCounts {
  /** Drafts waiting on a human right now. */
  awaiting: number;
  /** Closer messages confirmed sent, ever. */
  sent: number;
  /** Inbound replies to closer messages, ever. */
  replies: number;
}

/**
 * The three numbers the approval panel's status strip shows.
 *
 * Counts, not rows: `head: true` asks PostgREST for the count alone, so the strip
 * costs three cheap queries rather than pulling every touch a practice has ever
 * sent into memory to call `.length` on it.
 *
 * `replies` counts INBOUND closer touches. It is a signpost, not an inbox: replies
 * are handled by the existing shared inbound path (the Twilio inbound webhook logs
 * the reply, stops the closer for that opportunity, and hands the conversation to
 * the patient-facing agent and the staff inbox). Nothing on this surface answers
 * a patient.
 */
export async function closerQueueCounts(siteIds: string[]): Promise<CloserQueueCounts> {
  const empty: CloserQueueCounts = { awaiting: 0, sent: 0, replies: 0 };
  if (siteIds.length === 0) return empty;
  const db = serviceClient();

  async function countOf(build: (q: ReturnType<typeof base>) => ReturnType<typeof base>): Promise<number> {
    const { count, error } = await build(base());
    if (error) throw error;
    return count ?? 0;
  }
  function base() {
    return db.from("closer_touch").select("id", { count: "exact", head: true }).in("site_id", siteIds);
  }

  const [awaiting, sent, replies] = await Promise.all([
    countOf((q) => q.eq("status", "draft").eq("direction", "outbound")),
    countOf((q) => q.eq("status", "sent").eq("direction", "outbound")),
    countOf((q) => q.eq("direction", "inbound")),
  ]);
  return { awaiting, sent, replies };
}

/** Every drafted touch still waiting on a human, for a set of sites. */
export async function listAwaitingApproval(siteIds: string[]): Promise<CloserTouch[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_touch")
    .select(
      TOUCH_COLUMNS,
    )
    .in("site_id", siteIds)
    .eq("status", "draft")
    .eq("direction", "outbound")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as TouchRow[]).map(rowToTouch);
}

/**
 * Inbound reply bodies for a set of opportunities, from the closer's OWN touches
 * AND the treatment coordinator's. A patient does not distinguish between the two
 * modules, so a reply to either one stops the closer.
 */
export async function listInboundBodiesByOpportunity(
  opportunityIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (opportunityIds.length === 0) return out;
  const db = serviceClient();
  const CHUNK = 200;
  const add = (id: string, body: string) => {
    const list = out.get(id);
    if (list) list.push(body);
    else out.set(id, [body]);
  };
  for (let i = 0; i < opportunityIds.length; i += CHUNK) {
    const slice = opportunityIds.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("closer_touch")
      .select("opportunity_id, body")
      .in("opportunity_id", slice)
      .eq("direction", "inbound");
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ opportunity_id: string; body: string }>) {
      add(r.opportunity_id, r.body ?? "");
    }
    const { data: coord, error: cErr } = await db
      .from("coordinator_touch")
      .select("opportunity_id, body")
      .in("opportunity_id", slice)
      .eq("direction", "inbound");
    if (cErr) throw cErr;
    for (const r of (coord ?? []) as Array<{ opportunity_id: string; body: string }>) {
      add(r.opportunity_id, r.body ?? "");
    }
  }
  return out;
}

/**
 * Approve a draft and queue it for the shared drain, in that order.
 *
 * The transition is CONDITIONAL on the row still being 'draft', so a double
 * click, a retry, or two staff acting at once cannot produce two outbox rows for
 * one message. Returns null when no row transitioned; the caller must then not
 * enqueue anything.
 *
 * `body` lets a human edit the message before releasing it. The edit is written
 * in the SAME conditional update as the transition, so an edited body and the
 * approval can never come apart, and the outbox row is built from the row the
 * database returned rather than from anything the caller held.
 */
export async function approveDraft(
  touchId: string,
  approvedBy: string,
  opts: { body?: string; toRef: string },
): Promise<{ touch: CloserTouch; outbox: CloserOutboxItem } | null> {
  const db = serviceClient();
  const patch: Record<string, unknown> = { status: "approved", approved_by: approvedBy };
  if (opts.body !== undefined) {
    patch.body = opts.body;
    patch.drafted_by = "human";
  }
  const { data, error } = await db
    .from("closer_touch")
    .update(patch)
    .eq("id", touchId)
    .eq("status", "draft")
    .select(
      TOUCH_COLUMNS,
    )
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);

  const { data: obData, error: obErr } = await db
    .from("closer_outbox")
    .insert({
      touch_id: touch.id,
      site_id: touch.siteId,
      channel: touch.channel,
      to_ref: opts.toRef,
      body: touch.body,
    })
    .select(
      "id, touch_id, site_id, channel, to_ref, body, status, provider, created_at, sent_at",
    )
    .single();
  if (obErr) throw obErr;

  await patchState(touch.opportunityId, touch.siteId, {
    status: "in_flight",
    retry_not_before: null,
  });
  return { touch, outbox: rowToOutbox(obData as OutboxRow) };
}

/**
 * A human rejected the draft, and said why.
 *
 * The touch becomes 'discarded' — a real terminal state, so the opportunity is not
 * left holding a touch that is neither sent nor failed — and the REASON decides
 * what happens to the opportunity next. `discardOutcome` (pure, in discard.ts) is
 * the only thing that makes that decision; this function does not interpret the
 * reason, it applies the outcome:
 *
 *   retry -> the opportunity goes back to 'active' behind a cool-off, so it is not
 *            immediately re-drafted with the wording the human just rejected;
 *   stop  -> the opportunity is stopped for good, with the stop reason the outcome
 *            carries.
 *
 * The transition is CONDITIONAL on the row still being 'draft', exactly like
 * approveDraft, so a double-clicked discard cannot stop an opportunity twice and
 * cannot discard a draft somebody else has just approved. The state write happens
 * only after a row actually transitioned, so a losing double-click changes nothing.
 */
export async function discardDraft(
  touchId: string,
  discardedBy: string,
  reason: CloserDiscardReason,
  outcome: CloserDiscardOutcome,
  now: Date = new Date(),
): Promise<CloserTouch | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_touch")
    .update({ status: "discarded", approved_by: discardedBy, discard_reason: reason })
    .eq("id", touchId)
    .eq("status", "draft")
    .select(
      TOUCH_COLUMNS,
    )
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const touch = rowToTouch(data as TouchRow);
  if (outcome.kind === "stop") {
    await stopOpportunity(touch.opportunityId, touch.siteId, outcome.stopReason);
  } else {
    await coolOff(
      touch.opportunityId,
      touch.siteId,
      new Date(now.getTime() + outcome.coolOffHours * 3_600_000),
    );
  }
  return touch;
}

// ---------------------------------------------------------------------------
// Drain-facing contract. These five function shapes are what the shared
// messaging drain imports; every module exports the same five.
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
    .from("closer_outbox")
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
    .from("closer_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A confirmed send: the touch is sent, the cadence advances, and the failure
 *  counter resets. This is the ONLY place `step` moves forward. */
export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("closer_outbox")
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
    .from("closer_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId)
    .select("opportunity_id, site_id, step")
    .maybeSingle();
  if (tErr) throw tErr;
  const touch = data as { opportunity_id: string; site_id: string; step: number | string } | null;
  if (!touch) return;

  const step = num(touch.step);
  const lastStep = CLOSER_CADENCE[CLOSER_CADENCE.length - 1]?.step ?? 0;
  await patchState(touch.opportunity_id, touch.site_id, {
    status: step >= lastStep ? "exhausted" : "active",
    stop_reason: step >= lastStep ? "exhausted" : null,
    step,
    last_touch_at: nowIso,
    consecutive_failures: 0,
    retry_not_before: null,
  });
}

/** Shared tail for a non-delivery: fail the touch, count it, and cool the
 *  opportunity off. The step is deliberately NOT advanced, because nothing was
 *  delivered; the failure counter is what stops an endless replay. */
async function recordNonDelivery(outboxId: string, cooldownHours: number): Promise<void> {
  const db = serviceClient();
  const { data } = await db
    .from("closer_outbox")
    .select("touch_id")
    .eq("id", outboxId)
    .maybeSingle();
  const touchId = (data as { touch_id: string } | null)?.touch_id;
  if (!touchId) return;
  const { data: tData } = await db
    .from("closer_touch")
    .update({ status: "failed" })
    .eq("id", touchId)
    .select("opportunity_id, site_id")
    .maybeSingle();
  const touch = tData as { opportunity_id: string; site_id: string } | null;
  if (!touch) return;
  const current = await getState(touch.opportunity_id);
  const failures = (current?.consecutiveFailures ?? 0) + 1;
  await patchState(touch.opportunity_id, touch.site_id, {
    status: "active",
    consecutive_failures: failures,
    retry_not_before: new Date(Date.now() + cooldownHours * 3_600_000).toISOString(),
  });
}

function cooldownHours(): number {
  const n = Number(process.env.CLOSER_COOLDOWN_HOURS ?? "24");
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("closer_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, cooldownHours());
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("closer_outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, cooldownHours());
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
    .from("closer_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** The most recent closer outbound to an address, resolved back to its opportunity. */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ opportunityId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("closer_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("closer_touch")
    .select("opportunity_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return {
    opportunityId: (touch as { opportunity_id: string }).opportunity_id,
    siteId: row.site_id,
  };
}

/**
 * Log a patient reply. The reply is recorded as an inbound touch, and the closer
 * is stopped immediately here rather than waiting for the next sweep tick: the
 * gap between a reply landing and the sweep running is exactly the window in
 * which a queued follow-up could otherwise still go out.
 */
export async function insertInboundTouch(input: {
  opportunityId: string;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("closer_touch").insert({
    opportunity_id: input.opportunityId,
    site_id: input.siteId,
    step: 0,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
  });
  if (error) throw error;
}
