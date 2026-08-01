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
  { name: "reviews", touchTable: "review_touch", parentKey: "request_id", parentTable: "review_request" },
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
    ...TOUCH_SOURCES.map((s) =>
      loadTouchSource(s, siteIds).catch((err) => {
        // Surface the error (e.g. an FK column mismatch) instead of silently
        // dropping the source, so a misconfigured source is not invisible.
        console.warn(`inbox: failed to load touch source "${s.name}"`, err);
        return [] as InboxMessage[];
      }),
    ),
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

/**
 * One patient's thread, filtered AT THE QUERY LEVEL rather than by loading every
 * thread for the site and then finding one.
 *
 * getThread above does exactly that, which is acceptable behind a drawer opened
 * occasionally and wasteful on a record page that a receptionist opens all day: it
 * pulls up to 400 rows from each of six stores, groups them all, and throws away
 * everything but one contact. Here each source is asked for this patient only.
 *
 * A null thread means nothing at all is held, which the Correspondence tab renders as
 * "no messages have been sent to this patient FROM THIS PLATFORM" rather than as
 * "this patient has never been contacted".
 *
 * IT REPORTS ITS OWN FAILURES, and that is not cosmetic. Every one of the seven
 * sources is caught individually so one dead table cannot blank the tab. Without a
 * signal that resilience becomes a lie on a clinical record: if two of the six touch
 * tables error the tab showed a partial history as if it were the whole one, and if
 * every source errored it returned null and the tab stated in writing that this
 * patient has never been messaged. The counts below are what let the panel say which
 * of the three it is.
 */
export interface PatientThreadRead {
  thread: Thread | null;
  /** How many of the sources threw. 0 in the normal case. */
  failedSources: number;
  /** How many were attempted, so the caller can tell "some" from "all". */
  totalSources: number;
}

export async function getThreadForPatient(siteIds: string[], patientId: string): Promise<PatientThreadRead> {
  const totalSources = 1 + TOUCH_SOURCES.length;
  if (siteIds.length === 0 || !patientId) return { thread: null, failedSources: 0, totalSources };
  let failedSources = 0;
  const fail = () => {
    failedSources += 1;
    return [] as InboxMessage[];
  };
  const results = await Promise.all([
    loadAgentMessagesForPatient(siteIds, patientId).catch((err) => {
      console.warn("inbox: failed to load agent messages for one patient", err);
      return fail();
    }),
    ...TOUCH_SOURCES.map((s) =>
      loadTouchSourceForPatient(s, siteIds, patientId).catch((err) => {
        console.warn(`inbox: failed to load touch source "${s.name}" for one patient`, err);
        return fail();
      }),
    ),
  ]);
  const messages = results.flat();
  if (messages.length === 0) return { thread: null, failedSources, totalSources };
  const threads = groupThreads(messages);
  // groupThreads keys on contactRef; a patient can appear as `patient:<id>` from every
  // source, so there is normally exactly one thread here. Pick the patient's own.
  const thread = threads.find((t) => t.contactRef === `patient:${patientId}`) ?? threads[0] ?? null;
  return { thread, failedSources, totalSources };
}

async function loadAgentMessagesForPatient(siteIds: string[], patientId: string): Promise<InboxMessage[]> {
  const db = serviceClient();
  const { data: convs, error: cErr } = await db
    .from("agent_conversation")
    .select("id, site_id, dentally_patient_id, patient_name, channel")
    .in("site_id", siteIds)
    // The agent store keys a known patient as the raw id; `patient:<id>` is the
    // canonical form the rest of the inbox uses. Accept both so a row written by
    // either convention is found.
    .in("dentally_patient_id", [patientId, `patient:${patientId}`])
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
    .order("created_at", { ascending: true })
    .limit(PER_SOURCE_LIMIT);
  if (mErr) throw mErr;

  const out: InboxMessage[] = [];
  for (const m of (msgs as AgentMsgRow[]) ?? []) {
    const conv = byId.get(m.conversation_id);
    if (!conv) continue;
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

async function loadTouchSourceForPatient(
  source: TouchSource,
  siteIds: string[],
  patientId: string,
): Promise<InboxMessage[]> {
  const db = serviceClient();
  // Parents first: the patient id lives on the parent (target/opportunity/request),
  // not on the touch, so the filter has to start there. That is what makes this a
  // query-level filter rather than a scan-and-discard.
  const { data: parents, error: pErr } = await db
    .from(source.parentTable)
    .select("id, dentally_patient_id, patient_name")
    .in("site_id", siteIds)
    .eq("dentally_patient_id", patientId);
  if (pErr) throw pErr;
  const parentRows = (parents as ParentRow[]) ?? [];
  if (parentRows.length === 0) return [];
  const byParent = new Map<string, ParentRow>();
  for (const p of parentRows) byParent.set(p.id, p);

  const { data: touches, error: tErr } = await db
    .from(source.touchTable)
    .select(`id, site_id, ${source.parentKey}, channel, direction, body, created_at`)
    .in("site_id", siteIds)
    .in(source.parentKey, Array.from(byParent.keys()))
    .order("created_at", { ascending: false })
    .limit(PER_SOURCE_LIMIT)
    .overrideTypes<Array<Record<string, unknown>>>();
  if (tErr) throw tErr;

  const out: InboxMessage[] = [];
  for (const raw of ((touches as Array<Record<string, unknown>> | null) ?? [])) {
    const parent = byParent.get(String(raw[source.parentKey] ?? ""));
    if (!parent) continue;
    const direction: InboxDirection = raw.direction === "inbound" ? "inbound" : "outbound";
    out.push({
      id: `${source.name}:${String(raw.id)}`,
      contactRef: `patient:${parent.dentally_patient_id}`,
      contactName: parent.patient_name,
      channel: toInboxChannel(String(raw.channel ?? "sms")),
      direction,
      body: String(raw.body ?? ""),
      at: String(raw.created_at),
      source: source.name,
    });
  }
  return out;
}
