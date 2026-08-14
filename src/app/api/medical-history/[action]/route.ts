import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import { getPatientById } from "@/lib/dentally/read";
import { isMedicalHistoryEnabled, MEDICAL_COPY } from "@/lib/patient-medical/gate";
import { QUESTION_BANK_VERSION, isKnownQuestionKey } from "@/lib/patient-medical/questions";
import {
  saveQuestionnaire,
  recordReview,
  latestQuestionnaire,
  latestReview,
  listReviews,
  retractQuestionnaire,
  MedicalDisabledError,
  MedicalRefusedError,
  type MedicalScope,
  type NewQuestionnaire,
  type NewReview,
} from "@/lib/patient-medical/repository";
import type {
  MedicalAnswer,
  MedicalAnswerValue,
  MedicalClinician,
  MedicalReviewOutcome,
  MedicalSignature,
  SignatureMethod,
} from "@/lib/patient-medical/types";

/**
 * MEDICAL HISTORY. Like perio, the part of this platform that is NOT a mirror.
 *
 * Dentally's /v1/medical_histories endpoint exists but is permanently empty for
 * this practice (0 rows across 51k patients, verified GET-only), so every row this
 * route stores is AUTHORED here. The only Dentally medical signal we read is the
 * patient object's own `medical_alert` flag, which lives on the patient record and
 * is a DIFFERENT fact from the questionnaire below. That is why the feature ships
 * off, why every REVIEW is attributed to a named clinician, and why the disabled
 * path is a 503 rather than an empty 200 — an empty medical result reads as "this
 * patient has no medical history", which it must never claim.
 *
 * GET  /api/medical-history/latest?client=&siteId=&patientId=   -> questionnaire + review
 * GET  /api/medical-history/reviews?...                         -> the review history
 * POST /api/medical-history/questionnaire  { ...scope, answers, ... }  (staff fallback)
 * POST /api/medical-history/review         { ...scope, outcome, ... }
 * POST /api/medical-history/retract        { ...scope, id, reason }
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 5000;
const MAX_REASON = 1000;
const MAX_ANSWER_DETAIL = 1000;
const MAX_SIGNATURE = 500_000; // a drawn-signature data-url; generous, but bounded
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const ANSWER_VALUES: readonly MedicalAnswerValue[] = ["yes", "no", "unknown"];
const OUTCOMES: readonly MedicalReviewOutcome[] = ["no-changes", "updated"];
const SIGNATURE_METHODS: readonly SignatureMethod[] = ["drawn", "typed", "ipad"];

type Payload = Record<string, unknown>;
type Failed = { error: string };

function failed(value: unknown): value is Failed {
  return Boolean(value) && typeof value === "object" && "error" in (value as object);
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Authorisation. Identical in shape and order to /api/perio/[action], failing
// closed at every step.
// ---------------------------------------------------------------------------

interface Authorised {
  scope: MedicalScope;
  /** null when auth enforcement is off (no service-role key). Reads still work. */
  clinician: MedicalClinician | null;
}

async function patientBelongsToSite(auth: unknown, patientId: string, siteId: string): Promise<boolean> {
  if (!auth) return true; // unenforced pilot: the detail route behaves the same
  const patient = await getPatientById(patientId);
  return Boolean(patient && patient.siteId === siteId);
}

async function authorise(
  clientSlug: string,
  siteId: string,
  patientId: string,
): Promise<Authorised | Response> {
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;

  if (!siteId || !patientId) {
    return Response.json({ ok: false, error: "siteId and patientId are required" }, { status: 400 });
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  // A patient in another site does not exist as far as this caller is concerned:
  // the same 404 as a missing one, so a probe learns nothing from the difference.
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return {
    scope: { siteId, patientId },
    // gdcNumber is null because app_user does not hold one. A null is allowed; a
    // fabricated one is not, so nothing is invented here (GDC 4.1.4).
    clinician: auth ? { id: auth.id, name: auth.name, gdcNumber: null } : null,
  };
}

/** The one 503 for a switched-off feature, naming the variable that switches it on. */
function disabled(): Response {
  return Response.json({ ok: false, error: MEDICAL_COPY.disabled }, { status: 503 });
}
function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}
/** Every successful response carries the two-records notice: the questionnaire here
 *  and Dentally's own medical record are different facts. */
function ok(body: Record<string, unknown>): Response {
  return Response.json({ ok: true, notice: MEDICAL_COPY.twoRecords, ...body });
}

function writeFailure(error: unknown): Response {
  if (error instanceof MedicalDisabledError) return disabled();
  if (error instanceof MedicalRefusedError) {
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }
  return Response.json({ ok: false, error: MEDICAL_COPY.saveFailed }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Shared field parsing
// ---------------------------------------------------------------------------

/** An ISO instant in the past (within clock-skew tolerance), or now when absent. */
function readWhen(raw: unknown, noun: string): string | Failed {
  if (raw === undefined || raw === null || raw === "") return new Date().toISOString();
  if (typeof raw !== "string") return { error: `${noun} must be an ISO date and time` };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { error: `${noun} must be an ISO date and time` };
  if (ms > Date.now() + FUTURE_TOLERANCE_MS) {
    return { error: `${noun} cannot be in the future` };
  }
  return new Date(ms).toISOString();
}

function readText(raw: unknown, noun: string, max = MAX_TEXT): string | null | Failed {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { error: `${noun} must be text` };
  if (raw.length > max) return { error: `that ${noun} is too long` };
  return raw.trim() || null;
}

/**
 * The answers array. Every answer must name a key IN THE CURRENT BANK and carry a
 * yes/no/unknown value; anything else is refused rather than stored, so a stale or
 * forged key can never bloat a clinical record. An empty array is allowed (a
 * questionnaire the patient left blank is a distinct fact from one not captured),
 * but a malformed one is refused.
 */
function readAnswers(raw: unknown): MedicalAnswer[] | Failed {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: "answers must be a list" };
  const out: MedicalAnswer[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = asRecord(entry);
    if (!obj) return { error: "each answer must name a question and a response" };
    const key = typeof obj.key === "string" ? obj.key : "";
    if (!key || !isKnownQuestionKey(key)) {
      return { error: `"${String(obj.key)}" is not a question on the current medical-history form` };
    }
    if (seen.has(key)) return { error: `the ${key} question is answered more than once` };
    seen.add(key);
    const answer = obj.answer as MedicalAnswerValue;
    if (!ANSWER_VALUES.includes(answer)) {
      return { error: `the answer to ${key} must be yes, no or unknown` };
    }
    const detailRaw = obj.detail;
    if (detailRaw !== undefined && detailRaw !== null && typeof detailRaw !== "string") {
      return { error: `the detail for ${key} must be text` };
    }
    const detail = typeof detailRaw === "string" ? detailRaw.trim() : "";
    if (detail.length > MAX_ANSWER_DETAIL) return { error: `the detail for ${key} is too long` };
    out.push({ key, answer, detail: detail || null });
  }
  return out;
}

function readSignature(raw: unknown): MedicalSignature | null | Failed {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw);
  if (!obj) return { error: "signature must be an object" };
  const method = obj.method as SignatureMethod;
  if (!SIGNATURE_METHODS.includes(method)) {
    return { error: `a signature method is one of ${SIGNATURE_METHODS.join(", ")}` };
  }
  const value = typeof obj.value === "string" ? obj.value : "";
  if (!value) return { error: "a signature carries a value" };
  if (value.length > MAX_SIGNATURE) return { error: "that signature is too large" };
  const signedAt = readWhen(obj.signedAt, "signedAt");
  if (failed(signedAt)) return signedAt;
  return { method, value, signedAt };
}

function readAmendment(
  p: Payload,
): { supersedesId: string | null; amendmentReason: string | null } | Failed {
  const rawId = p.supersedesId;
  const rawReason = p.amendmentReason;
  if (rawId === undefined || rawId === null || rawId === "") {
    if (typeof rawReason === "string" && rawReason.trim()) {
      return { error: "an amendment reason needs the supersedesId of the record being amended" };
    }
    return { supersedesId: null, amendmentReason: null };
  }
  if (typeof rawId !== "string") return { error: "supersedesId must be an id" };
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!reason) {
    return { error: "an amendment must say why it was made, and that reason is kept on the record" };
  }
  if (reason.length > MAX_REASON) return { error: "that amendment reason is too long" };
  return { supersedesId: rawId, amendmentReason: reason };
}

// ===========================================================================
// GET
// ===========================================================================

const GET_ACTIONS = new Set(["latest", "reviews"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  if (!GET_ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
  }

  const url = new URL(request.url);
  const auth = await authorise(
    url.searchParams.get("client") ?? "",
    url.searchParams.get("siteId") ?? "",
    url.searchParams.get("patientId") ?? "",
  );
  if (auth instanceof Response) return auth;

  // Checked AFTER authorisation, so an unauthorised caller cannot learn the
  // practice's feature state from the response.
  if (!isMedicalHistoryEnabled()) return disabled();

  try {
    if (action === "latest") {
      const [questionnaire, review, reviews] = await Promise.all([
        latestQuestionnaire(auth.scope),
        latestReview(auth.scope),
        listReviews(auth.scope),
      ]);
      return ok({ questionnaire, review, reviews, questionBankVersion: QUESTION_BANK_VERSION });
    }
    return ok({ reviews: await listReviews(auth.scope) });
  } catch (error) {
    if (error instanceof MedicalDisabledError) return disabled();
    // ok:false, NEVER an empty list — an empty medical result renders as "this
    // patient has no medical history", which is a claim about the patient rather
    // than about the database.
    return Response.json({ ok: false, error: MEDICAL_COPY.readFailed }, { status: 500 });
  }
}

// ===========================================================================
// POST
// ===========================================================================

const POST_ACTIONS = new Set(["questionnaire", "review", "retract"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  if (!POST_ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const auth = await authorise(
    String(payload.client ?? ""),
    String(payload.siteId ?? ""),
    String(payload.patientId ?? ""),
  );
  if (auth instanceof Response) return auth;

  if (!isMedicalHistoryEnabled()) return disabled();

  // Every write on this route records the clinician who made it (GDC 4.1.4): a
  // staff-entered questionnaire is authored by the staff member, a review by the
  // reviewing clinician. Patient self-capture is the PUBLIC route's job, which is
  // the only path that writes a null-author questionnaire.
  if (!auth.clinician) {
    return Response.json({ ok: false, error: MEDICAL_COPY.noAuthor }, { status: 503 });
  }

  try {
    if (action === "questionnaire") return await postQuestionnaire(payload, auth.scope, auth.clinician);
    if (action === "review") return await postReview(payload, auth.scope, auth.clinician);
    return await postRetract(payload, auth.scope, auth.clinician);
  } catch (error) {
    return writeFailure(error);
  }
}

async function postQuestionnaire(
  payload: Payload,
  scope: MedicalScope,
  clinician: MedicalClinician,
): Promise<Response> {
  if (payload.version !== undefined) {
    return badRequest("versions are assigned when a record is written and cannot be set by a caller");
  }
  const answers = readAnswers(payload.answers);
  if (failed(answers)) return badRequest(answers.error);
  const medications = readText(payload.medicationsText, "medications list");
  if (failed(medications)) return badRequest(medications.error);
  const allergies = readText(payload.allergiesText, "allergies list");
  if (failed(allergies)) return badRequest(allergies.error);
  const patientName = readText(payload.patientName, "patient name", 200);
  if (failed(patientName)) return badRequest(patientName.error);
  const signature = readSignature(payload.signature);
  if (failed(signature)) return badRequest(signature.error);
  const recordedAt = readWhen(payload.recordedAt, "recordedAt");
  if (failed(recordedAt)) return badRequest(recordedAt.error);
  const amendment = readAmendment(payload);
  if (failed(amendment)) return badRequest(amendment.error);

  const input: NewQuestionnaire = {
    answers,
    questionBankVersion: QUESTION_BANK_VERSION,
    patientName,
    medicationsText: medications,
    allergiesText: allergies,
    signature,
    capturedVia: "staff",
    recordedAt,
    author: clinician,
    ...amendment,
  };
  return ok({ questionnaire: await saveQuestionnaire(scope, input) });
}

async function postReview(
  payload: Payload,
  scope: MedicalScope,
  clinician: MedicalClinician,
): Promise<Response> {
  const outcome = payload.outcome as MedicalReviewOutcome;
  if (!OUTCOMES.includes(outcome)) {
    return badRequest(`a review outcome is one of ${OUTCOMES.join(", ")}`);
  }
  const reviewedAt = readWhen(payload.recordedAt ?? payload.reviewedAt, "reviewedAt");
  if (failed(reviewedAt)) return badRequest(reviewedAt.error);
  const appointmentId = typeof payload.appointmentId === "string" && payload.appointmentId
    ? payload.appointmentId
    : null;
  const questionnaireId = typeof payload.questionnaireId === "string" && payload.questionnaireId
    ? payload.questionnaireId
    : null;

  const input: NewReview = { outcome, reviewedAt, appointmentId, questionnaireId, author: clinician };
  return ok({ review: await recordReview(scope, input) });
}

async function postRetract(
  payload: Payload,
  scope: MedicalScope,
  clinician: MedicalClinician,
): Promise<Response> {
  const id = typeof payload.id === "string" ? payload.id : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!id) return badRequest("id is required");
  // GDC 4.1.5: a withdrawal with no reason is a deletion wearing a timestamp.
  if (!reason) return badRequest("a retraction must say why, and that reason stays on the record");
  if (reason.length > MAX_REASON) return badRequest("that reason is too long");

  const retracted = await retractQuestionnaire(scope, id, reason, clinician);
  if (!retracted) {
    // Missing, out of this site, or already retracted — all one answer, so a probe
    // cannot tell a foreign patient's record from a nonexistent one.
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return ok({ retracted });
}
