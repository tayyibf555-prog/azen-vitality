// ---------------------------------------------------------------------------
// FIRST-TICK RAMP for the no-show sweep.
//
// No-show confirmations are TRANSACTIONAL: the shared drain exempts them from
// the per-recipient daily frequency cap (drain/route.ts marks the noshow source
// `transactional: true`), and the module has no daily contact limit of its own
// the way recall and reactivation do. So unlike every other sending module, the
// only thing standing between "owner flips the switch" and "every due cadence
// texts a real patient in one tick" is this file.
//
// At the time of writing the live database holds 911 active cadences already
// past their next_due_at, of which ~107 would draft and send on the very first
// tick after the toggle goes on. That is not a ramp, it is a blast — and it is
// also ~107 sequential Anthropic drafts inside a 300s function, so most of it
// would time out half-sent.
//
// Two rules fix it, and they only work together:
//
//   1. SETTLE BEFORE SENDING. The great majority of that backlog is stale: the
//      appointment has already started, or the patient confirmed/cancelled, or
//      the cadence has run out of steps. Those cost nothing to close. If the
//      sweep expired them lazily — interleaved with sending, as it used to —
//      then a send cap that stops the loop would strand the rest of the stale
//      rows in the due list FOREVER, and they would be re-read on every future
//      tick. Expiring the whole backlog first is what makes a cap safe.
//
//   2. CAP THE SENDS, AND SPEND THE CAP WHERE IT MATTERS. What is left after
//      settling is genuinely due. Send at most `noshowSendCap()` of them, most
//      imminent appointment first: a T-3h final nudge for an appointment at
//      lunchtime beats a T-48h "are you still coming?" for one on Thursday.
//      The rest are simply not touched, so they stay active with next_due_at in
//      the past and the next tick picks them up. Nothing is lost; the backlog
//      drains over ticks instead of in one burst.
//
// Deferring cannot starve anyone: a deferred cadence's appointment only gets
// nearer, so it climbs the ordering on every subsequent tick.
//
// Everything here is pure — no I/O, no clock of its own (the caller passes
// `now`) — so the rules are unit tested rather than reasoned about in a route.
// ---------------------------------------------------------------------------

/**
 * Sends allowed in ONE sweep run. Deliberately conservative for the first ticks
 * after switch-on.
 *
 * THE CADENCE THIS NUMBER IS CALIBRATED AGAINST IS THE SCHEDULER'S, NOT A
 * REMEMBERED ONE. This comment used to say "the sweep runs hourly, so this is
 * ~600 confirmations a day". `app-sweep-noshow` is registered at a TEN-MINUTE
 * step (src/lib/agent-wiring/scheduler.ts, which is cron.job's truth per ruling
 * W3/31), so the real ceiling is 25 x 6 x 24 = 3,600 a day — six times what the
 * comment claimed, on the one constant whose whole job is to make a cold-start
 * blast impossible. A calibration contract that is out by a factor of six is
 * worse than none, because the next lane widens the cap trusting it.
 *
 * So: the sweep runs every ten minutes, and this is a ceiling of ~3,600
 * confirmations a day — far above the practice's steady-state need (roughly
 * three touches per booked appointment) while still making a cold-start blast
 * impossible. "the ramp's stated daily ceiling is derived from the scheduler's
 * real cadence" in ./ramp.test.ts recomputes both numbers from SCHEDULER and
 * this constant, so the day the job's minute changes, that test says so here
 * rather than leaving a false figure for somebody to reason from.
 */
export const NOSHOW_DEFAULT_MAX_SENDS_PER_RUN = 25;

/**
 * The per-run send cap (env NOSHOW_MAX_SENDS_PER_RUN), so the owner can widen or
 * pause the ramp without a redeploy. Hardened exactly like recall's daily cap: an
 * empty, non-numeric or negative value reverts to the default LOUDLY, so a typo
 * can never be mistaken for "unlimited". 0 is a valid "paused" value that sends
 * nothing (settling still happens). Unset uses the default with no noise.
 */
export function noshowSendCap(): number {
  const raw = process.env.NOSHOW_MAX_SENDS_PER_RUN;
  if (raw === undefined) return NOSHOW_DEFAULT_MAX_SENDS_PER_RUN;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  // Number("") is 0, so the empty check must precede the numeric check.
  if (trimmed === "" || !Number.isFinite(n) || n < 0) {
    console.error(
      `[noshow] NOSHOW_MAX_SENDS_PER_RUN="${raw}" is invalid; using default ${NOSHOW_DEFAULT_MAX_SENDS_PER_RUN}`,
    );
    return NOSHOW_DEFAULT_MAX_SENDS_PER_RUN;
  }
  return Math.floor(n);
}

/**
 * What the sweep should do with one due cadence.
 *  - `suppress`: leave it exactly as it is (platform admin excluded the patient).
 *  - `expire`:   close it now; it can never send again. Costs no message.
 *  - `send`:     a genuine, consented, still-confirmable touch.
 */
export type NoshowDisposition = "suppress" | "expire" | "send";

export interface NoshowDispositionInput {
  /** Platform admin status (inactive / do-not-contact) excludes this patient. */
  excluded: boolean;
  /** The target's own status; anything but "scheduled" means the patient settled it. */
  targetStatus: string;
  /** Appointment start (ISO). A started appointment can no longer be confirmed. */
  appointmentStartAt: string;
  /** Whether the cadence has a step after its current one. */
  hasNextStep: boolean;
  /** Whether that step's channel is consented. */
  channelConsented: boolean;
}

/**
 * The settle decision, in the sweep's original precedence.
 *
 * `excluded` deliberately WINS over every expiry rule: an admin exclusion is a
 * temporary override the practice can lift, so the cadence is left untouched and
 * resumes if the override goes away — closing it would be irreversible. (A
 * genuinely finished appointment gets closed by the next tick after the
 * exclusion is lifted anyway.)
 *
 * An unparseable or missing appointment time is treated as STARTED, i.e. expire.
 * Failing the other way would keep a cadence alive on a date nobody can read and
 * text a patient about an appointment that may be long gone.
 */
export function disposeCadence(input: NoshowDispositionInput, now: Date): NoshowDisposition {
  if (input.excluded) return "suppress";
  if (input.targetStatus !== "scheduled") return "expire";
  const start = Date.parse(input.appointmentStartAt);
  if (!Number.isFinite(start) || start <= now.getTime()) return "expire";
  if (!input.hasNextStep) return "expire";
  if (!input.channelConsented) return "expire";
  return "send";
}

/** The minimum a send candidate must expose for the ramp to order it. */
export interface NoshowSendOrderable {
  cadence: { id: string };
  target: { appointmentStartAt: string };
}

/**
 * Send candidates, most imminent appointment first.
 *
 * Ties break on cadence id so the order is TOTAL: `listDueCadences` has no ORDER
 * BY, so without a tie-break the identical backlog could be sliced differently on
 * two runs and a cadence could be deferred forever by pure chance.
 *
 * An unparseable appointment time sorts LAST rather than first — a junk date must
 * never jump the queue ahead of a real appointment three hours away. (In practice
 * disposeCadence has already expired those; this is the belt to its braces.)
 */
export function orderBySoonestAppointment<T extends NoshowSendOrderable>(candidates: readonly T[]): T[] {
  const key = (c: T): number => {
    const t = Date.parse(c.target.appointmentStartAt);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...candidates].sort((a, b) => {
    const d = key(a) - key(b);
    if (d !== 0) return d;
    return a.cadence.id < b.cadence.id ? -1 : a.cadence.id > b.cadence.id ? 1 : 0;
  });
}

/**
 * Split an ordered candidate list into what this run may send and what it must
 * leave for the next tick.
 *
 * The cap counts ATTEMPTS, not successes: a candidate in `send` whose draft or
 * enqueue throws may already have queued an outbox row, so retrying it inside the
 * same run to "fill" the cap is how you get a double-text. A run therefore touches
 * exactly min(candidates, cap) cadences for sending, every time.
 *
 * A non-finite or negative cap sends NOTHING — the cap failing closed is the
 * whole point of it existing.
 */
export function applySendCap<T>(ordered: readonly T[], cap: number): { send: T[]; deferred: T[] } {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  return { send: ordered.slice(0, limit), deferred: ordered.slice(limit) };
}
