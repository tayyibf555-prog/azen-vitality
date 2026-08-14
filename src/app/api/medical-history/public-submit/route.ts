import { consumeBudget } from "@/lib/rate-budget";
import { verifyPatientToken } from "@/lib/public-link/patient-token";
import { isMedicalHistoryEnabled } from "@/lib/patient-medical/gate";
import { QUESTION_BANK_VERSION, isKnownQuestionKey } from "@/lib/patient-medical/questions";
import { saveQuestionnaire, type NewQuestionnaire } from "@/lib/patient-medical/repository";
import type {
  MedicalAnswer,
  MedicalAnswerValue,
  MedicalSignature,
  SignatureMethod,
} from "@/lib/patient-medical/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// PUBLIC medical-history capture — the "link 24h before / iPad on the day" path.
//
// A patient opens /mh/<token>, answers the yes/no questions, signs, and POSTs
// here. Nobody is signed in, so this is the ONLY path that writes a questionnaire
// with a NULL author: the patient authored it, not a clinician. That is exactly
// why the authoring route refuses a null-author write and this one embraces it.
//
// THE TOKEN IS THE IDENTITY, NEVER THE BODY. verifyPatientToken decodes the signed
// { siteId, patientRef } and rejects a tampered or cross-purpose token. The stored
// site and patient come from the TOKEN; the request body cannot name a patient. A
// patient's typed name is stored as the signed name only, never as the patient id.
//
// ABUSE SURFACE: unauthenticated, writes a row. It sends no outbound message (blast
// radius is "junk rows"), but it is still gated OFF by MEDICAL_HISTORY_ENABLED,
// rate-limited per IP, and behind the shared budget. It never throws to the client
// and never leaks an id.
// ===========================================================================

const IP_RATE_LIMIT = 15; // per IP per hour (best-effort, per-instance)
const HOUR_MS = 60 * 60 * 1000;
const MAX_TEXT = 5000;
const MAX_ANSWER_DETAIL = 1000;
const MAX_NAME = 200;
const MAX_SIGNATURE = 500_000;

const ANSWER_VALUES: readonly MedicalAnswerValue[] = ["yes", "no", "unknown"];
const SIGNATURE_METHODS: readonly SignatureMethod[] = ["drawn", "typed", "ipad"];

const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
  }
  return hits.length > IP_RATE_LIMIT;
}

function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function trimmed(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parse the answers, dropping any key not on the current bank and refusing a
 *  malformed value. An unknown or duplicate key is dropped rather than stored, so
 *  a stale or forged form cannot bloat the record. Returns null on a hard error. */
function parseAnswers(raw: unknown): MedicalAnswer[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: MedicalAnswer[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = asRecord(entry);
    if (!obj) return null;
    const key = typeof obj.key === "string" ? obj.key : "";
    if (!key || !isKnownQuestionKey(key) || seen.has(key)) continue; // drop, do not fail
    const answer = obj.answer as MedicalAnswerValue;
    if (!ANSWER_VALUES.includes(answer)) return null;
    const detailRaw = obj.detail;
    if (detailRaw !== undefined && detailRaw !== null && typeof detailRaw !== "string") return null;
    const detail = typeof detailRaw === "string" ? detailRaw.trim() : "";
    if (detail.length > MAX_ANSWER_DETAIL) return null;
    seen.add(key);
    out.push({ key, answer, detail: detail || null });
  }
  return out;
}

function parseSignature(raw: unknown): MedicalSignature | null | "error" {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw);
  if (!obj) return "error";
  const method = obj.method as SignatureMethod;
  if (!SIGNATURE_METHODS.includes(method)) return "error";
  const value = typeof obj.value === "string" ? obj.value : "";
  if (!value || value.length > MAX_SIGNATURE) return "error";
  const signedAtRaw = obj.signedAt;
  const signedAt =
    typeof signedAtRaw === "string" && !Number.isNaN(Date.parse(signedAtRaw))
      ? new Date(signedAtRaw).toISOString()
      : new Date().toISOString();
  return { method, value, signedAt };
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  try {
    // The gate first: with the feature off, accept nothing. Neutral wording — a
    // public caller learns nothing about the practice's internal feature state.
    if (!isMedicalHistoryEnabled()) {
      return Response.json({ ok: false, error: "This form is not currently available." }, { status: 503 });
    }

    // The token IS the identity. A missing, tampered or cross-purpose token (an
    // FP17 token replayed here) verifies to null and is refused.
    const token = typeof body.token === "string" ? body.token : "";
    const identity = verifyPatientToken(token, "mh");
    if (!identity) {
      return Response.json({ ok: false, error: "This link is invalid or has expired." }, { status: 403 });
    }

    // Per-IP cap first (cheap, in-process) so a flood is blunted before any DB hit.
    if (tooManyForIp(clientIp(request), Date.now())) {
      return bad("Too many submissions, please try again later", 429);
    }
    // Shared global budget: the real ceiling across all instances, immune to IP
    // spoofing.
    if (!(await consumeBudget("medical-history-submit", 240, 60))) {
      return Response.json(
        { ok: false, error: "The form is busy, please try again shortly." },
        { status: 429 },
      );
    }

    const answers = parseAnswers(body.answers);
    if (answers === null) return bad("Some of your answers could not be read. Please try again.");
    const signature = parseSignature(body.signature);
    if (signature === "error") return bad("Your signature could not be read. Please try again.");

    const input: NewQuestionnaire = {
      answers,
      questionBankVersion: QUESTION_BANK_VERSION,
      // The name the patient typed / signed. NEVER the patient identity — that comes
      // from the token below.
      patientName: trimmed(body.patientName, MAX_NAME),
      medicationsText: trimmed(body.medicationsText, MAX_TEXT),
      allergiesText: trimmed(body.allergiesText, MAX_TEXT),
      signature,
      capturedVia: "public-link",
      recordedAt: new Date().toISOString(),
      // Patient self-capture: no clinician authored this. The one place a null
      // author is written, and it is truthful.
      author: null,
      supersedesId: null,
      amendmentReason: null,
    };

    // Scope from the TOKEN, never from the body — this is the load-bearing IDOR
    // defence.
    const saved = await saveQuestionnaire(
      { siteId: identity.siteId, patientId: identity.patientRef },
      input,
    );
    void saved; // do not leak the row id to the public caller

    return Response.json({
      ok: true,
      message: "Thank you. Your medical history has been sent to the practice.",
    });
  } catch {
    // Never throw to the client, and never claim success on a failed write.
    return bad("We could not save your answers, please try again", 500);
  }
}
