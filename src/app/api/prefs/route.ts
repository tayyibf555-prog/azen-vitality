import { verifyPrefToken } from "@/lib/messaging/pref-token";
import { setChannelPref, type PreferredChannel } from "@/lib/messaging/channel-pref";
import { addSuppression } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import { getSite, getSites } from "@/lib/mock/clients";
import { consumeBudget } from "@/lib/rate-budget";

export const dynamic = "force-dynamic";

// Public endpoint behind the signed /prefs/<token> page. A patient POSTs their
// channel choice (SMS/WhatsApp) or asks us to stop messaging them. The token is
// the only authority: it is signed and carries the (site, patient) pair, so no
// caller can set another patient's preference. Like the other public write
// endpoints it is api_budget-guarded and never throws to the client.

// Bound how many times one patient link can POST per window (a signed link is not
// a secret if it leaks, and this is a real DB write). Fails OPEN on a DB error.
const BUDGET_LIMIT = Number(process.env.PREFS_BUDGET_LIMIT ?? "30");
const BUDGET_WINDOW_SECONDS = Number(process.env.PREFS_BUDGET_WINDOW ?? "3600");

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Apply an opt-out for a known patient exactly like an inbound STOP: record a
 * suppression by the patient ref, on BOTH phone channels, for EVERY site of the
 * practice. This reuses the SAME addSuppression -> message_suppression machinery
 * the inbound webhook uses; it is not a parallel opt-out list.
 */
async function suppressAcrossPractice(siteId: string, patientRef: string): Promise<void> {
  const clientId = getSite(siteId)?.clientId ?? "vitality";
  const sites = new Set<string>(getSites(clientId).map((s) => s.id));
  sites.add(siteId); // belt and braces: always cover the token's own site
  const channels: MessageChannel[] = ["sms", "whatsapp"];
  for (const sid of sites) {
    for (const ch of channels) {
      await addSuppression(sid, ch, patientRef, "stop");
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  // The token is the authority. Verify BEFORE any spend or write; a forged/tampered
  // token resolves to null and is rejected without consuming budget.
  const payload = verifyPrefToken(str(body.token));
  if (!payload) return bad("This preferences link is invalid or has expired.", 400);

  const action = str(body.action);
  if (action !== "sms" && action !== "whatsapp" && action !== "stop") {
    return bad("action must be one of sms, whatsapp, stop");
  }

  // Abuse ceiling per patient link. Fails open on a DB error (never blocks a genuine
  // patient over a transient outage).
  const withinBudget = await consumeBudget(`prefs:${payload.patientRef}`, BUDGET_LIMIT, BUDGET_WINDOW_SECONDS);
  if (!withinBudget) return bad("Too many requests, please try again later.", 429);

  try {
    if (action === "stop") {
      await suppressAcrossPractice(payload.siteId, payload.patientRef);
      return Response.json({ ok: true, action: "stop" });
    }
    await setChannelPref(payload.siteId, payload.patientRef, action as PreferredChannel);
    return Response.json({ ok: true, action });
  } catch {
    // Never leak internals; the patient just needs to know to retry.
    return bad("Sorry, we could not save that just now. Please try again.", 500);
  }
}
