import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getLead, setLeadStage } from "@/lib/speed-to-lead/repository";
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
    case "resend":
      // Re-fire first contact. contactLead records the attempt and, on success,
      // stamps first_response_at and advances the stage to 'contacted'.
      await contactLead(lead);
      return Response.json({ ok: true });
    default:
      return bad(`Unknown action: ${action}`);
  }
}
