import { serviceClient } from "@/lib/supabase/server";
import type { AssessmentBand, AssessmentChannel, AssessmentResponse } from "./types";

// Smile Assessment owns one server-only table: smile_assessment_response (one row
// per quiz submission). Access is via the service-role client only — the public
// submit endpoint validates + rate-limits before writing, and the internal list
// is requireUser + site-scoped.

// ---------------------------------------------------------------------------
// Row shape + mapper.
// ---------------------------------------------------------------------------

interface ResponseRow {
  id: string;
  site_id: string;
  lead_id: string | null;
  first_name: string;
  email: string | null;
  phone: string | null;
  channel: string | null;
  treatment_interest: string | null;
  responses: Record<string, string> | null;
  raw_score: number | string;
  band: string;
  source: string;
  created_at: string;
}

function rowToResponse(r: ResponseRow): AssessmentResponse {
  return {
    id: r.id,
    siteId: r.site_id,
    leadId: r.lead_id,
    firstName: r.first_name,
    email: r.email,
    phone: r.phone,
    channel: (r.channel as AssessmentChannel | null) ?? null,
    treatmentInterest: r.treatment_interest,
    responses: r.responses ?? {},
    rawScore: typeof r.raw_score === "number" ? r.raw_score : Number(r.raw_score) || 0,
    band: r.band as AssessmentBand,
    source: r.source,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export interface InsertResponseInput {
  siteId: string;
  firstName: string;
  email?: string | null;
  phone?: string | null;
  channel?: AssessmentChannel | null;
  treatmentInterest?: string | null;
  responses: Record<string, string>;
  rawScore: number;
  band: AssessmentBand;
  source?: string;
  leadId?: string | null;
}

export async function insertResponse(input: InsertResponseInput): Promise<AssessmentResponse> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_response")
    .insert({
      site_id: input.siteId,
      lead_id: input.leadId ?? null,
      first_name: input.firstName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      channel: input.channel ?? null,
      treatment_interest: input.treatmentInterest ?? null,
      responses: input.responses,
      raw_score: input.rawScore,
      band: input.band,
      source: input.source ?? "quiz",
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToResponse(data as ResponseRow);
}

/** Stamp the Speed-to-lead lead created for a high-scoring submission. */
export async function setResponseLead(id: string, leadId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("smile_assessment_response")
    .update({ lead_id: leadId })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export async function listResponses(args: {
  siteIds: string[];
  bands?: AssessmentBand[];
  limit?: number;
}): Promise<AssessmentResponse[]> {
  const db = serviceClient();
  let q = db.from("smile_assessment_response").select("*").in("site_id", args.siteIds);
  if (args.bands && args.bands.length > 0) q = q.in("band", args.bands);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 200);
  if (error) throw error;
  return (data as ResponseRow[]).map(rowToResponse);
}

/**
 * How many submissions from the same contact key (phone, email, or IP) landed
 * since `sinceIso`. Powers the public-endpoint rate-limit so one number/address/IP
 * cannot flood us — important because a high score triggers a real outbound SMS.
 */
export async function countRecent(contactKeyOrIp: string, sinceIso: string): Promise<number> {
  const db = serviceClient();
  // Two parameterized .eq() counts, NOT an interpolated .or() filter (a crafted
  // phone/email could otherwise rewrite the predicate and disable the cap).
  const byPhone = await db
    .from("smile_assessment_response")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso)
    .eq("phone", contactKeyOrIp);
  if (byPhone.error) throw byPhone.error;
  const byEmail = await db
    .from("smile_assessment_response")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso)
    .eq("email", contactKeyOrIp);
  if (byEmail.error) throw byEmail.error;
  return (byPhone.count ?? 0) + (byEmail.count ?? 0);
}
