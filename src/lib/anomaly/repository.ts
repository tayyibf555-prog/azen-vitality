import "server-only";

import { serviceClient } from "@/lib/supabase/server";
import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";

import type { StoredAlert } from "./dedupe";
import type { ApprovalQueueReading, OutboxReading } from "./detect";
import {
  OUTBOX_STUCK_HOURS,
  SEND_FAILURE_WINDOW_HOURS,
  type Alert,
  type AlertKind,
  type AlertSeverity,
} from "./types";

// ---------------------------------------------------------------------------
// The reads this module makes, and the one table it owns.
//
// EVERY READ HERE IS BOUNDED AND EVERY READ HERE IS HONEST ABOUT ITS BOUND.
//
// Counting a queue by listing its rows is capped at ROW_CAP, so a runaway
// backlog cannot make the alerting pass itself the slow thing in the system. A
// capped read does not produce a wrong number: it produces a FLOOR, the reading
// carries `truncated: true`, and the alert then says "At least 500" in words.
// The one thing that never happens is a cap being reported as a total.
//
// A read that FAILS returns null, never an empty array. Zero stuck messages and
// an unreadable outbox are different facts and the difference is the whole
// module: the first is a good day, the second is a blind spot, and only one of
// them should let an existing alert be marked resolved.
// ---------------------------------------------------------------------------

/** Rows a single queue count will look at. Beyond this the count is a floor. */
export const ROW_CAP = 500;

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// The watch registries.
// ---------------------------------------------------------------------------

/** One outbox to watch. `table` is the module's own outbox, per the per-module pattern. */
export interface OutboxWatch {
  /** The messaging drain's own source name, so the two lists can be checked against each other. */
  source: string;
  table: string;
  /** The systems-catalog slug, which supplies the owner-facing label. */
  slug: string;
  /**
   * The screen that shows this module's messages, or null when none exists yet.
   * Balance reminders and post-op check-ins are headless systems whose worklists
   * are a later workstream; the closer's queue renders inside Treatment
   * Coordinator, which is why it points there rather than at a page of its own.
   */
  href: string | null;
  /**
   * True when the table carries `not_before_at` — a deliberate hold (quiet
   * hours, or a check-in timed for the morning after a procedure). Those rows
   * are NOT stuck and are excluded, otherwise every overnight defer would look
   * like a jam at breakfast. Only two tables have the column (migrations 0063
   * and 0091); selecting it on the others would fail the read outright.
   */
  hasNotBefore: boolean;
}

/**
 * Every outbox the shared drain delivers from. Kept in the same order and with
 * the same keys as DRAIN_SOURCE_TO_SLUG, and a test asserts the two lists agree:
 * a new lifecycle module that registers itself with the drain and forgets to
 * register here would otherwise be silently unwatched, which is the exact failure
 * this alerting layer exists to catch.
 */
export const OUTBOX_WATCHES: readonly OutboxWatch[] = [
  { source: "diary", table: "diary_outbox", slug: "calendar-writes", href: "calendar", hasNotBefore: true },
  { source: "reactivation", table: "reactivation_outbox", slug: "reactivation", href: "reactivation", hasNotBefore: false },
  { source: "recall", table: "recall_outbox", slug: "recall", href: "recall", hasNotBefore: false },
  { source: "noshow", table: "noshow_outbox", slug: "no-show-defence", href: "no-show-defence", hasNotBefore: false },
  // 0001's generically named `outbox` is in fact the coordinator's; see 0090's header.
  { source: "coordinator", table: "outbox", slug: "treatment-coordinator", href: "treatment-coordinator", hasNotBefore: false },
  { source: "closer", table: "closer_outbox", slug: "treatment-closer", href: "treatment-coordinator", hasNotBefore: false },
  { source: "collection", table: "collection_outbox", slug: "balance-reminders", href: null, hasNotBefore: false },
  { source: "postop", table: "postop_outbox", slug: "postop-checkin", href: null, hasNotBefore: true },
  { source: "reviews", table: "review_outbox", slug: "reviews", href: "reviews", hasNotBefore: false },
  { source: "outreach", table: "outreach_outbox", slug: "outreach", href: "outreach", hasNotBefore: false },
];

/** One approval queue to watch: drafts a person must release before anything sends. */
export interface ApprovalWatch {
  table: string;
  slug: string;
  href: string | null;
}

/**
 * The draft-for-approval modules. These are the three that write a `draft` touch
 * and have no path to the outbox until a human approves it, so a backlog here is
 * a backlog of work nobody has done rather than a backlog of messages nobody has
 * sent. A test pins each slug against the systems catalog.
 */
export const APPROVAL_WATCHES: readonly ApprovalWatch[] = [
  { table: "closer_touch", slug: "treatment-closer", href: "treatment-coordinator" },
  { table: "collection_touch", slug: "balance-reminders", href: null },
  { table: "postop_touch", slug: "postop-checkin", href: null },
];

/** The owner-facing name for a slug, straight from the systems catalog. */
export function labelForSlug(slug: string): string {
  return SYSTEM_BY_SLUG.get(slug)?.label ?? slug;
}

// ---------------------------------------------------------------------------
// The queue reads.
// ---------------------------------------------------------------------------

interface DatedRow {
  created_at: string;
}

/**
 * Drafts waiting on a human for one module, or null when the read failed.
 * Oldest first, so `rows[0]` is the oldest waiting draft without a second query.
 */
export async function readApprovalQueue(
  watch: ApprovalWatch,
  siteIds: readonly string[],
): Promise<ApprovalQueueReading | null> {
  if (siteIds.length === 0) return null;
  try {
    const { data, error } = await serviceClient()
      .from(watch.table)
      .select("created_at")
      .in("site_id", siteIds as string[])
      .eq("status", "draft")
      .eq("direction", "outbound")
      .order("created_at", { ascending: true })
      .limit(ROW_CAP);
    if (error) throw error;
    const rows = (data ?? []) as DatedRow[];
    return {
      key: watch.slug,
      label: labelForSlug(watch.slug),
      href: watch.href,
      count: rows.length,
      oldestAt: rows[0]?.created_at ?? null,
      truncated: rows.length >= ROW_CAP,
    };
  } catch {
    return null;
  }
}

/**
 * One outbox's two health figures, or null when either read failed.
 *
 * Both halves are needed for the reading to mean anything, so a partial success
 * is treated as a failure rather than reported as a zero on the half that broke.
 */
export async function readOutboxHealth(
  watch: OutboxWatch,
  siteIds: readonly string[],
  now: Date,
): Promise<OutboxReading | null> {
  if (siteIds.length === 0) return null;
  const nowIso = now.toISOString();
  const stuckBefore = new Date(now.getTime() - OUTBOX_STUCK_HOURS * HOUR_MS).toISOString();
  const failedSince = new Date(now.getTime() - SEND_FAILURE_WINDOW_HOURS * HOUR_MS).toISOString();

  try {
    const db = serviceClient();

    let stuckQuery = db
      .from(watch.table)
      .select("created_at")
      .in("site_id", siteIds as string[])
      .eq("status", "queued")
      .lt("created_at", stuckBefore);
    // A row held back on purpose is waiting, not stuck.
    if (watch.hasNotBefore) stuckQuery = stuckQuery.lte("not_before_at", nowIso);
    const stuck = await stuckQuery.order("created_at", { ascending: true }).limit(ROW_CAP);
    if (stuck.error) throw stuck.error;

    const failed = await db
      .from(watch.table)
      .select("created_at")
      .in("site_id", siteIds as string[])
      .eq("status", "failed")
      .gte("created_at", failedSince)
      .limit(ROW_CAP);
    if (failed.error) throw failed.error;

    const stuckRows = (stuck.data ?? []) as DatedRow[];
    const failedRows = (failed.data ?? []) as DatedRow[];
    return {
      key: watch.source,
      label: labelForSlug(watch.slug),
      href: watch.href,
      stuckCount: stuckRows.length,
      oldestStuckAt: stuckRows[0]?.created_at ?? null,
      stuckCutoffHours: OUTBOX_STUCK_HOURS,
      failedCount: failedRows.length,
      failureWindowHours: SEND_FAILURE_WINDOW_HOURS,
      truncated: stuckRows.length >= ROW_CAP || failedRows.length >= ROW_CAP,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The alert store (migration 0093).
// ---------------------------------------------------------------------------

const TABLE = "anomaly_alert";

interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  dedupe_key: string;
  sentence: string;
  href: string | null;
  anchored_at: string;
  first_raised_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

function rowToAlert(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    severity: row.severity as AlertSeverity,
    dedupeKey: row.dedupe_key,
    sentence: row.sentence,
    href: row.href,
    at: row.anchored_at,
    firstRaisedAt: row.first_raised_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

/** Every row for a client, open or resolved. The sweep needs both to decide. */
export async function listAlerts(clientId: string): Promise<StoredAlert[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("last_seen_at", { ascending: false })
    .limit(ROW_CAP);
  if (error) throw error;
  return ((data ?? []) as AlertRow[]).map(rowToAlert);
}

/**
 * The open alerts only, newest first. This is what the notifications feed reads.
 *
 * CLIENT-SCOPED, NOT SITE-SCOPED, and knowingly out of step with the rest of that
 * feed. Every other source there is filtered by the cookie-backed site switcher's
 * `getViewSiteIds`, so an owner looking at N15 sees N15's work; these alerts are
 * not, and an alert naming a lead at the other site will show up in the N15 view.
 *
 * That is a display-scope inconsistency rather than a leak — every guard on the
 * page is enforced, and a user of this client already has both sites in their
 * scope — and it is deliberate on the raise side: five of the six conditions are
 * measured ACROSS the client's sites (the takings trend comes off the dashboard's
 * all-sites scope; the queue and outbox counts are one `in (site_id)` query over
 * all of them), so there is no per-site figure to file them under and filtering
 * them by the switcher would hide a practice-wide fact rather than scope it. Only
 * lead_sla is about a single site's row.
 *
 * Making it match would mean a site column on the alert (migration 0093), a site
 * on the Alert type, and a filter in the feed — for a change that would still
 * show five of the six kinds in every site view, and would take a lead nobody has
 * rung at the other site OFF the screen of the one person watching. That is a
 * product call about what an alerting surface is for, not a tidy-up, so it is
 * named here and left for whoever makes it.
 */
export async function listOpenAlerts(clientId: string): Promise<StoredAlert[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .is("resolved_at", null)
    .order("anchored_at", { ascending: false })
    .limit(ROW_CAP);
  if (error) throw error;
  return ((data ?? []) as AlertRow[]).map(rowToAlert);
}

/** Raise a brand new alert. */
export async function insertAlert(clientId: string, alert: Alert, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const { error } = await serviceClient().from(TABLE).insert({
    client_id: clientId,
    kind: alert.kind,
    severity: alert.severity,
    dedupe_key: alert.dedupeKey,
    sentence: alert.sentence,
    href: alert.href,
    anchored_at: alert.at,
    first_raised_at: nowIso,
    last_seen_at: nowIso,
    resolved_at: null,
  });
  if (error) throw error;
}

/**
 * The condition is still true. Take the newer wording and figures (a backlog of
 * twelve should not still read "ten" a week later) and bump last-seen — but leave
 * first_raised_at alone, because that is the answer to "how long has this been
 * going on", and it is the field that makes this a refresh rather than a re-raise.
 */
export async function refreshAlert(clientId: string, alert: Alert, now: Date): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE)
    .update({
      severity: alert.severity,
      sentence: alert.sentence,
      href: alert.href,
      anchored_at: alert.at,
      last_seen_at: now.toISOString(),
    })
    .eq("client_id", clientId)
    .eq("dedupe_key", alert.dedupeKey);
  if (error) throw error;
}

/** A resolved condition has come back after the cooldown: raise it again. */
export async function reraiseAlert(clientId: string, alert: Alert, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const { error } = await serviceClient()
    .from(TABLE)
    .update({
      severity: alert.severity,
      sentence: alert.sentence,
      href: alert.href,
      anchored_at: alert.at,
      first_raised_at: nowIso,
      last_seen_at: nowIso,
      resolved_at: null,
    })
    .eq("client_id", clientId)
    .eq("dedupe_key", alert.dedupeKey);
  if (error) throw error;
}

/** Mark conditions the pass looked for and did not find as resolved. */
export async function resolveAlerts(
  clientId: string,
  dedupeKeys: readonly string[],
  now: Date,
): Promise<void> {
  if (dedupeKeys.length === 0) return;
  const { error } = await serviceClient()
    .from(TABLE)
    .update({ resolved_at: now.toISOString() })
    .eq("client_id", clientId)
    .is("resolved_at", null)
    .in("dedupe_key", dedupeKeys as string[]);
  if (error) throw error;
}
