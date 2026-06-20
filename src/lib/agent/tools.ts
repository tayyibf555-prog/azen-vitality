import type Anthropic from "@anthropic-ai/sdk";
import type { DentallyClient } from "@/lib/dentally/client";
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
  dentally: Pick<DentallyClient, "getAvailability" | "createAppointment">;
  context: AgentContext;
}

export function makeDispatch(deps: ToolDeps) {
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "find_slots": {
        const res = await deps.dentally.getAvailability({
          siteId: deps.context.siteId,
          fromDate: typeof input.fromDate === "string" ? input.fromDate : undefined,
          toDate: typeof input.toDate === "string" ? input.toDate : undefined,
        });
        const slots = Array.isArray(res.availability) ? res.availability : [];
        return JSON.stringify({ slots });
      }
      case "book": {
        const { appointment } = await deps.dentally.createAppointment({
          patient_id: deps.context.patientId,
          site_id: deps.context.siteId,
          start_time: input.slotStart,
          treatment: input.treatment,
          booked_via_api: true,
        });
        return JSON.stringify({ booked: true, appointmentId: appointment.id });
      }
      case "escalate_to_human":
        return JSON.stringify({ escalated: true, reason: input.reason ?? "" });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  };
}
