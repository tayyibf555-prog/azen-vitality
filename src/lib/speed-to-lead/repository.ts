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
 */
export async function listUncontacted(olderThanIso: string): Promise<SpeedToLeadLead[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .select("*")
    .eq("stage", "new")
    .is("first_response_at", null)
    .lt("created_at", olderThanIso)
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
      .in("stage", ["new", "contacted", "qualifying"])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
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
