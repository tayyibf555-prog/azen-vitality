import { getClient, getSites, dentallySiteId, siteIdFromDentally } from "@/lib/mock/clients";
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
import { markHoldConfirmed } from "@/lib/booking/holds";
import { londonDayKey } from "@/lib/time/london";
import { ageFromDob } from "@/lib/patient/demographics";

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

/** Names for comparison: case and spacing insensitive. */
function nameKey(first: string, last: string): string {
  return `${first} ${last}`.toLowerCase().replace(/\s+/g, " ").trim();
}

// What the patient said they are coming in for, mapped to the appointment
// reasons Dentally accepts (BOOKING_REASONS in lib/dentally/write.ts). Anything
// we cannot map confidently books as "Other" and the patient's own words ride
// along in the notes, so the practice always sees WHY the patient booked and
// never sees an appointment mislabelled as a check-up.
const TREATMENT_REASONS: Record<string, string> = {
  "check-up": "Exam",
  "check-up and hygiene clean": "Exam + Scale & Polish",
  "hygiene clean": "Scale & Polish",
  "in pain or a dental problem": "Emergency",
  "continuing treatment already started": "Continuing Treatment",
  "something else": "Other",
};

/**
 * The booking page's own six options are the ONLY accepted values.
 *
 * This endpoint is public and unauthenticated, and the value ends up in the notes
 * of a real clinical record, so an unrecognised string is DROPPED rather than
 * written through. Without this a stranger could post arbitrary text straight into
 * the practice's Dentally notes. Returns the cleaned original (for the note) so the
 * staff member reads the patient's own wording, not a normalised key.
 */
function knownTreatment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.toLowerCase() in TREATMENT_REASONS ? cleaned : undefined;
}

/** Free text bound for a Dentally note: single line and length capped, because
 *  this endpoint is public and the value reaches a real clinical record. */
function safeNote(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

/* ---------------------------------------------------------------------------
 * The fields live Dentally REQUIRES to register a patient.
 *
 * Registering a brand new patient against real Dentally fails with a 422 unless
 * date_of_birth, title and payment_plan are all present, and gender is sent as a
 * BOOLEAN. Nothing below is trusted from the client: every value is re-derived or
 * re-checked here, because this endpoint is public and unauthenticated.
 * ------------------------------------------------------------------------- */

/** The only titles this practice uses, and the only ones the booking page offers. */
const TITLES = ["Mr", "Mrs", "Miss", "Ms", "Master"] as const;
type Title = (typeof TITLES)[number];

/**
 * Whitelist, exactly like knownTreatment(): the booking page's own five options
 * are the ONLY accepted values, so no arbitrary string a stranger posts can land
 * on a real patient record. Returns the canonical spelling, never the caller's.
 */
function knownTitle(value: string | undefined): Title | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim().toLowerCase();
  return TITLES.find((t) => t.toLowerCase() === cleaned);
}

/**
 * Dentally carries sex as a BOOLEAN on the patient record, true = male and
 * false = female (proven against 200 real records for this practice: Mr and
 * Master are true, Miss, Ms and Mrs are false), and it is required to register.
 *
 * DELIBERATE DECISION, not an oversight: we derive it from the chosen title
 * rather than asking. This form is the end of a public marketing funnel, and
 * putting a binary male or female question in front of someone booking a
 * check-up is off-putting and adds a step for no patient benefit. The derivation
 * happens HERE, on the server, never in the browser, so the client cannot set it.
 * It is a starting value on the record like any other detail, and the practice
 * can correct it in Dentally whenever it is wrong.
 */
function genderFromTitle(title: Title): boolean {
  return title === "Mr" || title === "Master";
}

/**
 * How the patient asked to be seen, mapped to THIS practice's own Dentally
 * payment plan ids. Whitelisted like the title: an unrecognised value is refused
 * rather than passed through.
 */
const FUNDING_PLAN_IDS: Record<string, number> = { nhs: 1, private: 2 };

function knownPaymentPlanId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return FUNDING_PLAN_IDS[value.replace(/\s+/g, " ").trim().toLowerCase()];
}

/**
 * A real calendar date as YYYY-MM-DD, the same check the onboarding register
 * route and the co-pilot's create_patient already make: an impossible date
 * (2001-13-40, 31 February) fails the UTC round trip rather than being written
 * through because it was merely regex-shaped. Anchored at both ends here, unlike
 * those two: the booking page posts a plain date input value, and this endpoint
 * is public, so a timestamp or trailing junk is refused rather than truncated.
 */
function canonicalDob(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
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

    // Live Dentally will not register a patient without these, so the booking page
    // asks for all three and every one is re-checked here. Sex is NOT among them:
    // it is derived from the title below, server side (see genderFromTitle).
    const title = knownTitle(str(body.title));
    if (!title) return bad("Please choose a title and try again.", 400);
    const dob = canonicalDob(str(body.dateOfBirth) ?? "");
    // ageFromDob returns null for a date in the future, so a future date of birth
    // is refused here along with an impossible or implausibly old one.
    const age = dob ? ageFromDob(dob, new Date()) : null;
    if (!dob || age === null || age > 120) {
      return bad("Please check your date of birth and try again.", 400);
    }
    const paymentPlanId = knownPaymentPlanId(str(body.funding));
    if (paymentPlanId === undefined) {
      return bad("Please choose how you would like to be seen and try again.", 400);
    }

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
    // What the patient said they are coming in for (the same field the hold
    // route records). Optional: a booking without one still books as an exam.
    const treatment = knownTreatment(str(body.treatment));
    // Optional: the step-1 hold this confirmation completes. Flipped to
    // 'confirmed' after a successful write so the sweep never mistakes a finished
    // booking for an abandonment. Absent for a direct (non-two-step) booking.
    const holdId = str(body.holdId);

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

    // (h) Patient resolution: an exact mobile match on one of THIS client's own
    // sites reuses the existing Dentally record (never create a duplicate);
    // otherwise register a new patient, mirroring the agent's validated
    // register_patient payload.
    //
    // The site scope is not optional. The write key can see other practices on
    // the same Dentally account (see SITES in lib/mock/clients.ts: two nearby
    // practices are deliberately unmapped), so an unscoped phone lookup could
    // match a stranger's record and file this appointment against it. Rows that
    // do not resolve to one of the client's own sites are ignored entirely.
    const ownSiteIds = new Set(getSites(client.id).map((s) => s.id));
    let patientId = "";
    let patientCreated = false;
    try {
      const found = await dentally.findPatientsByPhone(phone);
      const rows = Array.isArray(found.patients) ? found.patients : [];
      const candidates: Array<{ id: string; name: string }> = [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const p = r as Record<string, unknown>;
        const id = typeof p.id === "string" || typeof p.id === "number" ? String(p.id) : "";
        // Normalise BOTH sides: Dentally stores numbers in national format
        // ("07834...") while ours is already E.164 ("+447834..."), so a raw
        // string compare never matches and would duplicate every patient.
        const rowMobile = typeof p.mobile_phone === "string" ? toE164(p.mobile_phone) : null;
        if (!id || !rowMobile || rowMobile !== phone) continue;
        // A row with no site, or a site that is not ours, is never a match.
        const rowSite = typeof p.site_id === "string" ? siteIdFromDentally(p.site_id) : undefined;
        if (!rowSite || !ownSiteIds.has(rowSite)) continue;
        candidates.push({
          id,
          name: nameKey(
            typeof p.first_name === "string" ? p.first_name : "",
            typeof p.last_name === "string" ? p.last_name : "",
          ),
        });
      }
      // A household often shares one mobile, so prefer the record whose name the
      // patient just gave us; fall back to the first match on our own sites.
      const wanted = nameKey(firstName, lastName);
      patientId = (candidates.find((c) => c.name === wanted) ?? candidates[0])?.id ?? "";

      if (!patientId) {
        const { patient } = await dentally.createPatient({
          first_name: firstName,
          last_name: lastName,
          // Live Dentally rejects a registration missing any of these three.
          title,
          date_of_birth: dob,
          payment_plan_id: paymentPlanId,
          // A BOOLEAN, never a string: Dentally stores sex as true = male. Derived
          // from the title HERE rather than taken from the client, so the browser
          // can never set it (see genderFromTitle for why we do not ask for it).
          gender: genderFromTitle(title),
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
      // fields come from the REVALIDATED live slot, never the client's copy;
      // liveSlot.finish is one booking duration after its start, because the
      // availability reader chunks Dentally's windows (see lib/booking/slots.ts).
      //
      // The reason follows what the patient said they wanted, and their own
      // words are appended to the notes either way, so the practice can see why
      // the patient booked instead of a diary full of identical exams.
      const built = buildManualBookingPayload(
        {
          start_time: liveSlot.start,
          finish_time: liveSlot.finish,
          practitioner_id: liveSlot.practitionerId ?? "",
          reason: treatment ? TREATMENT_REASONS[treatment.toLowerCase()] ?? "Other" : "Exam",
          notes: treatment
            ? `Booked online via Smile Assessment. Patient interest: ${safeNote(treatment)}`
            : "Booked online via Smile Assessment",
        },
        patientId,
      );
      if ("error" in built) {
        // e.g. a live slot with no practitioner id: refuse rather than send an
        // invalid write. Internal detail, so the patient sees the friendly line.
        console.error(`[booking/create] refused an invalid write: ${built.error}`);
        return bad(BOOKING_FAILED, 502);
      }
      await dentally.createAppointment(built.payload);
    } catch (err) {
      // Any Dentally failure (422 included): friendly, never the error body.
      //
      // LOG IT. This branch previously swallowed the cause entirely, so a booking
      // that failed in production was invisible: the patient saw "please call the
      // practice" and nobody could tell whether Dentally was down, the payload was
      // rejected, or the patient could not be registered. Server-side only, and it
      // deliberately records which half failed, since registering a new patient and
      // writing the appointment fail for very different reasons.
      const stage = patientCreated || patientId ? "createAppointment" : "createPatient";
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const status = (err as { status?: number })?.status;
      const bodyText = (err as { body?: unknown })?.body;
      console.error(
        `[booking/create] ${stage} failed for site ${siteId}` +
          (status ? ` (HTTP ${status})` : "") +
          `: ${detail}` +
          (bodyText ? ` | ${typeof bodyText === "string" ? bodyText.slice(0, 500) : JSON.stringify(bodyText).slice(0, 500)}` : ""),
      );
      return bad(BOOKING_FAILED, 502);
    }

    // (j) The booking is made. Flip the step-1 hold to 'confirmed' so the
    // abandoned-hold sweep never turns this finished booking into a win-back lead.
    // Best-effort and scoped to this site: a completed appointment must never fail
    // because its hold row could not be stamped (worst case the hold expires and
    // the dedupe on the sweep catches the already-booked patient).
    if (holdId) {
      try {
        await markHoldConfirmed(holdId, siteId);
      } catch {
        // Swallow: the appointment already exists in Dentally.
      }
    }

    // (k) Done.
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
