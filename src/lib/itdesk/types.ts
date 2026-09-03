/**
 * The IT desk module's domain types.
 *
 * THE SHAPE OF THIS MODULE IS DECIDED BY WHAT IT IS NOT. There is no endpoint
 * software, no installed per-computer agent, no remote-control session and no
 * credential handling anywhere in it — the installed agent is PARKED by decision
 * (programme charter §4), and the other three are refused structurally by the
 * gate. What is left is a knowledgeable first responder: it walks a member of
 * staff through the practice's own troubleshooting steps and, when those run out,
 * hands them the name and number of the practice's IT contact.
 *
 * That boundary is not a limitation to be worked around later. It is the reason
 * this module is safe to switch on for a receptionist.
 */

/** The catalog slug + system-toggle slug for the IT desk agent. */
export const IT_DESK_SLUG = "it-desk";

/** The five areas the shipped playbooks cover. */
export const PLAYBOOK_AREAS = [
  "connectivity",
  "printing",
  "accounts",
  "dentally",
  "devices",
] as const;

export type PlaybookArea = (typeof PLAYBOOK_AREAS)[number];

export const AREA_LABELS: Record<PlaybookArea, string> = {
  connectivity: "Internet & network",
  printing: "Printers & scanning",
  accounts: "Logins & passwords",
  dentally: "Dentally access",
  devices: "iPads, kiosks & devices",
};

export interface Playbook {
  /** Stable id. Used by the agent's tools and cited in its answers. */
  id: string;
  area: PlaybookArea;
  title: string;
  /** How a member of staff would describe the problem, in their words. */
  symptoms: string[];
  /**
   * The steps, in order, each one a thing a non-technical person can actually do
   * at the desk. Nothing here needs admin rights, an installer or a password.
   */
  steps: string[];
  /**
   * What to say when the steps run out. Every playbook has one: an agent that
   * walks somebody to the end of a list and then stops is the thing that makes
   * people give up on the tool and ring the engineer anyway, five minutes later
   * and crosser.
   */
  escalation: string;
}

/**
 * The practice's named IT contact — the one settings field this module owns.
 *
 * NULLABLE EVERYWHERE, and the agent says so plainly rather than inventing a
 * number. "Ring your IT company" with no name attached is not an escalation, it
 * is a shrug; and a fabricated number is worse than either.
 */
export interface ItContact {
  clientId: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  /** e.g. "Mon-Fri 8am-6pm, emergency line out of hours". Free text. */
  hours: string | null;
  /** Anything the practice wants staff told before they ring. */
  notes: string | null;
  updatedAt: string | null;
}

/** True when there is enough here to send somebody somewhere real. */
export function contactIsUsable(contact: ItContact | null): boolean {
  if (!contact) return false;
  return Boolean(contact.phone?.trim() || contact.email?.trim());
}
