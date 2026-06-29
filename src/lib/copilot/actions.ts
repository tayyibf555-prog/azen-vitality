import { serviceClient } from "@/lib/supabase/server";

// Audit trail for side-effectful co-pilot actions. Every send attempt (sent, dry
// run, or blocked) is recorded so the practice can see exactly what the assistant
// did on its behalf. Logging is best-effort and must never block the action.

export interface CopilotActionLog {
  clientId: string;
  siteId: string | null;
  actor: string;
  action: string;
  targetRef: string | null;
  targetName: string | null;
  channel: string | null;
  body: string | null;
  status: string;
}

export async function logCopilotAction(a: CopilotActionLog): Promise<void> {
  try {
    await serviceClient().from("copilot_action").insert({
      client_id: a.clientId,
      site_id: a.siteId,
      actor: a.actor,
      action: a.action,
      target_ref: a.targetRef,
      target_name: a.targetName,
      channel: a.channel,
      body: a.body,
      status: a.status,
    });
  } catch {
    // Never let an audit-write failure break the action itself.
  }
}
