// ---------------------------------------------------------------------------
// The detectors. Pure functions: no I/O, no clock read, no database, no Dentally.
// Everything they need arrives as a "reading", and every reading can be missing.
//
// A reading is missing (`null`) when the collector's read FAILED or was refused.
// That is not the same as a reading of zero, and the difference is the whole
// point of this module: zero high-risk appointments is a quiet day, and an
// unreadable no-show table is a blind spot. Both are silent, neither is a
// fabricated number, and only one of them is a bug.
//
// THE HONESTY AXIS, CONCRETELY
//
// The takings detector never adds up a payment. It consumes the dashboard's own
// `TakingsCell`s, whose contract is already "a figure that cannot be sourced is
// null, with a reason" (src/lib/dashboard/takings.ts). If the live payment scan
// did not reach back thirty days, the last-30 cell arrives null with
// "Takings unavailable: the live scan does not reach back this far." and this
// detector says nothing at all. There is no branch in this file that can turn a
// short scan into a percentage.
//
// Counts that came from a CAPPED read are handled the other way, because a cap
// still proves a floor: a query that returned its first hundred rows proves
// there are at least a hundred. Those alerts say "at least", in the sentence, in
// words. They never round a floor up into a total.
// ---------------------------------------------------------------------------

import { windowLength, type TakingsCell } from "@/lib/dashboard";
import { londonDayKey } from "@/lib/time/london";

import {
  APPROVAL_BACKLOG_MIN,
  APPROVAL_STALE_HOURS,
  LEAD_SLA_MINUTES,
  NOSHOW_CLUSTER_HIGH,
  NOSHOW_CLUSTER_MIN,
  OUTBOX_STUCK_HOURS,
  OUTBOX_STUCK_MIN,
  SEND_FAILURE_MIN,
  SEND_FAILURE_WINDOW_HOURS,
  TAKINGS_DROP_FRACTION,
  TAKINGS_DROP_HIGH_FRACTION,
  TAKINGS_DROP_MIN_PENCE,
  type Alert,
  type AlertSeverity,
} from "./types";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Formatting helpers. All deterministic and ICU-free on purpose: an alert
// sentence is asserted verbatim in the tests, and Intl output can shift between
// Node builds (narrow vs ordinary spaces in particular). A sentence that changes
// shape because the runtime changed is a test that fails for no reason.
// ---------------------------------------------------------------------------

/** "£1,240" / "-£85". Whole pounds: these are trend figures, not a ledger. */
export function formatPoundsRounded(pence: number): string {
  const pounds = Math.round(Math.abs(pence) / 100);
  const grouped = String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${pence < 0 ? "-" : ""}£${grouped}`;
}

/** "45 minutes" / "3 hours" / "2 days". Rounds down: never overstate an age. */
export function describeAge(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms >= DAY_MS) return plural(Math.floor(ms / DAY_MS), "day");
  if (ms >= HOUR_MS) return plural(Math.floor(ms / HOUR_MS), "hour");
  return plural(Math.max(1, Math.floor(ms / MINUTE_MS)), "minute");
}

/**
 * Make a piece of free text safe to put in a sentence we store and render.
 *
 * Names in this platform originate in Dentally or in a public enquiry form, so
 * they are untrusted text. This is the same posture as the closer's
 * sanitiseTreatmentName: strip anything that is not ordinary printable text,
 * collapse the whitespace, and cap the length. Nothing here reaches a model
 * prompt — these sentences are read by a person, never sent to one and never
 * completed by one — but a control character or a five-hundred-character "name"
 * has no business in an alert either.
 */
export function plainText(raw: unknown, fallback: string, maxChars = 60): string {
  if (typeof raw !== "string") return fallback;
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return fallback;
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars).trimEnd()}...` : stripped;
}

/** Parse an ISO instant, or null. Never NaN, never a silent 0. */
function millis(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// Readings.
// ---------------------------------------------------------------------------

/**
 * The three takings cells the trend is computed from, straight off the
 * dashboard's own strip. Any of them may be null — either because the whole read
 * failed, or because the dashboard itself declared that period unavailable.
 */
export interface TakingsReading {
  today: TakingsCell | null;
  last7: TakingsCell | null;
  last30: TakingsCell | null;
}

/** High-risk appointments still being defended. Null when the read failed. */
export interface NoshowReading {
  appointments: readonly { appointmentId: string; startAt: string }[] | null;
}

/** Enquiries with no first contact recorded. Null when the read failed. */
export interface LeadReading {
  leads: readonly { id: string; name: string; createdAt: string }[] | null;
}

/** One approval queue: drafts a human has to release before anything sends. */
export interface ApprovalQueueReading {
  /** Stable key for the dedupe key, e.g. "treatment-closer". */
  key: string;
  /** Owner-facing name, taken from the systems catalog so it cannot drift. */
  label: string;
  href: string | null;
  /** Drafts waiting. A FLOOR when `truncated`, an exact total otherwise. */
  count: number;
  /** Oldest waiting draft, or null when the queue is empty or undateable. */
  oldestAt: string | null;
  /** True when `count` came from a capped read, so it is "at least", not "exactly". */
  truncated: boolean;
}

/** One outbox: messages approved and queued, and messages that failed to send. */
export interface OutboxReading {
  key: string;
  label: string;
  href: string | null;
  /** Queued rows older than `stuckCutoffHours`. A FLOOR when `truncated`. */
  stuckCount: number;
  oldestStuckAt: string | null;
  /**
   * The age the collector actually filtered on. The detector refuses the reading
   * unless it matches OUTBOX_STUCK_HOURS — a reading built against a different
   * cutoff describes a different condition, and silently reporting it under this
   * one's wording is exactly the kind of quiet drift the honesty rule forbids.
   */
  stuckCutoffHours: number;
  /** Rows marked failed inside `failureWindowHours`. A FLOOR when `truncated`. */
  failedCount: number;
  /** Likewise checked against SEND_FAILURE_WINDOW_HOURS before anything is said. */
  failureWindowHours: number;
  truncated: boolean;
}

/** Everything the detectors run on, for one client, at one instant. */
export interface AnomalyReadings {
  now: Date;
  takings: TakingsReading | null;
  noshow: NoshowReading | null;
  leads: LeadReading | null;
  approvals: readonly ApprovalQueueReading[] | null;
  outboxes: readonly OutboxReading[] | null;
}

// ---------------------------------------------------------------------------
// 1. TAKINGS MATERIALLY OFF TREND
// ---------------------------------------------------------------------------

/**
 * Compares the last SIX FULL DAYS against the daily rate of the twenty-three
 * days before them, entirely from the dashboard's own cells.
 *
 * WHY TODAY IS SUBTRACTED OUT. `last7` ends on today, and today is a part-day:
 * at nine in the morning it holds one appointment's takings. Comparing a window
 * containing it against a baseline of whole days biases the current side down by
 * up to a seventh, which on a quiet Tuesday morning is enough to invent a
 * twenty-five percent "fall" out of nothing. So the current side is
 * `last7 - today` over six whole days and the baseline is `last30 - last7` over
 * twenty-three whole days, and both sides are then daily rates.
 *
 * The window lengths are read off the cells' own windows rather than hard-coded,
 * so if the strip's periods ever change the arithmetic follows rather than
 * quietly reporting a six-day figure as a seven-day one.
 *
 * ONLY A FALL IS REPORTED. "Takings are up" is not something an owner needs
 * woken for, and a symmetric detector would spend half its alerts saying so.
 */
export function detectTakingsTrend(reading: TakingsReading | null, now: Date): Alert | null {
  if (!reading) return null;
  const { today, last7, last30 } = reading;
  if (!today || !last7 || !last30) return null;

  // The dashboard's own verdict. A null total always carries a reason; either
  // way, a period the dashboard will not report is a period we will not report.
  if (today.totalPence === null || last7.totalPence === null || last30.totalPence === null) {
    return null;
  }

  const recentDays = windowLength(last7.window) - windowLength(today.window);
  const baselineDays = windowLength(last30.window) - windowLength(last7.window);
  if (recentDays <= 0 || baselineDays <= 0) return null;

  const recentPence = last7.totalPence - today.totalPence;
  const baselinePence = last30.totalPence - last7.totalPence;
  // A baseline of zero or less cannot be fallen from: there is no trend to be off.
  if (baselinePence <= 0) return null;

  const recentDaily = recentPence / recentDays;
  const baselineDaily = baselinePence / baselineDays;
  const shortfallDaily = baselineDaily - recentDaily;

  // ONLY A FALL IS REPORTED, and the proportional test below is what enforces
  // it: the baseline is positive by the guard above, so takings being UP gives a
  // negative fraction, which can never clear TAKINGS_DROP_FRACTION. There is
  // deliberately no separate "is it a rise" branch, because a branch no input
  // can reach is a branch no test can hold to account.
  const fraction = shortfallDaily / baselineDaily;
  const shortfallPence = Math.round(shortfallDaily * recentDays);
  // BOTH tests must pass. The proportion alone would alert a practice whose
  // takings fell from £40 to £28; the money alone would alert a big practice on
  // an ordinary week. Together they mean "a real amount, really missing".
  if (fraction < TAKINGS_DROP_FRACTION) return null;
  if (shortfallPence < TAKINGS_DROP_MIN_PENCE) return null;

  const severity: AlertSeverity = fraction >= TAKINGS_DROP_HIGH_FRACTION ? "high" : "medium";
  const percent = Math.round(fraction * 100);
  return {
    kind: "takings_trend",
    severity,
    dedupeKey: "takings_trend:last7",
    sentence:
      `Takings over the last ${recentDays} days are running at ${formatPoundsRounded(Math.round(recentDaily))} a day, ` +
      `${percent}% below the ${formatPoundsRounded(Math.round(baselineDaily))} a day of the ${baselineDays} days before that. ` +
      `That is about ${formatPoundsRounded(shortfallPence)} less than the same stretch would normally take. ` +
      `Worth checking the diary and the payments page.`,
    href: "payments",
    at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. A CLUSTER OF HIGH NO-SHOW RISK IN TODAY'S OR TOMORROW'S DIARY
// ---------------------------------------------------------------------------

/**
 * Keyed by the diary DAY, not by the condition alone: tomorrow's cluster is a
 * genuinely new problem needing a fresh round of phone calls, not yesterday's
 * problem still open. One alert per day is the right cadence; two are not.
 */
export function detectNoshowCluster(reading: NoshowReading | null, now: Date): Alert | null {
  if (!reading || reading.appointments === null) return null;

  const today = londonDayKey(now);
  const tomorrow = londonDayKey(new Date(now.getTime() + DAY_MS));
  let count = 0;
  for (const appt of reading.appointments) {
    const t = millis(appt.startAt);
    if (t === null) continue; // an undateable row is not evidence of anything
    const day = londonDayKey(new Date(t));
    if (day === today || day === tomorrow) count += 1;
  }

  if (count < NOSHOW_CLUSTER_MIN) return null;

  const severity: AlertSeverity = count >= NOSHOW_CLUSTER_HIGH ? "high" : "medium";
  return {
    kind: "noshow_cluster",
    severity,
    dedupeKey: `noshow_cluster:${today}`,
    sentence:
      `${count} patients booked in today or tomorrow are at high risk of not turning up. ` +
      `Confirming them now is the cheapest way to protect the diary.`,
    href: "no-show-defence",
    at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 3. A LEAD PAST ITS SPEED-TO-LEAD SLA WITHOUT CONTACT
// ---------------------------------------------------------------------------

/**
 * One alert per lead, keyed by the lead's own id, because each one is a
 * different person waiting and each needs its own phone call. The condition
 * clears when the lead is contacted, at which point the collector stops
 * reporting it and the sweep resolves the alert.
 *
 * This fires whether or not the speed-to-lead system is switched on. A practice
 * that handles enquiries by hand still wants to know one has gone unanswered for
 * an hour; the alert names the fact, not the automation.
 */
export function detectLeadSla(reading: LeadReading | null, now: Date): Alert[] {
  if (!reading || reading.leads === null) return [];

  const cutoff = now.getTime() - LEAD_SLA_MINUTES * MINUTE_MS;
  const out: Alert[] = [];
  for (const lead of reading.leads) {
    const created = millis(lead.createdAt);
    if (created === null) continue;
    if (created > cutoff) continue;
    const name = plainText(lead.name, "Someone");
    out.push({
      kind: "lead_sla",
      severity: "high",
      dedupeKey: `lead_sla:${lead.id}`,
      sentence:
        `${name} enquired ${describeAge(now.getTime() - created)} ago and still has not been contacted. ` +
        `Enquiries answered in the first few minutes are the ones that book.`,
      href: "speed-to-lead",
      at: lead.createdAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4a. AN APPROVAL QUEUE BACKING UP
// ---------------------------------------------------------------------------

/**
 * Two independent triggers, because a queue fails in two shapes: many drafts
 * nobody has got to, or one draft nobody ever will. Either alone is enough.
 */
export function detectApprovalBacklog(
  readings: readonly ApprovalQueueReading[] | null,
  now: Date,
): Alert[] {
  if (readings === null) return [];

  const out: Alert[] = [];
  for (const queue of readings) {
    if (queue.count <= 0) continue;

    const oldest = millis(queue.oldestAt);
    const ageMs = oldest === null ? null : now.getTime() - oldest;
    const stale = ageMs !== null && ageMs >= APPROVAL_STALE_HOURS * HOUR_MS;
    const big = queue.count >= APPROVAL_BACKLOG_MIN;
    if (!big && !stale) continue;

    // "at least" is not decoration: a capped read proves a floor and nothing more.
    const howMany = queue.truncated ? `At least ${queue.count}` : `${queue.count}`;
    const noun = queue.count === 1 ? "message is" : "messages are";
    const ageClause = ageMs === null ? "" : ` The oldest has been waiting ${describeAge(ageMs)}.`;
    out.push({
      kind: "approval_backlog",
      severity: "medium",
      dedupeKey: `approval_backlog:${queue.key}`,
      sentence:
        `${howMany} ${noun} waiting for someone to approve them in ${plainText(queue.label, "a system")}.` +
        `${ageClause} Nothing goes out until a person releases them.`,
      href: queue.href,
      at: queue.oldestAt ?? now.toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4b. AN OUTBOX STUCK, AND 4c. SENDS FAILING REPEATEDLY
// ---------------------------------------------------------------------------

/**
 * Stuck: messages a person has already approved that are still sitting queued
 * hours later. This is the one that matters most operationally, because the
 * practice believes those patients were contacted and they were not.
 *
 * The reading is refused outright unless it was built against this module's own
 * cutoff. The cutoff lives in the SQL (a count query, not a capped row read, so
 * a big backlog is counted rather than truncated at a hundred), which puts the
 * threshold one file away from the detector — so the detector checks it rather
 * than trusting it.
 */
export function detectOutboxStuck(
  readings: readonly OutboxReading[] | null,
  now: Date,
): Alert[] {
  if (readings === null) return [];

  const out: Alert[] = [];
  for (const box of readings) {
    if (box.stuckCutoffHours !== OUTBOX_STUCK_HOURS) continue;
    if (box.stuckCount < OUTBOX_STUCK_MIN) continue;

    const oldest = millis(box.oldestStuckAt);
    const ageClause =
      oldest === null ? "" : ` The oldest has been queued for ${describeAge(now.getTime() - oldest)}.`;
    const howMany = box.truncated ? `At least ${box.stuckCount}` : `${box.stuckCount}`;
    out.push({
      kind: "outbox_stuck",
      severity: "high",
      dedupeKey: `outbox_stuck:${box.key}`,
      sentence:
        `${howMany} approved ${plainText(box.label, "system")} messages have not gone out yet.` +
        `${ageClause} The practice will assume those patients were contacted.`,
      href: box.href,
      at: box.oldestStuckAt ?? now.toISOString(),
    });
  }
  return out;
}

/**
 * Failing: the platform records a send that could not be delivered by marking
 * its outbox row `failed`, and that is the ONLY repeated-error record the
 * platform keeps. There is no per-sweep error log anywhere in this codebase, so
 * a run of failures in one module's outbox is the honest observable proxy for
 * "that module's sending is erroring repeatedly", and it is what this reports.
 * A true sweep-level error detector would need every sweep instrumented to write
 * its outcome somewhere, which is a change to twenty routes and deliberately not
 * in this lane.
 */
export function detectSendFailures(
  readings: readonly OutboxReading[] | null,
  now: Date,
): Alert[] {
  if (readings === null) return [];

  const out: Alert[] = [];
  for (const box of readings) {
    if (box.failureWindowHours !== SEND_FAILURE_WINDOW_HOURS) continue;
    if (box.failedCount < SEND_FAILURE_MIN) continue;

    const howMany = box.truncated ? `At least ${box.failedCount}` : `${box.failedCount}`;
    out.push({
      kind: "send_failures",
      severity: "high",
      dedupeKey: `send_failures:${box.key}`,
      sentence:
        `${howMany} ${plainText(box.label, "system")} messages failed to send in the last ${box.failureWindowHours} hours. ` +
        `Something is wrong with sending, not with the message.`,
      href: box.href,
      at: now.toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Run every detector over one set of readings.
 *
 * Deterministic order (severity, then dedupe key) so two runs over the same
 * readings produce byte-identical output — which is what makes the sweep's
 * "nothing changed" path provable rather than probable.
 *
 * A quiet practice with sound readings gets an empty array, and so does a
 * practice whose every read failed. Telling those two apart is the sweep's job,
 * not this one's: it counts the refusals separately.
 */
export function detectAnomalies(readings: AnomalyReadings): Alert[] {
  const { now } = readings;
  const alerts: Alert[] = [
    detectTakingsTrend(readings.takings, now),
    detectNoshowCluster(readings.noshow, now),
    ...detectLeadSla(readings.leads, now),
    ...detectApprovalBacklog(readings.approvals, now),
    ...detectOutboxStuck(readings.outboxes, now),
    ...detectSendFailures(readings.outboxes, now),
  ].filter((a): a is Alert => a !== null);

  return alerts.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
}
