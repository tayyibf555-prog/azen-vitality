/**
 * Reaction layer for parsed Dentally webhook events.
 *
 * `classifyEvent` is pure (unit-tested in webhook.test.ts). `dispatchWebhookEvent`
 * is the extension point: today each branch is a no-op with a TODO marking the
 * intended reaction. The real reactions land when the downstream modules exist.
 */

export type EventClass = "appointment" | "patient" | "other";

/** Pure: map a Dentally event type to a coarse class. */
export function classifyEvent(eventType: string): EventClass {
  if (eventType.startsWith("appointment.")) return "appointment";
  if (eventType.startsWith("patient.")) return "patient";
  return "other";
}

export interface DispatchInput {
  eventType: string;
  siteId: string | null;
  resource: Record<string, unknown>;
}

/**
 * Route a parsed event to its reaction. Never throws for known OR unknown
 * event types — recording the event must succeed even when no reaction is
 * wired yet. Reactions arrive as the relevant modules are built.
 */
export async function dispatchWebhookEvent(parsed: DispatchInput): Promise<void> {
  switch (classifyEvent(parsed.eventType)) {
    case "appointment":
      // TODO react: no-show defence on did_not_attend, closed-loop on completed.
      // Appointment payloads carry the state timestamps (confirmed_at, arrived_at,
      // in_surgery_at, completed_at, cancelled_at, did_not_attend_at).
      return;
    case "patient":
      // TODO react: refresh recall dates / consent.
      return;
    case "other":
      // Unknown/unhandled event type: accepted and recorded, no reaction.
      return;
  }
}
