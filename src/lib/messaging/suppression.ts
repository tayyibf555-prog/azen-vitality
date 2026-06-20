import { serviceClient } from "@/lib/supabase/server";
import type { MessageChannel } from "./types";

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.has(body.trim().toLowerCase());
}

export async function isSuppressed(siteId: string, channel: MessageChannel, toRef: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("message_suppression")
    .select("id")
    .eq("site_id", siteId)
    .eq("channel", channel)
    .eq("to_ref", toRef)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function addSuppression(
  siteId: string,
  channel: MessageChannel,
  toRef: string,
  reason = "stop",
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("message_suppression")
    .upsert({ site_id: siteId, channel, to_ref: toRef, reason }, { onConflict: "site_id,channel,to_ref" });
  if (error) throw error;
}
