import { getClient } from "@/lib/mock";
import { getViewSiteIds, getViewSiteSelection, ALL_SITES } from "@/lib/site-view";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { presetWindow, customWindow, REPORT_PRESETS, type ReportPreset } from "@/lib/reports/report-window";
import { readPaymentAllocation } from "@/lib/reports/flagship-read";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/reports/payment-allocation?client=<slug>&preset=<preset> | &from=&to=
//
// Report B: payments received per practitioner, with every line flagged for the
// allocation conditions it cannot verify (this is NOT the pay-the-dentists figure
// on its own — the four-way join is not on the API we read). Authed members with
// access to the client; site-scoped to the current view selection.
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

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

  const [siteIds, selection] = await Promise.all([
    getViewSiteIds(client.id),
    getViewSiteSelection(client.id),
  ]);
  const siteId = selection === ALL_SITES ? null : selection;

  try {
    const result = await readPaymentAllocation({ siteIds, window, siteId, now });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[reports] payment-allocation read failed", err);
    return Response.json({ ok: false, error: "report unavailable" }, { status: 500 });
  }
}
