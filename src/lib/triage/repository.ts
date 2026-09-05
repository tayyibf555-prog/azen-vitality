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
// 3. A PATIENT NEVER LOSES THEIR ANSWERS. `recordResponse` spends the link first
//    (rule 2 needs the claim to come first, or two concurrent submits both write
//    a response), so the claim is RELEASED if the response insert then fails: the
//    target goes back to the status the link resolved under and the patient's
//    retry opens the same form. 'answered' is terminal and both public doors
//    refuse it, so a claim left standing over a failed insert would lose the
//    answers permanently and show the practice a target marked 'answered' with
//    nothing behind it — the state this rule exists to prevent (ruling W3/6).
//    The interest rows are written last and are the one thing that may fail
//    without a rollback: the response is already stored and already visible.
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
 * THE ORDER IS THE SAFETY PROPERTY (rule 3 in this file's header). The link is
 * claimed, the response lands, then the interest rows. A failure on the response
 * RELEASES the claim, so the failure a patient sees is "please try again" on a
 * link that still works rather than a target marked 'answered' with nothing behind
 * it and a form that will never open again.
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

  // THE CLAIM IS RELEASED IF THE ANSWERS DO NOT LAND (ruling W3/6). Spending the
  // link first is what makes a double submit impossible, but a link spent for a
  // response that was never written is the worse failure of the two: 'answered' is
  // terminal (migration 0097), and both public doors — /pv/[token] and
  // /api/previsit/submit — refuse anything that is not 'queued' or 'sent'. So a
  // transient failure on this one insert would take the patient's answers AND
  // their interest ticks with it, permanently, while showing the practice a target
  // marked 'answered' with an empty summary behind it that nobody would chase.
  //
  // The rollback is CONDITIONAL on the row still being 'answered', so it cannot
  // overwrite a state something else has since moved it to, and it restores the
  // status the link resolved under so the patient's retry opens the same form.
  let response: TriageResponse;
  try {
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
    response = rowToResponse(data as ResponseRow);
  } catch (err) {
    const restoreTo: TriageTargetStatus =
      target.status === "queued" || target.status === "sent" ? target.status : "sent";
    try {
      const { error: releaseErr } = await db
        .from("previsit_target")
        .update({ status: restoreTo, updated_at: new Date().toISOString() })
        .eq("id", target.id)
        .eq("status", "answered");
      if (releaseErr) throw releaseErr;
    } catch (releaseFailed) {
      // Both writes failed, which means the database is unreachable rather than
      // fussy. Loud, because this is the one path that can still cost a patient
      // their answers and the practice needs to know the link needs reopening.
      console.error(
        `[previsit] target ${target.id} is marked answered with no response behind it; the link must be reopened by hand`,
        releaseFailed,
      );
    }
    throw err;
  }

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

/**
 * The headline row: how many DISTINCT PATIENTS said yes to each treatment, and
 * whether the scan that produced those figures reached the end of the table.
 *
 * PAGED, WITH AN ABSOLUTE CEILING, and both halves are load-bearing.
 *
 * This select used to be unbounded, which quietly relied on PostgREST's max-rows:
 * past that ceiling it returns a clipped page with `error: null`, so a truncated
 * scan is indistinguishable from a complete one in the returned shape. The same
 * trap has already been fixed and documented three times in this tree
 * (src/lib/task-queue/repository.ts, src/lib/coordinator/repository.ts,
 * src/lib/telemetry.ts) and these figures are printed to the owner under the words
 * "The count is people, not answers" and handed to the co-pilot as "distinct
 * patients who answered yes" — a floor wearing a total's clothes, in the one place
 * a campaign gets sized (charter §0/5, ruling W3/11).
 *
 * The ceiling exists because the paging must terminate: one row accrues per
 * (patient, treatment, response), so a practice that has run this for a year has
 * hundreds of thousands, and a loop with no end would trade a wrong number for an
 * exhausted function. `capped` is how the caller tells the two apart, and a capped
 * result is a FLOOR: the caller must render it as "at least N", never as N.
 */
export interface InterestCountSummary {
  /** Distinct patients per treatment key, over the rows actually read. */
  counts: Record<string, number>;
  /** True when the scan hit its ceiling: every count is a floor, not a total. */
  capped: boolean;
  /** How many interest rows were read to produce it. */
  scanned: number;
}

/** One PostgREST page. 1000 is the server's own default max-rows. */
const INTEREST_COUNT_PAGE = 1000;
/** The absolute ceiling on one scan: 20 pages, then we say so rather than guess. */
const INTEREST_COUNT_CEILING = 20_000;

/** Where one page stopped, in the scan's own (created_at desc, id asc) order. */
interface InterestCursor {
  createdAt: string;
  id: string;
}

/**
 * The characters a cursor value may hold.
 *
 * Both values come straight out of this table — a timestamptz and a uuid — so this
 * can only fire on something that is not a cursor at all. It exists because the
 * values are interpolated into the PostgREST filter string below, and a value
 * carrying a quote or a backslash could break out of the quoting that makes that
 * string safe. Same belt-and-braces as the step-event scan
 * (src/lib/smile-assessment/step-events-repository.ts).
 */
const INTEREST_CURSOR_SAFE = /^[A-Za-z0-9:.+-]+$/;

/**
 * "Strictly after this row, in (created_at desc, id asc) order": an older
 * timestamp, OR the same timestamp with a higher id.
 *
 * The values are double-quoted because a timestamptz literal contains `.`, `:` and
 * `+`, every one of which is a structural character in PostgREST's filter grammar.
 */
function interestKeysetFilter(c: InterestCursor): string {
  return `created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.gt."${c.id}")`;
}

/**
 * How many interest rows are in scope at all, as ONE count read with no rows
 * returned (`head: true`), or null if the database would not say.
 *
 * Only ever asked once, and only after a full page has already come back, so a
 * practice below one page — which is every practice for a long while — still pays
 * exactly one query for its counts.
 *
 * Null on error rather than a throw: this read only ever makes the scan STOP
 * EARLIER than it otherwise would, so not knowing costs time and never accuracy.
 * The page reads themselves still throw, because those decide the figures.
 */
async function countInterestRowsInScope(
  db: ReturnType<typeof serviceClient>,
  siteIds: string[],
): Promise<number | null> {
  const { count, error } = await db
    .from("treatment_interest")
    .select("id", { count: "exact", head: true })
    .in("site_id", siteIds)
    .eq("answer", "yes");
  if (error) return null;
  return typeof count === "number" ? count : null;
}

/**
 * KEYSET PAGED, NOT OFFSET PAGED, and NEVER MORE PAGES THAN THE ANSWER IS WORTH.
 *
 * This scan runs inside the pre-visit module page's own server render (both trees,
 * `force-dynamic`, nothing caching it), so its query shape is the page's latency.
 * Two things were wrong with the `.range(from, from + want - 1)` walk it replaces:
 *
 *  1. OFFSET MOVES UNDER A TABLE THAT IS BEING WRITTEN TO, and this one is
 *     written by the PUBLIC submit endpoint — up to four rows in a single insert.
 *     Every row that arrives above the scan's position shifts the result set down,
 *     so the next page hands back a row the last page already had. The tally
 *     de-duplicates into sets, so a repeat does not double-count anybody; it
 *     spends this scan's FIXED budget on rows already counted and pushes real ones
 *     towards the ceiling, which is how a complete count quietly becomes a floor.
 *     A concurrent DELETE (previsit_response cascades into this table) shifts the
 *     other way and drops a row outright — a patient missing from the number a
 *     campaign is sized on. Ordering deterministically fixes neither; only
 *     carrying the last row's (created_at, id) and asking for "strictly older than
 *     the row I stopped at" does, because no concurrent write can move that
 *     boundary. The tiebreak is still load-bearing and still for the same reason:
 *     one submit writes up to four rows in one instant, so `created_at` alone is
 *     not a cursor.
 *  2. DEEP OFFSET GETS SLOWER AS IT DEEPENS. This filter (site_id, answer) is not
 *     the leading edge of 0097's `(site_id, treatment, answer, created_at desc)`
 *     index, so Postgres sorts the matching set — and page 20 sorted the whole set
 *     again to throw the first 19,000 rows away. A keyset page carries its own
 *     `created_at <` predicate, so the work shrinks page by page instead.
 *
 * AND THE CEILING IS NOW DETECTED, NOT WALKED INTO. Past 20,000 rows the old loop
 * paid all twenty round trips and twenty thousand rows to arrive at `capped`, which
 * the module page renders as "The totals could not be read." — maximum cost for
 * zero information. One `count: 'exact', head: true` read after the first full page
 * settles it (charter §0/5 asks for exactly that read where a true total is cheap),
 * so the honest sentence now costs two queries rather than twenty.
 *
 * What has NOT changed is every number and flag this returns: `capped` still means
 * "these are floors", it is still conservative at the exact boundary (a table
 * holding precisely `ceiling` rows reports capped, because the scan stops on a full
 * page without asking again), `scanned` is still the rows actually read, and the
 * counts are still distinct patients. A one-query answer needs a Postgres
 * `count(distinct …)` aggregate behind an RPC — a migration, and a handoff.
 */
export async function countInterestByTreatmentDetailed(
  siteIds: string[],
  opts: { pageSize?: number; ceiling?: number } = {},
): Promise<InterestCountSummary> {
  const counts: Record<string, number> = {};
  if (siteIds.length === 0) return { counts, capped: false, scanned: 0 };
  const page = Math.max(1, Math.floor(opts.pageSize ?? INTEREST_COUNT_PAGE));
  const ceiling = Math.max(page, Math.floor(opts.ceiling ?? INTEREST_COUNT_CEILING));
  const db = serviceClient();

  // DISTINCT PATIENTS, not rows. A patient who filled the form in before two
  // appointments and said yes to whitening both times is ONE person interested in
  // whitening, and a count that said two would be a number nobody could act on.
  const seen = new Map<string, Set<string>>();
  let scanned = 0;
  let capped = true;
  let cursor: InterestCursor | null = null;
  let totalAsked = false;
  while (scanned < ceiling) {
    const want = Math.min(page, ceiling - scanned);
    let q = db
      .from("treatment_interest")
      // id and created_at are read for the cursor, not for the tally.
      .select("id, created_at, treatment, dentally_patient_id")
      .in("site_id", siteIds)
      .eq("answer", "yes");
    if (cursor) q = q.or(interestKeysetFilter(cursor));
    const { data, error } = await q
      .order("created_at", { ascending: false })
      // The tiebreak, so paging cannot repeat or skip a row when two ticks share
      // an instant — which they do, because one submit writes up to four at once.
      .order("id", { ascending: true })
      .limit(want);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      id: string;
      created_at: string;
      treatment: string;
      dentally_patient_id: string;
    }>;
    scanned += rows.length;
    for (const raw of rows) {
      const set = seen.get(raw.treatment) ?? new Set<string>();
      set.add(raw.dentally_patient_id);
      seen.set(raw.treatment, set);
    }
    // A short page is the end of the table — measured against what this page ASKED
    // for, not against the page size, so the last part-page of the ceiling cannot
    // be misread as the end of the data. Only then is the scan complete.
    if (rows.length < want) {
      capped = false;
      break;
    }
    const last = rows[rows.length - 1];
    if (!INTEREST_CURSOR_SAFE.test(String(last.created_at)) || !INTEREST_CURSOR_SAFE.test(String(last.id))) {
      // No cursor we trust, so stop and SAY the figures are floors rather than page
      // on a filter string we did not mean to write. Fails closed: `capped` stands.
      break;
    }
    cursor = { createdAt: last.created_at, id: last.id };
    if (!totalAsked) {
      totalAsked = true;
      const total = await countInterestRowsInScope(db, siteIds);
      // More rows in scope than this scan is allowed to read: the remaining pages
      // could only produce floors the caller must not print, so stop now.
      if (total !== null && total > ceiling) break;
    }
  }
  for (const [treatment, patients] of seen) counts[treatment] = patients.size;
  if (capped) {
    console.warn(
      `[previsit] interest counts hit the ${ceiling}-row ceiling for sites ${siteIds.join(", ")}; the figures are floors`,
    );
  }
  return { counts, capped, scanned };
}

/**
 * The same counts in the bare shape the two existing callers read, and it REFUSES
 * rather than returning a floor a caller would print as a total.
 *
 * A `Record<string, number>` cannot say "at least". The module page renders each
 * figure as a headline number with exactly two states — the number, or "The totals
 * could not be read" — and the co-pilot's `interest_lists` labels the same map
 * "distinct patients who answered yes". Neither can qualify a capped figure, so
 * this throws when the scan capped and the honest sentence is shown instead:
 * honest numbers or no numbers (charter §0/5), failing closed.
 *
 * Callers that CAN say "at least N" should use countInterestByTreatmentDetailed
 * and read `capped`; when both of them do, this wrapper goes away.
 */
export async function countInterestByTreatment(
  siteIds: string[],
  opts: { pageSize?: number; ceiling?: number } = {},
): Promise<Record<string, number>> {
  const summary = await countInterestByTreatmentDetailed(siteIds, opts);
  if (summary.capped) {
    throw new Error(
      "There are more interest rows than one read can total, so these counts would be floors rather than totals. Ask for one treatment by name to see the list itself.",
    );
  }
  return summary.counts;
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
 * THREE load-bearing filters, and the third is the one this module cannot do
 * without. `status = 'queued'` makes the send at-most-once (a claimed row is
 * 'sending'). `not_before_at <= now()` is this module's QUIET HOURS, and it lives
 * here rather than in the drain because the drain has no time-of-day gate at all:
 * the diary and post-op do exactly the same thing for exactly the same reason.
 *
 * THE THIRD IS THE UPPER BOUND: a link is never handed to the drain once the
 * appointment it refers to has started (ruling W3/5). `not_before_at` is a floor
 * and there was no ceiling anywhere: ./schedule.ts rule 3 — "a link that would
 * arrive after the appointment it refers to is not sent" — was enforced ONLY by
 * decideSend, which runs once, at queue time, and only over targets still
 * 'pending'. Once a row was queued nothing re-examined it, so an owner switching
 * the system off for a day (or any drain outage inside the drain's own 48h
 * staleness ceiling) would send "Before your visit, a few quick questions" AFTER
 * the visit, with a live token whose form still opened and whose answers landed
 * dated after the appointment they were asked about.
 *
 * The instant lives on the TARGET, not on the outbox row, so it is read here
 * rather than filtered in the query — a column would need a migration, and the
 * ruling allows either. Expired rows are RETIRED, not merely hidden: hiding them
 * would leave them at the head of a 100-row batch for ever.
 *
 * FAIL CLOSED. A row whose target cannot be read, or whose appointment instant
 * cannot be parsed, is not sent — the same direction decideSend takes for an
 * undatable appointment, and for the same reason: staleness we cannot establish
 * is not staleness we may ignore. A lookup that ERRORS throws, which leaves every
 * row queued for the next tick rather than sending any of them.
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
  const rows = ((data ?? []) as Array<{
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
  if (rows.length === 0) return [];
  return dropRowsPastTheirAppointment(rows);
}

/**
 * Split the queued batch on the appointment each row is ahead of, retiring the
 * ones that are no longer ahead of anything.
 *
 * Two reads, both keyed and bounded by the batch (at most 100 rows), because the
 * appointment instant is two hops away: outbox -> touch -> target.
 */
async function dropRowsPastTheirAppointment(rows: QueuedOutbox[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const nowMs = Date.now();

  const { data: touchData, error: touchErr } = await db
    .from("previsit_touch")
    .select("id, target_id")
    .in("id", rows.map((r) => r.touchId));
  if (touchErr) throw touchErr;
  const targetIdByTouch = new Map<string, string>();
  for (const t of (touchData ?? []) as Array<{ id: string; target_id: string }>) {
    targetIdByTouch.set(t.id, t.target_id);
  }

  const targetIds = [...new Set([...targetIdByTouch.values()])];
  const appointmentAtByTarget = new Map<string, string>();
  if (targetIds.length > 0) {
    const { data: targetData, error: targetErr } = await db
      .from("previsit_target")
      .select("id, appointment_at")
      .in("id", targetIds);
    if (targetErr) throw targetErr;
    for (const t of (targetData ?? []) as Array<{ id: string; appointment_at: string }>) {
      appointmentAtByTarget.set(t.id, t.appointment_at);
    }
  }

  const sendable: QueuedOutbox[] = [];
  for (const row of rows) {
    const targetId = targetIdByTouch.get(row.touchId);
    const appointmentAt = targetId ? appointmentAtByTarget.get(targetId) : undefined;
    const startMs = appointmentAt ? Date.parse(appointmentAt) : NaN;
    if (Number.isFinite(startMs) && nowMs < startMs) {
      sendable.push(row);
      continue;
    }
    console.warn(
      `[previsit] outbox ${row.id} is for an appointment at ${appointmentAt ?? "an instant we could not read"}; retired unsent rather than delivered after the visit`,
    );
    await expireOutbox(row.id);
  }
  return sendable;
}

/**
 * Retire one queued row that can no longer be a PRE-visit message.
 *
 * `status = 'failed'` with `provider = 'expired'` rather than a new status value:
 * migration 0097's CHECK has no 'expired', and the same idiom already carries the
 * reason for a suppressed row (markOutboxBlocked writes provider 'suppressed').
 * The outbox update is conditional on the row still being 'queued' so it cannot
 * overwrite a row the drain has already claimed.
 */
async function expireOutbox(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("previsit_outbox")
    .update({ status: "failed", provider: "expired" })
    .eq("id", outboxId)
    .eq("status", "queued");
  if (error) throw error;
  // The shared tail: the touch fails and the target stops, exactly as it does for
  // an undeliverable number. One attempt, then the practice asks at the desk.
  await recordNonDelivery(outboxId, "expired");
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
