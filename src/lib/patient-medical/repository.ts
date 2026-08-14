import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isMedicalHistoryEnabled, MEDICAL_COPY } from "./gate";
import { isKnownQuestionKey } from "./questions";
import type {
  MedicalAnswer,
  MedicalAnswerValue,
  MedicalCaptureMethod,
  MedicalClinician,
  MedicalReviewOutcome,
  MedicalSignature,
  MedicalSummary,
  ReviewEvent,
  SignatureMethod,
  StoredQuestionnaire,
} from "./types";

// ===========================================================================
// public.patient_medical_history + public.patient_medical_review — the
// medical-history record this platform AUTHORS.
//
// THE ONE FACT THAT SHAPES EVERY LINE. Dentally's /v1/medical_histories endpoint
// exists but is permanently empty for this practice (0 rows across 51k patients),
// so unlike the FDI chart — a read-only mirror of a Dentally resource — nothing
// here mirrors anything. These rows ARE the record. That is why they are
// versioned, append-only, attributed on review to a named clinician, and switched
// off by default. The perio repository is the archetype and this follows it.
//
// THREE DELIBERATE POSTURES, each with a reason:
//
// 1. WITH THE GATE OFF EVERY METHOD THROWS, none returns []. An empty medical
//    result renders as "this patient has no medical history", indistinguishable
//    from a patient who simply has none captured here — the false completeness
//    this feature exists to prevent.
//
// 2. A REVIEW'S AUTHOR IS NOT OPTIONAL (GDC 4.1.4): recordReview takes a
//    MedicalClinician. A QUESTIONNAIRE's author IS optional and null on purpose —
//    a patient self-capture over the public link was authored by the patient, not
//    a clinician, and forcing a clinician name onto it would be a fabrication.
//
// 3. NOTHING UPDATES AND NOTHING DELETES. An amendment inserts a new version whose
//    supersedesId names the one it replaces (GDC 4.1.5); a mistake is retracted
//    with a reason and stays readable. The database enforces this with triggers —
//    serviceClient() holds the service role and bypasses RLS, but not a trigger.
//
// EVERY QUERY IS SITE-SCOPED AND PATIENT-SCOPED IN THE PREDICATE ITSELF, the fix
// pattern the getPatientDetail IDOR taught: the scope is written into the query,
// never checked once at the top of a caller.
// ===========================================================================

/** Which patient, in which site. Both halves go into every predicate. */
export interface MedicalScope {
  siteId: string;
  patientId: string;
}

export interface NewQuestionnaire {
  answers: MedicalAnswer[];
  questionBankVersion: string;
  patientName: string | null;
  medicationsText: string | null;
  allergiesText: string | null;
  signature: MedicalSignature | null;
  capturedVia: MedicalCaptureMethod;
  recordedAt: string;
  /** The clinician for a staff-entered fallback, or null for patient self-capture. */
  author: MedicalClinician | null;
  supersedesId: string | null;
  amendmentReason: string | null;
}

export interface NewReview {
  outcome: MedicalReviewOutcome;
  reviewedAt: string;
  appointmentId: string | null;
  questionnaireId: string | null;
  author: MedicalClinician;
}

/** A patient with a captured questionnaire that has not been reviewed since it
 *  was captured — the task-queue's "medical history awaiting review" signal. The id
 *  field is named dentallyPatientId to match every other module's target, so a task
 *  keyed on it is provably keyed on a real patient id and never on a name. */
export interface OutstandingReview {
  siteId: string;
  dentallyPatientId: string;
  patientName: string | null;
  latestQuestionnaireAt: string;
}

// ---------------------------------------------------------------------------
// Errors. Typed, so the route can say the right thing rather than flattening
// every failure into "could not save".
// ---------------------------------------------------------------------------

/** The feature is off. Defence in depth: the route checks the gate first. */
export class MedicalDisabledError extends Error {
  constructor() {
    super(MEDICAL_COPY.disabled);
    this.name = "MedicalDisabledError";
  }
}

/** A write the data refuses — an amendment pointing at a record that is not this
 *  patient's, in this site, or that has already been retracted. */
export class MedicalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedicalRefusedError";
  }
}

function assertEnabled(): void {
  if (!isMedicalHistoryEnabled()) throw new MedicalDisabledError();
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

const QUESTIONNAIRE_COLS =
  "id, site_id, dentally_patient_id, version, question_bank_version, patient_name, answers, " +
  "medications_text, allergies_text, signature, captured_via, recorded_at, created_at, " +
  "author_user_id, author_name, supersedes_id, amendment_reason, retracted_at, retraction_reason";

const REVIEW_COLS =
  "id, site_id, dentally_patient_id, dentally_appointment_id, questionnaire_id, outcome, " +
  "reviewed_at, created_at, author_user_id, author_name, author_gdc_number";

type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}
function asRow(data: unknown): Row {
  return data as Row;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const CAPTURE_METHODS: readonly MedicalCaptureMethod[] = ["public-link", "ipad", "staff"];
const SIGNATURE_METHODS: readonly SignatureMethod[] = ["drawn", "typed", "ipad"];
const ANSWER_VALUES: readonly MedicalAnswerValue[] = ["yes", "no", "unknown"];
const OUTCOMES: readonly MedicalReviewOutcome[] = ["no-changes", "updated"];

/**
 * Parse the stored answers jsonb defensively. An answer whose key is not in the
 * current bank, or whose value is not one of yes/no/unknown, is DROPPED rather
 * than shown — a stale or corrupt key must never render as a clinical answer.
 */
function toAnswers(v: unknown): MedicalAnswer[] {
  if (!Array.isArray(v)) return [];
  const out: MedicalAnswer[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key : "";
    const answer = r.answer as MedicalAnswerValue;
    if (!key || !isKnownQuestionKey(key) || !ANSWER_VALUES.includes(answer)) continue;
    out.push({ key, answer, detail: nullableStr(r.detail) });
  }
  return out;
}

function toSignature(v: unknown): MedicalSignature | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const method = r.method as SignatureMethod;
  const value = typeof r.value === "string" ? r.value : "";
  if (!SIGNATURE_METHODS.includes(method) || !value) return null;
  return { method, value, signedAt: str(r.signedAt) || str(r.signed_at) };
}

function toCaptureMethod(v: unknown): MedicalCaptureMethod {
  const m = str(v) as MedicalCaptureMethod;
  return CAPTURE_METHODS.includes(m) ? m : "staff";
}

function toQuestionnaire(r: Row): StoredQuestionnaire {
  return {
    id: str(r.id),
    siteId: str(r.site_id),
    patientId: str(r.dentally_patient_id),
    version: Number(r.version),
    questionBankVersion: str(r.question_bank_version),
    patientName: nullableStr(r.patient_name),
    answers: toAnswers(r.answers),
    medicationsText: nullableStr(r.medications_text),
    allergiesText: nullableStr(r.allergies_text),
    signature: toSignature(r.signature),
    capturedVia: toCaptureMethod(r.captured_via),
    recordedAt: str(r.recorded_at),
    createdAt: str(r.created_at),
    authorUserId: nullableStr(r.author_user_id),
    authorName: nullableStr(r.author_name),
    supersedesId: nullableStr(r.supersedes_id),
    amendmentReason: nullableStr(r.amendment_reason),
    retractedAt: nullableStr(r.retracted_at),
    retractionReason: nullableStr(r.retraction_reason),
  };
}

function toReview(r: Row): ReviewEvent {
  const outcome = str(r.outcome) as MedicalReviewOutcome;
  return {
    id: str(r.id),
    siteId: str(r.site_id),
    patientId: str(r.dentally_patient_id),
    appointmentId: nullableStr(r.dentally_appointment_id),
    questionnaireId: nullableStr(r.questionnaire_id),
    outcome: OUTCOMES.includes(outcome) ? outcome : "no-changes",
    reviewedAt: str(r.reviewed_at),
    createdAt: str(r.created_at),
    authorUserId: str(r.author_user_id),
    authorName: str(r.author_name),
    authorGdcNumber: nullableStr(r.author_gdc_number),
  };
}

// ---------------------------------------------------------------------------
// Version assignment is the database's job (trigger medical_history_assign_version),
// so nothing here sends a version. Two concurrent writes can compute the same next
// version under read-committed; the unique index turns the loser into a 23505, and
// ONE retry is enough because the retry re-reads the max.
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function insertRow(table: string, row: Row, cols: string): Promise<Row> {
  const db = serviceClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.from(table).insert(row).select(cols).single();
    if (!error) return asRow(data);
    if (!isUniqueViolation(error) || attempt === 1) throw error;
  }
  throw new Error(`could not insert into ${table}`); // unreachable
}

/**
 * Confirm an amendment target is this patient's, in this site, and still standing.
 * Scoped in the predicate, not checked by the caller: an amendment that could
 * point across a site boundary would let one practice's record acquire another's
 * history — the same IDOR class getPatientDetail shipped once.
 */
async function requireAmendable(scope: MedicalScope, id: string): Promise<void> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_history")
    .select("id, retracted_at")
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .maybeSingle();
  if (error) throw error;
  const row = (data ?? null) as Row | null;
  if (!row) {
    throw new MedicalRefusedError("the questionnaire being amended does not exist for this patient");
  }
  if (row.retracted_at) {
    throw new MedicalRefusedError("the questionnaire being amended has been retracted");
  }
}

// ===========================================================================
// Questionnaires
// ===========================================================================

/** Record a questionnaire. An amendment is a NEW VERSION, never an edit. */
export async function saveQuestionnaire(
  scope: MedicalScope,
  input: NewQuestionnaire,
): Promise<StoredQuestionnaire> {
  assertEnabled();
  if (input.supersedesId) {
    await requireAmendable(scope, input.supersedesId);
  }
  const row: Row = {
    site_id: scope.siteId,
    dentally_patient_id: scope.patientId,
    question_bank_version: input.questionBankVersion,
    patient_name: input.patientName,
    answers: input.answers,
    medications_text: input.medicationsText,
    allergies_text: input.allergiesText,
    signature: input.signature,
    captured_via: input.capturedVia,
    recorded_at: input.recordedAt,
    author_user_id: input.author?.id ?? null,
    author_name: input.author?.name ?? null,
    supersedes_id: input.supersedesId,
    amendment_reason: input.amendmentReason,
  };
  return toQuestionnaire(await insertRow("patient_medical_history", row, QUESTIONNAIRE_COLS));
}

/** The standing questionnaire: newest, not retracted. */
export async function latestQuestionnaire(scope: MedicalScope): Promise<StoredQuestionnaire | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_history")
    .select(QUESTIONNAIRE_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .is("retracted_at", null)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = asRows(data);
  return rows.length ? toQuestionnaire(rows[0]) : null;
}

/** This patient's questionnaire history in this site, newest first. Retracted
 *  rows ARE included — a withdrawn record is part of the history, which is the
 *  whole difference between retracting and deleting. */
export async function listQuestionnaires(scope: MedicalScope, limit = 20): Promise<StoredQuestionnaire[]> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_history")
    .select(QUESTIONNAIRE_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asRows(data).map(toQuestionnaire);
}

/** Withdraw a questionnaire entered in error. The row stays; the reason and the
 *  name are added. The append-only trigger permits exactly this update. */
export async function retractQuestionnaire(
  scope: MedicalScope,
  id: string,
  reason: string,
  by: MedicalClinician,
): Promise<StoredQuestionnaire | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_history")
    .update({
      retracted_at: new Date().toISOString(),
      retracted_by: by.id,
      retraction_reason: reason,
    })
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .is("retracted_at", null)
    .select(QUESTIONNAIRE_COLS)
    .maybeSingle();
  if (error) throw error;
  return data ? toQuestionnaire(asRow(data)) : null;
}

// ===========================================================================
// Reviews — the "reviewed at this appointment" clinical event
// ===========================================================================

/** Record a review. Always attributed to a named clinician (GDC 4.1.4). */
export async function recordReview(scope: MedicalScope, input: NewReview): Promise<ReviewEvent> {
  assertEnabled();
  const row: Row = {
    site_id: scope.siteId,
    dentally_patient_id: scope.patientId,
    dentally_appointment_id: input.appointmentId,
    questionnaire_id: input.questionnaireId,
    outcome: input.outcome,
    reviewed_at: input.reviewedAt,
    author_user_id: input.author.id,
    author_name: input.author.name,
    author_gdc_number: input.author.gdcNumber,
  };
  return toReview(await insertRow("patient_medical_review", row, REVIEW_COLS));
}

/** This patient's review history in this site, newest first. */
export async function listReviews(scope: MedicalScope, limit = 20): Promise<ReviewEvent[]> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_review")
    .select(REVIEW_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .order("reviewed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asRows(data).map(toReview);
}

/** The most recent review, or null. */
export async function latestReview(scope: MedicalScope): Promise<ReviewEvent | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_medical_review")
    .select(REVIEW_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .order("reviewed_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = asRows(data);
  return rows.length ? toReview(rows[0]) : null;
}

/** The standing questionnaire and the last review together — the pair the record
 *  screen and the header pill read. Both reads run in parallel. */
export async function getSummary(scope: MedicalScope): Promise<MedicalSummary> {
  assertEnabled();
  const [q, r] = await Promise.all([latestQuestionnaire(scope), latestReview(scope)]);
  return { latestQuestionnaire: q, latestReview: r };
}

// ===========================================================================
// Cross-patient: the task-queue's "awaiting review" list
// ===========================================================================

/**
 * Patients across the given sites whose latest captured questionnaire has NOT been
 * reviewed since it was captured. This is the task-queue signal, and it is
 * DELIBERATELY coarser than medicalReviewStatus: the task queue has no per-patient
 * appointment feed, so it flags "captured, not yet reviewed" rather than "due at
 * the next appointment". Both are honest; neither claims the other.
 *
 * Bounded by `scanLimit` so a large practice cannot pull an unbounded set into
 * Node. The screen this feeds is the task queue, which is a worklist, not a report.
 */
export async function listOutstandingReviews(
  siteIds: string[],
  scanLimit = 500,
): Promise<OutstandingReview[]> {
  assertEnabled();
  if (siteIds.length === 0) return [];
  const db = serviceClient();

  const [questionnaireRes, reviewRes] = await Promise.all([
    db
      .from("patient_medical_history")
      .select("site_id, dentally_patient_id, patient_name, recorded_at")
      .in("site_id", siteIds)
      .is("retracted_at", null)
      .order("recorded_at", { ascending: false })
      .limit(scanLimit),
    db
      .from("patient_medical_review")
      .select("site_id, dentally_patient_id, reviewed_at")
      .in("site_id", siteIds)
      .order("reviewed_at", { ascending: false })
      .limit(scanLimit),
  ]);
  if (questionnaireRes.error) throw questionnaireRes.error;
  if (reviewRes.error) throw reviewRes.error;

  // Latest questionnaire per (site, patient). Rows arrive newest-first, so the
  // first one seen for a key is the latest.
  const latestQ = new Map<string, { row: Row; at: number }>();
  for (const row of asRows(questionnaireRes.data)) {
    const key = `${str(row.site_id)}:${str(row.dentally_patient_id)}`;
    if (latestQ.has(key)) continue;
    latestQ.set(key, { row, at: Date.parse(str(row.recorded_at)) });
  }
  // Latest review per (site, patient).
  const latestR = new Map<string, number>();
  for (const row of asRows(reviewRes.data)) {
    const key = `${str(row.site_id)}:${str(row.dentally_patient_id)}`;
    if (latestR.has(key)) continue;
    latestR.set(key, Date.parse(str(row.reviewed_at)));
  }

  const out: OutstandingReview[] = [];
  for (const [key, q] of latestQ) {
    const reviewedAt = latestR.get(key);
    const reviewedSinceCapture =
      reviewedAt !== undefined && !Number.isNaN(reviewedAt) && !Number.isNaN(q.at) && reviewedAt >= q.at;
    if (reviewedSinceCapture) continue;
    out.push({
      siteId: str(q.row.site_id),
      dentallyPatientId: str(q.row.dentally_patient_id),
      patientName: nullableStr(q.row.patient_name),
      latestQuestionnaireAt: str(q.row.recorded_at),
    });
  }
  return out;
}
