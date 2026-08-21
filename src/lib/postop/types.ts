// Post-op check-in agent: types + configuration. Pure, no I/O.
//
// WHAT THIS MODULE IS, AND THE ONE LINE IT MUST NEVER CROSS.
//
// The day after a flagged procedure (an extraction, an implant, anything
// surgical) the practice sends ONE short message asking how the patient is.
// That is the whole of the outbound side: one touch, no cadence, no chasing.
//
// The inbound side is where the compliance risk lives, and the rule there is
// absolute: THE AGENT TRIAGES, IT NEVER ADVISES. Any symptom, any question, any
// reply this module cannot positively read as "I am fine" is escalated to a
// human immediately, and the only thing the patient is told is that a member of
// the team will call them. There is no code path in this module that can produce
// clinical guidance, reassurance about a symptom, a dosage, or the words "that is
// normal" — not because a prompt forbids it, but because nothing here generates
// free text at all. Every patient-facing string is a fixed template in copy.ts.
//
// That is also why the outbound is not model-written. A drafter would be one
// jailbreak, one injected treatment name, or one model slip away from giving
// aftercare advice on behalf of a dentist, and no scan catches every wording of
// "you should be fine by tomorrow". A template cannot say it at all.

import type { TouchChannel } from "@/lib/coordinator/types";

export type { TouchChannel };

/**
 * The procedures that earn a check-in.
 *
 * Deliberately THREE broad buckets rather than a long list of procedure names.
 * The bucket decides one thing only — which of the three fixed sentences in
 * copy.ts is used — so a finer taxonomy would buy nothing and would multiply the
 * ways a Dentally free-text label can be mis-read.
 */
export type ProcedureFlag = "extraction" | "implant" | "surgical";

/**
 * Lifecycle of one flagged appointment inside the module. Terminal: closed,
 * stopped. `escalated` is NOT terminal: a patient who has already been escalated
 * can text again with more detail, and that must escalate again rather than be
 * swallowed.
 *
 *   pending            flagged, the check-in is not yet drafted
 *   awaiting_approval  a draft exists and a human has not acted on it
 *   in_flight          approved and queued; the shared drain owns it now
 *   sent               the check-in was delivered; we are waiting on a reply
 *   escalated          the patient replied with something a human must handle
 *   closed             the patient replied and the reply was an all-clear
 *   stopped            terminal without a check-in (no consent, opted out, stale)
 */
export type PostopStatus =
  | "pending"
  | "awaiting_approval"
  | "in_flight"
  | "sent"
  | "escalated"
  | "closed"
  | "stopped";

/** Why the module stopped for good on a target, without a check-in going out. */
export type PostopStopReason =
  | "no_consent"
  | "opted_out"
  | "excluded"
  | "stale"
  | "staff_stopped"
  | "undeliverable";

/** Touch lifecycle. 'discarded' is the exit a human-rejected draft needs; without
 *  it a rejected draft is neither sent nor failed and wedges the target forever. */
export type PostopTouchStatus =
  | "draft"
  | "approved"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "discarded";

export interface PostopTarget {
  /** `${siteId}:${appointmentId}` — stable, and derivable without a database read. */
  id: string;
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  procedureFlag: ProcedureFlag;
  /**
   * The SANITISED Dentally text the flag was derived from, kept for the audit
   * trail so a practice can see why a patient was flagged.
   *
   * NEVER SENT TO A PATIENT AND NEVER PUT IN A PROMPT. It is free text a human
   * typed into Dentally, which makes it the module's one injection surface; the
   * patient-facing wording comes from `procedureFlag` (a closed vocabulary of
   * three values decided by our own code), never from this string.
   */
  procedureSource: string;
  /** ISO. When the appointment finished, per Dentally. */
  procedureAt: string;
  /** ISO. The earliest the check-in may be sent (next day, inside the send window). */
  dueAt: string;
  status: PostopStatus;
  stopReason: PostopStopReason | null;
  consentSms: boolean;
  consentEmail: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PostopTouch {
  id: string;
  targetId: string;
  siteId: string;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  status: PostopTouchStatus;
  /** Who approved or discarded the draft. */
  actionedBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface PostopOutboxItem {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
  status: "queued" | "sending" | "sent" | "delivered" | "failed";
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** One drafted check-in as an approval panel receives it. A deliberately small
 *  projection: everything here crosses to the browser, and the approve/discard
 *  requests carry `touchId` alone so nothing in it is trusted back at the API. */
export interface PostopDraftView {
  touchId: string;
  targetId: string;
  patientName: string;
  procedureFlag: ProcedureFlag;
  procedureAt: string;
  channel: TouchChannel;
  /** The full message. Never truncated for the person approving it. */
  body: string;
  createdAt: string;
}

export interface PostopConfig {
  /**
   * Hours after the procedure before the check-in is due. 20 rather than 24 so a
   * procedure that finished at 17:00 becomes due at 13:00 the next day rather than
   * being pushed into the evening; the send window clamp in schedule.ts does the
   * rest of the work.
   */
  checkInAfterHours: number;
  /**
   * A procedure older than this gets no check-in at all. "Just checking in after
   * your extraction" three days late is not a check-in, it is a reminder that
   * nobody looked. A target past this is stopped 'stale', never sent.
   */
  maxProcedureAgeHours: number;
  /**
   * How long after a check-in an inbound from that number is still read as a
   * REPLY to it. Beyond this, an address match is just the same patient texting
   * the practice about something else, and swallowing it into this module would
   * silently take every future message from that patient away from the booking
   * agent. Seven days.
   */
  replyWindowHours: number;
  /** Hard cap on drafts created in a single sweep tick. */
  maxDraftsPerRun: number;
  /** Hard cap on appointments examined in a single sweep tick. */
  maxExaminedPerRun: number;
}

export const DEFAULT_POSTOP_CONFIG: PostopConfig = {
  checkInAfterHours: 20,
  maxProcedureAgeHours: 48,
  replyWindowHours: 168,
  maxDraftsPerRun: 50,
  maxExaminedPerRun: 500,
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The post-op config from the environment, falling back to the defaults. */
export function postopConfig(): PostopConfig {
  return {
    checkInAfterHours: envNumber("POSTOP_CHECK_IN_AFTER_HOURS", DEFAULT_POSTOP_CONFIG.checkInAfterHours),
    maxProcedureAgeHours: envNumber("POSTOP_MAX_PROCEDURE_AGE_HOURS", DEFAULT_POSTOP_CONFIG.maxProcedureAgeHours),
    replyWindowHours: envNumber("POSTOP_REPLY_WINDOW_HOURS", DEFAULT_POSTOP_CONFIG.replyWindowHours),
    maxDraftsPerRun: envNumber("POSTOP_MAX_DRAFTS_PER_RUN", DEFAULT_POSTOP_CONFIG.maxDraftsPerRun),
    maxExaminedPerRun: envNumber("POSTOP_MAX_EXAMINED_PER_RUN", DEFAULT_POSTOP_CONFIG.maxExaminedPerRun),
  };
}

/**
 * One escalation: a reply a human must handle.
 *
 * `triageReason` is a plain string rather than the EscalationReason union, and
 * that is deliberate at the persistence boundary: the classifier is expected to
 * gain categories, and a row written by a newer deploy must still READ on an older
 * one rather than blowing up a worklist query. The union is the authority inside
 * the module; the stored value is a label.
 */
export interface PostopEscalationRecord {
  id: string;
  targetId: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: TouchChannel;
  /** The patient's own words. Read by a person, never re-sent. */
  replyBody: string;
  triageReason: string;
  /** The token or phrase the classifier matched. */
  matched: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
