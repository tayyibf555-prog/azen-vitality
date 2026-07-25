import { DentallyClient, DentallyError } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
import { wasContactedToday, recordContacted } from "@/lib/messaging/frequency";
import { validateMobile } from "@/lib/messaging/lookup";
import { validateEmail } from "@/lib/messaging/email-lookup";
import { getChannelPref, resolvePreferredChannel } from "@/lib/messaging/channel-pref";
import { isWhatsappConfigured } from "@/lib/messaging/providers/twilio";
import { londonDayKey } from "@/lib/time/london";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  listQueuedOutbox as listReactivationQueued,
  claimOutbox as claimReactivation,
  recordOutboxSent as recordReactivationSent,
  markOutboxFailed as markReactivationFailed,
  markOutboxBlocked as markReactivationBlocked,
} from "@/lib/reactivation/repository";
import {
  listQueuedOutbox as listRecallQueued,
  claimOutbox as claimRecall,
  recordOutboxSent as recordRecallSent,
  markOutboxFailed as markRecallFailed,
  markOutboxBlocked as markRecallBlocked,
} from "@/lib/recall/repository";
import {
  listQueuedOutbox as listNoshowQueued,
  claimOutbox as claimNoshow,
  recordOutboxSent as recordNoshowSent,
  markOutboxFailed as markNoshowFailed,
  markOutboxBlocked as markNoshowBlocked,
} from "@/lib/noshow/repository";
import {
  listQueuedOutbox as listCoordinatorQueued,
  claimOutbox as claimCoordinator,
  recordOutboxSent as recordCoordinatorSent,
  markOutboxFailed as markCoordinatorFailed,
  markOutboxBlocked as markCoordinatorBlocked,
} from "@/lib/coordinator/repository";
import {
  listQueuedOutbox as listReviewsQueued,
  claimOutbox as claimReviews,
  recordOutboxSent as recordReviewsSent,
  markOutboxFailed as markReviewsFailed,
  markOutboxBlocked as markReviewsBlocked,
} from "@/lib/reviews/repository";
import {
  listQueuedOutbox as listOutreachQueued,
  claimOutbox as claimOutreach,
  recordOutboxSent as recordOutreachSent,
  markOutboxFailed as markOutreachFailed,
  markOutboxBlocked as markOutreachBlocked,
} from "@/lib/outreach/repository";
import { SITES } from "@/lib/mock/clients";
import { getDisabledSlugsForSend } from "@/lib/systems/repository";
import { DRAIN_SOURCE_TO_SLUG } from "@/lib/systems/catalog";

import { dentallyReadKey } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

// Per-source, per-run cap on recipient-resolution throws. The rows themselves
// stay 'queued' (no schema support for an attempt count), so this bounds the
// time a run can lose to a failing upstream rather than retiring poison rows.
const MAX_RESOLVE_FAILURES_PER_RUN = 5;

interface QueuedRow {
  id: string;
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
  /** When the row was queued; rows older than MAX_ROW_AGE_MS are retired unsent. */
  createdAt?: string;
}

// Staleness guard: a row queued while a system was switched off (or during a
// long outage) must NOT fire days later as if nothing happened — "see you at
// your appointment tomorrow" sent three days late is wrong and confusing. Any
// queued row older than this is retired as failed instead of sent; the sweeps
// re-draft current messages on their own schedule.
const MAX_ROW_AGE_MS = 48 * 3_600_000;

// Reactivation and recall each have their own outbox, but the send pipeline
// (resolve recipient, suppression check, dispatch, record) is identical.
interface OutboxSource {
  name: string;
  list: (siteIds: string[]) => Promise<QueuedRow[]>;
  claim: (id: string) => Promise<boolean>;
  recordSent: (id: string, touchId: string, fields: { provider: string; providerMessageId: string; toAddress: string }) => Promise<void>;
  markFailed: (id: string) => Promise<void>;
  markBlocked: (id: string) => Promise<void>;
  // Transactional = an appointment confirmation the patient is expecting. It ALWAYS
  // sends (never blocked by the daily frequency cap) but still stamps the day, so
  // same-day OUTREACH (recall/reactivation/coordinator/reviews) yields to it.
  transactional?: boolean;
}

// Order matters: this is the cross-module priority for the once-per-day cap. The FIRST
// source to reach a recipient on a given day wins; every later source that day is
// blocked. Transactional confirmations (no-show) drain first so a reminder never loses
// its slot to outreach, then outreach in priority order (recall > reactivation >
// coordinator > reviews).
const SOURCES: OutboxSource[] = [
  { name: "noshow", list: listNoshowQueued, claim: claimNoshow, recordSent: recordNoshowSent, markFailed: markNoshowFailed, markBlocked: markNoshowBlocked, transactional: true },
  { name: "recall", list: listRecallQueued, claim: claimRecall, recordSent: recordRecallSent, markFailed: markRecallFailed, markBlocked: markRecallBlocked },
  { name: "reactivation", list: listReactivationQueued, claim: claimReactivation, recordSent: recordReactivationSent, markFailed: markReactivationFailed, markBlocked: markReactivationBlocked },
  { name: "coordinator", list: listCoordinatorQueued, claim: claimCoordinator, recordSent: recordCoordinatorSent, markFailed: markCoordinatorFailed, markBlocked: markCoordinatorBlocked },
  { name: "reviews", list: listReviewsQueued, claim: claimReviews, recordSent: recordReviewsSent, markFailed: markReviewsFailed, markBlocked: markReviewsBlocked },
  // Segment outreach drains LAST: it is a deliberate campaign, so it yields its
  // once-per-day slot to every automatic lifecycle message (recall/reactivation/
  // coordinator/reviews) already established for a recipient.
  { name: "outreach", list: listOutreachQueued, claim: claimOutreach, recordSent: recordOutreachSent, markFailed: markOutreachFailed, markBlocked: markOutreachBlocked },
];

/**
 * Send one row, with a ONE-SHOT SMS fallback for WhatsApp. Returns the provider
 * result, or null when the message could not be delivered at all.
 *
 * WhatsApp refuses a freeform message sent outside its 24 hour customer service
 * window (the patient has not messaged us recently), so a cadence message we
 * queued on WhatsApp can fail for a reason SMS never would. The number is the
 * same handset either way, so rather than retiring a real reminder or recall
 * unsent we send it by SMS instead.
 *
 * Opt-out safety: suppression rows are per channel, so the SMS opt-out is
 * re-checked before the fallback. A patient who stopped SMS is never reached by
 * the fallback, even though their WhatsApp send failed.
 */
async function dispatch(
  sourceName: string,
  row: QueuedRow,
  channel: MessageChannel,
  to: string,
  statusCallbackUrl: string | undefined,
): Promise<Awaited<ReturnType<typeof sendMessage>> | null> {
  try {
    return await sendMessage({
      channel,
      to,
      body: row.body,
      statusCallbackUrl: channel === "email" ? undefined : statusCallbackUrl,
    });
  } catch (err) {
    if (channel !== "whatsapp") return null;
    const smsOptedOut =
      (await isSuppressed(row.siteId, "sms", row.toRef)) || (await isSuppressed(row.siteId, "sms", to));
    if (smsOptedOut) {
      console.warn(
        `[drain] ${sourceName}: outbox ${row.id} failed on WhatsApp and the SMS fallback is opted out; not sent`,
        err,
      );
      return null;
    }
    try {
      const fallback = await sendMessage({ channel: "sms", to, body: row.body, statusCallbackUrl });
      console.warn(
        `[drain] ${sourceName}: outbox ${row.id} could not be sent on WhatsApp; delivered by SMS instead`,
        err,
      );
      return fallback;
    } catch (smsErr) {
      console.warn(`[drain] ${sourceName}: outbox ${row.id} SMS fallback also failed`, smsErr);
      return null;
    }
  }
}

async function drainSource(
  source: OutboxSource,
  client: DentallyClient,
  siteIds: string[],
  statusCallbackUrl: string | undefined,
  today: string,
  whatsappEnabled: boolean,
): Promise<{ drained: number; sent: number; failed: number; blocked: number }> {
  const rows = await source.list(siteIds);
  let sent = 0, failed = 0, blocked = 0;
  let resolveFailures = 0;
  let examined = 0;
  for (const row of rows) {
    const rowChannel = row.channel as MessageChannel;
    // Channel preference: honour the patient's chosen channel where BOTH channels
    // are genuinely viable. WhatsApp routing is DOUBLE-GATED by the caller (owner
    // kill switch ON *and* a WhatsApp sender configured); `whatsappEnabled` is that
    // combined verdict. When either gate is closed it is false, so this whole block
    // is skipped, the preference read is never even issued, and the effective
    // channel is exactly the queued one - a WhatsApp preference is never routed to a
    // dead channel. sms and whatsapp resolve to the same handset, and a STOP
    // suppresses both channels, so switching between them is address- and
    // opt-out-safe.
    let channel = rowChannel;
    if (whatsappEnabled && rowChannel !== "email") {
      const preferred = await getChannelPref(row.siteId, row.toRef);
      channel = resolvePreferredChannel(rowChannel, preferred, whatsappEnabled);
    } else if (rowChannel === "whatsapp") {
      // Dead-channel guard for a row QUEUED as WhatsApp (rather than re-routed to
      // it by preference above). With WhatsApp switched off or no sender
      // configured, sending it as WhatsApp can only fail, so the message would be
      // retired unsent. sms and whatsapp are the same handset and a STOP
      // suppresses both, so downgrade to SMS and let the patient actually get it.
      channel = "sms";
      console.warn(
        `[drain] ${source.name}: outbox ${row.id} was queued for WhatsApp but WhatsApp is not available; sending by SMS`,
      );
    }

    // Resolve the recipient first. A THROW here is transient (e.g. Dentally briefly
    // unavailable): leave the row 'queued' so the next drain retries, rather than
    // marking it permanently failed. The outbox tables have no attempts column, so
    // a permanently-throwing row cannot be retired; instead cap resolve failures
    // per run so a broken upstream (or a poison row) cannot burn the whole run's
    // maxDuration on doomed lookups. Remaining rows stay queued for the next tick.
    if (resolveFailures >= MAX_RESOLVE_FAILURES_PER_RUN) {
      console.warn(
        `[drain] ${source.name}: resolve-failure cap (${MAX_RESOLVE_FAILURES_PER_RUN}) reached; leaving remaining rows queued for the next tick`,
      );
      break;
    }
    examined += 1;

    // Retire stale rows unsent (see MAX_ROW_AGE_MS above).
    if (row.createdAt && Date.now() - Date.parse(row.createdAt) > MAX_ROW_AGE_MS) {
      await source.markFailed(row.id);
      failed += 1;
      console.warn(`[drain] ${source.name}: outbox ${row.id} queued ${row.createdAt} is stale; retired unsent`);
      continue;
    }

    let to: string | null;
    try {
      to = await resolveRecipient(row.toRef, channel, client);
    } catch (err) {
      // A deleted/merged patient (Dentally 404/410) is PERMANENT: retire the row
      // as failed rather than letting it sit at the head of the queue poisoning
      // every future run (head-of-line blocking). Anything else (timeout, 5xx,
      // 429) is transient: leave the row queued and count it against the cap.
      if (err instanceof DentallyError && (err.status === 404 || err.status === 410)) {
        await source.markFailed(row.id);
        failed += 1;
        console.warn(
          `[drain] ${source.name}: recipient gone (Dentally ${err.status}) for outbox ${row.id}; marked failed`,
        );
        continue;
      }
      resolveFailures += 1;
      console.warn(
        `[drain] ${source.name}: resolveRecipient threw for outbox ${row.id} (${resolveFailures}/${MAX_RESOLVE_FAILURES_PER_RUN} this run); row stays queued`,
        err,
      );
      continue;
    }
    // No deliverable contact on file is permanent: mark failed.
    if (!to) { await source.markFailed(row.id); failed += 1; continue; }

    // Honour opt-out by the touch ref (patient:<id>) AND the resolved address, so a
    // STOP recorded against either form blocks the send (a number that opted out
    // while unidentified is suppressed by address, not by patient id).
    if (
      (await isSuppressed(row.siteId, channel, row.toRef)) ||
      (await isSuppressed(row.siteId, channel, to))
    ) {
      await source.markBlocked(row.id);
      blocked += 1;
      continue;
    }

    // Output backstop for EVERY module send, whatever composed the body
    // (templated or LLM-drafted): never let funding/NHS-private jargon or
    // clinical advice reach a patient. Price is excluded on purpose, since
    // modules legitimately relay a real treatment-plan figure from Dentally.
    // A hit blocks the row (terminal) and logs loudly for review rather than
    // sending forbidden wording.
    const guard = checkAgentReply(row.body, { includePrice: false });
    if (!guard.ok) {
      console.error(
        `[drain] ${source.name}: outbox ${row.id} blocked by output guardrail ` +
          `(${guard.category}: ${JSON.stringify(guard.matched)}); not sent`,
      );
      await source.markBlocked(row.id);
      blocked += 1;
      continue;
    }

    // Pre-send deliverability validation (both dormant by default). A resolved
    // address that can never receive the message is BLOCKED before the paid send:
    // marked blocked exactly like a consent block (never failed), and, because we
    // skip before wasContactedToday/recordContacted, it never consumes the
    // recipient's daily cap. Either validator fails OPEN on an API error, so an
    // outage never halts genuine sends.
    //   - Phone: Twilio Lookup (dormant unless TWILIO_LOOKUP_ENABLED). A landline or
    //     otherwise undeliverable number is blocked.
    //   - Email: NeverBounce (dormant unless NEVERBOUNCE_API_KEY + EMAIL_LOOKUP_ENABLED).
    //     An invalid or disposable address is blocked; catchall/unknown pass.
    if (channel !== "email") {
      const check = await validateMobile(to);
      if (!check.valid) {
        await source.markBlocked(row.id);
        blocked += 1;
        console.warn(
          `[drain] ${source.name}: outbox ${row.id} resolved to ${to} which is not a deliverable ` +
            `mobile (${check.lineType ?? "invalid-number"}); blocked pre-send, not sent`,
        );
        continue;
      }
    } else {
      const check = await validateEmail(to);
      if (!check.valid) {
        await source.markBlocked(row.id);
        blocked += 1;
        console.warn(
          `[drain] ${source.name}: outbox ${row.id} resolved to ${to} which is not a deliverable ` +
            `email (${check.verdict ?? "invalid-address"}); blocked pre-send, not sent`,
        );
        continue;
      }
    }

    // Cross-module daily frequency cap: at most one OUTREACH message per recipient per
    // London day across ALL modules, so a patient is never chased by two systems the
    // same day. Keyed by the resolved address (dedupes SMS + WhatsApp on one number).
    // Transactional confirmations (no-show) are exempt from being blocked but still
    // stamp the day after sending, so same-day outreach yields to them. Fail-open.
    if (!source.transactional && (await wasContactedToday(row.siteId, to, today))) {
      await source.markBlocked(row.id);
      blocked += 1;
      continue;
    }

    // Atomically claim the row (queued -> sending) IMMEDIATELY before dispatch.
    // The cron lock stops concurrent drains, but a run killed at maxDuration (or a
    // crash) between sendMessage returning and recordSent committing would leave
    // the row 'queued'; the next tick would re-list and re-send it (double-text).
    // Claiming first moves the row out of 'queued' before the send, so a kill in
    // that window strands it in 'sending' (visible to ops) rather than re-sending.
    // A claim that does not land (already claimed) is skipped without sending.
    if (!(await source.claim(row.id))) continue;

    // Separate the SEND from the post-send bookkeeping. Only a send failure may mark
    // the row 'failed'; a recordSent failure must NOT (recordSent is two writes —
    // outbox + touch — and flipping a genuinely DELIVERED message to 'failed' would
    // strand the cadence and, once a status webhook lands, misreport delivery).
    const result = await dispatch(source.name, row, channel, to, statusCallbackUrl);
    if (!result) {
      // Delivery threw with no way through. Mark failed; the Twilio status webhook
      // tracks terminal delivery state separately for any retryable handling.
      await source.markFailed(row.id);
      failed += 1;
      continue;
    }

    // Sent. Record it; on a bookkeeping failure retry once, then leave the row as-is
    // (still 'sending') for reconciliation rather than lying about delivery. Never
    // markFailed after a successful provider send.
    try {
      await source.recordSent(row.id, row.touchId, {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        toAddress: to,
      });
    } catch {
      try {
        await source.recordSent(row.id, row.touchId, {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          toAddress: to,
        });
      } catch (err2) {
        console.error(
          `[drain] ${source.name}: outbox ${row.id} was SENT (provider ${result.provider} ${result.providerMessageId}) ` +
            `but recordSent failed twice; leaving the row 'sending' for reconciliation, NOT marking it failed`,
          err2,
        );
      }
    }
    sent += 1;
    // Stamp the day so later sources this run and later ticks apply the once-per-day
    // cap to this recipient. Best-effort: a failure here never affects the sent message.
    await recordContacted(row.siteId, to, today, source.name);
  }
  // 'drained' counts rows this run actually examined; rows deferred past a cap
  // break stay queued for the next tick and are not counted.
  return { drained: examined, sent, failed, blocked };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // Never overlap with another drain run: two drains would list the same 'queued'
  // rows and both send, double-texting the patient. The lease must OUTLIVE the
  // function's maxDuration (300s): a shorter lease would expire while a slow run
  // was still sending, letting the next tick acquire the lock and double-send the
  // rows the slow run had not yet reached (and the slow run's finally-release
  // would then drop the new holder's lease too). A crashed run still self-heals:
  // the lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("drain", 310))) {
    return Response.json({ ok: true, skipped: "another drain run is in progress" });
  }

  const client = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });

  try {
    // Twilio rejects a StatusCallback that is not publicly reachable, so only
    // attach it when PUBLIC_BASE_URL is a real https endpoint (deployed app or tunnel).
    const base = process.env.PUBLIC_BASE_URL ?? "";
    const statusCallbackUrl = base.startsWith("https://")
      ? `${base}/api/webhooks/twilio/status`
      : undefined;

    const siteIds = vitalitySiteIds();
    // The Europe/London calendar day, computed once so every source this run shares one
    // "today" for the cross-module frequency cap (a run cannot straddle local midnight).
    const today = londonDayKey(new Date());
    // Owner kill switch: a disabled system's outbox must not send. Fetch the
    // disabled set once. The ForSend variant FAILS CLOSED when messaging is live:
    // a toggle-read error returns EVERY slug as disabled, so the whole tick skips
    // rather than sending for a system the owner may have switched off. It behaves
    // fail-open only under dry-run. Single client in the pilot, matching
    // vitalitySiteIds().
    const disabledSlugs = await getDisabledSlugsForSend("vitality");
    // Channel-preference gate for WhatsApp - DOUBLE-GATED and fail-closed. A
    // patient's WhatsApp preference is honoured ONLY when BOTH are true:
    //   1) the owner kill switch is ON - 'whatsapp' is not in the disabled set.
    //      getDisabledSlugsForSend fails CLOSED when messaging is live (every slug
    //      disabled on a read error), so a blip leaves WhatsApp treated as OFF; and
    //      migration 0047 seeds the 'whatsapp' toggle OFF so it is never live by the
    //      mere ABSENCE of a row (system_toggle is default-ON, like 0041 for outreach).
    //   2) WhatsApp is actually DELIVERABLE - a WhatsApp sender (TWILIO_WHATSAPP_FROM)
    //      is configured. Without a sender, routing to WhatsApp would fail the send in
    //      live mode instead of using SMS, so a 'whatsapp' preference must stay a no-op.
    // Either gate closed => WhatsApp treated as OFF: the queued SMS path is left intact,
    // never routed to a dead channel. This holds regardless of the toggle's state.
    const whatsappEnabled = !disabledSlugs.has("whatsapp") && isWhatsappConfigured();
    let drained = 0, sent = 0, failed = 0, blocked = 0;
    const perSource: Record<string, { drained: number; sent: number; failed: number; blocked: number; error?: string; skipped?: string }> = {};
    const sourceErrors: string[] = [];
    for (const source of SOURCES) {
      // Kill switch: skip this system entirely when the owner has turned it off.
      // Its rows stay 'queued' and drain the moment it is switched back on.
      const slug = DRAIN_SOURCE_TO_SLUG[source.name];
      if (slug && disabledSlugs.has(slug)) {
        perSource[source.name] = { drained: 0, sent: 0, failed: 0, blocked: 0, skipped: "system off" };
        continue;
      }
      // Isolate each module's drain. list() throwing (DB briefly down) or any
      // unexpected throw inside drainSource must NOT abort the remaining modules'
      // drains for this tick: reactivation being unreachable should not stop
      // recall/noshow/coordinator/reviews from delivering their queued rows.
      // The rows of the failing module stay 'queued' for the next tick.
      try {
        const r = await drainSource(source, client, siteIds, statusCallbackUrl, today, whatsappEnabled);
        perSource[source.name] = r;
        drained += r.drained; sent += r.sent; failed += r.failed; blocked += r.blocked;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perSource[source.name] = { drained: 0, sent: 0, failed: 0, blocked: 0, error: message };
        sourceErrors.push(`${source.name}: ${message}`);
        console.error(`[drain] ${source.name}: source drain threw; skipping to next module`, err);
      }
    }

    return Response.json({
      ok: sourceErrors.length === 0,
      drained, sent, failed, blocked, perSource,
      ...(sourceErrors.length ? { errors: sourceErrors } : {}),
    });
  } finally {
    await releaseCronLock("drain");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
