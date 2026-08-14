import { getClient, getSite } from "@/lib/mock/clients";
import { verifyPatientToken } from "@/lib/public-link/patient-token";
import { validateFp17Declaration } from "@/lib/fp17/validate";
import { createDeclaration } from "@/lib/fp17/repository";
import { consumeBudget } from "@/lib/rate-budget";
import { isSystemEnabled } from "@/lib/systems/repository";
import { FP17_COPY, FP17_SYSTEM_SLUG } from "@/lib/fp17/copy";

export const dynamic = "force-dynamic";

// Public submit endpoint for the FP17 / PR consent + exemption declaration. A patient
// opens the branded, per-patient /fp17/<client>/<token> link and POSTs their answers
// here. Modelled on /api/onboarding/submit: resolve the client, kill-switch, cap per
// IP, consume the shared budget, validate, store, and return a friendly ack. It never
// throws to the client and leaks no row id.
//
// THE TOKEN IS THE ONLY SOURCE OF THE PATIENT BINDING. We re-verify the signed link
// token server-side (purpose 'fp17', so an 'mh' token cannot be replayed here) and
// store dentally_patient_id + site_id FROM THE TOKEN — never from the request body,
// which a caller controls. A body cannot re-point a declaration at another patient.
//
// NOTHING HERE IS SUBMITTED TO THE NHS (Compass). This stores the declaration for the
// practice's records only.

const IP_RATE_LIMIT = 15; // max submissions from one IP per hour (best-effort, per-instance)
const HOUR_MS = 60 * 60 * 1000;

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
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the LAST
  // x-forwarded-for entry (Vercel appends the real connecting IP at the end); the
  // leftmost entry is attacker-controlled, so never trust it.
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
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
    // Resolve the client (reject unknown).
    const clientSlug = str(body.clientSlug);
    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client) return bad("Unknown practice");

    // Owner kill-switch: if the feature is off for this client, accept nothing. A
    // 503, never an empty 200, so a caller never reads this as "captured".
    if (!(await isSystemEnabled(client.id, FP17_SYSTEM_SLUG))) {
      return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    }

    // Per-IP cap first (cheap, in-process) so a flood is blunted before any DB hit.
    if (tooManyForIp(clientIp(request), Date.now())) {
      return bad("Too many submissions, please try again later", 429);
    }
    // Shared global budget: the real ceiling across all instances, immune to IP
    // spoofing.
    if (!(await consumeBudget("fp17-submit", 240, 60))) {
      return Response.json(
        { ok: false, error: "the form is busy, please try again shortly" },
        { status: 429 },
      );
    }

    // THE PATIENT BINDING — re-verified server-side, purpose-scoped to 'fp17'.
    const token = str(body.token);
    const payload = token ? verifyPatientToken(token, "fp17") : null;
    if (!payload) return bad("This link is not valid", 400);
    // Belt-and-braces: the token's site must belong to THIS client, so a token minted
    // for one practice's site cannot be presented against another practice's slug.
    const site = getSite(payload.siteId);
    if (!site || site.clientId !== client.id) return bad("This link is not valid", 400);

    // Validate + normalise the declaration (pure, tested).
    const parsed = validateFp17Declaration({
      exemptionCategory: body.exemptionCategory,
      evidenceAck: body.evidenceAck,
      declarationTruth: body.declarationTruth,
      consentTreatment: body.consentTreatment,
      consentDataShare: body.consentDataShare,
      signatureMethod: body.signatureMethod,
      signatureValue: body.signatureValue,
      patientName: body.patientName,
      dateOfBirth: body.dateOfBirth,
    });
    if (!parsed.ok) return bad(parsed.error);
    const v = parsed.value;

    const signedAt = new Date().toISOString();
    await createDeclaration({
      clientId: client.id,
      // FROM THE TOKEN, never the body.
      siteId: payload.siteId,
      dentallyPatientId: payload.patientRef,
      patientName: v.patientName,
      dateOfBirth: v.dateOfBirth,
      consent: { treatment: v.consent.treatment, dataShare: v.consent.dataShare, signedAt },
      exemptionCategory: v.exemptionCategory,
      exemptionEvidenceAck: v.evidenceAck,
      declarationTruth: v.declarationTruth,
      signature: { method: v.signature.method, value: v.signature.value, signedAt },
      capturedVia: "public-link",
    });

    // Do not leak the row id or internals to the public caller; a friendly ack only.
    return Response.json({ ok: true, message: FP17_COPY.thanks });
  } catch {
    // Never throw to the client, and never phrase it as a partial success.
    return bad(FP17_COPY.saveFailed, 500);
  }
}
