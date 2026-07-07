import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { listPatients, searchPatients } from "@/lib/dentally/read";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// GET /api/dentally/patients?client=<slug>&search=<q>
// Serves BOTH the command palette and the patients-table search. Without ?search it
// returns a BOUNDED fast list (first ~300); with ?search it runs a server-side
// Dentally query so we never page the whole book. The returned objects are a superset
// of the command palette's fields (id/name/phone/siteId), so it stays compatible.
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("client") ?? "";
  const search = params.get("search") ?? "";
  const client = getClient(slug);
  if (!client) return Response.json({ ok: false, patients: [] }, { status: 404 });
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const siteIds = await getViewSiteIds(client.id);
  try {
    const patients = search
      ? await searchPatients(siteIds, search)
      : await listPatients(siteIds, { maxPages: 3 });
    return Response.json({
      ok: true,
      patients: patients.map((p) => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        email: p.email,
        siteId: p.siteId,
        active: p.active,
        lastVisitAt: p.lastVisitAt,
        recallDueAt: p.recallDueAt,
      })),
    });
  } catch {
    return Response.json({ ok: false, patients: [] }, { status: 500 });
  }
}
