// ===========================================================================
// THE PATIENT'S RESCHEDULE TEXT.
//
// PURE and unit-tested. One template, no variants, no model in the loop.
//
// House rules, all absolute:
//   - Never the words NHS or private. Never any AI or vendor name.
//   - Plain British English. No exclamation mark, no encouragement.
//   - Times are written 2.30pm in PATIENT copy while every staff surface stays
//     14:30, because that is how a patient reads a time and how the practice
//     writes one to them.
//
// THE CLINICIAN IS DELIBERATELY NOT NAMED. A patient does not choose their
// clinician, and naming a new one invites a call the practice did not ask for.
// What that gives up is that a patient who wanted a specific dentist will not
// learn from the text that they were reassigned; the copy invites a call, and the
// practice manager sees the reassignment in the confirmation dialog.
// ===========================================================================

const LONDON_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The absolute cap on a rendered body, so one SMS segment budget cannot blow out. */
export const DRAFT_MAX_CHARS = 300;

export interface DraftMoveArgs {
  firstName: string;
  siteName: string;
  /** null = no number configured. A GUESSED phone number in a patient text is not acceptable. */
  sitePhone: string | null;
  newStartIso: string;
}

export type DraftResult =
  | { ok: true; body: string }
  | { ok: false; reason: "no_phone" | "bad_time" };

interface LondonParts {
  weekday: string;
  day: string;
  month: string;
  hour: number;
  minute: number;
}

function londonParts(iso: string): LondonParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const parts = LONDON_PARTS.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hourRaw = Number(get("hour"));
  return {
    weekday: get("weekday"),
    day: get("day"),
    month: get("month"),
    hour: Number.isFinite(hourRaw) ? hourRaw % 24 : 0,
    minute: Number(get("minute")) || 0,
  };
}

/**
 * "2.30pm", "2pm", "12.05am". No leading zero, a full stop rather than a colon,
 * and ".00" dropped entirely: the form a British practice writes to a patient.
 */
export function patientTimeLabel(hour24: number, minute: number): string {
  const suffix = hour24 < 12 ? "am" : "pm";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0
    ? `${h12}${suffix}`
    : `${h12}.${String(minute).padStart(2, "0")}${suffix}`;
}

/**
 * The reschedule text.
 *
 * No phone number configured returns { ok: false, reason: "no_phone" }, and the
 * caller then does NOT enqueue. It never renders a body with a placeholder left
 * in it: a text telling a patient to ring {SitePhone} is worse than no text.
 */
export function draftMoveText(args: DraftMoveArgs): DraftResult {
  if (args.sitePhone === null || args.sitePhone.trim() === "") return { ok: false, reason: "no_phone" };

  const p = londonParts(args.newStartIso);
  if (!p) return { ok: false, reason: "bad_time" };

  const first = args.firstName.trim() === "" ? "there" : args.firstName.trim();
  const when = `${p.weekday} ${p.day} ${p.month} at ${patientTimeLabel(p.hour, p.minute)}`;
  const body =
    `Hello ${first}, your appointment at ${args.siteName} has been moved to ${when}. ` +
    `If that does not suit, please call us on ${args.sitePhone.trim()}. Vitality Dental Care.`;

  if (body.length > DRAFT_MAX_CHARS) {
    // Refuse rather than truncate: a half-sentence about an appointment time is
    // worse than no message at all.
    return { ok: false, reason: "bad_time" };
  }
  return { ok: true, body };
}
