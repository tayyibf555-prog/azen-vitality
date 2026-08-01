import { FAILED_COPY } from "./tabs";
import type { PatientAdminStatus } from "@/lib/patient-status/types";

/**
 * The one status chip both surfaces of the record render.
 *
 * PURE. No I/O. Tested.
 *
 * WHY IT IS SHARED RATHER THAN WRITTEN TWICE. The full record page decided this chip
 * inline, and the quick overview did not render one at all. The quick overview is the
 * surface actually opened mid-task from the diary, the debtors list, the task queue
 * and the command palette, which is precisely where somebody is about to ring or
 * message the patient, so a patient marked do_not_contact after a complaint appeared
 * there as an ordinary record with a phone number and no marker of any kind. The rule
 * for this record is that no fact may differ between the two surfaces; that is only
 * true by construction if the fact is computed once.
 *
 * THE ORDER OF PRECEDENCE, and it is deliberate:
 *   1. the read FAILED             -> say so. Never fall through to a safe-looking
 *                                     default: a suppression marker we could not read
 *                                     is not the same as one that is not set.
 *   2. a platform override exists  -> it WINS over Dentally's flag. That is the whole
 *                                     point of an override.
 *   3. Dentally's own active flag  -> Active, or Lapsed / Inactive when archived.
 */

export type PatientChipTone = "neutral" | "success" | "danger";

export interface PatientStatusChip {
  tone: PatientChipTone;
  label: string;
  /** True when this chip reports an outage rather than a fact about the patient. */
  unavailable: boolean;
}

const OVERRIDE_CHIP: Record<PatientAdminStatus, { tone: PatientChipTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  inactive: { tone: "neutral", label: "Inactive" },
  do_not_contact: { tone: "danger", label: "Do not contact" },
};

export function patientStatusChip(input: {
  /** The platform admin override, when one is set. */
  overrideStatus: PatientAdminStatus | null;
  /** The override read threw. Wins over everything below. */
  overrideUnavailable?: boolean;
  /** Dentally's own active flag. */
  active: boolean;
  /** Dentally's archive reason, when the patient is not active. */
  archivedReason?: string | null;
}): PatientStatusChip {
  if (input.overrideUnavailable) {
    return { tone: "neutral", label: FAILED_COPY.statusChip, unavailable: true };
  }
  if (input.overrideStatus) {
    return { ...OVERRIDE_CHIP[input.overrideStatus], unavailable: false };
  }
  if (input.active) return { tone: "success", label: "Active", unavailable: false };
  return {
    tone: "neutral",
    label: input.archivedReason === "lapsed" ? "Lapsed" : "Inactive",
    unavailable: false,
  };
}
