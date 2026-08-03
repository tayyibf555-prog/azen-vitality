// What an inbound call to the practice line should produce, as a pure rule.
//
// This branch tree used to live inline in the Twilio Voice webhook, where the
// only way to exercise it was to drive the whole HTTP route. Everything that
// decides WHAT should happen now lives here; the route keeps the I/O, the
// timeouts and the cooperative stand-down flag, because those are properties of
// a live call leg rather than rules.
//
// No clock and no network are read here: callers pass everything in.

import type { Site } from "@/lib/types";
import { isOutsideHours } from "./hours";
import {
  spokenClosedAlreadyTexted,
  spokenClosedNoText,
  spokenOpenNoText,
} from "./callback-copy";

/** What the route should DO about this call, beyond logging it. */
export type CallAction =
  /** Outside hours: route into speed-to-lead (AI-drafted opener, SLA, shared dedup). */
  | "lead-bridge"
  /** In hours: nobody could pick up, so text the caller a callback promise. */
  | "callback-sms"
  /** Withheld, deduped, switched off or opted out: log only, send nothing. */
  | "none";

/**
 * Whether a capture happened while the site was CLOSED, or as daytime overflow.
 *
 * Derived, never stored: `after_hours_capture` has no column for it, and adding
 * one would leave every existing row unlabelled. `capturedAt` plus the site's
 * opening hours already answer the question at read time.
 */
export type CaptureTiming = "after_hours" | "overflow";

export interface CallOutcomeInput {
  /** The site was closed at the moment of the call. */
  outside: boolean;
  /** The caller ID is a real, textable number (not withheld / a short code). */
  dialable: boolean;
  /** An open capture from this number already exists inside the dedup window. */
  alreadyCaptured: boolean;
  /** The owner's After-hours kill switch is ON for this client. */
  systemOn: boolean;
  /** This number (or the identified patient) has opted out of texts. */
  suppressed: boolean;
  /** Resolved practice name, for the spoken line. */
  practiceName: string;
}

export interface CallOutcome {
  /** Write a capture row for the worklist. */
  capture: boolean;
  /** What to do about contacting the caller. */
  action: CallAction;
  /**
   * The line to SPEAK given this decision alone, i.e. assuming no text goes out.
   *
   * It never promises a text. When the route's send genuinely succeeds it swaps
   * in the matching "text sent" line from callback-copy; if the send is
   * suppressed, switched off, times out or throws, this line is what the caller
   * hears, so a promise can never outrun a message.
   */
  spoken: string;
  /** Which timing this capture will be labelled with on the task queue. */
  taskKindHint: CaptureTiming;
}

/**
 * Decide the outcome of one inbound call.
 *
 * PRECEDENCE, highest first. The order is the rule, not an implementation
 * detail, so each step says why it outranks the next:
 *
 *  1. NOT DIALABLE wins over everything. A withheld number cannot be texted and
 *     cannot be deduped (every withheld caller shares the literal "withheld", so
 *     deduping on it would collapse different people into one and lose a call).
 *     It is always captured, flagged, for a manual callback.
 *  2. ALREADY CAPTURED suppresses a second row and a second text, so a repeat
 *     dialler cannot flood the worklist or run up SMS spend.
 *  3. SYSTEM OFF still captures. The owner's kill switch stops OUTBOUND; it must
 *     never lose the record of someone trying to reach the practice.
 *  4. SUPPRESSED still captures, for the same reason: an opt-out is a refusal of
 *     texts, not a refusal of a callback.
 *  5. Otherwise: outside hours goes to the speed-to-lead bridge, in hours gets
 *     the overflow callback text.
 */
export function decideCallOutcome(input: CallOutcomeInput): CallOutcome {
  const { outside, practiceName } = input;
  const taskKindHint: CaptureTiming = outside ? "after_hours" : "overflow";
  const quiet = outside ? spokenClosedNoText(practiceName) : spokenOpenNoText(practiceName);

  if (!input.dialable) {
    return { capture: true, action: "none", spoken: quiet, taskKindHint };
  }
  if (input.alreadyCaptured) {
    return {
      capture: false,
      action: "none",
      // Only the closed-hours path had definitely texted them: the in-hours line
      // stays a promise of nothing, because the earlier capture may have been
      // suppressed or switched off.
      spoken: outside ? spokenClosedAlreadyTexted(practiceName) : quiet,
      taskKindHint,
    };
  }
  if (!input.systemOn || input.suppressed) {
    return { capture: true, action: "none", spoken: quiet, taskKindHint };
  }
  return {
    capture: true,
    action: outside ? "lead-bridge" : "callback-sms",
    spoken: quiet,
    taskKindHint,
  };
}

/**
 * Whether a stored capture happened out of hours or as daytime overflow.
 *
 * An unparseable timestamp falls back to "after_hours", matching what
 * `isOutsideHours` already does when it cannot resolve the site: the
 * conservative label, and the one every historical row carried before this
 * distinction existed.
 */
export function captureTiming(capturedAtIso: string, site: Site | undefined): CaptureTiming {
  const at = new Date(capturedAtIso);
  if (Number.isNaN(at.getTime())) return "after_hours";
  return isOutsideHours(site, at) ? "after_hours" : "overflow";
}

export interface AfterHoursTaskCopy {
  /** Shown when the capture carries no message body of its own. */
  subtitle: string;
  dueHint: string;
}

/**
 * Staff-facing wording for an after-hours callback task.
 *
 * A 2pm overflow call labelled "out of hours" is simply wrong, and the person
 * picking up the callback reads that label to decide what to say.
 */
export function afterHoursTaskCopy(timing: CaptureTiming): AfterHoursTaskCopy {
  return timing === "overflow"
    ? { subtitle: "Overflow callback, the practice could not get to the call", dueHint: "missed in hours" }
    : { subtitle: "Tried to reach the practice out of hours", dueHint: "out of hours" };
}
