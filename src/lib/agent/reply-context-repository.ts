// RECALL-AWARE BOOKING REPLIES: the reads.
//
// Correlates one inbound number to the outbound each lifecycle module last SENT
// to it, and hands the raw facts to the pure decider in ./reply-context.ts. This
// file decides nothing; it only fetches.
//
// THE CORRELATION KEY is `to_address` on the module's own outbox, which is the
// address the drain actually resolved and messaged, not the number on the patient
// record. That is the same key every other reply-linkage block in the inbound
// webhook uses, so this cannot correlate to a message that was never sent to this
// number. Rows with a null `sent_at` are excluded: a queued or drafted message is
// not something a patient can be replying to.
//
// EVERY READ IS BEST EFFORT AND ISOLATED. Each module is fetched in its own try,
// so one unreadable table costs that module's context and nothing else, and a
// total failure returns no candidates, which the decider turns into null, which
// the webhook turns into exactly today's behaviour. Nothing here may throw.
//
// POST-OP IS DELIBERATELY NOT COLLECTED. src/lib/postop/inbound.ts answers and
// returns before the booking agent for every reply inside its window, so a
// post-op candidate is unreachable from here; and the decider refuses one anyway.
// See POSTOP_NEVER_PRIMES in ./reply-context.ts for the full argument.

import { serviceClient } from "@/lib/supabase/server";
import type { ReplyContextCandidate, ReplyContextVeto } from "./reply-context";

export interface ReplyContextCorrelation {
  candidates: ReplyContextCandidate[];
  vetoes: ReplyContextVeto[];
}

const EMPTY: ReplyContextCorrelation = { candidates: [], vetoes: [] };

/** The latest SENT outbox row for this address, as `{ touchId, sentAt }`. */
async function latestSend(
  table: string,
  toAddress: string,
): Promise<{ touchId: string; sentAt: string } | null> {
  const { data, error } = await serviceClient()
    .from(table)
    .select("touch_id, sent_at")
    .eq("to_address", toAddress)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; sent_at: string | null };
  if (!row.touch_id || !row.sent_at) return null;
  return { touchId: row.touch_id, sentAt: row.sent_at };
}

/** One column off one touch row, by id. */
async function touchField(
  table: string,
  column: string,
  touchId: string,
): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from(table)
    .select(column)
    .eq("id", touchId)
    .maybeSingle();
  if (error) throw error;
  const value = (data as Record<string, unknown> | null)?.[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Recall. The target row is read rather than parsed out of the composite target
 * id: `${siteId}:${patientId}:${recallType}` is a convention, and a convention is
 * not a place to get a patient identity from.
 */
async function recallCandidate(toAddress: string): Promise<ReplyContextCandidate | null> {
  const send = await latestSend("recall_outbox", toAddress);
  if (!send) return null;
  const targetId = await touchField("recall_touch", "target_id", send.touchId);
  if (!targetId) return null;
  const { data, error } = await serviceClient()
    .from("recall_target")
    .select("id, site_id, dentally_patient_id, recall_type")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    site_id: string;
    dentally_patient_id: string;
    recall_type: string;
  };
  return {
    module: "recall",
    reference: row.id,
    siteId: row.site_id,
    patientId: String(row.dentally_patient_id),
    sentAt: send.sentAt,
    recallType: row.recall_type === "hygienist" ? "hygienist" : "dentist",
  };
}

/** Reactivation. `reason` decides whether this is a check-up or a stalled plan. */
async function reactivationCandidate(toAddress: string): Promise<ReplyContextCandidate | null> {
  const send = await latestSend("reactivation_outbox", toAddress);
  if (!send) return null;
  const targetId = await touchField("reactivation_touch", "target_id", send.touchId);
  if (!targetId) return null;
  const { data, error } = await serviceClient()
    .from("reactivation_target")
    .select("id, site_id, dentally_patient_id, reason, treatment")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    site_id: string;
    dentally_patient_id: string;
    reason: string | null;
    treatment: string | null;
  };
  const reason =
    row.reason === "stalled_plan" || row.reason === "overdue_recall" || row.reason === "lapsed"
      ? row.reason
      : null;
  return {
    module: "reactivation",
    reference: row.id,
    siteId: row.site_id,
    patientId: String(row.dentally_patient_id),
    sentAt: send.sentAt,
    reactivationReason: reason,
    treatmentHint: row.treatment,
  };
}

/** Treatment-plan closer. The plan's own title is the (lookup-only) hint. */
async function closerCandidate(toAddress: string): Promise<ReplyContextCandidate | null> {
  const send = await latestSend("closer_outbox", toAddress);
  if (!send) return null;
  const opportunityId = await touchField("closer_touch", "opportunity_id", send.touchId);
  if (!opportunityId) return null;
  const { data, error } = await serviceClient()
    .from("treatment_opportunity")
    .select("id, site_id, dentally_patient_id, treatment")
    .eq("id", opportunityId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    site_id: string;
    dentally_patient_id: string;
    treatment: string | null;
  };
  return {
    module: "closer",
    reference: row.id,
    siteId: row.site_id,
    patientId: String(row.dentally_patient_id),
    sentAt: send.sentAt,
    treatmentHint: row.treatment,
  };
}

/**
 * Balance reminders. A VETO, never a candidate: a reply from somebody the practice
 * has just told they owe money is a conversation for a person, and the module's own
 * inbound linkage already stops the cadence and raises a work item. The touch row
 * carries the patient id directly, so no third read is needed.
 */
async function collectionVeto(toAddress: string): Promise<ReplyContextVeto | null> {
  const send = await latestSend("collection_outbox", toAddress);
  if (!send) return null;
  const { data, error } = await serviceClient()
    .from("collection_touch")
    .select("patient_id, site_id")
    .eq("id", send.touchId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { patient_id: string; site_id: string };
  return {
    module: "collection",
    siteId: row.site_id,
    patientId: String(row.patient_id),
    sentAt: send.sentAt,
  };
}

async function settle<T>(label: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[reply-context] could not correlate the ${label} outbound; skipping it`, err);
    return null;
  }
}

/**
 * Every correlation for one inbound number, fetched in parallel.
 *
 * Four indexed single-row lookups per module at worst, and they only run when the
 * caller has already decided this inbound is going to the booking agent (past
 * STOP, past the no-show and post-op handlers, past the opt-out gate), so a
 * suppressed number never pays for them.
 */
export async function collectReplyContext(toAddress: string): Promise<ReplyContextCorrelation> {
  if (!toAddress) return EMPTY;
  const [recall, reactivation, closer, collection] = await Promise.all([
    settle("recall", () => recallCandidate(toAddress)),
    settle("reactivation", () => reactivationCandidate(toAddress)),
    settle("closer", () => closerCandidate(toAddress)),
    settle("collection", () => collectionVeto(toAddress)),
  ]);
  return {
    candidates: [recall, reactivation, closer].filter(
      (c): c is ReplyContextCandidate => c !== null,
    ),
    vetoes: collection ? [collection] : [],
  };
}
