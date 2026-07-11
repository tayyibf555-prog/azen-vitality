import { getClient, getSites, dentallySiteId } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import {
  isDentallyWriteEnabled,
  dentallyAgentClient,
  buildManualBookingPayload,
} from "@/lib/dentally/write";
// REUSED on purpose: this is the client-scoped PUBLIC-funnel page token (the
// hour-rotating HMAC the Smile Assessment page fetches from
// /api/smile-assessment/token). The booking page is reached from that same
// funnel, so the same token proves "a real page fetched this just now" without
// shipping any raw key to the browser. See embed-token.ts for the threat model.
import { verifySubmitToken } from "@/lib/smile-assessment/embed-token";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { fetchAvailabilityDays, findExactSlot, type BookingSlot } from "@/lib/booking/slots";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// PUBLIC: create a real Dentally appointment from the online-booking page.
//
// ABUSE SURFACE: unauthenticated, and a successful call WRITES a real
// appointment (and possibly a real patient record). So every guard fails
// closed, in order: tenant resolution, owner kill switch, the Dentally write
// gate, the page token, input validation, per-IP + per-phone caps, and a LIVE
// slot revalidation so the write can never target a slot Dentally is not
// currently offering. All errors are friendly patient-facing copy; Dentally
// error bodies are never leaked.

const HOUR_MS = 3_600_000;
const IP_RATE_LIMIT = 20; // mirrors the smile-assessment submit route
const PHONE_RATE_LIMIT = 3; // max booking attempts per phone per hour

const UNAVAILABLE =
  "Online booking is unavailable right now. Please call the practice and we will find you a time.";
const BOOKING_FAILED =
  "We could not complete the booking. Please call the practice and we will find you a time.";

// Best-effort in-process caps (per instance, like the submit route's: they
// blunt a single-instance flood; this endpoint has no durable store of its own).
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
    // (a) Resolve the client, and the site must be one of ITS OWN sites: a plain
    // 404 otherwise, mirroring the anti-cross-tenant posture of the other public
    // routes (never book against a site the link has no relationship with).
    const clientSlug = str(body.clientSlug) ?? "";
    const siteId = str(body.siteId) ?? "";
    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client || !getSites(client.id).some((s) => s.id === siteId)) {
      return bad("We could not find that booking page. Please check the link and try again.", 404);
    }

    // (b) Owner kill switch. Availability stays viewable (GET route), but no
    // appointment is created while the system is off.
    if (!(await isSystemEnabled(client.id, "online-booking"))) {
      return bad(UNAVAILABLE, 503);
    }

    // (c) The Dentally write gate: without the dedicated write key + base URL,
    // no public request may reach a real appointment write.
    if (!isDentallyWriteEnabled()) {
      return bad(UNAVAILABLE, 503);
    }

    // (d) Page token: proves the request came from a page that fetched the
    // funnel token moments ago (see the import note above for what this buys).
    if (!verifySubmitToken(str(body.pageToken), clientSlug)) {
      return bad("Please refresh the page and try again.", 403);
    }

    // (e) Patient details. Phone is required (it is how the practice reaches
    // them and how we match an existing record); email optional.
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

    const slotStart = str(body.slotStart);
    const finish = str(body.finish);
    if (
      !slotStart ||
      !finish ||
      Number.isNaN(Date.parse(slotStart)) ||
      Number.isNaN(Date.parse(finish))
    ) {
      return bad("Please pick a time slot and try again.", 400);
    }
    const requestedPractitionerId = str(body.practitionerId);

    // (f) Rate caps: per IP (cheap flood blunting) and per phone (a handset gets
    // at most a few booking attempts an hour).
    const now = Date.now();
    if (tooMany(ipHits, clientIp(request), IP_RATE_LIMIT, now)) {
      return bad("Too many booking attempts. Please wait a little while and try again.", 429);
    }
    if (tooMany(phoneHits, phone, PHONE_RATE_LIMIT, now)) {
      return bad("Too many booking attempts. Please wait a little while and try again.", 429);
    }

    const dentally = dentallyAgentClient();

    // (g) SLOT REVALIDATION, live and uncached: the requested slot must still be
    // in Dentally's availability for that day. The client's copy identifies the
    // selection only; the booking uses the LIVE slot's own finish/practitioner.
    // The day is queried with a +1 day end so an exclusive end-date reading of
    // the availability filter can never hide the day's own evening slots.
    const day = londonDayKey(new Date(slotStart));
    let liveSlot: BookingSlot | null = null;
    try {
      const days = await fetchAvailabilityDays(dentally, siteId, day, shiftYmd(day, 1), new Date(now));
      liveSlot = findExactSlot(days, slotStart, finish, requestedPractitionerId);
    } catch {
      return bad(BOOKING_FAILED, 502);
    }
    if (!liveSlot) {
      return bad("That time has just been taken. Please pick another slot.", 409);
    }

    // (h) Patient resolution: an exact mobile match reuses the existing Dentally
    // record (never create a duplicate); otherwise register a new patient,
    // mirroring the agent's validated register_patient payload.
    let patientId = "";
    let patientCreated = false;
    try {
      const found = await dentally.findPatientsByPhone(phone);
      const rows = Array.isArray(found.patients) ? found.patients : [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const p = r as Record<string, unknown>;
        const id = typeof p.id === "string" || typeof p.id === "number" ? String(p.id) : "";
        if (id && p.mobile_phone === phone) {
          patientId = id;
          break;
        }
      }
      if (!patientId) {
        const { patient } = await dentally.createPatient({
          first_name: firstName,
          last_name: lastName,
          email_address: email ?? undefined,
          mobile_phone: phone,
          // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
          site_id: dentallySiteId(siteId),
          use_sms: true,
          use_email: true,
        });
        patientId = String(patient.id);
        patientCreated = true;
      }

      // (i) The write itself goes through the whitelisted payload builder that
      // was validated end-to-end against live Dentally. The time/practitioner
      // fields come from the REVALIDATED live slot, never the client's copy.
      const built = buildManualBookingPayload(
        {
          start_time: liveSlot.start,
          finish_time: liveSlot.finish,
          practitioner_id: liveSlot.practitionerId ?? "",
          reason: "Exam",
          notes: "Booked online via Smile Assessment",
        },
        patientId,
      );
      if ("error" in built) {
        // e.g. a live slot with no practitioner id: refuse rather than send an
        // invalid write. Internal detail, so the patient sees the friendly line.
        return bad(BOOKING_FAILED, 502);
      }
      await dentally.createAppointment(built.payload);
    } catch {
      // Any Dentally failure (422 included): friendly, never the error body.
      return bad(BOOKING_FAILED, 502);
    }

    // (j) Done.
    return Response.json({
      ok: true,
      booked: {
        start: liveSlot.start,
        finish: liveSlot.finish,
        practitionerId: liveSlot.practitionerId,
      },
      patientCreated,
    });
  } catch {
    // Never throw to the patient.
    return bad(BOOKING_FAILED, 502);
  }
}

/** YYYY-MM-DD shifted by whole days (UTC-safe). */
function shiftYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
