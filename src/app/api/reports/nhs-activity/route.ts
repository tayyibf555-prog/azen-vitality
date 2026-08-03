import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { presetWindow, customWindow, REPORT_PRESETS, type ReportPreset } from "@/lib/reports/report-window";
import { readNhsBandReport } from "@/lib/reports/flagship-read";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/reports/nhs-activity?client=<slug>&preset=<preset> | &from=&to=
//
// Report A: the band-level NHS activity breakdown per clinician, over a window.
// Authed members with access to the client; site-scoped to the user's current
// view selection (the top-bar site switcher). Returns the full per-clinician ×
// band report so the client can filter clinician/band in the UI without a round
// trip; changing the PERIOD re-queries here because a different window is a
// different backward scan.
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Reports is owner-only (see the page's requireModuleAccess("reports") + the
  // nav OWNER_ROLES). The page guard never runs on this data route, so repeat the
  // owner gate here or a coordinator/clinician pulls the per-clinician NHS band
  // breakdown the screen denies them. Matches reports/generate and payment-allocation.
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const presetRaw = url.searchParams.get("preset");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const now = new Date();

  const window =
    presetRaw && REPORT_PRESETS.includes(presetRaw as ReportPreset)
      ? presetWindow(presetRaw as ReportPreset, now)
      : customWindow(from, to);
  if (!window) {
    return Response.json({ ok: false, error: "invalid period" }, { status: 400 });
  }

  const siteIds = await getViewSiteIds(client.id);
  try {
    const result = await readNhsBandReport({ siteIds, window, now });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[reports] nhs-activity read failed", err);
    return Response.json({ ok: false, error: "report unavailable" }, { status: 500 });
  }
}
