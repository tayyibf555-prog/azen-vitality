import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  listQueuedOutbox as listReactivationQueued,
  recordOutboxSent as recordReactivationSent,
  markOutboxFailed as markReactivationFailed,
  markOutboxBlocked as markReactivationBlocked,
} from "@/lib/reactivation/repository";
import {
  listQueuedOutbox as listRecallQueued,
  recordOutboxSent as recordRecallSent,
  markOutboxFailed as markRecallFailed,
  markOutboxBlocked as markRecallBlocked,
} from "@/lib/recall/repository";
import {
  listQueuedOutbox as listNoshowQueued,
  recordOutboxSent as recordNoshowSent,
  markOutboxFailed as markNoshowFailed,
  markOutboxBlocked as markNoshowBlocked,
} from "@/lib/noshow/repository";
import {
  listQueuedOutbox as listCoordinatorQueued,
  recordOutboxSent as recordCoordinatorSent,
  markOutboxFailed as markCoordinatorFailed,
  markOutboxBlocked as markCoordinatorBlocked,
} from "@/lib/coordinator/repository";
import {
  listQueuedOutbox as listReviewsQueued,
  recordOutboxSent as recordReviewsSent,
  markOutboxFailed as markReviewsFailed,
  markOutboxBlocked as markReviewsBlocked,
} from "@/lib/reviews/repository";
import { SITES } from "@/lib/mock/clients";

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

interface QueuedRow {
  id: string;
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
}

// Reactivation and recall each have their own outbox, but the send pipeline
// (resolve recipient, suppression check, dispatch, record) is identical.
interface OutboxSource {
  name: string;
  list: (siteIds: string[]) => Promise<QueuedRow[]>;
  recordSent: (id: string, touchId: string, fields: { provider: string; providerMessageId: string; toAddress: string }) => Promise<void>;
  markFailed: (id: string) => Promise<void>;
  markBlocked: (id: string) => Promise<void>;
}

const SOURCES: OutboxSource[] = [
  { name: "reactivation", list: listReactivationQueued, recordSent: recordReactivationSent, markFailed: markReactivationFailed, markBlocked: markReactivationBlocked },
  { name: "recall", list: listRecallQueued, recordSent: recordRecallSent, markFailed: markRecallFailed, markBlocked: markRecallBlocked },
  { name: "noshow", list: listNoshowQueued, recordSent: recordNoshowSent, markFailed: markNoshowFailed, markBlocked: markNoshowBlocked },
  { name: "coordinator", list: listCoordinatorQueued, recordSent: recordCoordinatorSent, markFailed: markCoordinatorFailed, markBlocked: markCoordinatorBlocked },
  { name: "reviews", list: listReviewsQueued, recordSent: recordReviewsSent, markFailed: markReviewsFailed, markBlocked: markReviewsBlocked },
];

async function drainSource(
  source: OutboxSource,
  client: DentallyClient,
  siteIds: string[],
  statusCallbackUrl: string | undefined,
): Promise<{ drained: number; sent: number; failed: number; blocked: number }> {
  const rows = await source.list(siteIds);
  let sent = 0, failed = 0, blocked = 0;
  for (const row of rows) {
    const channel = row.channel as MessageChannel;

    // Resolve the recipient first. A THROW here is transient (e.g. Dentally briefly
    // unavailable): leave the row 'queued' so the next drain retries, rather than
    // marking it permanently failed.
    let to: string | null;
    try {
      to = await resolveRecipient(row.toRef, channel, client);
    } catch {
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

    try {
      const result = await sendMessage({
        channel,
        to,
        body: row.body,
        statusCallbackUrl: channel === "email" ? undefined : statusCallbackUrl,
      });
      await source.recordSent(row.id, row.touchId, {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        toAddress: to,
      });
      sent += 1;
    } catch {
      // Delivery threw. Mark failed; the Twilio status webhook tracks terminal
      // delivery state separately for any retryable handling.
      await source.markFailed(row.id);
      failed += 1;
    }
  }
  return { drained: rows.length, sent, failed, blocked };
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // Never overlap with another drain run: two drains would list the same 'queued'
  // rows and both send, double-texting the patient. Lease for just under the
  // function's maxDuration so a crashed run self-heals on the next tick.
  if (!(await acquireCronLock("drain", 280))) {
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
    let drained = 0, sent = 0, failed = 0, blocked = 0;
    const perSource: Record<string, { drained: number; sent: number; failed: number; blocked: number }> = {};
    for (const source of SOURCES) {
      const r = await drainSource(source, client, siteIds, statusCallbackUrl);
      perSource[source.name] = r;
      drained += r.drained; sent += r.sent; failed += r.failed; blocked += r.blocked;
    }

    return Response.json({ ok: true, drained, sent, failed, blocked, perSource });
  } finally {
    await releaseCronLock("drain");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
