import "server-only";

import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { readPracticeDashboard } from "@/lib/dashboard/read";
import { getSites } from "@/lib/mock/clients";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { listLeadsByIds, listUncontacted } from "@/lib/speed-to-lead/repository";

import type {
  AnomalyReadings,
  ApprovalQueueReading,
  LeadReading,
  NoshowReading,
  OutboxReading,
  TakingsReading,
} from "./detect";
import {
  APPROVAL_WATCHES,
  OUTBOX_WATCHES,
  readApprovalQueue,
  readOutboxHealth,
} from "./repository";
import { LEAD_SLA_MINUTES } from "./types";

// ---------------------------------------------------------------------------
// Gathering the readings. This is the only file in the module that does I/O.
//
// It reads NOTHING NEW. The takings figures are the practice dashboard's own
// assembled view, the no-show risks are the no-show module's own target table,
// the uncontacted enquiries are the speed-to-lead sweep's own query, and the
// queue figures are bounded counts over tables the messaging drain already owns.
// The one Dentally-touching read (the dashboard) goes through the shared cached
// view under the BACKGROUND priority class, so an alerting pass can never take
// quota away from a receptionist with a patient on the phone.
//
// Every read is independent and every failure is local. A failure produces a
// NULL reading and a dedupe-key prefix in `unproven`, and those two things do
// different jobs: the null stops an alert being invented, and the prefix stops
// an existing alert being resolved by a pass that could not actually check it.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** The dedupe-key prefix the lead detector uses. One place, so both ends agree. */
const LEAD_KEY_PREFIX = "lead_sla:";

/**
 * How many aged leads one pass will re-read by id. Matches listLeadsByIds' own
 * MAX_BATCH_IDS ceiling: asking for more would be silently trimmed there, and an
 * id we did not actually get an answer about is treated as unproven below, so a
 * practice with an absurd backlog degrades into "left alone", never into
 * "resolved because we stopped asking".
 */
const LEAD_RECHECK_CAP = 200;

export interface CollectedReadings {
  readings: AnomalyReadings;
  /**
   * Dedupe-key prefixes this pass could not evaluate. Anything open underneath
   * them is left alone rather than being marked resolved. See keysToResolve.
   *
   * A prefix may name a whole detector ("lead_sla:", the table was unreadable) or
   * exactly one condition ("lead_sla:<id>", that one lead could not be re-read) —
   * a complete key is simply the narrowest prefix there is, so both go in here
   * and neither needs its own mechanism.
   */
  unproven: string[];
  /** Human-readable notes for the sweep's response body, for operating it. */
  refusals: string[];
}

/**
 * The takings cells the trend detector needs, taken from the dashboard's own
 * all-sites scope.
 *
 * The BACKGROUND priority scope is declared here as well as on the sweep route.
 * That is deliberate rather than redundant: nesting the same priority is a no-op,
 * and it means any future caller of this function inherits the right class
 * without having to remember to wrap it.
 *
 * NOTE WHAT IS NOT HAPPENING HERE. No payment is read, summed, or converted.
 * The three cells arrive exactly as the dashboard published them, including
 * their `unavailableReason` when the live scan could not reach that far back,
 * and the detector refuses on a null total. The only way this module can state a
 * takings figure is for the dashboard to have stated it first.
 */
async function collectTakings(clientId: string, now: Date): Promise<TakingsReading | null> {
  try {
    const view = await runWithDentallyPriority("background", () =>
      readPracticeDashboard({ clientId, now }),
    );
    const scope = view.scopes.find((s) => s.siteId === null);
    if (!scope) return null;
    const cell = (period: string) => scope.strip.cells.find((c) => c.period === period) ?? null;
    return { today: cell("today"), last7: cell("last7"), last30: cell("last30") };
  } catch {
    return null;
  }
}

/** High-risk appointments still being defended, across the client's sites. */
async function collectNoshow(siteIds: string[]): Promise<NoshowReading | null> {
  try {
    const targets = await listNoshowTargets({
      siteIds,
      statuses: ["scheduled"],
      riskBands: ["high"],
    });
    return {
      appointments: targets.map((t) => ({
        appointmentId: t.appointmentId,
        startAt: t.appointmentStartAt,
      })),
    };
  } catch {
    return null;
  }
}

/** What the lead read produced: a reading, plus whatever it could not prove. */
interface LeadCollection {
  reading: LeadReading | null;
  unproven: string[];
  refusals: string[];
}

/**
 * Enquiries with no first contact recorded, older than the alerting SLA.
 *
 * `listUncontacted` is the speed-to-lead sweep's OWN query, reused rather than
 * reimplemented, which matters because of the guard inside it: it is bounded to
 * the last 48 hours, so a lead stranded at 'new' from before the system existed
 * cannot generate an alert today. It is not site-scoped (the platform runs one
 * practice), so it is scoped here.
 *
 * THAT BOUND IS A RAISE GUARD AND IT MUST NOT BECOME A RESOLVE GUARD.
 *
 * A lead that already has an open alert eventually ages out of the query, and a
 * pass that simply stopped seeing it would find no matching alert in `raised` and
 * mark the row resolved — closing a real alert because of a query bound rather
 * than because anybody rang the patient. A Friday enquiry nobody answers would
 * lose its alert by Sunday, silently, which is the exact failure the `unproven`
 * mechanism exists to prevent, arriving through a WHERE clause instead of an
 * error. So every open lead alert the bounded read did not cover is CHECKED
 * AGAINST THE LEAD ITSELF (`listLeadsByIds`, site-scoped, no created_at floor):
 *
 *   still 'new' with no first response -> the condition is still true, so the
 *                                         lead goes back into the reading and the
 *                                         alert is refreshed rather than closed;
 *   contacted, or moved on             -> evidence the condition ENDED, so the
 *                                         lead is left out and the pass resolves
 *                                         the alert honestly;
 *   not returned at all, or the read
 *   failed                             -> we did not look. UNPROVEN: the row is
 *                                         left exactly as it is.
 *
 * The re-check asks only about ids that ALREADY have an open alert, so it cannot
 * invent an alert for an old lead — the raise direction of the bound is untouched.
 * "Still uncontacted" is spelled with listUncontacted's own predicate (stage 'new'
 * AND no first_response_at), because an alert raised by that query's definition
 * must be cleared by the same one.
 */
async function collectLeads(
  siteIds: string[],
  now: Date,
  openLeadIds: readonly string[],
): Promise<LeadCollection> {
  const olderThan = new Date(now.getTime() - LEAD_SLA_MINUTES * MINUTE_MS).toISOString();
  const wanted = new Set(siteIds);

  let visible: { id: string; name: string; createdAt: string }[];
  try {
    const leads = await listUncontacted(olderThan);
    visible = leads
      .filter((l) => wanted.has(l.siteId))
      .map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt }));
  } catch {
    return {
      reading: null,
      unproven: [LEAD_KEY_PREFIX],
      refusals: ["leads: the enquiry table could not be read"],
    };
  }

  const covered = new Set(visible.map((l) => l.id));
  const missed = openLeadIds.filter((id) => !covered.has(id));
  if (missed.length === 0) return { reading: { leads: visible }, unproven: [], refusals: [] };

  let rechecked: Awaited<ReturnType<typeof listLeadsByIds>>;
  try {
    rechecked = await listLeadsByIds({ siteIds, ids: missed.slice(0, LEAD_RECHECK_CAP) });
  } catch {
    // The bounded read worked, so the leads it DID cover are sound and reported.
    // The ones it did not are unproven, one key each: an open alert is never
    // closed on the strength of a read that fell over.
    return {
      reading: { leads: visible },
      unproven: missed.map((id) => `${LEAD_KEY_PREFIX}${id}`),
      refusals: [`leads: ${missed.length} open enquiry alerts could not be re-checked`],
    };
  }

  const answered = new Map(rechecked.map((l) => [l.id, l]));
  const leads = [...visible];
  for (const id of missed) {
    const lead = answered.get(id);
    if (!lead) continue; // no answer for this id -> unproven, below
    if (lead.stage !== "new" || lead.firstResponseAt !== null) continue; // contacted: it ended
    leads.push({ id: lead.id, name: lead.name, createdAt: lead.createdAt });
  }

  const unanswered = missed.filter((id) => !answered.has(id));
  return {
    reading: { leads },
    unproven: unanswered.map((id) => `${LEAD_KEY_PREFIX}${id}`),
    refusals:
      unanswered.length === 0
        ? []
        : [`leads: ${unanswered.length} open enquiry alerts name a lead this pass could not read`],
  };
}

/**
 * Gather every reading for one client at one instant.
 *
 * A whole category failing (every approval queue unreadable) collapses to a null
 * category rather than an empty list, because an empty list means "checked, all
 * clear" to the detectors and that would be a lie.
 *
 * `openDedupeKeys` is what the store already has open, and it is passed IN rather
 * than looked up here because it is a fact about the alert table, not a reading.
 * Its one job is the resolve direction: a collector whose query cannot reach a
 * condition that is already on the owner's screen has to say so, and it cannot
 * say so about a row it does not know exists. Absent (the default), nothing is
 * re-checked and nothing extra is claimed.
 */
export async function collectReadings(
  clientId: string,
  now: Date,
  openDedupeKeys: readonly string[] = [],
): Promise<CollectedReadings> {
  const siteIds = getSites(clientId).map((s) => s.id);
  const openLeadIds = openDedupeKeys
    .filter((k) => k.startsWith(LEAD_KEY_PREFIX))
    .map((k) => k.slice(LEAD_KEY_PREFIX.length))
    .filter((id) => id.length > 0);

  const [takings, noshow, leadResult, approvalResults, outboxResults] = await Promise.all([
    collectTakings(clientId, now),
    collectNoshow(siteIds),
    collectLeads(siteIds, now, openLeadIds),
    Promise.all(APPROVAL_WATCHES.map((w) => readApprovalQueue(w, siteIds))),
    Promise.all(OUTBOX_WATCHES.map((w) => readOutboxHealth(w, siteIds, now))),
  ]);

  const leads = leadResult.reading;
  const unproven: string[] = [];
  const refusals: string[] = [];

  if (takings === null || takings.today === null || takings.last7 === null || takings.last30 === null) {
    unproven.push("takings_trend:");
    refusals.push("takings: the dashboard did not publish all three periods");
  } else if (
    takings.today.totalPence === null ||
    takings.last7.totalPence === null ||
    takings.last30.totalPence === null
  ) {
    unproven.push("takings_trend:");
    // The dashboard's own words, not ours — it always attaches a reason.
    const reason =
      takings.last30.unavailableReason ??
      takings.last7.unavailableReason ??
      takings.today.unavailableReason ??
      "no reason given";
    refusals.push(`takings: ${reason}`);
  }

  if (noshow === null) {
    unproven.push("noshow_cluster:");
    refusals.push("no-show: the risk table could not be read");
  }
  // The lead read reports its own refusals: a whole unreadable table is one
  // blanket prefix, and an aged-out alert it could not re-check is one exact key.
  unproven.push(...leadResult.unproven);
  refusals.push(...leadResult.refusals);

  const approvals: ApprovalQueueReading[] = [];
  approvalResults.forEach((reading, i) => {
    const watch = APPROVAL_WATCHES[i];
    if (reading === null) {
      unproven.push(`approval_backlog:${watch.slug}`);
      refusals.push(`approvals: ${watch.table} could not be read`);
      return;
    }
    approvals.push(reading);
  });

  const outboxes: OutboxReading[] = [];
  outboxResults.forEach((reading, i) => {
    const watch = OUTBOX_WATCHES[i];
    if (reading === null) {
      unproven.push(`outbox_stuck:${watch.source}`, `send_failures:${watch.source}`);
      refusals.push(`outbox: ${watch.table} could not be read`);
      return;
    }
    outboxes.push(reading);
  });

  return {
    readings: {
      now,
      takings,
      noshow,
      leads,
      // A category that produced nothing at all is unreadable, not empty.
      approvals: approvals.length === 0 && APPROVAL_WATCHES.length > 0 ? null : approvals,
      outboxes: outboxes.length === 0 && OUTBOX_WATCHES.length > 0 ? null : outboxes,
    },
    unproven,
    refusals,
  };
}
