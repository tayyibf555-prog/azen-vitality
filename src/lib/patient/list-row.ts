import type { PatientRecord } from "@/lib/dentally/read";

/**
 * A row in the patients list.
 *
 * It is the FULL PatientRecord (the list endpoint used to return an eight-field
 * subset, so a record opened from search showed a false "Not on file" date of birth
 * and a false "No marketing consent"), plus one flag.
 *
 * `partial` marks a row that did NOT come from a Dentally patient read. The Recall
 * segment is sourced from our own recall_target table so the segment can be complete
 * rather than capped at the list's first few hundred, and that table genuinely holds
 * no contact details, date of birth or payment plan. Those nulls are therefore facts
 * about THIS VIEW, not facts about the patient, and the table renders a dash rather
 * than the claim "No contact". A dash is not a claim.
 */
export interface PatientListRow extends PatientRecord {
  partial?: boolean;
}
