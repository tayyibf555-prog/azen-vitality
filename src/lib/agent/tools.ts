import type Anthropic from "@anthropic-ai/sdk";
import type { DentallyClient } from "@/lib/dentally/client";
import { findTreatment } from "@/lib/treatments/catalog";
import type { AgentContext } from "./types";

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
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "find_slots": {
        const treatment = typeof input.treatment === "string" ? findTreatment(input.treatment) : null;
        const res = await deps.dentally.getAvailability({
          siteId: deps.context.siteId,
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
        const { appointment } = await deps.dentally.createAppointment({
          patient_id: patientId,
          site_id: deps.context.siteId,
          start_time: input.slotStart,
          treatment: input.treatment,
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
        const { appointment } = await deps.dentally.updateAppointment(String(input.appointmentId), {
          start_time: input.newSlotStart,
        });
        return JSON.stringify({
          rescheduled: true,
          appointmentId: appointment.id,
          start_time: appointment.start_time ?? input.newSlotStart,
        });
      }
      case "cancel": {
        const { appointment } = await deps.dentally.cancelAppointment(String(input.appointmentId));
        return JSON.stringify({ cancelled: true, appointmentId: appointment.id, state: appointment.state ?? "cancelled" });
      }
      case "register_patient": {
        const { patient } = await deps.dentally.createPatient({
          first_name: input.firstName,
          last_name: input.lastName,
          email_address: typeof input.email === "string" ? input.email : undefined,
          mobile_phone: deps.context.phone ?? undefined,
          site_id: deps.context.siteId,
          use_sms: true,
          use_email: true,
        });
        registeredPatientId = patient.id;
        return JSON.stringify({ registered: true, patientId: patient.id });
      }
      case "escalate_to_human":
        return JSON.stringify({ escalated: true, reason: input.reason ?? "" });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  };
}
