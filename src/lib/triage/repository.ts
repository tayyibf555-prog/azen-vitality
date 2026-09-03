import { serviceClient } from "@/lib/supabase/server";
import { readStoredAnswers } from "./kind";
import { mintTriageLinkToken } from "./link";
import { usableConfig } from "./project";
import type {
  InterestAnswer,
  InterestRecord,
  InterestTreatmentKey,
  StoredTriageBank,
  TriageAnswer,
  TriageBankConfig,
  TriageChannel,
  TriageFork,
  TriageResponse,
  TriageStopReason,
  TriageTarget,
  TriageTargetStatus,
} from "./types";

// ===========================================================================
// Persistence for pre-visit triage (migration 0097: previsit_bank,
// previsit_target, previsit_touch, previsit_outbox, previsit_response,
// treatment_interest, previsit_mining_scan, previsit_mining_candidate).
//
// Service-role only, RLS on with no anon / authenticated grants, matching the
// post-0012 posture. There is no barrel in this directory, so a client component
// cannot reach this file by accident.
//
// THE THREE RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. THE FORK IS DECIDED ONCE, ON THE SERVER, AND STORED. `previsit_target.fork`
//    is written by the sweep from the patient's Dentally payment plan and is
//    never taken from a request. The public form reads the fork from the TARGET
//    the link resolves to, so a patient cannot ask for the other bank by editing
//    anything, and a submitted response carries the fork it was actually asked
//    under rather than the fork the patient is on today.
//
// 2. A LINK IS SPENT ONCE. `recordResponse` transitions the target to 'answered'
//    CONDITIONALLY on it still being 'sent' or 'queued', so a double submit — a
//    retried tap, a browser replaying a POST — cannot produce two responses for
//    one appointment, and a link that has been used stops opening the form.
//
// 3. AN INTEREST TICK IS NEVER LOST. `recordResponse` writes the response row
//    FIRST, then the interest rows, then moves the target. If the target update
//    fails the answers still exist and still surface; the reverse order would
//    give us a target marked 'answered' with nothing behind it.
// ===========================================================================

// ---------------------------------------------------------------------------
// The bank configs. Two rows per client at most (one per fork).
// ---------------------------------------------------------------------------

interface BankRow {
  client_id: string;
  fork: string;
  config: unknown;
  updated_at: string;
  updated_by: string | null;
}

/**
 * One fork's saved config, or null when the practice has never edited it.
 *
 * NULL IS MEANINGFUL and is not repaired here: the caller passes it to
 * `projectBank`, which falls back to the SHIPPED defaults. Writing a default row
 * on first read would turn "we ship these questions" into "somebody once chose
 * these questions", and the practice would lose the ability to pick up a later
 * improvement to the defaults.
 */
export async function getBank(clientId: string, fork: TriageFork): Promise<StoredTriageBank | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_bank")
    .select("client_id, fork, config, updated_at, updated_by")
    .eq("client_id", clientId)
    .eq("fork", fork)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as BankRow;
  return {
    clientId: row.client_id,
    fork: row.fork as TriageFork,
    config: usableConfig(row.fork as TriageFork, row.config),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Both forks in one query, for the editor. */
export async function getBanks(clientId: string): Promise<Partial<Record<TriageFork, StoredTriageBank>>> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_bank")
    .select("client_id, fork, config, updated_at, updated_by")
    .eq("client_id", clientId);
  if (error) throw error;
  const out: Partial<Record<TriageFork, StoredTriageBank>> = {};
  for (const raw of (data ?? []) as BankRow[]) {
    const fork = raw.fork as TriageFork;
    out[fork] = {
      clientId: raw.client_id,
      fork,
      config: usableConfig(fork, raw.config),
      updatedAt: raw.updated_at,
      updatedBy: raw.updated_by,
    };
  }
  return out;
}

export async function saveBank(
  clientId: string,
  fork: TriageFork,
  config: TriageBankConfig,
  updatedBy: string | null,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("previsit_bank").upsert(
    {
      client_id: clientId,
      fork,
      config,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id,fork" },
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  appointment_id: string;
  patient_name: string;
  fork: string;
  appointment_at: string;
  due_at: string;
  status: string;
  stop_reason: string | null;
  consent_sms: boolean | null;
  link_token: string;
  created_at: string;
  updated_at: string;
}

const TARGET_COLUMNS =
  "id, site_id, dentally_patient_id, appointment_id, patient_name, fork, appointment_at, due_at, status, stop_reason, consent_sms, link_token, created_at, updated_at";

function rowToTarget(r: TargetRow): TriageTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    appointmentId: r.appointment_id,
    patientName: r.patient_name,
    fork: r.fork as TriageFork,
    appointmentAt: r.appointment_at,
    dueAt: r.due_at,
    status: r.status as TriageTargetStatus,
    stopReason: (r.stop_reason as TriageStopReason | null) ?? null,
    consentSms: Boolean(r.consent_sms),
    linkToken: r.link_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The stable id for an appointment. Derivable with no database read, so the
 *  sweep's upsert is idempotent over the same window. */
export function triageTargetId(siteId: string, appointmentId: string): string {
  return `${siteId}:${appointmentId}`;
}

export interface UpsertTriageTargetInput {
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  fork: TriageFork;
  appointmentAt: string;
  dueAt: string;
  consentSms: boolean;
}

/**
 * Record an upcoming appointment, or leave an existing record alone.
 *
 * `ignoreDuplicates` is load-bearing, exactly as it is for post-op. A plain upsert
 * would rewrite the status of a target that has already been sent or answered
 * every time the sweep re-read the same window — resurrecting a spent link and
 * re-texting a patient who has already filled the form in. The row is written ONCE
 * and every later transition is an explicit call below.
 *
 * IT ALSO PROTECTS THE FORK. Re-upserting would rewrite `fork` from a fresh read
 * of the payment plan, so a patient whose plan changed between the send and the
 * submit could be shown one bank and recorded under the other.
 */
export async function upsertTargetIfNew(
  input: UpsertTriageTargetInput,
): Promise<TriageTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_target")
    .upsert(
      {
        id: triageTargetId(input.siteId, input.appointmentId),
        site_id: input.siteId,
        dentally_patient_id: input.dentallyPatientId,
        appointment_id: input.appointmentId,
        patient_name: input.patientName,
        fork: input.fork,
        appointment_at: input.appointmentAt,
        due_at: input.dueAt,
        consent_sms: input.consentSms,
        link_token: mintTriageLinkToken(),
      },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select(TARGET_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function getTarget(id: string): Promise<TriageTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_target")
    .select(TARGET_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

/**
 * The target a public link resolves to — the ONE place a link becomes a patient.
 *
 * Keyed on the unique `link_token` index. The caller checks the STATUS before
 * rendering anything: an 'answered' or 'stopped' target is a spent link, and the
 * page must not re-open a form the practice has already been told about.
 */
export async function getTargetByLinkToken(token: string): Promise<TriageTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_target")
    .select(TARGET_COLUMNS)
    .eq("link_token", token)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function listTargets(args: {
  siteIds: string[];
  statuses: TriageTargetStatus[];
  limit?: number;
}): Promise<TriageTarget[]> {
  if (args.siteIds.length === 0 || args.statuses.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_target")
    .select(TARGET_COLUMNS)
    .in("site_id", args.siteIds)
    .in("status", args.statuses)
    .order("appointment_at", { ascending: true })
    .limit(args.limit ?? 500);
  if (error) throw error;
  return ((data ?? []) as TargetRow[]).map(rowToTarget);
}

async function patchTarget(id: string, patch: Record<string, unknown>): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("previsit_target")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Terminal, with a reason. Idempotent: re-stopping rewrites the reason. */
export async function stopTarget(id: string, reason: TriageStopReason): Promise<void> {
  await patchTarget(id, { status: "stopped", stop_reason: reason });
}

// ---------------------------------------------------------------------------
// Touches + outbox. THIS MODULE'S OWN PAIR, because every module owns its own:
// previsit_outbox.touch_id is a hard FK to previsit_touch, so a row written into
// another module's outbox would violate that FK. Beyond the FK, the separation is
// what makes this module switchable on its own.
//
// NO DRAFT STATE ANYWHERE, and that is a decision rather than an omission. The
// closer, the balance reminder and the post-op check-in are all draft-for-approval
// because a human is deciding WHETHER to say something to a particular patient
// about their clinical or financial situation. This message says nothing about the
// patient at all: it is a fixed template with a first name and a link, sent to
// everybody with an appointment, and asking a receptionist to approve four hundred
// identical texts a week is not a safety control, it is a way of guaranteeing the
// feature is never used. The no-show confirmation — the other appointment-relative,
// fixed-template, everybody-gets-one message — queues directly for exactly this
// reason, and this follows it.
//
// What replaces the approval as the safety control is the composition scan
// (checkTriageMessage), which refuses to STORE a body that breaks a rule, so there
// is never a queued row a human would have had to catch.
// ---------------------------------------------------------------------------

interface TouchRow {
  id: string;
  target_id: string;
  site_id: string;
  channel: string;
  direction: string;
  body: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

const TOUCH_COLUMNS = "id, target_id, site_id, channel, direction, body, status, created_at, sent_at";

/**
 * Compose one send: a touch and its outbox row, in that order.
 *
 * The touch is written first so a failure on the outbox insert leaves a record
 * that the practice tried, rather than a queued message with nothing on the
 * patient's correspondence timeline behind it.
 *
 * `notBeforeAt` is the quiet-hours clamp (./schedule.ts). The shared drain has no
 * time-of-day gate, so quiet hours live on the row, exactly as they do for the
 * diary and for post-op.
 */
export async function enqueueSend(input: {
  targetId: string;
  siteId: string;
  channel: TriageChannel;
  toRef: string;
  body: string;
  notBeforeAt: string;
}): Promise<{ touchId: string; outboxId: string }> {
  const db = serviceClient();
  const { data: touch, error: tErr } = await db
    .from("previsit_touch")
    .insert({
      target_id: input.targetId,
      site_id: input.siteId,
      channel: input.channel,
      body: input.body,
      status: "queued",
    })
    .select(TOUCH_COLUMNS)
    .single();
  if (tErr) throw tErr;
  const touchRow = touch as TouchRow;

  const { data: outbox, error: oErr } = await db
    .from("previsit_outbox")
    .insert({
      touch_id: touchRow.id,
      site_id: input.siteId,
      channel: input.channel,
      to_ref: input.toRef,
      body: input.body,
      not_before_at: input.notBeforeAt,
    })
    .select("id")
    .single();
  if (oErr) throw oErr;

  await patchTarget(input.targetId, { status: "queued" });
  return { touchId: touchRow.id, outboxId: (outbox as { id: string }).id };
}

// ---------------------------------------------------------------------------
// Responses + interest.
// ---------------------------------------------------------------------------

interface ResponseRow {
  id: string;
  target_id: string;
  site_id: string;
  dentally_patient_id: string;
  fork: string;
  answers: unknown;
  interest: unknown;
  submitted_at: string;
}

const RESPONSE_COLUMNS =
  "id, target_id, site_id, dentally_patient_id, fork, answers, interest, submitted_at";

function rowToResponse(r: ResponseRow): TriageResponse {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    fork: r.fork as TriageFork,
    // NOT A CAST. `answers` is a jsonb column, so what comes back is whatever was
    // written — including a row older than the `kind` field, or one edited by hand.
    // readStoredAnswers is the one place that column becomes TriageAnswer[], and an
    // answer whose kind it cannot read resolves to `symptom` (the RESTRICTED class,
    // ruling W1-C/2) rather than to the class every role reads. See ./kind.ts.
    answers: readStoredAnswers(r.answers),
    interest: Array.isArray(r.interest)
      ? (r.interest as Array<{ treatment: InterestTreatmentKey; answer: InterestAnswer }>)
      : [],
    submittedAt: r.submitted_at,
  };
}

/**
 * Store one completed questionnaire, its interest rows, and spend the link.
 *
 * THE ORDER IS THE SAFETY PROPERTY (rule 3 in this file's header). The response
 * lands first, then the interest rows, then the target moves. A failure part way
 * through leaves answers a person can read rather than a target marked 'answered'
 * with nothing behind it.
 *
 * THE TARGET TRANSITION IS CONDITIONAL on the row still being 'queued' or 'sent',
 * which is what makes a double submit impossible: the second call finds no row to
 * transition and returns `duplicate`, so the caller can answer the patient with
 * the same thank-you rather than writing a second response.
 *
 * SCOPE COMES FROM THE TARGET, never from the caller. siteId, patientId and fork
 * are all read off the row the link resolved to; the request body cannot name a
 * patient, a site or a bank. This is the load-bearing IDOR defence, and it is the
 * same line the medical-history public submit takes about its token.
 */
export async function recordResponse(input: {
  target: TriageTarget;
  answers: TriageAnswer[];
  interest: Array<{ treatment: InterestTreatmentKey; answer: InterestAnswer }>;
  submittedAt: string;
}): Promise<{ ok: true; response: TriageResponse } | { ok: false; reason: "duplicate" }> {
  const db = serviceClient();
  const { target } = input;

  // Spend the link FIRST as a claim, not as a status change: the conditional
  // update both proves this is the first submit and reserves the row. Doing it
  // last would let two concurrent submits both write a response.
  const { data: claimed, error: claimErr } = await db
    .from("previsit_target")
    .update({ status: "answered", updated_at: new Date().toISOString() })
    .eq("id", target.id)
    .in("status", ["queued", "sent"])
    .select("id");
  if (claimErr) throw claimErr;
  if ((claimed?.length ?? 0) === 0) return { ok: false, reason: "duplicate" };

  const { data, error } = await db
    .from("previsit_response")
    .insert({
      target_id: target.id,
      site_id: target.siteId,
      dentally_patient_id: target.dentallyPatientId,
      fork: target.fork,
      answers: input.answers,
      interest: input.interest,
      submitted_at: input.submittedAt,
    })
    .select(RESPONSE_COLUMNS)
    .single();
  if (error) throw error;
  const response = rowToResponse(data as ResponseRow);

  if (input.interest.length > 0) {
    const { error: iErr } = await db.from("treatment_interest").insert(
      input.interest.map((row) => ({
        site_id: target.siteId,
        dentally_patient_id: target.dentallyPatientId,
        patient_name: target.patientName,
        treatment: row.treatment,
        answer: row.answer,
        response_id: response.id,
      })),
    );
    // An interest write that fails must NOT lose the response, which is already
    // stored and already visible to the clinician. It is loud and it is left.
    if (iErr) {
      console.error(`[previsit] interest rows failed for response ${response.id}; the answers are safe`, iErr);
    }
  }

  return { ok: true, response };
}

/** Every response for one patient, newest first. The record summary's read. */
export async function listResponsesForPatient(
  siteIds: string[],
  dentallyPatientId: string,
  limit = 10,
): Promise<TriageResponse[]> {
  if (siteIds.length === 0 || !dentallyPatientId) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_response")
    .select(RESPONSE_COLUMNS)
    .in("site_id", siteIds)
    .eq("dentally_patient_id", dentallyPatientId)
    .order("submitted_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ResponseRow[]).map(rowToResponse);
}

// ---------------------------------------------------------------------------
// Interest lists.
// ---------------------------------------------------------------------------

interface InterestRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  treatment: string;
  answer: string;
  response_id: string;
  created_at: string;
}

const INTEREST_COLUMNS =
  "id, site_id, dentally_patient_id, patient_name, treatment, answer, response_id, created_at";

function rowToInterest(r: InterestRow): InterestRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    treatment: r.treatment as InterestTreatmentKey,
    answer: r.answer as InterestAnswer,
    responseId: r.response_id,
    createdAt: r.created_at,
  };
}

/**
 * The interest list for one treatment, newest first.
 *
 * `answer` defaults to 'yes' because that is the list the practice acts on. The
 * refusals are stored (so a patient is not re-asked for ever) and readable by
 * passing 'not_now', but they are not a campaign target and the caller has to ask
 * for them by name.
 */
export async function listInterest(args: {
  siteIds: string[];
  treatment?: InterestTreatmentKey;
  answer?: InterestAnswer;
  limit?: number;
}): Promise<InterestRecord[]> {
  if (args.siteIds.length === 0) return [];
  const db = serviceClient();
  let q = db
    .from("treatment_interest")
    .select(INTEREST_COLUMNS)
    .in("site_id", args.siteIds)
    .eq("answer", args.answer ?? "yes");
  if (args.treatment) q = q.eq("treatment", args.treatment);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 500);
  if (error) throw error;
  return ((data ?? []) as InterestRow[]).map(rowToInterest);
}

/** How many patients said yes to each treatment. The list view's headline row. */
export async function countInterestByTreatment(
  siteIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (siteIds.length === 0) return out;
  const db = serviceClient();
  const { data, error } = await db
    .from("treatment_interest")
    .select("treatment, dentally_patient_id")
    .in("site_id", siteIds)
    .eq("answer", "yes");
  if (error) throw error;
  // DISTINCT PATIENTS, not rows. A patient who filled the form in before two
  // appointments and said yes to whitening both times is ONE person interested in
  // whitening, and a count that said two would be a number nobody could act on.
  const seen = new Map<string, Set<string>>();
  for (const raw of (data ?? []) as Array<{ treatment: string; dentally_patient_id: string }>) {
    const set = seen.get(raw.treatment) ?? new Set<string>();
    set.add(raw.dentally_patient_id);
    seen.set(raw.treatment, set);
  }
  for (const [treatment, patients] of seen) out[treatment] = patients.size;
  return out;
}

// ---------------------------------------------------------------------------
// THE DRAIN-FACING CONTRACT. These five function shapes are what the shared
// messaging drain imports; every module exports the same five.
// ---------------------------------------------------------------------------

export interface QueuedOutbox {
  id: string;
  touchId: string;
  siteId: string;
  channel: TriageChannel;
  toRef: string;
  body: string;
  createdAt: string;
}

/**
 * Queued rows for the drain.
 *
 * TWO load-bearing filters. `status = 'queued'` makes the send at-most-once (a
 * claimed row is 'sending'). `not_before_at <= now()` is this module's QUIET
 * HOURS, and it lives here rather than in the drain because the drain has no
 * time-of-day gate at all: the diary and post-op do exactly the same thing for
 * exactly the same reason.
 */
export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body, created_at")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .lte("not_before_at", new Date().toISOString())
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
    channel: r.channel as TriageChannel,
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
    .from("previsit_outbox")
    .update({ status: "sending" })
    .eq("id", outboxId)
    .eq("status", "queued")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A confirmed send: outbox, touch and target all move to 'sent'. */
export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("previsit_outbox")
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
    .from("previsit_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId)
    .select("target_id")
    .maybeSingle();
  if (tErr) throw tErr;
  const touch = data as { target_id: string } | null;
  if (!touch) return;
  await patchTarget(touch.target_id, { status: "sent" });
}

/**
 * Shared tail for a non-delivery: fail the touch and stop the target.
 *
 * STOPPED, NOT RETRIED, and it is the same call post-op makes. A retry would fire
 * after the staleness ceiling or after the appointment itself, and a pre-visit
 * link that lands during the visit is worse than none. One attempt, then the
 * practice asks at the desk like they always have.
 */
async function recordNonDelivery(outboxId: string, reason: TriageStopReason): Promise<void> {
  const db = serviceClient();
  const { data } = await db
    .from("previsit_outbox")
    .select("touch_id")
    .eq("id", outboxId)
    .maybeSingle();
  const touchId = (data as { touch_id: string } | null)?.touch_id;
  if (!touchId) return;
  const { data: tData } = await db
    .from("previsit_touch")
    .update({ status: "failed" })
    .eq("id", touchId)
    .select("target_id")
    .maybeSingle();
  const touch = tData as { target_id: string } | null;
  if (!touch) return;
  await stopTarget(touch.target_id, reason);
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("previsit_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, "undeliverable");
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("previsit_outbox")
    .update({ status: "failed", provider: "suppressed" })
    .eq("id", outboxId);
  if (error) throw error;
  await recordNonDelivery(outboxId, "opted_out");
}

/** The Twilio delivery-status webhook's write. */
export async function updateOutboxStatusByMessageId(
  providerMessageId: string,
  status: string,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("previsit_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}
