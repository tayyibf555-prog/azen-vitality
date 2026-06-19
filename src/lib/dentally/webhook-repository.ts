import { serviceClient } from "@/lib/supabase/server";

/**
 * Persistence for inbound webhook events (table `webhook_event`).
 *
 * Recording is idempotent on (provider, dentally_event_id): Dentally may
 * re-deliver the same event, so we never insert a duplicate when the delivery
 * id is known. The unique partial index on (provider, dentally_event_id) is the
 * backstop for the concurrent-insert race.
 */

const DEFAULT_PROVIDER = "dentally";

// Postgres unique-violation SQLSTATE, surfaced by supabase-js as error.code.
const UNIQUE_VIOLATION = "23505";

interface RecordWebhookInput {
  provider?: string;
  dentallyEventId: string | null;
  eventType: string;
  siteId: string | null;
  payload: unknown;
}

async function findExisting(
  provider: string,
  dentallyEventId: string,
): Promise<string | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("webhook_event")
    .select("id")
    .eq("provider", provider)
    .eq("dentally_event_id", dentallyEventId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as { id: string }).id : null;
}

/**
 * Record a webhook event, returning its row id and whether it was a duplicate.
 *
 * When `dentallyEventId` is non-null we first look for an existing row and
 * short-circuit to `{ duplicate: true }` if found. Otherwise we insert. If a
 * concurrent insert wins the race and the unique index rejects ours, we
 * re-select and report the duplicate rather than throwing.
 */
export async function recordWebhookEvent(
  input: RecordWebhookInput,
): Promise<{ id: string; duplicate: boolean }> {
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const db = serviceClient();

  if (input.dentallyEventId !== null) {
    const existingId = await findExisting(provider, input.dentallyEventId);
    if (existingId) return { id: existingId, duplicate: true };
  }

  const { data, error } = await db
    .from("webhook_event")
    .insert({
      provider,
      dentally_event_id: input.dentallyEventId,
      event_type: input.eventType,
      site_id: input.siteId,
      payload: input.payload,
    })
    .select("id")
    .single();

  if (error) {
    // Lost the race: a concurrent insert with the same delivery id committed
    // first. Re-select and report the duplicate.
    if (error.code === UNIQUE_VIOLATION && input.dentallyEventId !== null) {
      const existingId = await findExisting(provider, input.dentallyEventId);
      if (existingId) return { id: existingId, duplicate: true };
    }
    throw error;
  }

  return { id: (data as { id: string }).id, duplicate: false };
}

/**
 * Mark a recorded event processed. When `error` is given, store it (dispatch
 * failed) while still flagging the row as processed so it is not retried blind.
 */
export async function markWebhookProcessed(
  id: string,
  error?: string,
): Promise<void> {
  const db = serviceClient();
  const { error: dbError } = await db
    .from("webhook_event")
    .update({
      processed: true,
      processed_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    })
    .eq("id", id);
  if (dbError) throw dbError;
}
