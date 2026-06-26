import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
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
    try {
      const to = await resolveRecipient(row.toRef, channel, client);
      if (!to) { await source.markFailed(row.id); failed += 1; continue; }
      if (await isSuppressed(row.siteId, channel, row.toRef)) { await source.markBlocked(row.id); blocked += 1; continue; }

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
  const client = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });

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
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
