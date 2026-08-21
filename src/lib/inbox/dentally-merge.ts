import type { DentallySmsRecord } from "@/lib/dentally/sms-shape";
import type { InboxMessage } from "./types";

/**
 * Folding Dentally's own SMS log into the platform's correspondence timeline.
 *
 * THE SEAM. Two systems can hold the same text. Dentally sends its reminders through
 * its own Twilio number; so does this platform for some modules; and a patient's
 * reply can land in both logs. A naive concatenation therefore prints the same
 * sentence twice, which a coordinator reads as "we chased her twice in one morning" —
 * a false statement about the practice's conduct, on a record that may be read during
 * a complaint.
 *
 * THE RULE, AND WHY IT IS THIS ONE. Collapse ONLY on an exact body match inside a
 * short window. Two messages with identical words minutes apart are one message seen
 * from two sides; identical words a week apart are a genuine second chase and both
 * must show. Nothing is matched on timing alone: a reminder and a recall sent in the
 * same minute are two different things said to the patient.
 *
 * AND NOTHING IS SILENTLY DROPPED. When a Dentally row collapses into a platform row,
 * the survivor is flagged `alsoInDentally` and the screen says so. The platform row
 * is the one kept because it is strictly richer — it knows which module wrote the
 * message, what its delivery status was, and which human released it, none of which
 * Dentally's log carries. Dropping the platform row instead would lose all four.
 */

/** How far apart two identical bodies may be and still be one message. */
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

/** Whitespace- and case-insensitive body key. Two renderings of one text match. */
export function bodyKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

function millis(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Merge Dentally's SMS records into the platform's messages, oldest first.
 *
 * `platform` is not mutated; a new array is returned. A Dentally row with an
 * unparseable or missing timestamp is still INCLUDED (it happened, we just cannot
 * place it precisely) and simply never matches a platform row, because a comparison
 * against an unknown time cannot honestly conclude "same message".
 */
export function mergeDentallySms(
  platform: InboxMessage[],
  dentally: DentallySmsRecord[],
  patientId: string,
  patientName: string,
): InboxMessage[] {
  // Index the platform's rows by body so each Dentally row is one lookup, not a scan.
  const byBody = new Map<string, InboxMessage[]>();
  for (const m of platform) {
    const key = bodyKey(m.body);
    const list = byBody.get(key);
    if (list) list.push(m);
    else byBody.set(key, [m]);
  }

  const merged: InboxMessage[] = platform.map((m) => ({ ...m }));
  const byId = new Map(merged.map((m) => [m.id, m]));

  for (const row of dentally) {
    const at = millis(row.at);
    const twin =
      at === null
        ? undefined
        : (byBody.get(bodyKey(row.body)) ?? []).find((m) => {
            if (m.direction !== row.direction) return false;
            const mt = millis(m.at);
            return mt !== null && Math.abs(mt - at) <= DUPLICATE_WINDOW_MS;
          });
    if (twin) {
      const kept = byId.get(twin.id);
      if (kept) kept.alsoInDentally = true;
      continue;
    }
    merged.push({
      id: `dentally:${row.id}`,
      contactRef: `patient:${patientId}`,
      contactName: patientName,
      // Dentally's correspondence feed is SMS. It has no email or WhatsApp stream:
      // /v1/emails answers but is empty for every patient, and there is no WhatsApp
      // resource at all. So this is not a guess, it is the whole of what the feed is.
      channel: "sms",
      direction: row.direction,
      body: row.body,
      at: row.at,
      source: "dentally",
      // Dentally's log records that the message exists, not whether Twilio delivered
      // it. `unknown` is the honest reading; calling it "Sent" would be asserting a
      // delivery this platform never observed.
      status: "unknown",
      actionedBy: null,
    });
  }

  merged.sort((a, b) => a.at.localeCompare(b.at));
  return merged;
}
