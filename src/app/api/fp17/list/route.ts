import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listDeclarations } from "@/lib/fp17/repository";
import type { Fp17Status } from "@/lib/fp17/types";

export const dynamic = "force-dynamic";

const STATUSES: Fp17Status[] = ["new", "reviewed", "archived"];

// Internal worklist: a client's FP17 / PR consent + exemption declarations, newest
// first, for staff to review. Auth-gated (requireUser + requireClientAccess) AND
// module-guarded (requireModuleApiAccess): page guards do NOT protect API routes, so
// the clinician (denied fp17 in the nav) is denied this route too.
//
// The signature VALUE is never returned here — listDeclarations yields summaries
// carrying only the signature method + signedAt, so a drawn signature image is never
// re-served to a worklist. Nothing here is submitted to the NHS (Compass).

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const moduleDenied = requireModuleApiAccess(auth, "fp17");
  if (moduleDenied) return moduleDenied;
  // A VIEW capability, not a write one, so it does NOT fail closed when auth is
  // unenforced (see keys.ts `destructive`). Declarations carry a patient's NHS
  // exemption grounds, which is health-adjacent personal data the practice may
  // want to scope to named people even inside a module they can all reach.
  const capabilityDenied = await requireCapability(auth, "clinical.fp17.view");
  if (capabilityDenied) return capabilityDenied;

  try {
    // Scope the worklist to the dashboard's selected site (browser-called route,
    // cookie present). "All sites" passes every site; declarations with no site
    // remain visible either way so nothing is stranded un-triaged.
    const scope = await getViewScope(client.id);
    const declarations = await listDeclarations(
      client.id,
      200,
      scope.isAllSites ? undefined : scope.siteIds,
    );

    const byStatus: Record<Fp17Status, number> = { new: 0, reviewed: 0, archived: 0 };
    for (const d of declarations) byStatus[d.status] += 1;

    return Response.json({
      ok: true,
      declarations,
      stats: {
        total: declarations.length,
        byStatus: STATUSES.map((status) => ({ status, count: byStatus[status] })),
      },
    });
  } catch {
    // LOUD FAILURE: a read error is an honest failure, never a confident empty list.
    // The worklist renders FP17_COPY.readFailed off ok:false, not an empty state.
    return Response.json({ ok: false, error: "read-failed" }, { status: 500 });
  }
}
