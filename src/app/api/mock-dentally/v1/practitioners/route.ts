import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/practitioners?site_id=&per_page=
// Mirrors the live shape the availability flow consumes: {id, active, site_id,
// user:{first_name,last_name}}. Two active practitioners per requested site.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id") ?? "site-cc";
  const practitioners = [
    { id: "prac-1", active: true, site_id: siteId, user: { first_name: "Dana", last_name: "Hale" } },
    { id: "prac-2", active: true, site_id: siteId, user: { first_name: "Femi", last_name: "Osei" } },
    // One inactive row so callers must filter on `active`.
    { id: "prac-9", active: false, site_id: siteId, user: { first_name: "Old", last_name: "Locum" } },
  ];
  return Response.json({ practitioners });
}
