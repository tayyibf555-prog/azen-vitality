import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { generateBrief } from "@/lib/daily-brief/generate";
import type { BriefContext } from "@/lib/daily-brief/types";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/daily-brief?client=<slug>
// Computes the daily brief on read by composing the module repositories. The
// dashboard fetches this for its "Today's brief" headline; the staff page builds
// the brief server-side directly.
export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(slug);
  if (!client) {
    return Response.json({ ok: false, error: "Unknown client" }, { status: 400 });
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // Role comes from the authed user when enforced; default to client_owner so
  // the dashboard headline still renders all priorities in the pilot.
  const role: Role = auth?.role ?? "client_owner";
  const siteIds = getSites(client.id).map((s) => s.id);

  const ctx: BriefContext = { clientId: client.id, siteIds, role, now: new Date() };
  const brief = await generateBrief(ctx);
  return Response.json({ ok: true, brief });
}
