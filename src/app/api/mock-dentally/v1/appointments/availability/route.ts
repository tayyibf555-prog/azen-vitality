import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/appointments/availability?site_id=&start_date=&finish_date=
// Returns a few fixed open slots over the next several days (UTC, on the hour).
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id") ?? "site-cc";
  const base = url.searchParams.get("start_date") ?? "2026-06-22";
  const day = (offset: number) => {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const availability = [
    { start_time: `${day(0)}T09:00:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(0)}T15:30:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(1)}T11:00:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(3)}T17:00:00Z`, duration: 30, site_id: siteId },
  ];
  return Response.json({ availability });
}
