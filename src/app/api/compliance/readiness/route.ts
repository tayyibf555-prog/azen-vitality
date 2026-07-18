import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// AI compliance readiness check. It reads the practice's real compliance records
// (audits, policies, training) and produces a prioritised action plan plus an
// inspection-readiness view. There is NO live compliance-records source connected
// yet, so there is nothing genuine to assess: rather than score fabricated records,
// the check refuses honestly and explains what to add. When a real records source
// is wired, gather it here and run the existing prompt builder (@/lib/compliance/ai
// buildReadinessPrompt) on the real records to restore the AI assessment.
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  // No real records to assess: refuse honestly instead of scoring fiction.
  return Response.json({
    ok: false,
    awaiting: true,
    error:
      "The AI readiness check runs once your practice's real compliance records are added. Add your audits, policies and training records, then run the check for a prioritised action plan and an inspection view.",
  });
}
