import type Anthropic from "@anthropic-ai/sdk";
import type { DentallyClient } from "@/lib/dentally/client";
import { findTreatment } from "@/lib/treatments/catalog";
import { getSite, getClient, dentallySiteId } from "@/lib/mock/clients";
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
      "Register a new patient on our records so you can then book for them. Use for a number we do not recognise, once you have their first and last name (their mobile is already known). Confirm the name with them before calling this.",
    input_schema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string", description: "email address if they give one (optional)" },
      },
      required: ["firstName", "lastName"],
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

export interface ToolDeps {
  dentally: Pick<
    DentallyClient,
    | "getAvailability"
    | "createAppointment"
    | "createPatient"
    | "getPatientAppointments"
    | "updateAppointment"
    | "cancelAppointment"
  >;
  context: AgentContext;
}

export function makeDispatch(deps: ToolDeps) {
  // When a new patient is onboarded mid-conversation, book under their new id.
  let registeredPatientId: string | null = null;

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
        const res = await deps.dentally.getAvailability({
          // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
          siteId: dentallySiteId(deps.context.siteId),
          fromDate: typeof input.fromDate === "string" ? input.fromDate : undefined,
          toDate: typeof input.toDate === "string" ? input.toDate : undefined,
          duration: treatment?.durationMinutes,
        });
        const slots = Array.isArray(res.availability) ? res.availability : [];
        return JSON.stringify({ slots });
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
        const durationMin = findTreatment(treatmentName)?.durationMinutes ?? 30;
        const finishTime =
          typeof input.finishTime === "string" && input.finishTime
            ? input.finishTime
            : Number.isNaN(startMs)
              ? ""
              : new Date(startMs + durationMin * 60_000).toISOString();
        const practitionerId = typeof input.practitionerId === "string" ? input.practitionerId : "";
        // Dentally rejects an appointment with no practitioner or no end time. Never send
        // an invalid write: ask the model to re-pick a slot from find_slots instead.
        if (!practitionerId || !finishTime) {
          return JSON.stringify({ error: "That slot is missing its practitioner or end time. Call find_slots again and book one of the slots it returns." });
        }
        const { appointment } = await deps.dentally.createAppointment({
          patient_id: patientId,
          start_time: start,
          finish_time: finishTime,
          practitioner_id: practitionerId,
          reason: reasonForTreatment(treatmentName),
          notes: treatmentName ? `Booked via assistant: ${treatmentName}` : "Booked via assistant",
          booked_via_api: true,
        });
        return JSON.stringify({ booked: true, appointmentId: appointment.id });
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
        const reschedulePatch: Record<string, unknown> = { start_time: input.newSlotStart, finish_time: finish };
        const { appointment } = await deps.dentally.updateAppointment(appointmentId, reschedulePatch);
        return JSON.stringify({
          rescheduled: true,
          appointmentId: appointment.id,
          start_time: appointment.start_time ?? input.newSlotStart,
        });
      }
      case "cancel": {
        const appointmentId = String(input.appointmentId);
        if (!(await ownsAppointment(appointmentId))) {
          return JSON.stringify({ error: "I could not find that appointment on your record." });
        }
        const { appointment } = await deps.dentally.cancelAppointment(appointmentId);
        return JSON.stringify({ cancelled: true, appointmentId: appointment.id, state: appointment.state ?? "cancelled" });
      }
      case "register_patient": {
        const { patient } = await deps.dentally.createPatient({
          first_name: input.firstName,
          last_name: input.lastName,
          email_address: typeof input.email === "string" ? input.email : undefined,
          mobile_phone: deps.context.phone ?? undefined,
          // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
          site_id: dentallySiteId(deps.context.siteId),
          use_sms: true,
          use_email: true,
        });
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
