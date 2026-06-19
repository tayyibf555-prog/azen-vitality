import { parseWebhookEvent, verifyWebhookToken } from "@/lib/dentally/webhook";
import {
  markWebhookProcessed,
  recordWebhookEvent,
} from "@/lib/dentally/webhook-repository";
import { dispatchWebhookEvent } from "@/lib/dentally/webhook-dispatch";

export const dynamic = "force-dynamic";

/** Collect request headers into a lowercase-keyed plain object for the parser. */
function headerRecord(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const secret = process.env.DENTALLY_WEBHOOK_SECRET;
    if (!secret) {
      return Response.json(
        { error: "DENTALLY_WEBHOOK_SECRET not set" },
        { status: 503 },
      );
    }

    // Token from the header, falling back to the `token` query param.
    const url = new URL(request.url);
    const token =
      request.headers.get("x-webhook-token") ?? url.searchParams.get("token");
    if (!verifyWebhookToken(token, secret)) {
      return Response.json({ error: "invalid webhook token" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const headers = headerRecord(request);
    const parsed = parseWebhookEvent(body, headers);
    if (!parsed) {
      return Response.json({ error: "unrecognized event" }, { status: 400 });
    }

    // Record first so an event is never lost, even if its reaction fails.
    const { id, duplicate } = await recordWebhookEvent({
      dentallyEventId: parsed.dentallyEventId,
      eventType: parsed.eventType,
      siteId: parsed.siteId,
      payload: body,
    });

    // Dispatch the reaction; recording stands regardless of the outcome. Skip
    // dispatch on a duplicate — the original delivery already handled it.
    if (!duplicate) {
      try {
        await dispatchWebhookEvent({
          eventType: parsed.eventType,
          siteId: parsed.siteId,
          resource: parsed.resource,
        });
        await markWebhookProcessed(id);
      } catch (e) {
        await markWebhookProcessed(id, String(e));
      }
    }

    return Response.json({ ok: true, duplicate });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500 });
  }
}
