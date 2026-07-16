import { getClient } from "@/lib/mock/clients";
import { consumeBudget } from "@/lib/rate-budget";
import {
  insertFunnelEvents,
  isFunnelSurface,
  isValidSessionId,
  parseFunnelEvents,
} from "@/lib/funnel/events";

export const dynamic = "force-dynamic";

// PUBLIC: anonymous, PII-free funnel telemetry from the smile-assessment quiz and
// the booking page. The browser fire-and-forgets small batches (sendBeacon /
// keepalive fetch), so this is deliberately opaque: it always answers 202 and
// never returns anything the page reacts to.
//
// ABUSE POSTURE: it only writes tiny scalar rows (no SMS, no AI, no Dentally), so
// the guard is the shared api_budget ceiling (the same durable, IP-spoof-proof
// cap the smile-assessment endpoints use) plus a bounded batch and meta
// sanitisation. Over budget or malformed input is silently dropped, never an
// error the beacon would surface.

const BUDGET_LIMIT = 600; // requests
const BUDGET_WINDOW_SECONDS = 60;

// A single opaque acknowledgement for every outcome (accepted, dropped, unknown
// client, over budget): telemetry must never leak whether a slug exists or a
// batch landed.
function ack(): Response {
  return Response.json({ ok: true }, { status: 202 });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return ack();
  }

  try {
    const clientSlug = str(body.clientSlug) ?? "";
    const surface = body.surface;
    const sessionId = body.sessionId;

    // Durable, distributed ceiling keyed per slug (bounds even unknown-slug spam).
    // Fails OPEN on a DB blip, so telemetry degrades rather than the guard breaking.
    if (!(await consumeBudget(`funnel-event:${clientSlug}`, BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))) {
      return ack();
    }

    if (!isFunnelSurface(surface) || !isValidSessionId(sessionId)) return ack();
    const client = getClient(clientSlug);
    if (!client) return ack();

    const events = parseFunnelEvents(body.events);
    if (events.length === 0) return ack();

    await insertFunnelEvents(
      events.map((e) => ({
        clientId: client.id,
        surface,
        sessionId,
        step: e.step,
        meta: e.meta,
      })),
    );
    return ack();
  } catch {
    // Telemetry never errors the caller.
    return ack();
  }
}
