import { serviceClient } from "@/lib/supabase/server";
import type { AgentConversation, AgentMessageRow, ConversationStatus, MessageRole, PhoneIdentity } from "./types";

interface ConvRow {
  id: string; site_id: string; dentally_patient_id: string; patient_name: string; channel: string;
  status: string; treatment: string | null; funding_type: string | null;
  last_inbound_at: string | null; created_at: string; updated_at: string;
}
interface MsgRow {
  id: string; conversation_id: string; role: string; body: string; tool_name: string | null; created_at: string;
}

function toConv(r: ConvRow): AgentConversation {
  return {
    id: r.id, siteId: r.site_id, dentallyPatientId: r.dentally_patient_id, patientName: r.patient_name,
    channel: r.channel, status: r.status as ConversationStatus,
    treatment: r.treatment, fundingType: (r.funding_type as "nhs" | "private" | null) ?? null,
    lastInboundAt: r.last_inbound_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toMsg(r: MsgRow): AgentMessageRow {
  return { id: r.id, conversationId: r.conversation_id, role: r.role as MessageRole, body: r.body, toolName: r.tool_name, createdAt: r.created_at };
}

export async function findOrCreateConversation(input: {
  siteId: string; dentallyPatientId: string; patientName: string; channel: string;
  treatment: string | null; fundingType: "nhs" | "private" | null;
}): Promise<AgentConversation> {
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from("agent_conversation")
    .select("*")
    .eq("site_id", input.siteId)
    .eq("dentally_patient_id", input.dentallyPatientId)
    .eq("channel", input.channel)
    .not("status", "in", "(closed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return toConv(existing as ConvRow);

  const { data, error } = await db
    .from("agent_conversation")
    .insert({
      site_id: input.siteId, dentally_patient_id: input.dentallyPatientId, patient_name: input.patientName,
      channel: input.channel, treatment: input.treatment, funding_type: input.fundingType,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toConv(data as ConvRow);
}

// ---------------------------------------------------------------------------
// Phone -> patient identity directory (recognise any inbound number).
// ---------------------------------------------------------------------------

interface IdentityRow {
  phone: string; site_id: string; dentally_patient_id: string; patient_name: string;
  treatment: string | null; funding_type: string | null;
  last_visit_at: string | null; recall_due_at: string | null;
}

/** Look up a cached identity for an inbound phone number. */
export async function lookupPhoneIdentity(phone: string): Promise<PhoneIdentity | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_phone_identity")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as IdentityRow;
  return {
    patientId: r.dentally_patient_id,
    siteId: r.site_id,
    patientName: r.patient_name,
    treatment: r.treatment,
    fundingType: (r.funding_type as "nhs" | "private" | null) ?? null,
    lastVisitAt: r.last_visit_at,
    recallDueAt: r.recall_due_at,
    source: "directory",
  };
}

/** Cache a resolved identity against a phone number for fast future routing. */
export async function upsertPhoneIdentity(phone: string, identity: PhoneIdentity): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("agent_phone_identity").upsert(
    {
      phone,
      site_id: identity.siteId,
      dentally_patient_id: identity.patientId,
      patient_name: identity.patientName,
      treatment: identity.treatment,
      funding_type: identity.fundingType,
      last_visit_at: identity.lastVisitAt,
      recall_due_at: identity.recallDueAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "phone" },
  );
  if (error) throw error;
}

/** One conversation by id (incl. its site), or null. Used to authz reads by site. */
export async function getConversation(id: string): Promise<AgentConversation | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_conversation").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toConv(data as ConvRow);
}

/**
 * A conversation's messages, oldest first.
 *
 * `limit` takes the MOST RECENT n and returns them still oldest-first, which is
 * not the same query as "the first n": it reads descending, slices, and reverses.
 * That direction matters twice over.
 *
 *   COST. A conversation here is per (site, patient, channel) and is only replaced
 *   once it is CLOSED, so a returning patient's thread accumulates for as long as
 *   they are a patient: first contact, three nurture touches, every booking,
 *   reschedule and cancel, and up to 20 agent turns an hour on top. The booking
 *   agent re-sends this whole thread to the model on every round of every turn, so
 *   an unbounded read is an unbounded per-message bill that only ever grows.
 *
 *   CORRECTNESS. PostgREST applies its own server-side row ceiling (db-max-rows)
 *   when one is configured, and it truncates the result of the query as written.
 *   Ascending-with-no-limit therefore keeps the OLDEST rows and silently drops the
 *   newest — the agent would answer having never seen the message it is replying
 *   to. Anchoring to the newest end makes the ceiling harmless: the rows a cap
 *   could take are the ones we were discarding anyway.
 *
 * No limit is the previous behaviour exactly, for the staff inbox, which wants the
 * whole thread.
 */
export async function listMessages(
  conversationId: string,
  opts?: { limit?: number },
): Promise<AgentMessageRow[]> {
  const db = serviceClient();
  const limit = opts?.limit;
  if (typeof limit === "number" && limit > 0) {
    const { data, error } = await db
      .from("agent_message")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw error;
    // Reverse in place of a second sort: the rows came back newest-first, so
    // reversing restores the oldest-first order every caller expects. The tie
    // break on id keeps two messages written in the same millisecond in a stable
    // order rather than letting the page boundary fall between them at random.
    return (data as MsgRow[]).map(toMsg).reverse();
  }
  const { data, error } = await db
    .from("agent_message").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data as MsgRow[]).map(toMsg);
}

export async function appendMessage(input: {
  conversationId: string; role: MessageRole; body: string; toolName?: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("agent_message").insert({
    conversation_id: input.conversationId, role: input.role, body: input.body, tool_name: input.toolName ?? null,
  });
  if (error) throw error;
}

export async function setConversationName(id: string, patientName: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ patient_name: patientName, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Idempotently mark a conversation as needing a human, and say whether THIS call
 * was the one that did it.
 *
 * The `.neq("status", "needs_human")` predicate is the point: a conversation that
 * is already handed over is left completely untouched, so re-running the handover
 * path cannot churn `updated_at` and reshuffle the Conversations list under a
 * colleague who is reading it. It is also a single statement, so two concurrent
 * handovers on the same thread cannot both believe they were first.
 *
 * `closed` is excluded on purpose: a thread a human has already finished with must
 * not be dragged back open by a late alert for a turn that happened before it closed.
 */
export async function ensureNeedsHuman(id: string): Promise<"set" | "already"> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_conversation")
    .update({ status: "needs_human", updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "needs_human")
    .neq("status", "closed")
    .select("id");
  if (error) throw error;
  return ((data as { id: string }[] | null) ?? []).length > 0 ? "set" : "already";
}

/** The shape the Task Queue needs for a handed-over conversation. */
export interface NeedsHumanConversation {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  updatedAt: string;
}

/**
 * Conversations waiting on a human, newest first.
 *
 * Lean by design: the Task Queue needs one row per thread, not the message bodies
 * `listDashboardConversations` fetches, and this runs on every dashboard render.
 * Bounded so a practice that has let a backlog build up cannot turn one queue read
 * into an unbounded scan; the cap is generous relative to any real backlog, and a
 * queue showing 200 escalations has already made its point.
 */
export async function listNeedsHumanConversations(
  siteIds: string[],
  limit = 200,
): Promise<NeedsHumanConversation[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_conversation")
    .select("id, site_id, dentally_patient_id, patient_name, channel, updated_at")
    .in("site_id", siteIds)
    .eq("status", "needs_human")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data as ConvRow[]) ?? []).map((r) => ({
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    channel: r.channel,
    updatedAt: r.updated_at,
  }));
}

export async function stampInbound(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Dashboard: settings, analytics, conversation list.
// ---------------------------------------------------------------------------

/** Whether the agent is enabled for a site (defaults to true when unset). */
export async function isAgentEnabled(siteId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_settings")
    .select("enabled")
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return true;
  return (data as { enabled: boolean }).enabled;
}

/** Per-site enabled map for the given sites (default true when no row). */
export async function getAgentSettings(siteIds: string[]): Promise<Record<string, boolean>> {
  const db = serviceClient();
  const { data, error } = await db.from("agent_settings").select("site_id, enabled").in("site_id", siteIds);
  if (error) throw error;
  const map: Record<string, boolean> = {};
  for (const id of siteIds) map[id] = true;
  for (const r of (data as { site_id: string; enabled: boolean }[]) ?? []) map[r.site_id] = r.enabled;
  return map;
}

export async function setAgentEnabled(siteId: string, enabled: boolean): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_settings")
    .upsert({ site_id: siteId, enabled, updated_at: new Date().toISOString() }, { onConflict: "site_id" });
  if (error) throw error;
}

export interface AgentAnalytics {
  total: number;
  active: number;
  booked: number;
  needsHuman: number;
}

export async function getAgentAnalytics(siteIds: string[], channel?: string): Promise<AgentAnalytics> {
  const db = serviceClient();
  let q = db.from("agent_conversation").select("status").in("site_id", siteIds);
  if (channel) q = q.eq("channel", channel);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data as { status: string }[]) ?? [];
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    booked: rows.filter((r) => r.status === "booked").length,
    needsHuman: rows.filter((r) => r.status === "needs_human").length,
  };
}

export interface DashboardConversation {
  id: string;
  patientName: string;
  treatment: string | null;
  channel: string;
  status: ConversationStatus;
  lastMessage: string;
  lastMessageRole: MessageRole;
  messageCount: number;
  updatedAt: string;
}

/** Conversations for the dashboard, newest first, each with its latest message + count. */
export async function listDashboardConversations(
  siteIds: string[],
  channel?: string,
  limit = 50,
): Promise<DashboardConversation[]> {
  const db = serviceClient();
  let q = db.from("agent_conversation").select("*").in("site_id", siteIds);
  if (channel) q = q.eq("channel", channel);
  const { data: convs, error } = await q.order("updated_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const conversations = (convs as ConvRow[]) ?? [];
  if (conversations.length === 0) return [];

  const ids = conversations.map((c) => c.id);
  const { data: msgs, error: mErr } = await db
    .from("agent_message")
    .select("conversation_id, role, body, created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: true });
  if (mErr) throw mErr;
  const messages = (msgs as { conversation_id: string; role: string; body: string; created_at: string }[]) ?? [];

  const byConv = new Map<string, { last: { role: string; body: string }; count: number }>();
  for (const m of messages) {
    const cur = byConv.get(m.conversation_id) ?? { last: { role: m.role, body: m.body }, count: 0 };
    cur.last = { role: m.role, body: m.body };
    cur.count += 1;
    byConv.set(m.conversation_id, cur);
  }

  return conversations.map((c) => {
    const agg = byConv.get(c.id);
    return {
      id: c.id,
      patientName: c.patient_name,
      treatment: c.treatment,
      channel: c.channel,
      status: c.status as ConversationStatus,
      lastMessage: agg?.last.body ?? "",
      lastMessageRole: (agg?.last.role as MessageRole) ?? "patient",
      messageCount: agg?.count ?? 0,
      updatedAt: c.updated_at,
    };
  });
}
