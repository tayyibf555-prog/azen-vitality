import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { presetWindow, customWindow, REPORT_PRESETS, type ReportPreset } from "@/lib/reports/report-window";
import { readNhsClinicalReport } from "@/lib/reports/flagship-read";

export const dynamic = "force-dynamic";
// The per-clinician fan-out can make dozens of live GETs (one probe + a page or
// two per active clinician), so this route needs the longer budget Report B has,
// not the 60s of Report A.
export const maxDuration = 120;

// GET /api/reports/nhs-clinical?client=<slug>&preset=<preset> | &from=&to=
//
// Report C: the clinical completed-vs-pending breakdown per clinician × NHS band,
// read from /v1/treatment_plan_items (NOT nhs_claims). Owner-only, exactly like
// Report A / payment-allocation: the page's requireModuleAccess("reports") never
// runs on this data route, so the owner gate is repeated here or a coordinator /
// clinician could pull the per-clinician breakdown the screen denies them. The
// api-guard coverage test pins that this route carries requireOwnerRole.
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
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
    const result = await readNhsClinicalReport({ siteIds, window, now });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[reports] nhs-clinical read failed", err);
    return Response.json({ ok: false, error: "report unavailable" }, { status: 500 });
  }
}
