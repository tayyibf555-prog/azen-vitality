import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  listQueuedOutbox,
  recordOutboxSent,
  markOutboxFailed,
  markOutboxBlocked,
} from "@/lib/reactivation/repository";
import { SITES } from "@/lib/mock/clients";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unset in local dev
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  const client = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });

  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const statusCallbackUrl = `${base}/api/webhooks/twilio/status`;

  const rows = await listQueuedOutbox(vitalitySiteIds());
  let sent = 0, failed = 0, blocked = 0;

  for (const row of rows) {
    const channel = row.channel as MessageChannel;
    try {
      const to = await resolveRecipient(row.toRef, channel, client);
      if (!to) { await markOutboxFailed(row.id); failed += 1; continue; }
      if (await isSuppressed(row.siteId, channel, row.toRef)) { await markOutboxBlocked(row.id); blocked += 1; continue; }

      const result = await sendMessage({
        channel,
        to,
        body: row.body,
        statusCallbackUrl: channel === "email" ? undefined : statusCallbackUrl,
      });
      await recordOutboxSent(row.id, row.touchId, {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        toAddress: to,
      });
      sent += 1;
    } catch {
      await markOutboxFailed(row.id);
      failed += 1;
    }
  }

  return Response.json({ ok: true, drained: rows.length, sent, failed, blocked });
}
