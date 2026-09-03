import { serviceClient } from "@/lib/supabase/server";
import {
  directionFromAgentRole,
  groupThreads,
  toInboxChannel,
} from "./normalise";
import { belongsOnRecord, normaliseDeliveryStatus } from "./delivery";
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
      // A conversation turn is a message that HAPPENED: the patient's own words, or
      // a reply the agent already put on the wire. There is no draft state and no
      // approver here, and inventing a "queued" for it would be inventing a state
      // this store does not have.
      status: "sent",
      actionedBy: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-module touch sources (the lifecycle agents).
// ---------------------------------------------------------------------------

/** A parent row, normalised: whichever columns the module happens to name them. */
interface ParentRow {
  id: string;
  patientId: string;
  patientName: string;
}

/** Where a touch row's patient identity lives. */
type PatientLink =
  | {
      via: "parent";
      parentTable: string;
      /** FK column on the touch row pointing at its parent. */
      parentKey: string;
      /** Column on the parent carrying the Dentally patient id. */
      idCol: string;
      /** Column on the parent carrying the patient's name, or null when it has none. */
      nameCol: string | null;
    }
  /** The touch row itself carries the patient id; there is no parent table. */
  | { via: "row"; idCol: string };

interface TouchSource {
  /** Source label surfaced on each message; also the key into SOURCE_LABEL. */
  name: string;
  table: string;
  /** Site column on the touch row, or null when only the PARENT is site-scoped. */
  siteCol: string | null;
  /** Direction column, or null when the table only ever holds outbound rows. */
  directionCol: string | null;
  /** Delivery-status column, or null when the table has none. */
  statusCol: string | null;
  /** Column naming the human who approved or actioned the send, or null. */
  actorCol: string | null;
  /** Column holding when the message actually LEFT, or null when the table has none. */
  sentAtCol: string | null;
  patient: PatientLink;
}

/**
 * Every MODULE STORE this platform can put words in front of a patient from.
 *
 * NOT, on its own, every message: the two registries below it are the other half.
 * See the note under ADDING A SENDER at the foot of this comment.
 *
 * This list used to hold five of them. The drain has eleven outbox sources and the
 * speed-to-lead agent sends outside the drain entirely, so the Correspondence tab —
 * the screen a coordinator opens to answer "what have we already said to her?" —
 * was missing the treatment-plan closer, the balance reminder, the aftercare
 * check-in, segment campaigns, appointment-change notifications and every
 * first-contact reply to a new enquiry. Six whole modules of real messages, absent
 * from the record, under a heading that says "Messages sent from this platform".
 *
 * That is worse than an incomplete screen. The tab's empty state reads "No messages
 * have been sent to this patient from this platform", which was printed as a fact
 * about patients the balance agent had texted three times.
 *
 * THE SHAPE VARIES because these tables were written months apart, and the config
 * below is the honest way to say so rather than pretending they are uniform:
 *   - the closer hangs off treatment_opportunity, the SAME parent as the coordinator;
 *   - the balance reminder carries `patient_id` on the touch row and has no parent;
 *   - segment outreach names its columns `patient_id` / `name`, not the
 *     `dentally_patient_id` / `patient_name` the older modules use;
 *   - diary notifications hang off a move that may carry no patient at all;
 *   - the aftercare check-in records `actioned_by` where the others record
 *     `approved_by`;
 *   - speed-to-lead's attempt log has no site column, no direction column and no
 *     sent_at at all, and is site-scoped only through its lead.
 *
 * ADDING A MODULE: add it here AND to SOURCE_LABEL in ./delivery. A coverage test
 * pins the two together, so a new messaging module cannot ship half-registered.
 *
 * ADDING A SENDER THAT IS NOT A MODULE — and this is the half that was missing.
 * Registering every touch table proved that no DRAIN module was absent, and said
 * nothing at all about the four senders that never touch the drain: the missed-call
 * callback, the no-show confirmation reply, the aftercare acknowledgement and the
 * co-pilot's own send. All four texted real patients and wrote to none of the tables
 * below, so this list was complete and the record still was not.
 *
 * They now append to the agent conversation store — the `agent` source, read by
 * loadAgentMessagesForPatient — via src/lib/inbox/record-outbound.ts. And the claim
 * itself is now checkable: ./send-sites.ts enumerates EVERY sendMessage call site in
 * the codebase with its audience, and ./send-sites.test.ts derives that list from the
 * source tree and fails if the two disagree in either direction.
 *
 * So: a new sender goes in ./send-sites.ts, and if it is patient-facing it must land
 * in one of the sources here or in the agent store. There is no third option that
 * leaves the tab's wording true.
 *
 * AND THE KEY MATTERS AS MUCH AS THE TABLE. Landing in the agent store is not the
 * same as landing on the PATIENT: loadAgentMessagesForPatient below filters
 * dentally_patient_id to [id, `patient:<id>`], so a row keyed `lead:<number>` — what
 * outboundPatientKey produces whenever identifyByPhone returned nothing — is on a
 * conversation this read never opens. That is not confined to strangers.
 * identifyByPhone matches on mobile_phone ALONE, so a real patient ringing from a
 * landline, a work number or a shared family number lands there, as does anyone whose
 * Dentally lookup outran the voice route's 3s cap. Nothing re-keys it afterwards. The
 * screen therefore names the exception instead of claiming completeness, and the
 * correspondence empty state sends the reader to the Conversations inbox.
 */
const TOUCH_SOURCES: TouchSource[] = [
  {
    name: "reactivation", table: "reactivation_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "reactivation_target", parentKey: "target_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    name: "recall", table: "recall_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "recall_target", parentKey: "target_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    // NOTE a real limit, recorded in docs/runbooks/correspondence-visibility.md:
    // noshow_touch.target_id is NULLABLE because waitlist slot-offer texts are not
    // tied to a defended target. Those rows carry no patient identity of any kind,
    // so they cannot appear on anybody's record. They are visible in the no-show
    // module's own view; nothing here can fix that without a schema change.
    name: "noshow", table: "noshow_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "noshow_target", parentKey: "target_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    name: "coordinator", table: "coordinator_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "treatment_opportunity", parentKey: "opportunity_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    name: "closer", table: "closer_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "treatment_opportunity", parentKey: "opportunity_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    name: "postop", table: "postop_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "actioned_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "postop_target", parentKey: "target_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    // The pre-visit questionnaire link. `actorCol` is NULL and it is the only
    // outbound source here with no actor at all, which is truthful rather than a
    // gap: this module has no approval step (see the header of migration 0097), so
    // there is no person to name. A column filled with "system" or with the cron's
    // name would put a fabricated actor on a patient's correspondence record.
    name: "previsit", table: "previsit_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: null, sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "previsit_target", parentKey: "target_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    name: "reviews", table: "review_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "review_request", parentKey: "request_id", idCol: "dentally_patient_id", nameCol: "patient_name" },
  },
  {
    // The only source with no parent table: collection_touch carries the Dentally
    // patient id itself. It therefore also carries no patient NAME, which is fine
    // on a record (the page knows whose it is) and is why groupThreads takes the
    // most recent NON-EMPTY name across a thread rather than the newest row's.
    name: "collection", table: "collection_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "row", idCol: "patient_id" },
  },
  {
    name: "outreach", table: "outreach_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "outreach_target", parentKey: "target_id", idCol: "patient_id", nameCol: "name" },
  },
  {
    // diary_move.patient_id is nullable and diary_touch.move_id is nullable, so a
    // notification whose move was deleted resolves to no patient and is dropped.
    // Recorded in the runbook rather than papered over.
    name: "diary", table: "diary_touch", siteCol: "site_id", directionCol: "direction",
    statusCol: "status", actorCol: "approved_by", sentAtCol: "sent_at",
    patient: { via: "parent", parentTable: "diary_move", parentKey: "move_id", idCol: "patient_id", nameCol: null },
  },
  {
    // The first reply to a new enquiry. It does NOT double up with the agent spine:
    // speed_to_lead_attempt logs the OUTBOUND first contact, and agent_conversation
    // only starts once the lead replies. Before this it appeared nowhere on a record.
    // A lead who never resolved to a Dentally patient has no record to appear on.
    name: "speed-to-lead", table: "speed_to_lead_attempt", siteCol: null, directionCol: null,
    statusCol: "status", actorCol: null, sentAtCol: null,
    patient: { via: "parent", parentTable: "speed_to_lead_lead", parentKey: "lead_id", idCol: "dentally_patient_id", nameCol: "name" },
  },
];

/** The registered source names, for the coverage test and for callers reporting health. */
export const CORRESPONDENCE_SOURCE_NAMES: string[] = ["agent", ...TOUCH_SOURCES.map((s) => s.name)];

/** The columns one source needs, built per-source because no two tables agree. */
function touchSelect(source: TouchSource): string {
  const cols = new Set<string>(["id", "channel", "body", "created_at"]);
  if (source.siteCol) cols.add(source.siteCol);
  if (source.directionCol) cols.add(source.directionCol);
  if (source.statusCol) cols.add(source.statusCol);
  if (source.actorCol) cols.add(source.actorCol);
  if (source.sentAtCol) cols.add(source.sentAtCol);
  cols.add(source.patient.via === "parent" ? source.patient.parentKey : source.patient.idCol);
  return Array.from(cols).join(", ");
}

/** Read one parent table's identity columns under whatever names it gave them. */
function parentSelect(link: Extract<PatientLink, { via: "parent" }>): string {
  const cols = new Set<string>(["id", link.idCol]);
  if (link.nameCol) cols.add(link.nameCol);
  return Array.from(cols).join(", ");
}

function toParentRow(link: Extract<PatientLink, { via: "parent" }>, raw: Record<string, unknown>): ParentRow | null {
  const patientId = raw[link.idCol];
  // A parent with no patient id (a diary move on an unassigned slot, a lead that
  // never became a record) cannot be attributed to anyone. Dropped, not guessed.
  if (typeof patientId !== "string" || patientId === "") return null;
  return {
    id: String(raw.id),
    patientId,
    patientName: link.nameCol ? String(raw[link.nameCol] ?? "") : "",
  };
}

/**
 * One touch row → one inbox message, or null when it does not belong on a record.
 *
 * Drafts and discarded drafts are filtered HERE rather than in the query, because
 * `status` is a per-source column name and a filter written eleven times is a filter
 * that will eventually be forgotten once.
 */
function toTouchMessage(
  source: TouchSource,
  raw: Record<string, unknown>,
  patientId: string,
  patientName: string,
): InboxMessage | null {
  const status = source.statusCol ? normaliseDeliveryStatus(raw[source.statusCol] as string | null) : "unknown";
  if (!belongsOnRecord(status)) return null;
  const direction: InboxDirection =
    source.directionCol && raw[source.directionCol] === "inbound" ? "inbound" : "outbound";
  const sentAt = source.sentAtCol ? (raw[source.sentAtCol] as string | null) : null;
  return {
    id: `${source.name}:${String(raw.id)}`,
    contactRef: `patient:${patientId}`,
    contactName: patientName,
    channel: toInboxChannel(String(raw.channel ?? "sms")),
    direction,
    body: String(raw.body ?? ""),
    // When it LEFT, falling back to when it was written. A draft approved on Monday
    // and sent on Wednesday belongs on Wednesday in a record of what was said.
    at: sentAt && sentAt !== "" ? sentAt : String(raw.created_at),
    source: source.name,
    status,
    actionedBy: source.actorCol ? ((raw[source.actorCol] as string | null) ?? null) : null,
  };
}

async function loadTouchSource(source: TouchSource, siteIds: string[]): Promise<InboxMessage[]> {
  const db = serviceClient();
  const link = source.patient;

  // No parent table: the touch row carries the patient id itself.
  if (link.via === "row") {
    const { data, error } = await db
      .from(source.table)
      .select(touchSelect(source))
      .in("site_id", siteIds)
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (error) throw error;
    const out: InboxMessage[] = [];
    for (const raw of (data as Array<Record<string, unknown>> | null) ?? []) {
      const patientId = raw[link.idCol];
      if (typeof patientId !== "string" || patientId === "") continue;
      const msg = toTouchMessage(source, raw, patientId, "");
      if (msg) out.push(msg);
    }
    return out;
  }

  // A touch table with no site column of its own (speed-to-lead's attempt log) is
  // site-scoped only through its parent, so the parent has to be read FIRST and the
  // touches fetched by parent id. Bounded exactly as the agent spine is, rather than
  // reading the newest attempts across every client and filtering afterwards.
  let byParent = new Map<string, ParentRow>();
  let rows: Array<Record<string, unknown>> = [];

  if (source.siteCol === null) {
    const { data: parents, error: pErr } = await db
      .from(link.parentTable)
      .select(parentSelect(link))
      .in("site_id", siteIds)
      .limit(PER_SOURCE_LIMIT)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (pErr) throw pErr;
    byParent = parentMap(link, (parents as Array<Record<string, unknown>> | null) ?? []);
    if (byParent.size === 0) return [];
    const { data, error } = await db
      .from(source.table)
      .select(touchSelect(source))
      .in(link.parentKey, Array.from(byParent.keys()))
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (error) throw error;
    rows = (data as Array<Record<string, unknown>> | null) ?? [];
  } else {
    const { data, error } = await db
      .from(source.table)
      .select(touchSelect(source))
      .in(source.siteCol, siteIds)
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (error) throw error;
    rows = (data as Array<Record<string, unknown>> | null) ?? [];
    if (rows.length === 0) return [];
    const parentIds = Array.from(
      new Set(rows.map((r) => String(r[link.parentKey] ?? "")).filter((v) => v !== "")),
    );
    if (parentIds.length === 0) return [];
    const { data: parents, error: pErr } = await db
      .from(link.parentTable)
      .select(parentSelect(link))
      .in("id", parentIds)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (pErr) throw pErr;
    byParent = parentMap(link, (parents as Array<Record<string, unknown>> | null) ?? []);
  }

  const out: InboxMessage[] = [];
  for (const raw of rows) {
    const parent = byParent.get(String(raw[link.parentKey] ?? ""));
    if (!parent) continue;
    const msg = toTouchMessage(source, raw, parent.patientId, parent.patientName);
    if (msg) out.push(msg);
  }
  return out;
}

function parentMap(
  link: Extract<PatientLink, { via: "parent" }>,
  raws: Array<Record<string, unknown>>,
): Map<string, ParentRow> {
  const map = new Map<string, ParentRow>();
  for (const raw of raws) {
    const p = toParentRow(link, raw);
    if (p) map.set(p.id, p);
  }
  return map;
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
  /**
   * WHICH sources threw, by name.
   *
   * A count alone told the reader that something was missing but not what, which on
   * a record leaves them no way to go and look. "The balance reminder history could
   * not be read" sends someone to the collection module; "1 of 12 sources failed"
   * sends them nowhere.
   */
  failedSourceNames: string[];
}

export async function getThreadForPatient(siteIds: string[], patientId: string): Promise<PatientThreadRead> {
  const totalSources = 1 + TOUCH_SOURCES.length;
  if (siteIds.length === 0 || !patientId) {
    return { thread: null, failedSources: 0, totalSources, failedSourceNames: [] };
  }
  const failedSourceNames: string[] = [];
  const fail = (name: string) => {
    failedSourceNames.push(name);
    return [] as InboxMessage[];
  };
  const results = await Promise.all([
    loadAgentMessagesForPatient(siteIds, patientId).catch((err) => {
      console.warn("inbox: failed to load agent messages for one patient", err);
      return fail("agent");
    }),
    ...TOUCH_SOURCES.map((s) =>
      loadTouchSourceForPatient(s, siteIds, patientId).catch((err) => {
        console.warn(`inbox: failed to load touch source "${s.name}" for one patient`, err);
        return fail(s.name);
      }),
    ),
  ]);
  const failedSources = failedSourceNames.length;
  const messages = results.flat();
  if (messages.length === 0) return { thread: null, failedSources, totalSources, failedSourceNames };
  const threads = groupThreads(messages);
  // groupThreads keys on contactRef; a patient can appear as `patient:<id>` from every
  // source, so there is normally exactly one thread here. Pick the patient's own.
  const thread = threads.find((t) => t.contactRef === `patient:${patientId}`) ?? threads[0] ?? null;
  return { thread, failedSources, totalSources, failedSourceNames };
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
      // A conversation turn is a message that HAPPENED: the patient's own words, or
      // a reply the agent already put on the wire. There is no draft state and no
      // approver here, and inventing a "queued" for it would be inventing a state
      // this store does not have.
      status: "sent",
      actionedBy: null,
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
  const link = source.patient;

  // No parent table: filter the touch rows on the patient id directly.
  if (link.via === "row") {
    const { data, error } = await db
      .from(source.table)
      .select(touchSelect(source))
      .in("site_id", siteIds)
      .eq(link.idCol, patientId)
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .overrideTypes<Array<Record<string, unknown>>>();
    if (error) throw error;
    const out: InboxMessage[] = [];
    for (const raw of (data as Array<Record<string, unknown>> | null) ?? []) {
      const msg = toTouchMessage(source, raw, patientId, "");
      if (msg) out.push(msg);
    }
    return out;
  }

  // Parents first: the patient id lives on the parent (target/opportunity/request/
  // move/lead), not on the touch, so the filter has to start there. That is what
  // makes this a query-level filter rather than a scan-and-discard.
  const parentQuery = db
    .from(link.parentTable)
    .select(parentSelect(link))
    .eq(link.idCol, patientId);
  // Every parent table but one is site-scoped. speed_to_lead_lead is too; the
  // exception is that its TOUCH table is not, which is handled below.
  const { data: parents, error: pErr } = await parentQuery
    .in("site_id", siteIds)
    .limit(PER_SOURCE_LIMIT)
    .overrideTypes<Array<Record<string, unknown>>>();
  if (pErr) throw pErr;
  const byParent = parentMap(link, (parents as Array<Record<string, unknown>> | null) ?? []);
  if (byParent.size === 0) return [];

  let touchQuery = db
    .from(source.table)
    .select(touchSelect(source))
    .in(link.parentKey, Array.from(byParent.keys()));
  // The parent ids were just established inside the site boundary, so a touch table
  // WITHOUT a site column is still correctly scoped; adding a filter on a column
  // that does not exist would fail the whole read.
  if (source.siteCol) touchQuery = touchQuery.in(source.siteCol, siteIds);
  const { data: touches, error: tErr } = await touchQuery
    .order("created_at", { ascending: false })
    .limit(PER_SOURCE_LIMIT)
    .overrideTypes<Array<Record<string, unknown>>>();
  if (tErr) throw tErr;

  const out: InboxMessage[] = [];
  for (const raw of (touches as Array<Record<string, unknown>> | null) ?? []) {
    const parent = byParent.get(String(raw[link.parentKey] ?? ""));
    if (!parent) continue;
    const msg = toTouchMessage(source, raw, parent.patientId, parent.patientName);
    if (msg) out.push(msg);
  }
  return out;
}
