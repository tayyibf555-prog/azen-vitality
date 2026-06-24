import { getClient, getSites } from "@/lib/mock";
import { listPatients } from "@/lib/dentally/read";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients?client=<slug>
// Minimal patient list for the command palette (id, name, phone, site).
export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(slug);
  if (!client) return Response.json({ ok: false, patients: [] }, { status: 404 });
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const siteIds = getSites(client.id).map((s) => s.id);
  try {
    const patients = await listPatients(siteIds);
    return Response.json({
      ok: true,
      patients: patients.map((p) => ({ id: p.id, name: p.name, phone: p.phone, siteId: p.siteId })),
    });
  } catch {
    return Response.json({ ok: false, patients: [] }, { status: 500 });
  }
}
