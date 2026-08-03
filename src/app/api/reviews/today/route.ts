import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { listAppointments } from "@/lib/dentally/read";
import { listByAppointments } from "@/lib/reviews/repository";
import type { ReviewStatus } from "@/lib/reviews/types";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

interface TodayItem {
  appointmentId: string;
  patientId: string;
  patientName: string;
  siteId: string;
  start: string;
  state: string;
  practitioner: string | null;
  // The review request for this appointment, if one exists yet, so the UI can show
  // the attendance list and the review status side by side.
  reviewStatus: ReviewStatus | null;
  hasReviewRequest: boolean;
}

// GET /api/reviews/today?client=<slug>
// Today's appointments for the client's sites, each annotated with whether it
// already has a review request (and its status). Drives the staff attendance list:
// mark attended -> POST /api/reviews/attend schedules the request.
export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Reviews is outside CLINICIAN_SLUGS (this feeds the attend action that sends).
  const moduleDenied = requireModuleApiAccess(auth, "reviews");
  if (moduleDenied) return moduleDenied;

  // Limit to the sites this user may act on (when enforced); otherwise all client sites.
  const allSiteIds = await getViewSiteIds(client.id);
  const siteIds = auth ? allSiteIds.filter((id) => auth.siteIds.includes(id)) : allSiteIds;

  const today = londonDayKey(new Date());
  const appts = await listAppointments(siteIds, { from: today, to: today });

  const requests = await listByAppointments(appts.map((a) => a.id));
  const byAppt = new Map(requests.map((r) => [r.dentallyAppointmentId, r]));

  const items: TodayItem[] = appts.map((a) => {
    const req = byAppt.get(a.id) ?? null;
    return {
      appointmentId: a.id,
      patientId: a.patientId,
      patientName: a.patientName,
      siteId: a.siteId,
      start: a.start,
      state: a.state,
      practitioner: a.practitioner,
      reviewStatus: req?.status ?? null,
      hasReviewRequest: req !== null,
    };
  });

  return Response.json({ ok: true, count: items.length, appointments: items });
}
