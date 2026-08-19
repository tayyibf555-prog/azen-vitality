// The agent store keys a conversation by `dentally_patient_id`, but that column
// holds TWO different things:
//
//   - a real Dentally patient id, when the number was resolved to a patient, and
//   - a SYNTHETIC `lead:<phone>` key, when it was not (the inbound webhook writes
//     `lead:${from}` for an unknown number, and speed-to-lead's first contact
//     writes the same key so the reply threads back into the same conversation).
//
// Anything that treats that column as a patient id must say which of the two it
// got. Pure, no I/O, so the rule can be asserted directly.

/** The prefix the inbound webhook and speed-to-lead use for an unidentified enquiry. */
export const LEAD_CONVERSATION_PREFIX = "lead:";

/**
 * A conversation's REAL Dentally patient id, or null when the conversation is
 * keyed to an unidentified enquiry.
 *
 * The patient record's Tasks tab matches tasks to a record by exact patient id, so
 * handing it `lead:+447700900123` would be a claim we cannot support: it is a phone
 * number wearing a patient id's clothes. Null is the honest answer, and the task
 * still appears in the practice-wide queue where it can actually be worked.
 */
export function realPatientId(dentallyPatientId: string | null | undefined): string | null {
  const id = (dentallyPatientId ?? "").trim();
  if (id === "") return null;
  if (id.startsWith(LEAD_CONVERSATION_PREFIX)) return null;
  return id;
}
