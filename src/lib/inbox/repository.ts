import { serviceClient } from "@/lib/supabase/server";
import {
  directionFromAgentRole,
  groupThreads,
  toInboxChannel,
} from "./normalise";
import type { InboxDirection, InboxMessage, Thread } from "./types";

// The Conversations inbox aggregates read-only across the stores that already
// hold patient messages. No new schema: the agent conversation store is the
// spine (every inbound SMS/WhatsApp, after-hours overflow and speed-to-lead reply
// threads into agent_conversation/agent_message), and the per-module lifecycle
// agents (reactivation, recall, no-show, treatment coordinator, reviews) keep
// their own *_touch rows. Every read is scoped to the caller's siteIds.

// How many recent rows to pull per source. Bounded so the inbox stays snappy and
// never scans an unbounded history; the newest activity is what matters here.
const PER_SOURCE_LIMIT = 400;

// ---------------------------------------------------------------------------
// Agent conversation store (the live two-way spine).
// ---------------------------------------------------------------------------

interface AgentConvRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  channel: string;
}
interface AgentMsgRow {
  id: string;
  conversation_id: string;
  role: string;
  body: string;
  created_at: string;
}

/**
 * Map a conversation's dentally_patient_id to a canonical contactRef. The agent
 * store keys known patients as the raw id and unknown enquiries as `lead:<phone>`,
 * so we normalise the former to `patient:<id>` to match the module sources and the
 * reply route's resolver.
 */
function contactRefFromConv(dentallyPatientId: string): string {
  if (dentallyPatientId.startsWith("lead:") || dentallyPatientId.startsWith("patient:")) {
    return dentallyPatientId;
  }
  return `patient:${dentallyPatientId}`;
}

async function loadAgentMessages(siteIds: string[]): Promise<InboxMessage[]> {
  const db = serviceClient();
  const { data: convs, error: cErr } = await db
    .from("agent_conversation")
    .select("id, site_id, dentally_patient_id, patient_name, channel")
    .in("site_id", siteIds)
    .order("updated_at", { ascending: false })
    .limit(PER_SOURCE_LIMIT);
  if (cErr) throw cErr;
  const conversations = (convs as AgentConvRow[]) ?? [];
  if (conversations.length === 0) return [];

  const byId = new Map<string, AgentConvRow>();
  for (const c of conversations) byId.set(c.id, c);

  const { data: msgs, error: mErr } = await db
    .from("agent_message")
    .select("id, conversation_id, role, body, created_at")
    .in("conversation_id", Array.from(byId.keys()))
    .order("created_at", { ascending: true });
  if (mErr) throw mErr;

  const out: InboxMessage[] = [];
  for (const m of (msgs as AgentMsgRow[]) ?? []) {
    const conv = byId.get(m.conversation_id);
    if (!conv) continue;
    // tool/system trace rows are internal; only surface real patient + agent turns.
    if (m.role !== "patient" && m.role !== "agent") continue;
    out.push({
      id: `agent:${m.id}`,
      contactRef: contactRefFromConv(conv.dentally_patient_id),
      contactName: conv.patient_name,
      channel: toInboxChannel(conv.channel),
      direction: directionFromAgentRole(m.role),
      body: m.body,
      at: m.created_at,
      source: "agent",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-module touch sources (the lifecycle agents).
// ---------------------------------------------------------------------------

interface TouchRow {
  id: string;
  site_id: string;
  parent_id: string;
  channel: string;
  direction: string | null;
  body: string;
  created_at: string;
}
interface ParentRow {
  id: string;
  dentally_patient_id: string;
  patient_name: string;
}

interface TouchSource {
  /** Source label surfaced on each message. */
  name: string;
  touchTable: string;
  /** FK column on the touch row pointing at its parent. */
  parentKey: string;
  /** Parent table carrying the patient identity. */
  parentTable: string;
}

const TOUCH_SOURCES: TouchSource[] = [
  { name: "reactivation", touchTable: "reactivation_touch", parentKey: "target_id", parentTable: "reactivation_target" },
  { name: "recall", touchTable: "recall_touch", parentKey: "target_id", parentTable: "recall_target" },
  { name: "noshow", touchTable: "noshow_touch", parentKey: "target_id", parentTable: "noshow_target" },
  { name: "coordinator", touchTable: "coordinator_touch", parentKey: "opportunity_id", parentTable: "treatment_opportunity" },
  { name: "reviews", touchTable: "review_touch", parentKey: "opportunity_id", parentTable: "review_request" },
];

async function loadTouchSource(source: TouchSource, siteIds: string[]): Promise<InboxMessage[]> {
  const db = serviceClient();
  // The select column list is built per-source (different FK column per module),
  // so the typed-string parser can't infer it: query through a loosely typed
  // builder and validate the shape ourselves below.
  const { data: touches, error: tErr } = await db
    .from(source.touchTable)
    .select(`id, site_id, ${source.parentKey}, channel, direction, body, created_at`)
    .in("site_id", siteIds)
    .order("created_at", { ascending: false })
    .limit(PER_SOURCE_LIMIT)
    .overrideTypes<Array<Record<string, unknown>>>();
  if (tErr) throw tErr;
  const rows = ((touches as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
    id: String(r.id),
    site_id: String(r.site_id),
    parent_id: String(r[source.parentKey] ?? ""),
    channel: String(r.channel ?? "sms"),
    direction: (r.direction as string | null) ?? null,
    body: String(r.body ?? ""),
    created_at: String(r.created_at),
  })) as TouchRow[];
  if (rows.length === 0) return [];

  const parentIds = Array.from(new Set(rows.map((r) => r.parent_id).filter(Boolean)));
  const { data: parents, error: pErr } = await db
    .from(source.parentTable)
    .select("id, dentally_patient_id, patient_name")
    .in("id", parentIds);
  if (pErr) throw pErr;
  const byParent = new Map<string, ParentRow>();
  for (const p of (parents as ParentRow[]) ?? []) byParent.set(p.id, p);

  const out: InboxMessage[] = [];
  for (const r of rows) {
    const parent = byParent.get(r.parent_id);
    if (!parent) continue;
    const direction: InboxDirection = r.direction === "inbound" ? "inbound" : "outbound";
    out.push({
      id: `${source.name}:${r.id}`,
      contactRef: `patient:${parent.dentally_patient_id}`,
      contactName: parent.patient_name,
      channel: toInboxChannel(r.channel),
      direction,
      body: r.body,
      at: r.created_at,
      source: source.name,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

async function loadAllMessages(siteIds: string[]): Promise<InboxMessage[]> {
  if (siteIds.length === 0) return [];
  // Each source is independent and self-contained; a failure in one store must
  // not blank the whole inbox, so we swallow per-source errors and aggregate the
  // rest. This mirrors the resilience the module views already use.
  const results = await Promise.all([
    loadAgentMessages(siteIds).catch(() => [] as InboxMessage[]),
    ...TOUCH_SOURCES.map((s) => loadTouchSource(s, siteIds).catch(() => [] as InboxMessage[])),
  ]);
  return results.flat();
}

/** Every patient thread across all sources, newest activity first, scoped to siteIds. */
export async function listThreads(siteIds: string[]): Promise<Thread[]> {
  const messages = await loadAllMessages(siteIds);
  return groupThreads(messages);
}

/** A single thread for one contact, or null if nothing is held for them. */
export async function getThread(siteIds: string[], contactRef: string): Promise<Thread | null> {
  const threads = await listThreads(siteIds);
  return threads.find((t) => t.contactRef === contactRef) ?? null;
}
