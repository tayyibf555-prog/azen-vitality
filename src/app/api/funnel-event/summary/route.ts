import { requireUser, requireOwnerRole } from "@/lib/auth/guard";
import { funnelSummary, isFunnelSurface } from "@/lib/funnel/events";

export const dynamic = "force-dynamic";

// OWNER-ONLY: per-step counts for one surface over a date range, powering a
// later drop-off UI. requireUser gates on a verified session (no-op until auth is
// enforced, matching the other dashboard routes) and requireOwnerRole restricts
// it to the practice owner / agency admin. Scoped to the caller's own client so a
// signed-in user can never read another tenant's funnel.

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // a year, so an open range can't scan forever

function bad(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user; // 401 when enforced + signed out
  const forbidden = requireOwnerRole(user);
  if (forbidden) return forbidden; // 403 for non-owner roles

  const url = new URL(request.url);
  const surface = url.searchParams.get("surface");
  if (!isFunnelSurface(surface)) {
    return bad("surface must be one of assessment, booking", 400);
  }

  // Client scope: an enforced user reads only their own client; agency_admin (null
  // clientId, spans all) and the pre-auth pilot fall back to the single tenant.
  const clientId = user?.clientId ?? "vitality";

  // Date range: default to the last 30 days; both bounds optional but clamped.
  const now = Date.now();
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  const toMs = toParam && !Number.isNaN(Date.parse(toParam)) ? Date.parse(toParam) : now;
  let fromMs =
    fromParam && !Number.isNaN(Date.parse(fromParam))
      ? Date.parse(fromParam)
      : toMs - 30 * 24 * 60 * 60 * 1000;
  if (fromMs > toMs) fromMs = toMs;
  if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;

  try {
    const steps = await funnelSummary({
      clientId,
      surface,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
    });
    return Response.json({
      ok: true,
      surface,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      steps,
    });
  } catch {
    return bad("could not load the funnel summary", 500);
  }
}
