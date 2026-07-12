import { serviceClient } from "@/lib/supabase/server";
import type { LeadStage } from "@/lib/types";
import type {
  LeadChannel,
  LeadConsent,
  SpeedToLeadAttempt,
  SpeedToLeadLead,
} from "./types";

// Speed-to-lead owns two server-only tables: speed_to_lead_lead (the enquiry)
// and speed_to_lead_attempt (each outbound first-contact try). The agent
// conversation that threads the lead's reply lives in agent_conversation, keyed
// `lead:<phone>` so the inbound Twilio webhook routes the reply back into it.

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------

interface LeadRow {
  id: string;
  site_id: string;
  dentally_patient_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  channel: string;
  treatment_interest: string | null;
  source: string;
  score: number | string | null;
  stage: string;
  consent: LeadConsent | null;
  created_at: string;
  first_response_at: string | null;
  conversation_id: string | null;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  lead_id: string;
  channel: string;
  to_address: string;
  body: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  created_at: string;
}

function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function rowToLead(r: LeadRow): SpeedToLeadLead {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    channel: r.channel as LeadChannel,
    treatmentInterest: r.treatment_interest,
    source: r.source,
    score: numOrNull(r.score),
    stage: r.stage as LeadStage,
    consent: r.consent ?? {},
    createdAt: r.created_at,
    firstResponseAt: r.first_response_at,
    conversationId: r.conversation_id,
    updatedAt: r.updated_at,
  };
}

function rowToAttempt(r: AttemptRow): SpeedToLeadAttempt {
  return {
    id: r.id,
    leadId: r.lead_id,
    channel: r.channel as LeadChannel,
    toAddress: r.to_address,
    body: r.body,
    status: r.status as SpeedToLeadAttempt["status"],
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Leads.
// ---------------------------------------------------------------------------

export interface InsertLeadInput {
  siteId: string;
  dentallyPatientId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  channel: LeadChannel;
  treatmentInterest?: string | null;
  source?: string;
  score?: number | null;
  consent: LeadConsent;
}

export async function insertLead(input: InsertLeadInput): Promise<SpeedToLeadLead> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .insert({
      site_id: input.siteId,
      dentally_patient_id: input.dentallyPatientId ?? null,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      channel: input.channel,
      treatment_interest: input.treatmentInterest ?? null,
      source: input.source ?? "web",
      score: input.score ?? null,
      consent: input.consent,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToLead(data as LeadRow);
}

export async function getLead(id: string): Promise<SpeedToLeadLead | null> {
  const db = serviceClient();
  const { data, error } = await db.from("speed_to_lead_lead").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToLead(data as LeadRow) : null;
}

export async function listLeads(args: {
  siteIds: string[];
  stages?: LeadStage[];
  limit?: number;
}): Promise<SpeedToLeadLead[]> {
  const db = serviceClient();
  let q = db.from("speed_to_lead_lead").select("*").in("site_id", args.siteIds);
  if (args.stages && args.stages.length > 0) q = q.in("stage", args.stages);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 200);
  if (error) throw error;
  return (data as LeadRow[]).map(rowToLead);
}

export async function setLeadStage(id: string, stage: LeadStage): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("speed_to_lead_lead")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Atomically claim a lead for first-contact by the SLA sweep. A single
 * conditional UPDATE flips stage 'new' → 'contacting' and returns the row only if
 * it was still 'new'; exactly one caller can win. The sweep contacts only on a
 * true return, so it can never race the in-request intake contact (which already
 * owns its brand-new lead). On a send failure the caller must reset the claimed
 * lead back to 'new' so the next sweep can retry it.
 *
 * Returns true iff THIS call won the claim (a row was flipped).
 */
export async function claimLeadForContact(id: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .update({ stage: "contacting", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("stage", "new")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Atomically claim a lead for (re)contact from a SPECIFIC current stage -> 'contacting'.
 * Returns true only if THIS call transitioned it. Used by the staff "resend" action,
 * which can fire on a lead in any non-terminal stage: two concurrent resends (or a
 * resend racing the SLA sweep) can't both proceed because only one wins the flip.
 */
export async function claimLeadFromStage(id: string, from: LeadStage): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .update({ stage: "contacting", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("stage", from)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Reset any lead stranded at 'contacting' longer than `staleMinutes` back to 'new' so
 * the SLA sweep re-picks it up. A crash / function timeout between claim and the
 * contactLead stage-advance would otherwise leave a lead 'contacting' forever (never
 * re-contacted, never surfaced). claimLeadForContact/FromStage bump updated_at, so an
 * in-flight contact within the window is safe from this reset. Returns the count reset.
 */
export async function resetStaleContacting(staleMinutes = 10): Promise<number> {
  const db = serviceClient();
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .update({ stage: "new", updated_at: new Date().toISOString() })
    .eq("stage", "contacting")
    .lt("updated_at", cutoff)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Release a claim made by {@link claimLeadForContact} IFF the lead is still
 * 'contacting' — a conditional UPDATE 'contacting' → 'new'. Idempotent and safe to
 * call after every contact attempt: if the contact succeeded (lead now
 * 'contacted') or progressed, this is a no-op; only a stranded claim (contactLead
 * threw, or returned early for no-consent/no-address without advancing) is reset
 * to 'new' so the SLA sweep can re-pick it up.
 */
export async function releaseLeadClaim(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("speed_to_lead_lead")
    .update({ stage: "new", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("stage", "contacting");
  if (error) throw error;
}

export async function recordFirstResponse(
  id: string,
  fields: { firstResponseAt: string; conversationId: string | null },
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("speed_to_lead_lead")
    .update({
      first_response_at: fields.firstResponseAt,
      conversation_id: fields.conversationId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Leads still uncontacted (stage 'new', no first response) older than the cutoff.
 * The SLA sweep picks these up when the in-request contact did not fire in time.
 * Bounded to the last 48 hours (mirrors the drain's staleness guard): a lead
 * stranded at 'new' for days — e.g. from before the system was switched on —
 * must not get a "we just got your enquiry" text the moment the toggle flips.
 */
const MAX_UNCONTACTED_AGE_MS = 48 * 60 * 60 * 1000;

export async function listUncontacted(olderThanIso: string): Promise<SpeedToLeadLead[]> {
  const db = serviceClient();
  const freshestIso = new Date(Date.now() - MAX_UNCONTACTED_AGE_MS).toISOString();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .select("*")
    .eq("stage", "new")
    .is("first_response_at", null)
    .lt("created_at", olderThanIso)
    .gte("created_at", freshestIso)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as LeadRow[]).map(rowToLead);
}

/**
 * How many leads from the same contact (phone or email) landed since `sinceIso`.
 * Powers the intake rate-limit so one number/address cannot flood us.
 */
export async function countRecentByContact(phoneOrEmail: string, sinceIso: string): Promise<number> {
  const db = serviceClient();
  // Two parameterized .eq() counts, NOT an interpolated .or() filter (which would
  // let a crafted phone/email rewrite the predicate and bypass the rate-limit).
  const byPhone = await db
    .from("speed_to_lead_lead")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso)
    .eq("phone", phoneOrEmail);
  if (byPhone.error) throw byPhone.error;
  const byEmail = await db
    .from("speed_to_lead_lead")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso)
    .eq("email", phoneOrEmail);
  if (byEmail.error) throw byEmail.error;
  return (byPhone.count ?? 0) + (byEmail.count ?? 0);
}

/**
 * An already-open lead for this site reachable at the same (normalised) phone or
 * email created since `sinceIso`, or null. Both insert paths (intake + the
 * smile-assessment bridge) use this to avoid a duplicate lead + double first SMS.
 */
export async function findOpenLeadByAddress(
  siteId: string,
  phone: string | null,
  email: string | null,
  sinceIso: string,
): Promise<SpeedToLeadLead | null> {
  const db = serviceClient();
  for (const [col, val] of [["phone", phone], ["email", email]] as const) {
    if (!val) continue;
    const { data, error } = await db
      .from("speed_to_lead_lead")
      .select("*")
      .eq("site_id", siteId)
      .eq(col, val)
      .in("stage", ["new", "contacting", "contacted", "qualifying"])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return rowToLead(data as LeadRow);
  }
  return null;
}

/**
 * An OPEN lead for this contact created STRICTLY BEFORE `beforeIso`, excluding
 * `excludeId`. There is no DB unique constraint on (site, contact), so two
 * near-simultaneous submits can both pass the pre-insert dedup and create two leads.
 * After inserting, the caller re-checks: if a strictly-earlier open lead exists, this
 * one lost the race and is retired, so the patient is first-contacted once. Strict
 * `<` (not `<=`) means two rows with the exact same timestamp never retire EACH OTHER
 * (which would leave the patient uncontacted); that rare tie falls through unchanged.
 */
export async function findEarlierOpenLead(
  siteId: string,
  phone: string | null,
  email: string | null,
  sinceIso: string,
  excludeId: string,
  beforeIso: string,
): Promise<SpeedToLeadLead | null> {
  const db = serviceClient();
  for (const [col, val] of [["phone", phone], ["email", email]] as const) {
    if (!val) continue;
    const { data, error } = await db
      .from("speed_to_lead_lead")
      .select("*")
      .eq("site_id", siteId)
      .eq(col, val)
      .in("stage", ["new", "contacting", "contacted", "qualifying"])
      .gte("created_at", sinceIso)
      .lt("created_at", beforeIso)
      .neq("id", excludeId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return rowToLead(data as LeadRow);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attempts.
// ---------------------------------------------------------------------------

export interface InsertAttemptInput {
  leadId: string;
  channel: LeadChannel;
  toAddress: string;
  body: string;
  status?: "sent" | "failed";
  provider?: string | null;
  providerMessageId?: string | null;
}

export async function insertAttempt(input: InsertAttemptInput): Promise<SpeedToLeadAttempt> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_attempt")
    .insert({
      lead_id: input.leadId,
      channel: input.channel,
      to_address: input.toAddress,
      body: input.body,
      status: input.status ?? "sent",
      provider: input.provider ?? null,
      provider_message_id: input.providerMessageId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToAttempt(data as AttemptRow);
}

/**
 * Update a first-contact attempt's delivery status from a Twilio status callback,
 * matched by provider_message_id (the attempt that carried this SID; rows for other
 * leads are untouched). On a terminal FAILURE (failed/undelivered) the lead is reset
 * to a retryable state — stage back to 'new' and first_response_at cleared — so the
 * SLA sweep (`listUncontacted`) re-picks it up and the contact is retried. Without
 * this a silently-failed first SMS would be invisible and never retried.
 */
export async function updateAttemptStatusByMessageId(
  providerMessageId: string,
  status: "sent" | "delivered" | "failed",
): Promise<void> {
  const db = serviceClient();

  // The attempt row stores only 'sent' | 'failed'; 'delivered' confirms a send.
  const attemptStatus: "sent" | "failed" = status === "failed" ? "failed" : "sent";
  const { data, error } = await db
    .from("speed_to_lead_attempt")
    .update({ status: attemptStatus })
    .eq("provider_message_id", providerMessageId)
    .select("lead_id")
    .maybeSingle();
  if (error) throw error;
  // No matching attempt: this SID belongs to another module's outbox (no-op).
  if (!data) return;

  if (status === "failed") {
    const leadId = (data as { lead_id: string }).lead_id;
    // Only reset a lead that is STILL in the first-contact window, and only if no
    // later attempt actually delivered. A late 'failed' callback for a superseded
    // attempt must never resurrect a 'booked'/'lost'/'qualifying' lead (re-texting a
    // patient who already booked) or override a contact a subsequent attempt landed.
    const { data: sentAttempts, error: sentErr } = await db
      .from("speed_to_lead_attempt")
      .select("id")
      .eq("lead_id", leadId)
      .eq("status", "sent")
      .limit(1);
    if (sentErr) throw sentErr;
    if (sentAttempts && sentAttempts.length > 0) return; // a later attempt delivered: leave the lead alone

    const { error: leadErr } = await db
      .from("speed_to_lead_lead")
      .update({ stage: "new", first_response_at: null, updated_at: new Date().toISOString() })
      .eq("id", leadId)
      .eq("stage", "contacted"); // conditional: never touch booked/lost/qualifying
    if (leadErr) throw leadErr;
  }
}

export async function listAttempts(leadId: string): Promise<SpeedToLeadAttempt[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_attempt")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as AttemptRow[]).map(rowToAttempt);
}

/**
 * The lead whose first-contact threaded a given agent conversation, or null.
 * conversation_id is stamped by recordFirstResponse after the first outbound
 * sends, so any lead who has REPLIED resolves here. Newest wins if a number
 * re-enquired and two leads share the thread.
 */
export async function findLeadByConversation(conversationId: string): Promise<SpeedToLeadLead | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToLead(data as LeadRow) : null;
}
