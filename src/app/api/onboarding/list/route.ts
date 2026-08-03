import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listSubmissions } from "@/lib/onboarding/repository";
import type { OnboardingStatus, OnboardingSubmission } from "@/lib/onboarding/types";

export const dynamic = "force-dynamic";

const STATUSES: OnboardingStatus[] = ["new", "reviewed", "registered", "archived"];

// Internal worklist: a client's onboarding submissions, newest first, for staff to
// review. Auth-gated (requireUser + requireClientAccess). Raw file storage paths are
// NOT exposed as URLs here — only the document metadata (name/size/type); staff fetch
// a signed URL on demand from the /api/onboarding/file endpoint.

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Onboarding is outside CLINICIAN_SLUGS: reviewing and registering new-patient
  // submissions (contact details, medical intake, uploaded documents, consent) is
  // reception work, and requireClientAccess admits every role attached to the client.
  const moduleDenied = requireModuleApiAccess(auth, "onboarding");
  if (moduleDenied) return moduleDenied;

  // Scope the worklist to the dashboard's selected site (browser-called route,
  // cookie present). "All sites" passes every site; submissions with no site chosen
  // remain visible either way so nothing is stranded un-triaged.
  const scope = await getViewScope(client.id);
  const submissions = await listSubmissions(client.id, 200, scope.isAllSites ? undefined : scope.siteIds);

  // Strip the raw storage paths from the response; expose only document metadata so a
  // path can never be lifted from the list and replayed. Staff resolve a short-lived
  // signed URL per file via /api/onboarding/file, which re-checks the client prefix.
  const sanitised = submissions.map((s: OnboardingSubmission) => ({
    ...s,
    files: s.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
  }));

  const byStatus: Record<OnboardingStatus, number> = {
    new: 0,
    reviewed: 0,
    registered: 0,
    archived: 0,
  };
  for (const s of submissions) byStatus[s.status] += 1;

  return Response.json({
    submissions: sanitised,
    stats: {
      total: submissions.length,
      byStatus: STATUSES.map((status) => ({ status, count: byStatus[status] })),
    },
  });
}
