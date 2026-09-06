import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getLead, setLeadStage, claimLeadFromStage } from "@/lib/speed-to-lead/repository";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Site guard against the lead's real site; no-op when enforcement is off. */
function siteDenied(auth: AuthedUser | null, siteId: string): Response | null {
  return auth ? requireSiteAccess(auth, siteId) : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;

  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  // Leads are acquisition work, outside CLINICIAN_SLUGS. The lead's site check below
  // is tenancy only — a clinician holds every site of their own practice.
  const moduleDenied = requireModuleApiAccess(auth, "speed-to-lead");
  if (moduleDenied) return moduleDenied;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const leadId = body.leadId;
  if (typeof leadId !== "string" || leadId === "") return bad("leadId is required");

  const lead = await getLead(leadId);
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });
  const denied = siteDenied(auth, lead.siteId);
  if (denied) return denied;

  // THE KILL SWITCH, READ THE WAY A SEND DOOR HAS TO READ IT (ruling W1-B/1-5).
  //
  // `resend` below calls `contactLead`, which dispatches through `sendMessage`
  // DIRECTLY — speed is the point of the module, so there is no outbox row and no
  // drain to re-gate it with `getDisabledSlugsForSend`. This line is therefore the
  // WHOLE distance between a receptionist's click and a real first-contact SMS.
  //
  // `isSystemEnabled` — what this used to call — resolves a toggle-table READ
  // ERROR to the slug's catalog default, and `speed-to-lead` is default-ON, so a
  // transient blip on system_toggle answered "enabled" for a system the owner had
  // explicitly switched off. `isSystemEnabledForSend` is identical while
  // MESSAGING_DRY_RUN is on and counts an unreadable switch as DISABLED once
  // messaging is live. A refused resend is a click the receptionist repeats; a
  // text sent out of a system the owner had turned off is not retractable. Every
  // other door onto this same primitive already reads it this way:
  // /api/speed-to-lead/intake, /api/speed-to-lead/sweep,
  // /api/webhooks/twilio/voice, /api/smile-assessment/submit and the co-pilot's
  // nudge_lead. This was the last one.
  //
  // UNCONDITIONAL, for the same reason intake's is. The client used to be read as
  // `getSite(lead.siteId)?.clientId` and the check skipped entirely when that came
  // back undefined, so a lead on a site id SITES no longer maps — a renamed or
  // retired site — reached the send with no switch consulted at all. Site access
  // normally refuses that lead first (`requireSiteAccess` derives the user's sites
  // from SITES), but that guard is a no-op while AUTH_ENFORCED is off, and a
  // kill switch that depends on another guard being armed is not a kill switch.
  // The practice's own client id is the fallback, exactly as intake does it.
  const clientId = getSite(lead.siteId)?.clientId ?? "vitality";
  if (!(await isSystemEnabledForSend(clientId, "speed-to-lead"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }

  switch (action) {
    case "mark-booked":
      await setLeadStage(lead.id, "booked");
      return Response.json({ ok: true });
    case "mark-lost":
      await setLeadStage(lead.id, "lost");
      return Response.json({ ok: true });
    case "resend": {
      // Re-fire first contact, but gate on the atomic claim so two concurrent resends
      // (or a resend racing the SLA sweep) can't both text the same lead. A terminal
      // lead is never resent. Claim from the CURRENT stage -> 'contacting'; a lost claim
      // means another contact is already in flight.
      if (lead.stage === "booked" || lead.stage === "lost") {
        return bad(`Cannot resend a ${lead.stage} lead`, 409);
      }
      const from = lead.stage;
      if (!(await claimLeadFromStage(lead.id, from))) {
        return Response.json({ ok: true, skipped: "a contact is already in progress" });
      }
      try {
        await contactLead(lead);
      } finally {
        // If contactLead did not move the lead off 'contacting' (silent early-return
        // for no address, or a throw), restore its ORIGINAL stage so it is not stranded.
        const after = await getLead(lead.id).catch(() => null);
        if (after && after.stage === "contacting") {
          await setLeadStage(lead.id, from).catch(() => {});
        }
      }
      return Response.json({ ok: true });
    }
    default:
      return bad(`Unknown action: ${action}`);
  }
}
