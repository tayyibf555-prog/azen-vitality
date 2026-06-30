import type { InboxChannel, InboxDirection, InboxMessage, Thread } from "./types";

// Pure normalise + group helpers. No I/O: the repository builds the raw rows from
// each store and hands them here, which keeps the grouping logic unit-testable
// with fixtures and identical across every source.

/** Cap a body to a short single-line preview for the thread list. */
export function snippet(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Map an agent_conversation message role to an inbox direction. In the agent
 * store the patient is inbound; the agent (and any system/tool note we surface)
 * is outbound from the practice's point of view.
 */
export function directionFromAgentRole(role: string): InboxDirection {
  return role === "patient" ? "inbound" : "outbound";
}

/** Normalise a raw conversation channel string to an inbox channel. */
export function toInboxChannel(channel: string): InboxChannel {
  if (channel === "whatsapp") return "whatsapp";
  if (channel === "email") return "email";
  if (channel === "after-hours" || channel === "after_hours") return "after-hours";
  return "sms";
}

/**
 * Group a flat list of normalised messages into per-contact threads.
 *
 * - Messages are grouped by contactRef.
 * - Within a thread, messages are sorted oldest-first (chat order).
 * - The thread's lastAt / lastSnippet / channel / unread reflect the newest message.
 * - Threads are returned newest-activity first.
 * - contactName takes the most recent non-empty name seen for the contact, so a
 *   later identification (e.g. a lead that became a known patient) wins.
 */
export function groupThreads(messages: InboxMessage[]): Thread[] {
  const byContact = new Map<string, InboxMessage[]>();
  for (const m of messages) {
    const list = byContact.get(m.contactRef);
    if (list) list.push(m);
    else byContact.set(m.contactRef, [m]);
  }

  const threads: Thread[] = [];
  for (const [contactRef, list] of byContact) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const last = list[list.length - 1];
    // Most recent non-empty name across the thread (newest wins).
    let contactName = last.contactName;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].contactName && list[i].contactName.trim() !== "") {
        contactName = list[i].contactName;
        break;
      }
    }
    threads.push({
      contactRef,
      contactName,
      channel: last.channel,
      lastAt: last.at,
      lastSnippet: snippet(last.body),
      unread: last.direction === "inbound",
      messages: list,
    });
  }

  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return threads;
}
