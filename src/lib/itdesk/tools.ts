import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { PLAYBOOKS, rankPlaybooks } from "./playbooks";
import { getItContact } from "./repository";
import { contactIsUsable } from "./types";

// ===========================================================================
// THE IT DESK'S TOOLS.
//
// THREE TOOLS, ALL READ-ONLY. Two read the shipped playbooks; one reads the
// practice's IT contact. There is no tool here that changes anything, on any
// machine, anywhere — which is the entire security model of this module stated
// as a fact about its code rather than as an intention in a prompt.
//
// The dispatch mirrors `makeCopilotDispatch`: an unknown name is refused as the
// FIRST statement, outside the try/catch.
// ===========================================================================

export const IT_DESK_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_playbooks",
    description:
      "Find the practice's troubleshooting playbook that matches what the person is describing, in their own words. Returns the matching playbooks with their steps and their escalation. Use this before answering anything, and walk the steps one at a time rather than pasting them all.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the person said is wrong, in their words" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_playbook",
    description:
      "Read one playbook in full by its id (from search_playbooks). Use when you already know which one you are working through and need the next step.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The playbook id" } },
      required: ["id"],
    },
  },
  {
    name: "it_contact",
    description:
      "The practice's named IT contact: who to ring or email when the steps run out. Call this before escalating. If it reports that no contact has been set, say so plainly — never invent a name or a number.",
    input_schema: { type: "object", properties: {} },
  },
];

const TOOL_NAMES = new Set(IT_DESK_TOOLS.map((t) => t.name));

export function itDeskToolRefusal(): string {
  return JSON.stringify({
    error:
      "That tool is not available to the IT desk. It can only read the practice's troubleshooting playbooks and its IT contact — it cannot reach, see or change any computer.",
  });
}

export interface ItDeskDispatchContext {
  clientId: string;
}

export function makeItDeskDispatch(ctx: ItDeskDispatchContext) {
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    if (!TOOL_NAMES.has(name)) return itDeskToolRefusal();

    try {
      switch (name) {
        case "search_playbooks": {
          const query = String(input.query ?? "");
          const ranked = rankPlaybooks(query, 3);
          if (ranked.length === 0) {
            return JSON.stringify({
              matches: [],
              note: "No playbook covers this. Say what you can and cannot help with rather than improvising a procedure for hardware you have not been told about.",
            });
          }
          return JSON.stringify({
            matches: ranked.map((r) => ({
              id: r.playbook.id,
              title: r.playbook.title,
              steps: r.playbook.steps,
              escalation: r.playbook.escalation,
            })),
          });
        }

        case "get_playbook": {
          const id = String(input.id ?? "").trim();
          const playbook = PLAYBOOKS.find((p) => p.id === id);
          if (!playbook) return JSON.stringify({ error: "No playbook with that id." });
          return JSON.stringify({
            id: playbook.id,
            title: playbook.title,
            symptoms: playbook.symptoms,
            steps: playbook.steps,
            escalation: playbook.escalation,
          });
        }

        case "it_contact": {
          const contact = await getItContact(ctx.clientId);
          if (contact === null) {
            // READ FAILURE, not "none set". Kept distinct all the way to the
            // model, because telling a practice they have no IT contact when
            // they do is how somebody concludes the platform lost it.
            return JSON.stringify({
              available: false,
              reason: "unreadable",
              note: "The IT contact could not be read just now. Say that, rather than saying there isn't one, and do not invent a number.",
            });
          }
          if (!contactIsUsable(contact)) {
            return JSON.stringify({
              available: false,
              reason: "not_set",
              note: "No IT contact has been added yet. Say so and mention the practice owner can add one on the IT contact tab. Never invent a name or a number.",
            });
          }
          return JSON.stringify({
            available: true,
            name: contact.name,
            company: contact.company,
            phone: contact.phone,
            email: contact.email,
            hours: contact.hours,
            notes: contact.notes,
          });
        }

        default:
          return itDeskToolRefusal();
      }
    } catch (err) {
      console.error(`[itdesk] tool ${name} failed`, err);
      return JSON.stringify({ error: "That lookup failed. Say so rather than answering from memory." });
    }
  };
}
