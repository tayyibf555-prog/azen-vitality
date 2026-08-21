// Treatment-plan closer: the approval surface's pure half.
//
// Request parsing and the staff-facing wording for a refusal. PURE — no I/O, no
// clock, no environment — so the two rules that matter here are directly testable
// and mutation-checkable:
//
//   1. WHAT A REQUEST MAY CARRY. A caller may name a touch, may supply an edited
//      body, and may give a discard reason. It may not name a recipient, a site, an
//      opportunity, or a channel. Those all come from the STORED touch and its
//      opportunity, server-side, so a caller cannot redirect an approved message at
//      somebody else or switch it onto a channel the patient has not consented to.
//      The parser has no field for any of them, which is a stronger guarantee than
//      a route remembering not to read one.
//
//   2. WHAT A REFUSAL SAYS. A compliance refusal shown as "invented_figure" is a
//      developer's word in a receptionist's screen. Each category gets one sentence
//      of plain English naming what to change.

import { isCloserDiscardReason, type CloserDiscardReason } from "./discard";
import type { CloserRefusalCategory } from "./draft";

/**
 * Longest edited body accepted before the compliance scan runs.
 *
 * A cheap payload ceiling, not the real limit: `checkCloserDraft` enforces the
 * per-channel cap (480 chars for SMS, 1400 for email) and will refuse anything
 * over it with a message the human can act on. This only stops a megabyte of text
 * reaching the regex passes at all.
 */
export const MAX_EDITED_BODY_CHARS = 4000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ApproveRequest {
  touchId: string;
  /** null means "release the draft as written". A string is a human's edit. */
  body: string | null;
}

export interface DiscardRequest {
  touchId: string;
  reason: CloserDiscardReason;
}

function readTouchId(raw: Record<string, unknown>): ParseResult<string> {
  const touchId = raw.touchId;
  if (typeof touchId !== "string" || touchId.trim() === "") {
    return { ok: false, error: "touchId is required" };
  }
  return { ok: true, value: touchId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parse an approve request.
 *
 * An ABSENT body means "send it as drafted". A body that is present but blank is a
 * MISTAKE, not an instruction to send an empty message, so it is refused here
 * rather than passed to the scan (which would refuse it as `empty` — the same
 * answer, in worse words).
 */
export function parseApproveRequest(input: unknown): ParseResult<ApproveRequest> {
  const raw = asRecord(input);
  const id = readTouchId(raw);
  if (!id.ok) return id;

  const body = raw.body;
  if (body === undefined || body === null) {
    return { ok: true, value: { touchId: id.value, body: null } };
  }
  if (typeof body !== "string") return { ok: false, error: "body must be a string" };
  const trimmed = body.trim();
  if (trimmed === "") return { ok: false, error: "An edited message cannot be empty." };
  if (trimmed.length > MAX_EDITED_BODY_CHARS) {
    return { ok: false, error: "That message is far too long to send." };
  }
  return { ok: true, value: { touchId: id.value, body: trimmed } };
}

/** Parse a discard request. The reason is REQUIRED and must be one of the closed set. */
export function parseDiscardRequest(input: unknown): ParseResult<DiscardRequest> {
  const raw = asRecord(input);
  const id = readTouchId(raw);
  if (!id.ok) return id;

  const reason = raw.reason;
  if (!isCloserDiscardReason(reason)) {
    return { ok: false, error: "reason must be one of the offered discard reasons" };
  }
  return { ok: true, value: { touchId: id.value, reason } };
}

/**
 * One sentence of plain English per refusal category, addressed to the person who
 * just typed the message. Each names the thing to change, because "refused" with
 * no instruction turns into the staff member deleting the whole message and
 * writing something worse.
 */
export const CLOSER_REFUSAL_MESSAGE: Record<CloserRefusalCategory, string> = {
  empty: "The message is empty.",
  funding:
    "Take out the wording about how treatment is funded. Patients should never see those internal labels.",
  clinical:
    "Take out the clinical advice or opinion. A follow-up may offer an appointment, it may not say what someone needs.",
  debt:
    "Reword anything that says the patient owes money. The figure we hold is the cost of the treatment still to be done, not a bill.",
  harm_from_delay:
    "Take out anything suggesting things will get worse, or cost more, if the patient waits.",
  outcome_claim:
    "Take out the promise about the result. Nothing about treatment may be guaranteed or predicted.",
  pressure:
    "Take out the urgency, the deadline or the limited availability. This is a follow-up, not an offer.",
  invented_figure:
    "The only figure this message may carry is the one on the patient's own plan. Remove any other amount or percentage.",
  em_dash: "Replace the long dash with a comma or a full stop.",
  placeholder: "There is an unfilled placeholder left in the message.",
  preamble:
    "The message must open by greeting the patient by their first name. Take out any note or narration before the greeting.",
  too_long: "The message is too long for this channel. Shorten it.",
};

/** The sentence for a category, with a safe fallback for anything unrecognised. */
export function refusalMessage(category: string): string {
  return (
    CLOSER_REFUSAL_MESSAGE[category as CloserRefusalCategory] ??
    "That wording cannot be sent to a patient."
  );
}
