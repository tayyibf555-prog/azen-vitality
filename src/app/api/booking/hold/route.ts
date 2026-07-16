import { getClient, getSites } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
// REUSED: the same client-scoped public-funnel page token the booking create
// route verifies (see /api/smile-assessment/token + embed-token.ts). The booking
// page fetches it just before this call, so it proves "a real page did this".
import { verifySubmitToken } from "@/lib/smile-assessment/embed-token";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { createHold } from "@/lib/booking/holds";
import { BOOKING_HORIZON_DAYS } from "@/lib/booking/slots";

export const dynamic = "force-dynamic";

// PUBLIC: step 1 of the two-step online booking. The patient has picked a slot
// and given their name + mobile; this HOLDS the time by recording a booking_hold
// row. It writes NOTHING to Dentally — step 2 (the existing gated create path)
// makes the real appointment and flips the hold to 'confirmed'. A hold left
// un-confirmed is later converted into a speed-to-lead lead by the SLA sweep.
//
// ABUSE SURFACE: unauthenticated and it stores a caller-supplied name + mobile.
// It never sends a message or touches Dentally, so it is lighter than create, but
// still fails closed in order: tenant resolution, owner kill switch, page token,
// input validation, and per-IP + per-phone caps. No Dentally read happens here on
// purpose, so holding a time stays instant; create revalidates against live
// availability before any write.

const HOUR_MS = 3_600_000;
const IP_RATE_LIMIT = 30; // holds are cheap; a little looser than create's 20
const PHONE_RATE_LIMIT = 6; // a handset may start a few bookings an hour

const UNAVAILABLE =
  "Online booking is unavailable right now. Please call the practice and we will find you a time.";
const HOLD_FAILED =
  "We could not hold that time. Please try again, or call the practice and we will find you a time.";

// Best-effort in-process caps (per instance, like the create/submit routes).
const ipHits = new Map<string, number[]>();
const phoneHits = new Map<string, number[]>();
function tooMany(map: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (map.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  map.set(key, hits);
  if (map.size > 5000) {
    for (const [k, v] of map) {
      if (v.every((t) => t <= cutoff)) map.delete(k);
    }
  }
  return hits.length > limit;
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function bad(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
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
    return bad("We could not read that request. Please refresh the page and try again.", 400);
  }

  try {
    // (a) The site must be one of the resolved client's OWN sites: a plain 404
    // otherwise (mirrors create/slots' cross-tenant posture).
    const clientSlug = str(body.clientSlug) ?? "";
    const siteId = str(body.siteId) ?? "";
    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client || !getSites(client.id).some((s) => s.id === siteId)) {
      return bad("We could not find that booking page. Please check the link and try again.", 404);
    }

    // (b) Owner kill switch: no holds while online booking is switched off (there
    // would be nothing to confirm them into).
    if (!(await isSystemEnabled(client.id, "online-booking"))) {
      return bad(UNAVAILABLE, 503);
    }

    // (c) Page token: proves the request came from a page that fetched the funnel
    // token moments ago.
    if (!verifySubmitToken(str(body.pageToken), clientSlug)) {
      return bad("Please refresh the page and try again.", 403);
    }

    // (d) Patient details. Name + a UK mobile are required so the confirmation (and
    // any win-back) text can reach them; email optional.
    const firstName = str(body.firstName);
    const lastName = str(body.lastName);
    if (!firstName || !lastName) {
      return bad("Please enter your first and last name.", 400);
    }
    const phone = toE164(str(body.phone));
    if (!phone) return bad("Please check your mobile number and try again.", 400);
    const rawEmail = str(body.email);
    const email = normaliseEmail(rawEmail);
    if (rawEmail && !email) return bad("Please check your email address and try again.", 400);

    // (e) The chosen slot: parseable instants, in the future, within the horizon.
    // This is a light sanity check only; create does the LIVE revalidation.
    const slotStart = str(body.slotStart);
    const finish = str(body.finish);
    const startMs = slotStart ? Date.parse(slotStart) : NaN;
    const finishMs = finish ? Date.parse(finish) : NaN;
    if (!slotStart || !finish || Number.isNaN(startMs) || Number.isNaN(finishMs)) {
      return bad("Please pick a time slot and try again.", 400);
    }
    const now = Date.now();
    if (startMs <= now || startMs > now + BOOKING_HORIZON_DAYS * 86_400_000) {
      return bad("Please pick a time slot and try again.", 400);
    }
    const practitionerId = str(body.practitionerId) ?? null;
    const treatment = str(body.treatment) ?? "Exam";

    // (f) Rate caps: per IP and per phone.
    if (tooMany(ipHits, clientIp(request), IP_RATE_LIMIT, now)) {
      return bad("Too many attempts. Please wait a little while and try again.", 429);
    }
    if (tooMany(phoneHits, phone, PHONE_RATE_LIMIT, now)) {
      return bad("Too many attempts. Please wait a little while and try again.", 429);
    }

    const hold = await createHold({
      clientId: client.id,
      siteId,
      slotStart,
      slotFinish: finish,
      practitionerId,
      practitionerName: null,
      treatment,
      name: `${firstName} ${lastName}`,
      phone,
      email: email ?? null,
    });

    return Response.json({
      ok: true,
      holdId: hold.id,
      held: { start: hold.slotStart, finish: hold.slotFinish },
    });
  } catch {
    // Never throw to the patient.
    return bad(HOLD_FAILED, 500);
  }
}
