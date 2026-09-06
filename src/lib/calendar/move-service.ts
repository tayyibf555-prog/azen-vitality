// ===========================================================================
// MOVING AN APPOINTMENT IN DENTALLY.
//
// The guarded body of PATCH /api/calendar/appointment/[id]. It lives here rather
// than in the route file so it can be driven directly by a test, because the
// ordering below IS the safety property and an ordering nobody can test is an
// ordering that drifts.
//
// NOTHING THE CLIENT CLAIMS IS TRUSTED. The appointment is re-read from Dentally,
// the site is re-checked, the practitioner is re-checked against the site's own
// list, the span is re-derived, availability and breaks are re-fetched, and all
// six drop checks are re-run through the SAME pure validator the grid uses. The
// payload is then built fresh field by field; the request body is never
// forwarded.
//
// AN APPOINTMENT AGAINST THE WRONG CLINICIAN OR THE WRONG TIME IS A
// PATIENT-SAFETY EVENT. Every branch below prefers refusing to guessing.
//
// NOTE, and it must not be dressed up: appointment UPDATE has never been proven
// against live Dentally. createAppointment has; PUT /v1/appointments/:id has not.
// The read-back confirmation exists precisely because a resolved promise from
// updateAppointment proves nothing: the client SYNTHESISES { appointment: { id } }
// on a 204 or an empty body, echoing back the id it was given.
//
// This file deliberately carries NO `import "server-only"`: that specifier does
// not resolve under vitest, and the route test drives the real handler.
// ===========================================================================

import { DentallyError, type DentallyClient } from "@/lib/dentally/client";
import { dentallyAgentClient } from "@/lib/dentally/write";
import { dentallyWrite, precheckDentallyWrite } from "@/lib/dentally/write-gate";
import { authEnforced, requireClientAccess, requireSiteAccess, requireUser } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { dentallySiteId, getSite } from "@/lib/mock/clients";
import { isPatientAdminRole } from "@/lib/patient/roles";
import { isSystemEnabledStrict } from "@/lib/systems/repository";
import { invalidateAppointmentsCache, listSitePractitionersSafe, listDiaryAvailabilitySafe } from "@/lib/dentally/read";
import { recordUsage } from "@/lib/telemetry";
import { londonDayKey } from "@/lib/time/london";
import { openingWindowFor } from "@/components/client/calendar/diary-view";
import { dayBounds } from "@/components/client/calendar/diary-grid";
import {
  londonWallMinutes,
  parseAvailabilityWindows,
  UNTAGGED_FAIL_RATIO,
  windowsFor,
} from "./availability";
import { occupyingEntries } from "./entries";
import { listEntries, insertMove, insertTouch, enqueueOutbox, type MoveOutcome } from "./repository";
import { normaliseDurationMin, validateMove, type MoveProposal } from "./move-validate";
import { availabilityTrustedHere, readSharedPractitionerIds } from "./site-presence";
// occupiesTime, NOT a fourth hand-written copy of "cancelled or did_not_attend".
// The refusal this file computes and the paint the diary draws have to agree
// about which states consume a clinician's time -- a slot the screen shows as
// recoverable and the validator treats as occupied is a receptionist told "no"
// about a slot they can see is free -- so both read the one predicate.
import { columnWorkState, occupiesTime as occupies, workingSpans, type Span } from "./working-spans";
import { clampToSendWindow, willNotifyPatient } from "./notify";
import { draftMoveText } from "./draft";

/** The standardised 503 every gated write path in this codebase gives, word for word. */
const WRITE_GATE_OFF =
  "Booking into Dentally is not switched on yet. Ask your administrator to enable it.";

/**
 * WHAT THE DESK SAYS WHEN THE DIARY SWITCH IS OFF — the DESK's own sentence.
 *
 * This used to be `SYSTEM_BY_SLUG.get("calendar-writes")?.halts`, and reusing the
 * catalog row read well until the catalog row grew a second clause. `halts` is
 * written for the OWNER standing at System controls, deciding whether one flip is
 * enough, so ruling W3/9 required it to name every door the switch closes — it
 * now ends "— and the co-pilot cannot book, move or cancel one either", which is
 * true, necessary there, and a non-sequitur to a receptionist who has just
 * dragged an appointment across the grid. Two audiences, two sentences.
 *
 * They are not allowed to drift into disagreement, and they cannot: this one is
 * the desk half of that same sentence, and move-service-switch-copy.test.ts
 * drives a real switched-off move and holds both properties at once — the desk's
 * body says what the desk can no longer do, and it does NOT relay the co-pilot
 * clause. The catalog's own sentence stays pinned against the write registry by
 * catalog.test.ts, so the owner's half cannot quietly lose the co-pilot either.
 *
 * The old hard-coded fallback literal is gone with the lookup that needed it: a
 * literal that only ever appeared when the catalog lost its row was, by
 * construction, the one string nobody would notice going stale.
 */
const DIARY_SWITCH_OFF_MESSAGE =
  "Appointments can no longer be moved, reassigned or resized from the diary. The practice owner can switch diary moves back on in System controls.";

/**
 * A move that has been read back and confirmed, or one of three honest failures.
 *
 *   not_saved  the read-back shows the OLD values. The write did not land.
 *   unknown    we could not find out. It does NOT roll back and does NOT commit,
 *              because snapping back would assert something we do not know.
 */
export type MoveReason = "not_saved" | "unknown";

interface AgentAppointment {
  id: string;
  patientId: string;
  patientName: string;
  rawSiteId: string;
  startIso: string;
  finishIso: string;
  practitionerId: string | null;
  state: string;
  reason: string | null;
  durationMin: number;
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// The request.
// ---------------------------------------------------------------------------

export interface MoveBody {
  siteId: string;
  day: string;
  startTime: string;
  finishTime: string;
  practitionerId: string | null;
  expected: { startTime: string; finishTime: string; practitionerId: string | null };
  notifyPatient: boolean;
  undoOf?: string | null;
}

export type ParsedBody = { ok: true; value: MoveBody } | { ok: false; error: string };

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO instant carrying an EXPLICIT zone: a trailing Z, or +HH:MM / -HH:MM.
 *
 * Date.parse alone is not enough. It happily accepts zone-less forms
 * ("2026-08-03T14:30", "2026-08-03 14:30:00") and resolves them in the SERVER's
 * local zone, which on Vercel is UTC and in the practice is London. A request
 * that means 14:30 London would then be validated against one instant and, on
 * any path that echoes the string onward, stored as another. Every time this
 * route accepts must name its own offset.
 */
const ZONED_INSTANT_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isZonedInstant(value: string): boolean {
  if (!ZONED_INSTANT_RE.test(value.trim())) return false;
  return !Number.isNaN(Date.parse(value));
}

export function parseMoveBody(raw: unknown): ParsedBody {
  const b = asRecord(raw);
  const siteId = typeof b.siteId === "string" ? b.siteId.trim() : "";
  if (siteId === "") return { ok: false, error: "siteId is required" };

  const day = typeof b.day === "string" ? b.day.trim() : "";
  if (!DAY_KEY_RE.test(day)) return { ok: false, error: "day must be YYYY-MM-DD" };

  const startTime = typeof b.startTime === "string" ? b.startTime : "";
  const finishTime = typeof b.finishTime === "string" ? b.finishTime : "";
  if (!isZonedInstant(startTime)) return { ok: false, error: "startTime is not a readable time" };
  if (!isZonedInstant(finishTime)) return { ok: false, error: "finishTime is not a readable time" };

  // An appointment cannot be moved to Unassigned: it is not a person and has no
  // availability, so nothing about the move could be checked.
  const practitionerId = str(b.practitionerId);
  if (practitionerId === null) {
    return { ok: false, error: "An appointment cannot be moved to Unassigned. Choose a clinician." };
  }

  const expectedRaw = asRecord(b.expected);
  const expStart = typeof expectedRaw.startTime === "string" ? expectedRaw.startTime : "";
  const expFinish = typeof expectedRaw.finishTime === "string" ? expectedRaw.finishTime : "";
  if (!isZonedInstant(expStart)) return { ok: false, error: "expected.startTime is required" };
  if (!isZonedInstant(expFinish)) return { ok: false, error: "expected.finishTime is required" };

  return {
    ok: true,
    value: {
      siteId,
      day,
      startTime,
      finishTime,
      practitionerId,
      expected: {
        startTime: expStart,
        finishTime: expFinish,
        practitionerId: str(expectedRaw.practitionerId),
      },
      notifyPatient: b.notifyPatient === true,
      undoOf: str(b.undoOf),
    },
  };
}

// ---------------------------------------------------------------------------
// EVERY Dentally read on this path goes through the WRITE client, so the write
// and everything it is checked against come from the same instance, and the 60
// second read cache is bypassed entirely. write.ts takes its own
// DENTALLY_WRITE_BASE_URL so writes can be pointed at a sandbox, and a guard
// answered by a different instance than the one being written to is not a guard.
// ---------------------------------------------------------------------------

function toAgentAppointment(raw: unknown): AgentAppointment | null {
  const r = asRecord(raw);
  const id = str(r.id);
  const startIso = str(r.start_time);
  if (id === null || startIso === null) return null;
  const durationRaw = typeof r.duration === "number" ? r.duration : Number(r.duration);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : 30;
  const finishIso = str(r.finish_time) ?? new Date(Date.parse(startIso) + duration * 60_000).toISOString();
  return {
    id,
    patientId: str(r.patient_id) ?? "",
    patientName: str(r.patient_name) ?? "",
    rawSiteId: str(r.site_id) ?? "",
    startIso,
    finishIso,
    practitionerId: str(r.practitioner_id),
    state: String(r.state ?? ""),
    reason: str(r.reason),
    durationMin: duration,
  };
}

/** One London day of one site's appointments, cancelled rows included, read fresh. */
async function readDay(
  client: DentallyClient,
  siteUuid: string,
  dayKey: string,
): Promise<AgentAppointment[]> {
  const out: AgentAppointment[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await client.listAppointments({
      siteId: siteUuid,
      fromDate: dayKey,
      toDate: dayKey,
      page,
      perPage: 100,
    });
    const rows = Array.isArray(res.appointments) ? res.appointments : [];
    for (const raw of rows) {
      const a = toAgentAppointment(raw);
      if (a) out.push(a);
    }
    if (rows.length < 100) break;
  }
  return out;
}

/**
 * Is this row really at the site the caller named?
 *
 * The ONLY thing stopping a caller holding site A from moving a site B
 * appointment by pairing their own site id with a foreign appointment id. Both
 * forms are accepted because live Dentally answers with its site UUID while the
 * mock answers with our internal id, and a row with NO site at all is REFUSED:
 * an absent site is not proof of anything.
 */
function sameSite(row: AgentAppointment, siteId: string, siteUuid: string): boolean {
  if (row.rawSiteId === "") return false;
  return row.rawSiteId === siteUuid || row.rawSiteId === siteId;
}

/** Two instants are the same moment, however each is written. Never a string compare. */
function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return x === y;
}

/**
 * Minutes past London midnight, on the clock face.
 *
 * Through londonWallMinutes, never a slice of the ISO string: the mock emits Z
 * and live Dentally emits +01:00, and a string slice passes locally and is an
 * hour wrong in the practice through British Summer Time.
 */
function londonMinutesOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : londonWallMinutes(ms);
}

function spanOf(a: AgentAppointment): Span & { appointmentId: string } {
  const startMin = londonMinutesOf(a.startIso);
  const endMin = startMin + Math.max(1, Math.round((Date.parse(a.finishIso) - Date.parse(a.startIso)) / 60_000));
  return { startMin, endMin, appointmentId: a.id };
}

// ---------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------

export async function performMove(appointmentId: string, rawBody: unknown): Promise<Response> {
  if (appointmentId.trim() === "") return json({ ok: false, error: "not found" }, 404);

  const parsed = parseMoveBody(rawBody);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const body = parsed.value;

  // --- 1. a verified session ------------------------------------------------
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  // --- 2. FAIL CLOSED WHEN AUTH IS NOT ENFORCED -----------------------------
  //
  // requireUser returns null (a no-op, NOT a 401) whenever SUPABASE_SERVICE_ROLE_KEY
  // is unset, and every downstream guard is then also a no-op. That permissive
  // default is deliberate elsewhere so the pilot demo keeps working, and it is
  // unacceptable here: this route rewrites a patient's appointment time. THIS
  // ROUTE DEPARTS FROM THE PLATFORM DEFAULT ON PURPOSE.
  if (!authEnforced()) {
    return json(
      {
        ok: false,
        error:
          "Appointment moves are unavailable because sign-in is not configured on this environment.",
      },
      503,
    );
  }
  const user = auth as AuthedUser | null;

  // --- 3. role --------------------------------------------------------------
  //
  // PATIENT_ADMIN_ROLES, never requireOwnerRole. client_coordinator IS how the
  // practice manager is represented here, and she is the diary's primary user.
  if (!isPatientAdminRole(user?.role)) return json({ ok: false, error: "forbidden" }, 403);

  // --- 3b. the PERSON, not just the role ------------------------------------
  //
  // The role check above says "a practice manager may move appointments". This
  // says "this practice manager may". They compose and neither replaces the
  // other: the role is the default, the capability is the practice's decision
  // about one named individual, and an owner who has revoked it here means it.
  //
  // Placed AFTER the role check so a caller who was never going to be allowed
  // learns nothing about which capabilities exist, and BEFORE the site, the kill
  // switch and the write gate so no work is done for a caller who cannot act.
  const capabilityDenied = await requireCapability(user, "diary.appointment.move");
  if (capabilityDenied) return capabilityDenied;

  // --- 4. site and client ---------------------------------------------------
  const site = getSite(body.siteId);
  if (!site) return json({ ok: false, error: "unknown site" }, 400);
  const clientDenied = requireClientAccess(user, site.clientId);
  if (clientDenied) return clientDenied;
  const siteDenied = requireSiteAccess(user, body.siteId);
  if (siteDenied) return siteDenied;

  // --- 5. the owner's kill switch -------------------------------------------
  //
  // isSystemEnabledStrict, NOT isSystemEnabledForSend. The "ForSend" variant
  // fails OPEN whenever MESSAGING_DRY_RUN is true, which ties the fail direction
  // of a DENTALLY WRITE gate to a messaging flag it has nothing to do with: under
  // the staged configuration the owner runs (real writes, simulated texts) a
  // toggle-read blip would re-arm a switch that had just been turned off, and the
  // move would land in a real diary. A switch we cannot read is treated as off.
  if (!(await isSystemEnabledStrict(site.clientId, "calendar-writes"))) {
    return json({ ok: false, error: DIARY_SWITCH_OFF_MESSAGE }, 503);
  }

  // --- 6. THE WRITE GATE, BEFORE ANY CLIENT IS CONSTRUCTED ------------------
  //
  // This ordering is not stylistic. dentallyAgentClient() FAILS OPEN: with the
  // gate shut it hands back a perfectly working client pointed at whatever
  // DENTALLY_BASE_URL says, which in the pilot is the mock. Constructing it first
  // and checking afterwards is how a "disabled" write path quietly writes.
  //
  // ASKED THROUGH THE GATE, so a move attempted while write-back is off is
  // recorded rather than vanishing into a 503. Everything about the ordering is
  // unchanged: still before any client is constructed, still before the day is
  // read, and the message the diary shows is the same one.
  //
  // WHY THE SOURCE IS `diary` FOR EVERY CALLER, THE CO-PILOT INCLUDED, here and
  // at the write below. Since ruling W3/1 the co-pilot's `diary_write` move
  // drives THIS function instead of making its own gate call, so the ledger row
  // it produces is filed as a diary move -- which is what it was, and what the
  // registry says happens (see the `copilot` entry in
  // src/lib/dentally/write-vocabulary.ts). The door it came through is not lost:
  // the ctx carries the asking user's opaque id, the diary's own move audit row
  // names the person (actor_email), and the co-pilot files its own
  // `copilot_action` row for the same turn. Handoff H33 asked for an optional
  // per-call `source` override so Sync Status could show a co-pilot move apart
  // from a desk drag; that is a product question about what the ledger CLAIMS,
  // so it went up for a ruling rather than being guessed at.
  //
  // RULED, and this is now settled rather than provisional: W3/28 — "a co-pilot-
  // driven diary move is filed under source `diary` (what was done), actor = the
  // user id (who did it). No source override on performMove." So the literal
  // below is the answer, not a placeholder, and anybody adding an override is
  // reopening a decision rather than filling a gap. Nothing about safety turned
  // on it either way: `diary` and `copilot` resolve the SAME `calendar-writes`
  // switch for appointment.update, which write-gate.test.ts pins.
  const writeRefused = await precheckDentallyWrite({
    ctx: { source: "diary", siteId: body.siteId, clientId: site.clientId, actor: user?.id ?? null },
    kind: "appointment.update",
    appointmentId,
  });
  if (writeRefused) return json({ ok: false, error: WRITE_GATE_OFF }, 503);

  const siteUuid = dentallySiteId(body.siteId);
  const client = dentallyAgentClient();

  const actor = {
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    actorRole: user?.role ?? null,
  };

  const refuse = async (
    status: number,
    error: string,
    detail: {
      patientId?: string | null;
      fromStartAt?: string | null;
      fromFinishAt?: string | null;
      fromPractitionerId?: string | null;
    } = {},
  ): Promise<Response> => {
    // A REFUSED attempt is recorded too. A rejected move that leaves no trace is
    // a move nobody can later explain, and "why did that not save" is exactly the
    // question a practice manager asks a week later.
    await insertMove({
      clientId: site.clientId,
      siteId: body.siteId,
      appointmentId,
      patientId: detail.patientId ?? null,
      fromStartAt: detail.fromStartAt ?? null,
      fromFinishAt: detail.fromFinishAt ?? null,
      fromPractitionerId: detail.fromPractitionerId ?? null,
      toStartAt: body.startTime,
      toFinishAt: body.finishTime,
      toPractitionerId: body.practitionerId,
      ...actor,
      outcome: "refused" as MoveOutcome,
      detail: error,
      notifyIntent: body.notifyPatient,
      undoOf: body.undoOf ?? null,
    });
    return json({ ok: false, error }, status);
  };

  // --- 7. re-read the appointment -------------------------------------------
  //
  // Through the SAME client the write will use, so the check and the write can
  // never disagree about which Dentally instance they are talking to, and the
  // 60s read cache is bypassed entirely.
  const expectedDay = londonDayKey(new Date(Date.parse(body.expected.startTime)));
  let currentDayRows: AgentAppointment[];
  try {
    currentDayRows = await readDay(client, siteUuid, expectedDay);
  } catch (err) {
    console.error(`[diary] could not re-read appointment ${appointmentId} before moving it`, err);
    return refuse(
      503,
      "We could not re-read this appointment from Dentally, so it has not been moved. Try again shortly.",
    );
  }

  const current = currentDayRows.find((a) => a.id === appointmentId);
  // A 404 that reveals nothing: the caller learns neither whether the id exists
  // nor whether it belongs to another practice.
  if (!current || !sameSite(current, body.siteId, siteUuid)) {
    return refuse(404, "not found");
  }

  const from = {
    patientId: current.patientId,
    fromStartAt: current.startIso,
    fromFinishAt: current.finishIso,
    fromPractitionerId: current.practitionerId,
  };

  // --- 8. the appointment's own state ---------------------------------------
  //
  // A CANCELLED or DID-NOT-ATTEND booking is not a booking. Nothing else in this
  // chain looked at `state`: occupies() uses it only to decide whether a row
  // consumes a clinician's time, and validateMove takes no state input at all, so
  // a cancelled block could be dragged like a live one, written through, and then
  // TEXT THE PATIENT that "your appointment has been moved to" a new time for an
  // appointment they themselves cancelled. Refused outright rather than merely
  // suppressing the text: moving a row that represents nothing has no legitimate
  // meaning, and re-booking a cancelled patient is a new appointment, not a drag.
  if (!occupies(current.state)) {
    return refuse(
      409,
      current.state === "cancelled"
        ? "This appointment is cancelled, so it cannot be moved. Book a new appointment instead."
        : "This appointment is marked as did not attend, so it cannot be moved. Book a new appointment instead.",
      from,
    );
  }

  // --- 9. concurrency -------------------------------------------------------
  if (
    !sameInstant(current.startIso, body.expected.startTime) ||
    !sameInstant(current.finishIso, body.expected.finishTime) ||
    (current.practitionerId ?? null) !== (body.expected.practitionerId ?? null)
  ) {
    return refuse(
      409,
      "This appointment changed while you were moving it. Reload the diary and try again.",
      from,
    );
  }

  // --- 10. the target practitioner really belongs to this site --------------
  //
  // Through the WRITE client, so the guard and the write it guards describe the
  // same Dentally instance: write.ts takes its own DENTALLY_WRITE_BASE_URL, and a
  // practitioner who is site A in the read instance and site B in the write
  // instance would otherwise sail through. Passing a client also bypasses the 60
  // second read cache, so this decision is never a minute old.
  //
  // The FIRST of two cross-site guards. This one stops a caller holding site A
  // hanging a patient on a site B clinician's column. It does NOT establish that
  // the clinician is at this site TODAY: that is guard 12.
  const practitionersRead = await listSitePractitionersSafe(body.siteId, { client });
  if (practitionersRead.failed) {
    return refuse(
      503,
      "We could not check the clinician list for this site. The appointment has not been moved.",
      from,
    );
  }
  const target = practitionersRead.practitioners.find((p) => p.id === body.practitionerId);
  if (!target) return refuse(404, "not found", from);

  // --- 11. re-derive the span ----------------------------------------------
  //
  // startIso is the SERVER'S OWN rendering of the instant, and it is what gets
  // written, drafted into the patient's text and compared on the read-back. The
  // request's string is never carried forward: only the instant it named is.
  const startMs = Date.parse(body.startTime);
  const startIso = new Date(startMs).toISOString();
  const derivedDuration = normaliseDurationMin((Date.parse(body.finishTime) - startMs) / 60_000);
  if (derivedDuration === null) {
    return refuse(
      400,
      "That appointment length is not one Dentally will accept. It must be 5 to 480 minutes, on a five minute mark.",
      from,
    );
  }
  const finishIso = new Date(startMs + derivedDuration * 60_000).toISOString();
  // The client's own finishTime is a CROSS CHECK and nothing more. A mismatch
  // means the two ends disagree about the booking's length, and a booking whose
  // length is in dispute is not one to write.
  if (!sameInstant(finishIso, body.finishTime)) {
    return refuse(400, "The start and end times do not agree. Nothing has been changed.", from);
  }
  const targetDay = londonDayKey(new Date(startMs));
  if (targetDay !== body.day) {
    return refuse(400, "The date and the time do not agree. Nothing has been changed.", from);
  }

  // --- 12. re-fetch availability and breaks, and re-run every drop check ----
  const targetDayRows =
    targetDay === expectedDay ? currentDayRows : await readDay(client, siteUuid, targetDay).catch(() => null);
  if (targetDayRows === null) {
    return refuse(
      503,
      "We could not read that day's diary, so the appointment has not been moved. Try again shortly.",
      from,
    );
  }

  const [availability, entries, sharedRead] = await Promise.all([
    listDiaryAvailabilitySafe(
      {
        siteId: body.siteId,
        practitionerIds: [target.id],
        fromDayKey: targetDay,
        toDayKey: targetDay,
      },
      { client },
    ),
    listEntries(body.siteId, [targetDay]),
    // The SECOND cross-site guard, and the one that matters on the day. See
    // site-presence.ts: availability carries no site at all, so a clinician who
    // is on more than one of this client's lists can only be placed HERE by a
    // site-scoped booking. Without one, the windows this move would be checked
    // against may describe another practice entirely.
    readSharedPractitionerIds(site.clientId, body.siteId, { client }).catch(() => null),
  ]);

  if (availability.failed) {
    // During an availability outage the diary is READ ONLY. That is the correct
    // direction for a patient-safety write: an unverifiable move is refused,
    // never guessed.
    return refuse(
      503,
      "We could not check the clinician's working hours. The appointment has not been moved.",
      from,
    );
  }
  // THE SAME REFUSAL THE CLIENT MAKES, enforced independently here. A day that
  // has ended cannot be asked about at all (Dentally requires a future window),
  // so there are no hours to check the drop against. Checking it against the
  // day's bookings alone would accept a patient into a gap on a day nobody can
  // verify. 409 rather than 503: this is a rule, not an outage, and retrying
  // cannot change it.
  if (availability.unanswerableDayKeys.includes(targetDay)) {
    return refuse(
      409,
      "Dentally cannot report working hours for a date that has already passed, so the appointment has not been moved.",
      from,
    );
  }

  const parsedWindows = parseAvailabilityWindows(availability.rows);
  if (parsedWindows.total > 0 && parsedWindows.untagged / parsedWindows.total > UNTAGGED_FAIL_RATIO) {
    return refuse(
      503,
      "We could not check the clinician's working hours. The appointment has not been moved.",
      from,
    );
  }
  if (entries.failed) {
    // A drop cannot be validated against breaks we could not read, and dropping a
    // patient onto somebody's lunch is exactly the class of error this exists to
    // prevent.
    return refuse(
      503,
      "We could not read this site's breaks and notes. The appointment has not been moved.",
      from,
    );
  }

  if (sharedRead === null) {
    return refuse(
      503,
      "We could not check which practice this clinician is at. The appointment has not been moved.",
      from,
    );
  }

  const windows = windowsFor(parsedWindows.windows, target.id, targetDay);
  const ownRows = targetDayRows.filter((a) => a.practitionerId === target.id);
  // OCCUPYING rows only, for BOTH the union and the clash check. A cancelled row
  // is excluded from occupancy, so including it in the working union was the one
  // way white could appear with nothing positive behind it: a single cancelled
  // Saturday booking manufactured an hour the clinician was not there for, and
  // the validator then let a patient be dropped into it.
  const occupyingRows = ownRows.filter((a) => occupies(a.state));
  const apptSpans = occupyingRows.map(spanOf);
  const occupiedSpans = apptSpans;
  const breakSpans = occupyingEntries(entries.entries, target.id).map((e) => ({
    startMin: e.startMin,
    endMin: e.endMin,
  }));

  // The moving appointment itself is NOT corroboration when it is being handed to
  // a different clinician: `occupyingRows` is the target's own book at this site
  // on this day, and the row being moved is only in it when the clinician is
  // unchanged, which is exactly when they are demonstrably here anyway.
  const presenceConfirmed = availabilityTrustedHere({
    sharedWithAnotherSite: sharedRead.shared.has(target.id),
    rosterUnknown: sharedRead.rosterUnknown,
    bookedHere: occupyingRows.length > 0,
  });

  const { openMin, closeMin } = openingWindowFor(site.openingHours, targetDay);
  const bounds = dayBounds(targetDayRows.map(spanOf), openMin, closeMin);

  const startMin = londonMinutesOf(startIso);
  const proposal: MoveProposal = {
    appointmentId,
    startMin,
    endMin: startMin + derivedDuration,
    practitionerId: target.id,
    dayKey: targetDay,
  };

  const check = validateMove(proposal, {
    targetPractitionerId: target.id,
    targetPractitionerName: target.name,
    workState: columnWorkState({
      availabilityFailed: false,
      appointmentsFailed: false,
      windows: presenceConfirmed ? windows : [],
      apptSpans,
      presenceConfirmed,
      // THE SAME INPUT THE GRID PAINTS FROM. Today's earlier hours are missing
      // from the answer because nobody could ask for them, so an empty answer
      // must not read as "off" here either: the write path and the paint have to
      // agree, or a column the reader was told is unknowable silently accepts a
      // drop -- or refuses one with the wrong sentence.
      answerableFromMin: availability.answerableFromMin[targetDay] ?? 0,
    }),
    workingSpans: presenceConfirmed ? workingSpans(windows, apptSpans) : [],
    occupiedSpans,
    breakSpans,
    bounds,
    movingAppointmentId: appointmentId,
    // THE CONTINUING-TREATMENT RULE, re-run server side against the row the
    // server re-read for itself. `current` is that row, so the reason and the
    // holding clinician are Dentally's, never the client's claim: a caller who
    // stripped `reason` from their request could otherwise turn a root canal
    // into an untyped appointment and hand it to another dentist.
    //
    // The name is taken from the site's own practitioner list where it is there,
    // and falls back to the row's own string for a clinician who has since left
    // that list — an appointment can outlive a practitioner record, and a
    // refusal that cannot name anybody is a refusal nobody can act on.
    movingReason: current.reason,
    sourcePractitionerId: current.practitionerId,
    sourcePractitionerName:
      practitionersRead.practitioners.find((p) => p.id === current.practitionerId)?.name ?? null,
  });
  if (!check.ok) return refuse(409, check.message, from);

  // --- 13. the write --------------------------------------------------------
  //
  // The payload is built FRESH, field by field, and EVERY VALUE IS THE SERVER'S
  // OWN. The request body is never forwarded, not even the start time: a caller
  // could otherwise smuggle a state change, another patient's id or an arbitrary
  // Dentally field into an "innocent" reschedule, and a zone-less start string
  // echoed onward would be resolved by Rails in the account's zone while
  // finish_time went out as UTC, writing a mangled span the read-back then
  // reports as "unchanged". startIso is the instant this route validated.
  //
  // start_time ALONE is forbidden: it leaves the old finish_time behind, so a
  // 30 minute booking dragged an hour later silently becomes 90 minutes.
  // `duration` is NEVER sent: there is no evidence Dentally accepts it on a write.
  const payload = {
    start_time: startIso,
    finish_time: finishIso,
    practitioner_id: target.id,
  };

  let writeThrew: unknown = null;
  try {
    await dentallyWrite.updateAppointment(
      {
        source: "diary",
        siteId: body.siteId,
        clientId: site.clientId,
        // The OPAQUE id only: the diary's own move audit names the person
        // (actorEmail above); the Dentally sync ledger holds no personal data.
        actor: actor.actorId,
        patientId: current.patientId,
        // The SAME client every read in this move used, so the write and the
        // read-back below cannot be talking to two different Dentally instances.
        client,
      },
      appointmentId,
      payload,
    );
  } catch (err) {
    // A DentallyError with status 0 is the 15 second timeout, and the write MAY
    // still have landed. Every other throw could equally have landed after the
    // socket died. Either way the answer comes from the READ BACK, never from the
    // throw: reporting a failure we have not verified is how a saved move gets
    // "corrected" by a second, wrong one.
    writeThrew = err;
    if (err instanceof DentallyError && err.status >= 400 && err.status < 500) {
      // A 4xx is Dentally refusing the payload outright. Nothing landed.
      console.error(`[diary] Dentally refused the move of ${appointmentId}`, err);
    }
  }

  // --- 14. read back, and answer from the read ------------------------------
  let confirmed = false;
  let readBackFailed = false;
  let after: AgentAppointment | null = null;
  try {
    const rows = await readDay(client, siteUuid, targetDay);
    after = rows.find((a) => a.id === appointmentId) ?? null;
    if (!after) {
      // The row is not where it should now be. It may have moved to another day,
      // it may not have moved at all. Either way this is not a confirmation.
      const back = await readDay(client, siteUuid, expectedDay);
      after = back.find((a) => a.id === appointmentId) ?? null;
    }
    if (!after) readBackFailed = true;
  } catch (err) {
    console.error(`[diary] could not read back the move of ${appointmentId}`, err);
    readBackFailed = true;
  }

  if (after) {
    confirmed =
      sameInstant(after.startIso, startIso) &&
      sameInstant(after.finishIso, finishIso) &&
      (after.practitionerId ?? null) === target.id;
  }

  let outcome: MoveOutcome;
  let reason: MoveReason | null = null;
  if (confirmed) {
    outcome = "saved";
  } else if (readBackFailed) {
    outcome = "unknown";
    reason = "unknown";
  } else if (writeThrew !== null) {
    // We read the row back and it still holds the old values, and the write threw:
    // this is the one case we can say plainly did not save.
    outcome = "not_saved";
    reason = "not_saved";
  } else {
    outcome = "not_saved";
    reason = "not_saved";
  }

  // --- 15. the cache, the audit, the telemetry ------------------------------
  //
  // THE CACHE MUST GO FIRST. listAppointmentsSafe caches a successful window for
  // 60 seconds, so a refresh straight after a confirmed move would repaint the OLD
  // time, and to the person who just moved it that reads as a silent revert: the
  // exact failure the read-back exists to prevent, produced by the cache that
  // makes the page fast. AWAITED, because the cache is now cross-instance: the L2
  // row must be gone before the board is allowed to refresh, or another instance
  // serves the stale time back.
  if (confirmed) await invalidateAppointmentsCache([body.siteId]);

  // --- 16. the patient's text ----------------------------------------------
  //
  // ONLY on a confirmed write. A move that did not save never texts: a patient
  // told to come at 14:30 for an appointment still sitting at 09:30 is worse than
  // one told nothing at all.
  const timeChanged = willNotifyPatient({ startIso: current.startIso }, { startIso });
  let touchId: string | null = null;
  let notify: { queued: boolean; reason: string | null } = { queued: false, reason: null };

  if (!confirmed) {
    notify = { queued: false, reason: "not_saved" };
  } else if (!body.notifyPatient) {
    notify = { queued: false, reason: "not_requested" };
  } else if (!timeChanged) {
    notify = { queued: false, reason: "time_unchanged" };
  } else {
    const drafted = draftMoveText({
      firstName: current.patientName.trim().split(/\s+/)[0] ?? "",
      siteName: site.name,
      // null until the owner supplies real numbers. A GUESSED phone number in a
      // patient text is not acceptable, so draftMoveText refuses rather than
      // rendering a placeholder.
      sitePhone: site.publicPhone ?? null,
      // The instant that was WRITTEN, never the request's own string. A text must
      // not be able to quote a time Dentally does not hold.
      newStartIso: startIso,
    });
    if (!drafted.ok) {
      notify = { queued: false, reason: drafted.reason };
    } else if (current.patientId === "") {
      notify = { queued: false, reason: "no_patient" };
    } else {
      try {
        // The shared drain does the sending and applies EVERY guard it already
        // has: the owner kill switch, opt-out and suppression against both the
        // patient ref and the resolved address, the output guardrail, the
        // frequency cap, the atomic claim and MESSAGING_DRY_RUN. No new path to a
        // provider is opened here, and no guard is skipped because this send was
        // started by a person.
        const touch = await insertTouch({
          moveId: null,
          siteId: body.siteId,
          channel: "sms",
          body: drafted.body,
        });
        touchId = touch.id;
        await enqueueOutbox({
          touchId: touch.id,
          siteId: body.siteId,
          channel: "sms",
          toRef: `patient:${current.patientId}`,
          body: drafted.body,
          // The diary's own quiet hours, which exist nowhere else in this
          // codebase: clamped into 08:00 to 20:00 Europe/London.
          notBeforeAt: new Date(clampToSendWindow(Date.now())).toISOString(),
        });
        notify = { queued: true, reason: null };
      } catch (err) {
        // A queue failure must NOT turn a move that DID save into a reported
        // failure. The move is the fact; the text is a consequence of it.
        console.error(`[diary] could not queue the reschedule text for ${appointmentId}`, err);
        notify = { queued: false, reason: "queue_failed" };
      }
    }
  }

  const moveId = await insertMove({
    clientId: site.clientId,
    siteId: body.siteId,
    appointmentId,
    patientId: current.patientId || null,
    fromStartAt: current.startIso,
    fromFinishAt: current.finishIso,
    fromPractitionerId: current.practitionerId,
    toStartAt: startIso,
    toFinishAt: finishIso,
    toPractitionerId: target.id,
    ...actor,
    outcome,
    detail: reason,
    notifyIntent: body.notifyPatient,
    touchId,
    undoOf: body.undoOf ?? null,
  });

  void recordUsage("calendar", "appointment_move", {
    clientId: site.clientId,
    userEmail: user?.email,
    role: user?.role,
  });

  if (confirmed) {
    return json(
      {
        ok: true,
        confirmed: true,
        moveId,
        notify,
        appointment: {
          id: appointmentId,
          startTime: startIso,
          finishTime: finishIso,
          practitionerId: target.id,
          practitionerName: target.name,
          day: targetDay,
        },
      },
      200,
    );
  }

  return json(
    {
      ok: false,
      confirmed: false,
      reason,
      moveId,
      error:
        reason === "unknown"
          ? "The move may or may not have saved. Open this appointment in Dentally and check before telling the patient."
          : "That move did not save. The appointment is unchanged.",
    },
    200,
  );
}
