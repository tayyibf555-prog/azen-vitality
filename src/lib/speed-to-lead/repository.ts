import { serviceClient } from "@/lib/supabase/server";
import { isFunnelFinalStep } from "@/lib/smile-assessment/funnel-progress";
import type { LeadFunnelProgress } from "@/lib/smile-assessment/funnel-progress";
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
  nurture_step: number | string | null;
  nurture_next_at: string | null;
  // 0094. Optional in the TYPE on purpose, exactly as the campaign row's 0078
  // columns are: 0094 is written and not applied, so `select("*")` against today's
  // table simply does not return these six keys. Marking them required would be a
  // lie the compiler believes, and the first lead read would hand the worklist
  // `funnel_total_steps: undefined`. See the defaulting in funnelProgressFromRow.
  funnel_last_step?: number | string | null;
  funnel_total_steps?: number | string | null;
  funnel_flow_version?: number | string | null;
  funnel_last_step_at?: string | null;
  funnel_completed_at?: string | null;
  funnel_session_nonce?: string | null;
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

/** The six 0094 columns, whichever query brought them back. */
type FunnelColumns = Pick<
  LeadRow,
  | "funnel_last_step"
  | "funnel_total_steps"
  | "funnel_flow_version"
  | "funnel_last_step_at"
  | "funnel_completed_at"
>;

/**
 * THE ONLY PLACE the funnel_* columns become a LeadFunnelProgress.
 *
 * Two reads want them and want them to agree: the whole-row lead read behind the
 * worklist and the drawer (rowToLead), and the seven-column session lookup the
 * public progress endpoint uses (findLeadFunnelSession). Written twice they would
 * be free to drift — one of them fixed for a new column, or one of them "tidied"
 * to a cast — and the drift would show up as a lead the practice sees at question
 * 3 of 5 that the endpoint refuses to move. So the mapping is one function, and
 * both call sites take it.
 *
 * The pre-0094 default, decided once, here: no funnel behind this lead, so neither
 * the worklist nor the drawer says anything about one. An un-migrated row, an
 * un-migrated database and a lead that never came through an authored funnel are
 * three roads to the same (silent) rendering. `?? null` rather than a cast so
 * `undefined` and a NULL column are indistinguishable to every reader downstream.
 */
function funnelProgressFromRow(r: FunnelColumns): LeadFunnelProgress {
  return {
    lastStep: numOrNull(r.funnel_last_step),
    totalSteps: numOrNull(r.funnel_total_steps),
    flowVersion: numOrNull(r.funnel_flow_version),
    lastStepAt: r.funnel_last_step_at ?? null,
    completedAt: r.funnel_completed_at ?? null,
  };
}

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
    nurtureStep: numOrNull(r.nurture_step) ?? 0,
    nurtureNextAt: r.nurture_next_at,
    funnelProgress: funnelProgressFromRow(r),
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
  /**
   * Optional lower bound on created_at. Absent means "however far back the bound
   * reaches", which is every existing caller's behaviour, unchanged: the filter is
   * only applied when a caller asks for one. It exists so a date-shaped question
   * ("who came in today") is answered by the QUERY rather than by fetching the
   * newest N and hoping the day fits inside them — which under-reports silently
   * the moment a busy day is longer than the bound.
   */
  sinceIso?: string;
}): Promise<SpeedToLeadLead[]> {
  const db = serviceClient();
  let q = db.from("speed_to_lead_lead").select("*").in("site_id", args.siteIds);
  if (args.stages && args.stages.length > 0) q = q.in("stage", args.stages);
  if (args.sinceIso) q = q.gte("created_at", args.sinceIso);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 200);
  if (error) throw error;
  return (data as LeadRow[]).map(rowToLead);
}

/** The hard ceiling on one batched by-id read, whatever the caller asks for. */
const MAX_BATCH_IDS = 200;

/**
 * The leads behind a set of ids, SITE-SCOPED.
 *
 * The ids come from another table's foreign key (smile_assessment_response.lead_id),
 * and the site scope is NOT redundant belt-and-braces: it is the boundary. A
 * response row carries whatever lead id was stamped on it, so reading by id alone
 * would let a stale, mis-stamped or tampered value pull a lead row belonging to a
 * different site — and, at a multi-site group, a different practice's enquiry into
 * an answer scoped to N15. The scope is applied in the query, not after it, so a
 * row that fails it is never in this process's memory at all.
 *
 * Refuses to query on an empty site list or an empty id list: PostgREST's `in.()`
 * with no values is not "match nothing" in every version, and "no scope" must never
 * degrade into "every site".
 */
export async function listLeadsByIds(args: {
  siteIds: string[];
  ids: string[];
}): Promise<SpeedToLeadLead[]> {
  if (args.siteIds.length === 0 || args.ids.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .select("*")
    .in("site_id", args.siteIds)
    .in("id", args.ids.slice(0, MAX_BATCH_IDS))
    .limit(MAX_BATCH_IDS);
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

// ---------------------------------------------------------------------------
// Funnel progress (0094). Three functions: one the submit route calls once, and
// two the unauthenticated progress endpoint reaches — the latter pair shaped
// around exactly that.
// ---------------------------------------------------------------------------

/**
 * Record WHERE IN THE FUNNEL this lead's owner was when they gave their details,
 * and mint nothing: the bearer token is chosen by the caller (server-side) and
 * passed in, because the caller is the one that has to hand it back to the browser.
 *
 * A SEPARATE UPDATE, NOT A WIDER INSERT, and this is the one design decision in
 * this feature that is about go-live rather than about funnels. Folding these
 * columns into `insertLead` would put them on the statement that creates the lead —
 * so on a database where 0094 has not been applied yet, PostgREST would reject the
 * unknown columns and the INSERT would fail, and a real patient's enquiry would be
 * lost to an analytics field. As its own statement it cannot do that: the lead is
 * already committed, this either lands or it does not, and the caller treats a
 * failure as "no progress recorded" (the pre-0094 rendering, i.e. silence).
 *
 * ONCE PER LEAD. `funnel_session_nonce is null` in the predicate, so a lead that
 * already carries a token cannot have a second one written over it — which would
 * orphan the first browser's session and hand a second one a bearer for somebody
 * else's row.
 *
 * Returns true iff the stamp landed. The caller must only return the token to the
 * browser on true: a token the database never stored is a token every later post
 * would be dropped for, and the browser would spend a session posting into a bin.
 */
export async function stampLeadFunnelCapture(args: {
  leadId: string;
  lastStep: number;
  totalSteps: number;
  flowVersion: number;
  nonce: string;
}): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .update({
      funnel_last_step: args.lastStep,
      funnel_total_steps: args.totalSteps,
      funnel_flow_version: args.flowVersion,
      funnel_session_nonce: args.nonce,
      funnel_last_step_at: new Date().toISOString(),
    })
    .eq("id", args.leadId)
    .is("funnel_session_nonce", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * The bare minimum about a lead that the public progress endpoint may hold.
 *
 * NOTE WHAT IS NOT HERE: no name, no phone, no email, no stage, no score. The
 * lookup below selects these columns BY NAME rather than `*`, so a patient's
 * contact details never enter the process that serves an unauthenticated request
 * at all — not in a response body, not in a log line, not in a heap dump. It is
 * the cheapest possible way to make "this endpoint cannot leak a patient" a fact
 * about the query rather than a promise about the handler.
 */
export interface LeadFunnelSession {
  id: string;
  siteId: string;
  progress: LeadFunnelProgress;
}

/**
 * The one lead holding this bearer token, or null.
 *
 * A UNIQUE-INDEX SEEK (0094, partial unique on funnel_session_nonce), so a
 * stranger posting a wrong token costs one index probe rather than a scan of the
 * practice's enquiry history. `maybeSingle` and not `single`: "no such token" is
 * the ordinary case on a public endpoint, not an error.
 */
export async function findLeadFunnelSession(nonce: string): Promise<LeadFunnelSession | null> {
  if (!nonce) return null;
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_lead")
    .select(
      "id, site_id, funnel_last_step, funnel_total_steps, funnel_flow_version, funnel_last_step_at, funnel_completed_at",
    )
    .eq("funnel_session_nonce", nonce)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as Partial<LeadRow> & { id: string; site_id: string };
  return {
    id: r.id,
    siteId: r.site_id,
    // The same mapping the worklist's own read takes, so a lead the practice sees
    // at "question 3 of 5" is a lead this endpoint agrees is at step 2.
    progress: funnelProgressFromRow(r),
  };
}

/**
 * Raise ONE lead's funnel position, and stamp completion if that position is the
 * funnel's last screen. Returns true iff a row actually moved.
 *
 * EVERY RULE IS IN THE `WHERE`, not in the code that ran before it. The caller has
 * already checked the same things with `canAdvanceFunnelProgress`, and that check
 * is not the guard — it is what lets the caller stop early. Between a read and a
 * write on a public endpoint anything can happen (two of the patient's own posts
 * racing, a retry arriving late), so the conditional UPDATE is what makes the
 * rules true:
 *
 *   funnel_session_nonce = nonce   ADDRESSING AND AUTHORISATION IN ONE. A caller
 *                                  without the token cannot name a row at all, and
 *                                  the id alone is not enough to move one — so a
 *                                  guessed or leaked lead id is worth nothing here.
 *   funnel_flow_version = version  N and M stay from the same save of the funnel.
 *   funnel_last_step < step        FORWARD ONLY, and atomically: of two racing
 *                                  posts the higher one wins and the lower one
 *                                  simply matches no row.
 *   funnel_completed_at is null    (completing writes only) so completion is
 *                                  stamped AT MOST ONCE by the predicate itself
 *                                  rather than by an argument about which posts
 *                                  can arrive.
 *
 * `step > totalSteps - 1` is the one rule that cannot be a filter — PostgREST has
 * no column-to-column comparison — so the ceiling is passed in from the row the
 * caller just read and re-derived here rather than trusted from the request.
 *
 * AND IT TOUCHES NOTHING ELSE. The patch names funnel_* columns only. In
 * particular it does NOT bump `updated_at`: resetStaleContacting reclaims a lead
 * stranded at 'contacting' by comparing updated_at to a cutoff, and a patient's
 * browser must not be able to postpone the practice's own failsafe. Nor does it
 * touch `stage` — where somebody got to in a funnel is orthogonal to what the
 * practice has done about them.
 */
export async function advanceLeadFunnelProgress(args: {
  leadId: string;
  nonce: string;
  flowVersion: number;
  step: number;
  /** The lead's own funnel length, read a moment ago. The ceiling, never the caller's. */
  totalSteps: number;
}): Promise<boolean> {
  const { leadId, nonce, flowVersion, step, totalSteps } = args;
  if (!nonce || step > totalSteps - 1 || step < 0) return false;
  const db = serviceClient();
  const now = new Date().toISOString();
  const completing = isFunnelFinalStep(totalSteps, step);

  let q = db
    .from("speed_to_lead_lead")
    .update({
      funnel_last_step: step,
      funnel_last_step_at: now,
      ...(completing ? { funnel_completed_at: now } : {}),
    })
    .eq("id", leadId)
    .eq("funnel_session_nonce", nonce)
    .eq("funnel_flow_version", flowVersion)
    .lt("funnel_last_step", step);
  if (completing) q = q.is("funnel_completed_at", null);

  const { data, error } = await q.select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
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
 * How many leads landed on these sites since `sinceIso` — the EXACT number, at any
 * volume, optionally narrowed to a set of stages.
 *
 * WHY THIS EXISTS NEXT TO listLeads. The report snapshot used to answer "how many
 * enquiries this month" by fetching the newest 500 leads in the window and taking
 * `.length`. That is a floor rather than a total the moment a month is busier than
 * the bound, which is why the snapshot has to declare the answer unusable — and it
 * did so at the exact moment the practice was busiest, blanking the owner's whole
 * reports page mid-campaign.
 *
 * A COUNT IS NOT A READ. This is our own Postgres, not Dentally: `count: "exact"`
 * with `head: true` asks the database to count rows and return NO rows at all, so
 * five hundred and fifty thousand cost the same one query as five. There is no bound
 * to saturate and nothing to truncate, which is why the figure it returns can be
 * stated as a total.
 *
 * It does not replace listLeads: anything computed from a lead's own fields (first
 * response time, source mix) still needs the rows, and those stay honestly bounded.
 *
 * Refuses an empty site list rather than counting every site's leads — PostgREST's
 * `in.()` with no values is not "match nothing" in every version, and "no scope"
 * must never degrade into "the whole group" (the same refusal listLeadsByIds makes).
 */
export async function countLeadsInWindow(
  siteIds: string[],
  sinceIso: string,
  stages?: LeadStage[],
): Promise<number> {
  if (siteIds.length === 0) return 0;
  const db = serviceClient();
  let q = db
    .from("speed_to_lead_lead")
    .select("id", { count: "exact", head: true })
    .in("site_id", siteIds)
    .gte("created_at", sinceIso);
  if (stages && stages.length > 0) q = q.in("stage", stages);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
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
// Nurture cadence.
// ---------------------------------------------------------------------------

/**
 * Leads DUE for a nurture touch, in two shapes merged:
 *   - ENTRY (touch 1): stage 'contacted', never nurtured (step 0, no next_at),
 *     whose first contact is at least the entry delay old (first_response_at <=
 *     entryCutoffIso), so a lead that replied or was contacted only moments ago is
 *     not yet nurtured.
 *   - SUBSEQUENT (touch 2/3): stage 'contacted', step 1 or 2, with a scheduled
 *     nurture_next_at that has come due (<= nowIso).
 * Both are age-guarded (created_at >= ageCutoffIso) so a very old lead is never
 * nurtured, ordered oldest-first, and bounded by `limit`. The caller (the sweep)
 * owns the timing constants and passes the cutoffs, so this stays a dumb query.
 */
export async function listNurtureDue(args: {
  nowIso: string;
  entryCutoffIso: string;
  ageCutoffIso: string;
  limit?: number;
}): Promise<SpeedToLeadLead[]> {
  const db = serviceClient();
  const limit = args.limit ?? 50;

  const entry = await db
    .from("speed_to_lead_lead")
    .select("*")
    .eq("stage", "contacted")
    .eq("nurture_step", 0)
    .is("nurture_next_at", null)
    .not("first_response_at", "is", null)
    .lte("first_response_at", args.entryCutoffIso)
    .gte("created_at", args.ageCutoffIso)
    // CONSENT POSTURE (GDPR): abandoned-booking leads are created on IMPLIED consent
    // from the booking step - that basis covers the single booking-related first
    // contact (still sent), but NOT enrolment into the ongoing 3-touch MARKETING
    // nurture cadence. Exclude them from selection so they never occupy the bounded
    // nurture scan. Genuine enquiry sources (smile-assessment, website, etc.) gave
    // marketing-shaped consent and still nurture. One line to reverse if the practice
    // decides abandoned bookings are fair game for nurture.
    .neq("source", "abandoned-booking")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (entry.error) throw entry.error;

  const subsequent = await db
    .from("speed_to_lead_lead")
    .select("*")
    .eq("stage", "contacted")
    .in("nurture_step", [1, 2])
    .not("nurture_next_at", "is", null)
    .lte("nurture_next_at", args.nowIso)
    .gte("created_at", args.ageCutoffIso)
    // Same consent-posture exclusion as the entry query above (an abandoned-booking
    // lead can never be mid-cadence, but exclude here too so the policy holds on both
    // selection paths and stays trivially reversible in one place).
    .neq("source", "abandoned-booking")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (subsequent.error) throw subsequent.error;

  const rows = [...(entry.data as LeadRow[]), ...(subsequent.data as LeadRow[])]
    .map(rowToLead)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.slice(0, limit);
}

/** Advance the nurture schedule: set the touches-sent count and the next-due time. */
export async function setNurtureSchedule(
  id: string,
  step: number,
  nextAt: string | null,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("speed_to_lead_lead")
    .update({ nurture_step: step, nurture_next_at: nextAt, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Terminal nurture completion after the final touch: retire the lead to
 * 'nurture_done' and clear the schedule. `NURTURE_MAX_TOUCHES` is 3; inlined here to
 * keep the repository free of a cadence import.
 */
export async function markNurtureDone(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("speed_to_lead_lead")
    .update({ stage: "nurture_done", nurture_step: 3, nurture_next_at: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
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

/** The ceiling on one batched attempts read: MAX_BATCH_IDS leads x a few tries each. */
const MAX_BATCH_ATTEMPTS = 1000;

/**
 * Every recorded attempt for a SET of leads, in one query rather than one per lead.
 *
 * NOT SITE-SCOPED, and deliberately so: speed_to_lead_attempt has no site column,
 * and inventing a join here would be a second, weaker copy of a check the caller
 * has already made properly. The contract is that `leadIds` are ids the caller has
 * ALREADY established it may see (listLeads / listLeadsByIds both scope by site),
 * so this reads rows hanging off leads already inside the boundary. Callers must
 * not pass ids straight from user input.
 *
 * Bounded on both the id list and the row count, and refuses an empty id list for
 * the same reason listLeadsByIds does.
 */
export async function listAttemptsForLeads(leadIds: string[]): Promise<SpeedToLeadAttempt[]> {
  if (leadIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("speed_to_lead_attempt")
    .select("*")
    .in("lead_id", leadIds.slice(0, MAX_BATCH_IDS))
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH_ATTEMPTS);
  if (error) throw error;
  return (data as AttemptRow[]).map(rowToAttempt);
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
