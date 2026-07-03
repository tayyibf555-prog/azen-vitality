import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getLead, setLeadStage, claimLeadFromStage } from "@/lib/speed-to-lead/repository";
import { contactLead } from "@/lib/speed-to-lead/contact";

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
