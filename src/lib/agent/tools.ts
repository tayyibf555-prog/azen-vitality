import type Anthropic from "@anthropic-ai/sdk";
import type { DentallyClient } from "@/lib/dentally/client";
import { findTreatment } from "@/lib/treatments/catalog";
import { getSite, getClient, dentallySiteId } from "@/lib/mock/clients";
import {
  fetchAvailabilityDays,
  findExactSlot,
  chunkWindowIntoSlots,
  ceilToSlotGrid,
  BOOKING_SLOT_DURATION_MIN,
  type BookingDay,
  type BookingSlot,
} from "@/lib/booking/slots";
import { londonDayKey } from "@/lib/time/london";
import { isDentallyWriteEnabled } from "@/lib/dentally/write";
// The ONE live-calibrated derivation of a new Dentally patient, shared with the
// booking funnel, the owner co-pilot and the onboarding worklist. See patient-payload.ts.
import {
  knownTitle,
  canonicalDob,
  buildPatientRegistration,
  configuredDefaultPaymentPlanId,
} from "@/lib/dentally/patient-payload";
import type { AgentContext } from "./types";

// Real Dentally requires the appointment `reason` to be one of a fixed set (calibrated
// against developer.dentally.co): Exam, Scale & Polish, Exam + Scale & Polish,
// Continuing Treatment, Emergency, Review, Other. The patient's treatment interest is
// mapped onto the closest reason; the specific treatment name is carried in the notes.
function reasonForTreatment(treatment: string): string {
  const t = treatment.toLowerCase();
  if (/\b(check\s*-?up|exam|recall)\b/.test(t)) return "Exam";
  if (/\b(hygien|scale|polish|clean)\b/.test(t)) return "Scale & Polish";
  if (/\b(emergency|urgent|knocked|broken tooth|severe pain)\b/.test(t)) return "Emergency";
  return "Other";
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_slots",
    description:
      "Find open appointment slots for the patient's treatment at their site. Only ever offer slots this returns; never invent a time.",
    input_schema: {
      type: "object",
      properties: {
        treatment: { type: "string", description: "The treatment to book for" },
        fromDate: { type: "string", description: "ISO date to search from (optional)" },
        toDate: { type: "string", description: "ISO date to search to (optional)" },
        practitionerId: {
          type: "string",
          description:
            "Optional. Restrict slots to one clinician's diary. If the patient was invited to see a specific clinician, that clinician is used automatically; pass \"any\" to show every clinician's availability if the patient asks for other options.",
        },
      },
      required: ["treatment"],
    },
  },
  {
    name: "book",
    description:
      "Book a confirmed appointment. Only call after the patient has explicitly confirmed the date, time, site and treatment in the conversation.",
    input_schema: {
      type: "object",
      properties: {
        slotStart: { type: "string", description: "ISO datetime of the chosen slot, exactly as returned by find_slots" },
        finishTime: { type: "string", description: "ISO end datetime of the chosen slot from find_slots (optional; derived from the treatment length if omitted)" },
        practitionerId: { type: "string", description: "practitioner_id of the chosen slot from find_slots (optional)" },
        treatment: { type: "string" },
      },
      required: ["slotStart", "treatment"],
    },
  },
  {
    name: "find_appointments",
    description:
      "List this patient's upcoming appointments, so you can reschedule or cancel one. Returns appointment ids and times. Call this before reschedule or cancel.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "reschedule",
    description:
      "Move an existing appointment to a new slot. Only call after the patient confirms which appointment and the new date and time. Use an appointmentId from find_appointments and a slot from find_slots.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "id of the appointment to move, from find_appointments" },
        newSlotStart: { type: "string", description: "ISO datetime of the new slot, exactly as returned by find_slots" },
        newFinishTime: { type: "string", description: "ISO end datetime of the new slot from find_slots (optional)" },
        practitionerId: {
          type: "string",
          description:
            "practitioner_id of the new slot from find_slots. Always pass this when the new slot is in a different clinician's diary, otherwise the appointment stays with the clinician who has it now.",
        },
      },
      required: ["appointmentId", "newSlotStart"],
    },
  },
  {
    name: "cancel",
    description:
      "Cancel an existing appointment. Only call after the patient explicitly confirms they want to cancel that appointment. Use an appointmentId from find_appointments.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "id of the appointment to cancel, from find_appointments" },
      },
      required: ["appointmentId"],
    },
  },
  {
    name: "treatment_info",
    description:
      "Look up plain, non-clinical information about a treatment we offer: what it is, an indicative starting price in GBP, whether finance is available, and a selling point. Use this to answer what a treatment is or what it costs. Do NOT use it to judge whether a treatment is clinically suitable for the patient; escalate clinical questions instead.",
    input_schema: {
      type: "object",
      properties: {
        treatment: { type: "string", description: "The treatment the patient asked about, e.g. Invisalign, implant, whitening" },
      },
      required: ["treatment"],
    },
  },
  {
    name: "register_patient",
    description:
      "Register a new patient on our records so you can then book for them. Use for a number we do not recognise, once you have their title, first and last name and date of birth (their mobile is already known). Our records will not accept a new patient without all four, so collect them naturally in conversation and confirm them back before calling this.",
    input_schema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        title: {
          type: "string",
          enum: ["Mr", "Mrs", "Miss", "Ms", "Master"],
          description: "How they are addressed. Ask them; never guess it from their name.",
        },
        dateOfBirth: {
          type: "string",
          description: "Their date of birth as YYYY-MM-DD. Ask them for it; never guess or estimate it.",
        },
        email: { type: "string", description: "email address if they give one (optional)" },
      },
      required: ["firstName", "lastName", "title", "dateOfBirth"],
    },
  },
  {
    name: "send_onboarding_form",
    description:
      "Text this person a link to the new-patient onboarding form so they can register and share their details (contact, medical history) before booking. Use for a new enquiry as an alternative to collecting their name inline, or when they would rather fill in a form. Include the returned url in your reply to them.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Optional specific form slug; omit for the practice's default onboarding form" },
      },
      required: [],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human coordinator. Use for any clinical question, a complaint, an explicit request for a person, or anything you are unsure about.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

/**
 * Restrict availability rows to a single practitioner's diary. Each Dentally
 * availability row carries its own `practitioner_id`. A null/empty filter returns
 * the rows unchanged. Pure + exported so it is unit-testable.
 */
export function filterSlotsByPractitioner(slots: unknown[], practitionerId: string | null): unknown[] {
  if (!practitionerId) return slots;
  return slots.filter((s) => {
    const row = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
    return String(row.practitioner_id ?? "") === practitionerId;
  });
}

/**
 * Dentally's availability rows are WINDOWS, not bookable slots: one row can span a
 * whole afternoon. Handing a raw window to the model means it offers, and then
 * books, the entire span, which writes a multi hour appointment into a real
 * clinician's diary and blocks their day. Measured against live production data
 * most windows are longer than one booking, and the longest ran to 390 minutes.
 *
 * So every window is cut into consecutive units of exactly the length this booking
 * needs, before the model ever sees it. The raw Dentally field names are preserved
 * (and every other field carried through untouched) so the prompt, the practitioner
 * filter and the model's own slot echo all keep working unchanged.
 */
function chunkAvailabilityRows(rows: unknown[], durationMin: number): unknown[] {
  const out: unknown[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const start = typeof row.start_time === "string" ? row.start_time : "";
    const finish = typeof row.finish_time === "string" ? row.finish_time : "";
    if (!start || !finish) continue;
    for (const unit of chunkWindowIntoSlots({ start, finish, practitionerId: null }, durationMin)) {
      out.push({ ...row, start_time: unit.start, finish_time: unit.finish });
    }
  }
  return out;
}

/**
 * Whether live availability still covers a whole booking span.
 *
 * The agent quotes slots at the TREATMENT's own length, while availability is
 * read back in fixed 30 minute slots, so an exact slot match is not always on
 * offer. What has to be true before a write is simpler: every minute of
 * [start, finish) is still free in the diary. Back-to-back open slots are
 * merged first, so an hour-long appointment sitting across two adjacent slots
 * still counts as covered, while a slot taken in the meantime opens a gap and
 * fails the check. Pure + exported so it is unit-testable.
 */
export function spanStillOpen(
  days: BookingDay[],
  startIso: string,
  finishIso: string,
  practitionerId: string | null,
): boolean {
  const startMs = Date.parse(startIso);
  const finishMs = Date.parse(finishIso);
  if (Number.isNaN(startMs) || Number.isNaN(finishMs) || finishMs <= startMs) return false;
  const spans: Array<[number, number]> = [];
  for (const day of days) {
    for (const slot of day.slots) {
      if (practitionerId && slot.practitionerId !== practitionerId) continue;
      const s = Date.parse(slot.start);
      const f = Date.parse(slot.finish);
      if (Number.isNaN(s) || Number.isNaN(f) || f <= s) continue;
      spans.push([s, f]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let openFrom = Number.NaN;
  let openTo = Number.NaN;
  for (const [s, f] of spans) {
    if (Number.isFinite(openTo) && s <= openTo) {
      if (f > openTo) openTo = f; // contiguous or overlapping: extend the run
    } else {
      openFrom = s; // a gap in the diary: start a fresh run
      openTo = f;
    }
    if (openFrom <= startMs && openTo >= finishMs) return true;
  }
  return false;
}

/** YYYY-MM-DD shifted by whole days (UTC-safe), for an availability window. */
function shiftYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ToolDeps {
  dentally: Pick<
    DentallyClient,
    | "getAvailability"
    | "listPractitioners"
    | "createAppointment"
    | "createPatient"
    | "getPatientAppointments"
    | "updateAppointment"
    | "cancelAppointment"
  >;
  context: AgentContext;
  /**
   * Whether real Dentally writes are permitted. Defaults to the deployment gate;
   * injectable so tests can exercise both paths without touching process.env.
   * Same shape as handleNoshowInbound's own writesEnabled, deliberately.
   */
  writesEnabled?: boolean;
}

/**
 * The four write tools, and the honest refusal each returns when writes are off.
 *
 * Pure and exported so the exact words are testable — they are read by a language
 * model that then speaks to a patient, so what they say matters as much as that
 * they refuse. Each carries the NEGATIVE of its own success flag (`booked: false`
 * against `booked: true`) so a model skimming the field it was looking for cannot
 * read a refusal as a confirmation, and each names escalate_to_human so the turn
 * ends with a person rather than a promise.
 *
 * Never mention a funding regime here: this text can be paraphrased straight into a
 * patient message (project rule).
 */
export type AgentWriteTool = "book" | "reschedule" | "cancel" | "register_patient";

const WRITE_REFUSALS: Record<AgentWriteTool, Record<string, unknown>> = {
  book: {
    booked: false,
    error:
      "Booking is switched off in this system, so nothing has been booked. Do not tell the patient they have an appointment. Apologise, say a colleague will confirm a time with them shortly, and call escalate_to_human.",
  },
  reschedule: {
    rescheduled: false,
    error:
      "Changing appointments is switched off in this system, so nothing has moved. The original appointment still stands. Tell the patient a colleague will confirm the change, and call escalate_to_human.",
  },
  cancel: {
    cancelled: false,
    error:
      "Cancelling is switched off in this system, so the appointment is still in the diary. Do not tell the patient it is cancelled. Say a colleague will confirm it, and call escalate_to_human.",
  },
  register_patient: {
    registered: false,
    error:
      "Adding new patients is switched off in this system, so nothing has been created. Take their name, tell them a colleague will finish setting them up, and call escalate_to_human.",
  },
};

/** The refusal one write tool returns when writes are off, as the dispatch string. */
export function writeDisabledResult(tool: AgentWriteTool): string {
  return JSON.stringify(WRITE_REFUSALS[tool]);
}

/**
 * THE AGENT'S OWN WRITE GATE.
 *
 * Every other Dentally write in this codebase checks isDentallyWriteEnabled() before
 * it writes — booking/create, coordinator, no-show, reactivation, recall, the diary
 * move service, patient status, patient profile and the co-pilot. These four tools
 * were the outlier, with nothing between the model and Dentally but whichever client
 * the caller happened to inject, and they are the one path a language model drives.
 * Two entry points already build them (the inbound webhook and the dev harness), so
 * the check belongs here rather than in either route.
 */
export function makeDispatch(deps: ToolDeps) {
  const writesEnabled = deps.writesEnabled ?? isDentallyWriteEnabled();
  // When a new patient is onboarded mid-conversation, book under their new id.
  let registeredPatientId: string | null = null;

  // Bookings this dispatch has already written, keyed by patient + slot. Dentally
  // can be slow, and a write that times out on the client side may well have
  // landed; the model then retries the same booking in the same turn. Replaying
  // the first result keeps that retry from putting the patient in the diary twice.
  const bookedSlots = new Map<string, string>();

  // An appointment already on the patient's own record at exactly this start, if
  // any. Catches the cross-turn half of the same race: the timed-out write DID
  // land, and the retry arrives on a later inbound with a fresh dispatch. Returns
  // the existing appointment id so we confirm that booking rather than duplicate
  // it. Best-effort: a failed read must never block a genuine first booking (the
  // per-dispatch memo above still covers the same-turn retry).
  async function appointmentAtStart(patientId: string, startMs: number): Promise<string | null> {
    try {
      const res = await deps.dentally.getPatientAppointments(patientId);
      const raw = Array.isArray(res.appointments) ? res.appointments : [];
      for (const a of raw) {
        const row = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
        const state = typeof row.state === "string" ? row.state : "";
        if (state === "cancelled") continue;
        const s = Date.parse(String(row.start_time ?? ""));
        if (!Number.isNaN(s) && s === startMs && row.id !== undefined && row.id !== null) {
          return String(row.id);
        }
      }
    } catch (err) {
      console.warn("[agent] could not read existing appointments before booking; continuing", err);
    }
    return null;
  }

  // Server-side ownership check for a mutation on an existing appointment. A
  // patient can only ever reschedule/cancel an appointment that is on THEIR own
  // record. We re-derive the set of the texting patient's appointment ids from
  // Dentally (the same source find_appointments uses) and reject any id that is
  // not in it. This closes the IDOR where a crafted message supplies another
  // patient's appointment id. Matches the trust model of `book`, which injects
  // context.patientId itself rather than trusting a model-supplied id.
  async function findOwnedAppointment(appointmentId: string): Promise<Record<string, unknown> | null> {
    const patientId = registeredPatientId ?? deps.context.patientId;
    // A lead not yet registered has no appointments of their own to act on.
    if (!appointmentId || patientId.startsWith("lead:")) return null;
    const res = await deps.dentally.getPatientAppointments(patientId);
    const raw = Array.isArray(res.appointments) ? res.appointments : [];
    for (const a of raw) {
      const row = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
      if (String(row.id) === String(appointmentId)) return row;
    }
    return null;
  }
  async function ownsAppointment(appointmentId: string): Promise<boolean> {
    return (await findOwnedAppointment(appointmentId)) !== null;
  }

  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "find_slots": {
        const treatment = typeof input.treatment === "string" ? findTreatment(input.treatment) : null;
        // Live Dentally availability is PER PRACTITIONER (start_time/finish_time ISO
        // datetimes + practitioner_ids[]; each row carries its practitioner_id) —
        // calibrated against the live API 2026-07-11. So: the site's active
        // practitioners first, then one availability call covering all of them.
        // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
        const siteUuid = dentallySiteId(deps.context.siteId);
        const pr = await deps.dentally.listPractitioners(siteUuid);
        const practitionerIds: string[] = [];
        for (const raw of Array.isArray(pr.practitioners) ? pr.practitioners : []) {
          const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          if (row.active !== true) continue;
          if (typeof row.site_id === "string" && row.site_id !== siteUuid) continue;
          if (typeof row.id === "string" || typeof row.id === "number") practitionerIds.push(String(row.id));
        }
        if (practitionerIds.length === 0) return JSON.stringify({ slots: [] });
        const now = new Date();
        const fromMs =
          typeof input.fromDate === "string" ? Date.parse(`${input.fromDate}T00:00:00.000Z`) : Number.NaN;
        // Clamp to now rounded UP onto the booking grid, never to the raw instant:
        // both the mock and live clip the window they return to the requested
        // start, so a raw `now` had the agent offering the patient times like
        // "13:02" and, worse, offering a different set on every read. See
        // ceilToSlotGrid for the full account.
        const nowFloor = ceilToSlotGrid(now.getTime());
        const startTime = new Date(Math.max(Number.isNaN(fromMs) ? nowFloor : fromMs, nowFloor)).toISOString();
        const finishTime =
          typeof input.toDate === "string" && !Number.isNaN(Date.parse(`${input.toDate}T23:59:59.999Z`))
            ? new Date(`${input.toDate}T23:59:59.999Z`).toISOString()
            : new Date(now.getTime() + 14 * 86_400_000).toISOString();
        const res = await deps.dentally.getAvailability({
          practitionerIds,
          startTime,
          finishTime,
          duration: treatment?.durationMinutes,
        });
        const allSlots = Array.isArray(res.availability) ? res.availability : [];
        // Practitioner targeting. A segment-outreach invite primes a preferred clinician
        // (context.outreachInvite.practitionerId): offer THAT clinician's diary first, but
        // SOFT-prefer rather than hard-filter, so if they have no slots in the window the
        // patient still sees other clinicians instead of a false "no availability". An
        // EXPLICIT practitionerId from the model is an intentional choice and stays a hard
        // filter; "any"/"all" broadens to every clinician when the patient asks.
        const requested = typeof input.practitionerId === "string" ? input.practitionerId.trim() : "";
        const broaden = requested.toLowerCase() === "any" || requested.toLowerCase() === "all";
        const preferred = deps.context.outreachInvite?.practitionerId ?? null;
        let slots: unknown[];
        if (broaden) {
          slots = allSlots; // patient asked to see every clinician
        } else if (requested) {
          slots = filterSlotsByPractitioner(allSlots, requested); // explicit choice: hard filter
        } else if (preferred) {
          // Outreach invite: prefer the invited clinician, but fall back to every
          // clinician's availability when they have nothing free in the window.
          const preferredSlots = filterSlotsByPractitioner(allSlots, preferred);
          slots = preferredSlots.length > 0 ? preferredSlots : allSlots;
        } else {
          slots = allSlots; // no targeting at all
        }
        // Never offer a raw availability window: cut it to what this booking needs.
        return JSON.stringify({
          slots: chunkAvailabilityRows(slots, treatment?.durationMinutes ?? BOOKING_SLOT_DURATION_MIN),
        });
      }
      case "treatment_info": {
        const treatment = typeof input.treatment === "string" ? input.treatment : "";
        const t = findTreatment(treatment);
        if (!t) return JSON.stringify({ found: false });
        return JSON.stringify({
          found: true,
          name: t.name,
          summary: t.summary,
          priceFrom: t.priceFrom,
          financeAvailable: t.financeAvailable,
          usp: t.usp,
          typicalVisits: t.typicalVisits,
        });
      }
      case "book": {
        // Refuse FIRST: before the availability read, before the idempotency memo.
        // None of that work can matter when no write may follow it.
        if (!writesEnabled) return writeDisabledResult("book");
        const patientId = registeredPatientId ?? deps.context.patientId;
        if (patientId.startsWith("lead:")) {
          // Unknown caller not yet registered: force the register_patient step first.
          return JSON.stringify({ error: "Register this new patient with register_patient before booking." });
        }
        // Calibrated to the real Dentally POST /v1/appointments contract
        // (developer.dentally.co): start_time, finish_time, practitioner_id AND a
        // `reason` from the fixed enum are all REQUIRED. There is NO `treatment` field
        // (the treatment name goes in notes) and no site_id (the site is implied by the
        // practitioner). Prefer the slot's exact values from find_slots; derive
        // finish_time from the treatment length only as a fallback.
        const treatmentName = typeof input.treatment === "string" ? input.treatment : "";
        const start = typeof input.slotStart === "string" ? input.slotStart : "";
        const startMs = Date.parse(start);
        const durationMin = findTreatment(treatmentName)?.durationMinutes ?? BOOKING_SLOT_DURATION_MIN;
        // The treatment length is the AUTHORITY on how long to book, and the model's
        // echoed finish is only ever allowed to shorten it. Without this clamp a model
        // that echoed a raw Dentally availability window (a whole free afternoon) would
        // book that entire span, blocking a real clinician's diary. find_slots now
        // chunks its output so the model should never see such a span, but this is the
        // choke point immediately before the write, so it refuses one regardless.
        const derivedFinishMs = Number.isNaN(startMs) ? Number.NaN : startMs + durationMin * 60_000;
        const requestedFinishMs =
          typeof input.finishTime === "string" && input.finishTime ? Date.parse(input.finishTime) : Number.NaN;
        const finishMs =
          Number.isFinite(requestedFinishMs) &&
          requestedFinishMs > startMs &&
          requestedFinishMs < derivedFinishMs
            ? requestedFinishMs
            : derivedFinishMs;
        const finishTime = Number.isNaN(finishMs) ? "" : new Date(finishMs).toISOString();
        const practitionerId = typeof input.practitionerId === "string" ? input.practitionerId : "";
        // Dentally rejects an appointment with no practitioner, no start or no end time.
        // Never send an invalid write: ask the model to re-pick a slot from find_slots.
        if (!practitionerId || !finishTime || Number.isNaN(startMs)) {
          return JSON.stringify({ error: "That slot is missing its practitioner, or its start or end time. Call find_slots again and book one of the slots it returns." });
        }
        // Idempotency, first half: this dispatch has already written this exact
        // booking, so replay its result instead of writing a second appointment.
        const bookKey = `${patientId}|${start}|${practitionerId}`;
        const alreadyBooked = bookedSlots.get(bookKey);
        if (alreadyBooked) return alreadyBooked;
        // Idempotency, second half: the patient already holds an appointment at
        // this exact time (an earlier write that timed out but landed). Confirm
        // that one rather than booking them in twice.
        const existingId = await appointmentAtStart(patientId, startMs);
        if (existingId) {
          const already = JSON.stringify({ booked: true, appointmentId: existingId, alreadyBooked: true });
          bookedSlots.set(bookKey, already);
          return already;
        }
        // LIVE SLOT REVALIDATION. Minutes pass between the agent offering a time
        // and the patient confirming it, and in that gap reception or another
        // patient can take it. Re-read availability immediately before the write
        // and refuse if the time has gone, exactly as the public booking route
        // does, so the agent can never write over a slot Dentally is no longer
        // offering. The MATCHED live slot is what gets booked where there is an
        // exact match; otherwise the agent's own span is used, having been proved
        // still open. A failed availability read leaves the slot unproven, so it
        // throws rather than writing blind (the turn then hands over to a human).
        const dayKey = londonDayKey(new Date(startMs));
        // The availability reader drops days beyond the PUBLIC booking horizon, and
        // the agent legitimately books further ahead than that, so the read is
        // anchored to the day before the requested slot rather than to today. Never
        // earlier than now, so a slot in the past is still dropped and refused. The
        // question asked is unchanged (is this slot open in the live diary?); the
        // anchor only stops a genuinely distant booking being refused as "taken".
        const anchor = new Date(Math.max(Date.now(), startMs - 86_400_000));
        const days = await fetchAvailabilityDays(
          deps.dentally,
          deps.context.siteId,
          dayKey,
          shiftYmd(dayKey, 1),
          anchor,
        );
        const exact = findExactSlot(days, start, finishTime, practitionerId);
        const live: BookingSlot | null =
          exact ??
          (spanStillOpen(days, start, finishTime, practitionerId)
            ? { start, finish: finishTime, practitionerId }
            : null);
        if (!live) {
          return JSON.stringify({
            booked: false,
            error:
              "That time has just been taken. Apologise, call find_slots again and offer the patient the times it returns.",
          });
        }
        const { appointment } = await deps.dentally.createAppointment({
          patient_id: patientId,
          start_time: live.start,
          finish_time: live.finish,
          practitioner_id: live.practitionerId ?? practitionerId,
          reason: reasonForTreatment(treatmentName),
          notes: treatmentName ? `Booked via assistant: ${treatmentName}` : "Booked via assistant",
          booked_via_api: true,
        });
        const result = JSON.stringify({ booked: true, appointmentId: appointment.id });
        bookedSlots.set(bookKey, result);
        return result;
      }
      case "find_appointments": {
        const res = await deps.dentally.getPatientAppointments(deps.context.patientId);
        const raw = Array.isArray(res.appointments) ? res.appointments : [];
        const now = Date.now();
        const upcoming = raw
          .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))
          .filter((a) => {
            const s = typeof a.start_time === "string" ? a.start_time : "";
            const t = s ? new Date(s).getTime() : 0;
            const state = typeof a.state === "string" ? a.state : "";
            return t > now && state !== "cancelled" && state !== "completed";
          })
          .map((a) => ({ id: a.id, start_time: a.start_time, reason: a.reason ?? null, site_id: a.site_id }));
        return JSON.stringify({ appointments: upcoming });
      }
      case "reschedule": {
        if (!writesEnabled) return writeDisabledResult("reschedule");
        const appointmentId = String(input.appointmentId);
        const owned = await findOwnedAppointment(appointmentId);
        if (!owned) {
          return JSON.stringify({ error: "I could not find that appointment on your record." });
        }
        // Patching start_time alone leaves the OLD finish_time behind — a corrupted
        // (or rejected) reschedule. If the model omitted newFinishTime, derive it from
        // the appointment's own duration; refuse rather than send a start-only patch.
        let finish = typeof input.newFinishTime === "string" && input.newFinishTime ? input.newFinishTime : "";
        if (!finish && typeof input.newSlotStart === "string") {
          const prevStart = Date.parse(String(owned.start_time ?? ""));
          const prevFinish = Date.parse(String(owned.finish_time ?? ""));
          const durationMs = prevFinish - prevStart;
          if (Number.isFinite(durationMs) && durationMs > 0) {
            finish = new Date(Date.parse(input.newSlotStart) + durationMs).toISOString();
          }
        }
        if (!finish) {
          return JSON.stringify({ error: "Provide newFinishTime for the new slot before rescheduling." });
        }
        // The new slot belongs to a clinician, and a slot from find_slots is very
        // often in a DIFFERENT clinician's diary to the one holding the appointment
        // now. Patching the times alone left the appointment with its old clinician,
        // so the move landed in the wrong diary (and on top of whatever that
        // clinician already had). Carry the new slot's practitioner through; with
        // none supplied, restate the appointment's own so the diary is explicit.
        const newPractitionerId =
          (typeof input.practitionerId === "string" ? input.practitionerId.trim() : "") ||
          String(owned.practitioner_id ?? "");
        const reschedulePatch: Record<string, unknown> = { start_time: input.newSlotStart, finish_time: finish };
        if (newPractitionerId) reschedulePatch.practitioner_id = newPractitionerId;
        const { appointment } = await deps.dentally.updateAppointment(appointmentId, reschedulePatch);
        return JSON.stringify({
          rescheduled: true,
          appointmentId: appointment.id,
          start_time: appointment.start_time ?? input.newSlotStart,
        });
      }
      case "cancel": {
        if (!writesEnabled) return writeDisabledResult("cancel");
        const appointmentId = String(input.appointmentId);
        if (!(await ownsAppointment(appointmentId))) {
          return JSON.stringify({ error: "I could not find that appointment on your record." });
        }
        const { appointment } = await deps.dentally.cancelAppointment(appointmentId);
        return JSON.stringify({ cancelled: true, appointmentId: appointment.id, state: appointment.state ?? "cancelled" });
      }
      case "register_patient": {
        // Refused before registeredPatientId is set, so a later `book` in the same
        // turn cannot proceed against an id that was never created.
        if (!writesEnabled) return writeDisabledResult("register_patient");

        // WHAT THIS TOOL USED TO SEND, and why it could never have worked: names, an
        // email, a mobile and a site — and none of the four fields live Dentally
        // demands to create a patient (DENTALLY.md; memory dentally-createpatient-422).
        // Every registration this agent made would have 422'd against the real
        // practice, mid-conversation, with a patient waiting. It went unnoticed because
        // the local mock accepted it.
        //
        // Two of the four the agent can simply ASK for, and now does: a title and a
        // date of birth are ordinary things to give a practice over text. The third
        // (sex) is derived from the title exactly as the booking funnel derives it, so
        // nobody is asked a binary sex question in a chat about a check-up.
        const title = knownTitle(typeof input.title === "string" ? input.title : undefined);
        const dob = canonicalDob(typeof input.dateOfBirth === "string" ? input.dateOfBirth : undefined);
        if (!title || !dob) {
          // Told to the MODEL, which then asks the patient in its own words. Never
          // says "our system rejected it": from the patient's side this is simply a
          // detail we have not taken yet.
          return JSON.stringify({
            registered: false,
            error:
              `I still need ${!title && !dob ? "their title (Mr, Mrs, Miss, Ms or Master) and their date of birth" : !title ? "their title (Mr, Mrs, Miss, Ms or Master)" : "their date of birth as a real date, e.g. 1985-04-09"}` +
              " before I can add them to our records. Ask them for it warmly, confirm it back, then call register_patient again. Never guess it.",
          });
        }

        // THE FOURTH FIELD, and the one this agent cannot get: a payment plan.
        //
        // Live Dentally will not create a patient without one, and there is no honest
        // way for THIS caller to supply it. Asking the patient is forbidden — a
        // patient-facing agent message must never name a funding regime (project rule)
        // — and picking one silently would write a billing arrangement nobody chose
        // onto a real clinical record. The practice's own probe underlines the risk:
        // its biggest plan by volume is UDC (47752, 37% of recent registrations), not
        // NHS or Private, so any hard-coded guess would be wrong more often than right.
        //
        // So the agent registers nobody until the owner has DELIBERATELY chosen which
        // plan a conversational registration lands on (DENTALLY_DEFAULT_PAYMENT_PLAN_ID
        // — see configuredDefaultPaymentPlanId). Unset, which is what production runs
        // today, it refuses and hands over to a path that works: the onboarding form,
        // where the patient fills in their own details and a member of staff completes
        // the registration, or a colleague.
        const paymentPlanId = configuredDefaultPaymentPlanId();
        if (paymentPlanId === null) {
          return JSON.stringify({
            registered: false,
            error:
              "I cannot finish setting them up on our records myself. Do NOT tell them anything was rejected or that there is a problem with their details — there is not. Say warmly that you will get them registered, then either send them the onboarding form with send_onboarding_form so they can complete their details, or call escalate_to_human so a colleague finishes it. Do not call register_patient again this conversation.",
          });
        }

        const built = buildPatientRegistration({
          firstName: typeof input.firstName === "string" ? input.firstName : "",
          lastName: typeof input.lastName === "string" ? input.lastName : "",
          title,
          dateOfBirth: dob,
          paymentPlanId,
          email: typeof input.email === "string" ? input.email : null,
          phone: deps.context.phone ?? null,
          // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
          dentallySiteId: dentallySiteId(deps.context.siteId),
          useSms: true,
          useEmail: true,
        });
        if (!built.ok) {
          // Only a missing name can reach here (the other three are checked above).
          return JSON.stringify({
            registered: false,
            error:
              "I still need their full name before I can add them to our records. Ask them for it, confirm it back, then call register_patient again. Never guess it.",
          });
        }

        const { patient } = await deps.dentally.createPatient(built.payload);
        registeredPatientId = patient.id;
        return JSON.stringify({ registered: true, patientId: patient.id });
      }
      case "send_onboarding_form": {
        // Resolve the practice's public onboarding URL from the conversation's site.
        // Returns the link for the agent to include in its reply (it does not send it
        // itself, so the agent keeps one warm message per turn). Pilot: clientId === slug.
        const site = getSite(deps.context.siteId);
        const clientSlug = site ? getClient(site.clientId)?.slug ?? site.clientId : null;
        if (!clientSlug) {
          return JSON.stringify({ error: "Could not resolve the onboarding form link for this practice." });
        }
        const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
        const extra = typeof input.slug === "string" && input.slug.trim() ? `/${input.slug.trim()}` : "";
        return JSON.stringify({ url: `${base}/onboard/${clientSlug}${extra}` });
      }
      case "escalate_to_human":
        return JSON.stringify({ escalated: true, reason: input.reason ?? "" });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  };
}
