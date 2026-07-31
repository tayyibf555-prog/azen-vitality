import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { ROSTER } from "@/app/api/mock-dentally/_rota";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/practitioners?site_id=&per_page=
//
// Mirrors the live shape the availability flow consumes: {id, active, site_id,
// user:{first_name,last_name}}.
//
// This used to echo the requested site_id onto the SAME two practitioner ids, so
// every site looked identically staffed and no practitioner id could ever be
// wrong. It now serves each site's own roster (_rota.ts), and an UNKNOWN site_id
// returns nothing rather than inventing a team. site-cc keeps an active:false row
// (prac-9), so a caller that forgets to filter on `active` is caught.
//
// site_id IS ECHOED BACK IN THE FORM IT WAS ASKED FOR, and that is load-bearing
// rather than cosmetic. Callers query with the real Dentally UUID, and
// listSitePractitionersSafe drops any row whose site_id is a string that does not
// equal that UUID. Emitting the INTERNAL id here ("site-cc") therefore filtered
// out every practitioner and returned an empty list with failed:false - a silent
// "nobody works at this practice" that the diary would have drawn as a fully grey
// day while reporting the read as successful. Live Dentally echoes its own id, so
// echoing the requested one is both correct and faithful.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const requested = url.searchParams.get("site_id");
  const siteId = resolveMockSiteId(requested) ?? "site-cc";
  const roster = ROSTER[siteId] ?? [];
  const practitioners = roster.map((p) => ({
    id: p.id,
    active: p.active,
    site_id: requested ?? siteId,
    user: { first_name: p.first, last_name: p.last },
  }));
  return Response.json({ practitioners });
}
