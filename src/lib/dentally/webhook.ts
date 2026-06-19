/**
 * Pure helpers for the inbound Dentally webhook receiver.
 *
 * No I/O here: token verification and payload parsing only, so they can be
 * unit-tested in isolation (see webhook.test.ts). Anything that talks to the
 * DB lives in webhook-repository.ts; anything that reacts to an event lives in
 * webhook-dispatch.ts.
 */

/**
 * Verify the shared webhook token.
 *
 * Returns false if `provided` is missing/empty. Otherwise compares against
 * `secret` with a length-safe, full-scan equality check (we accumulate the
 * difference over every character rather than returning on the first mismatch,
 * so the comparison does not short-circuit). Differing lengths return false
 * without indexing out of range.
 */
export function verifyWebhookToken(
  provided: string | null | undefined,
  secret: string,
): boolean {
  if (!provided) return false;
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

export interface ParsedWebhookEvent {
  eventType: string;
  dentallyEventId: string | null;
  siteId: string | null;
  resource: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Defensively extract the event shape from a raw webhook body (+ optional
 * headers). Returns null if no event type can be resolved or the body is not
 * a plain object.
 */
export function parseWebhookEvent(
  body: unknown,
  headers?: Record<string, string>,
): ParsedWebhookEvent | null {
  const root = asRecord(body);
  if (!root) return null;

  const hdr = headers ?? {};

  // =========================================================================
  // CALIBRATION: confirm against Dentally webhook payloads.
  //
  // The exact webhook envelope (where the event type and event id live, and
  // whether the resource is nested) is NOT confirmed yet. Every assumption
  // about the raw shape lives in THIS block; the route and dispatcher consume
  // only the normalised ParsedWebhookEvent above, so recalibrating here is the
  // single place to change when real payloads are available.
  //
  //   - eventType: body.event ?? body.type ?? body.topic ?? header
  //                `x-dentally-event`. Required — null if none resolve.
  //   - dentallyEventId: body.id ?? body.event_id ?? header
  //                `x-dentally-delivery` ?? null (used for idempotent dedupe).
  //   - resource: body.data ?? body.object ?? body.payload ?? the body itself
  //                (when the event is flat with no nested resource).
  //   - siteId: resource.site_id ?? body.site_id ?? null.
  // =========================================================================
  const eventType =
    pickString(root, "event", "type", "topic") ?? hdr["x-dentally-event"] ?? null;
  if (!eventType) return null;

  const dentallyEventId =
    pickString(root, "id", "event_id") ?? hdr["x-dentally-delivery"] ?? null;

  const resource =
    asRecord(root.data) ??
    asRecord(root.object) ??
    asRecord(root.payload) ??
    root;

  const siteId = pickString(resource, "site_id") ?? pickString(root, "site_id");
  // =========================================================================
  // END CALIBRATION block.
  // =========================================================================

  return { eventType, dentallyEventId, siteId, resource };
}
