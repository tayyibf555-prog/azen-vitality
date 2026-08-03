import { getClient } from "@/lib/mock";
import { getViewSiteIds, getViewSiteSelection, ALL_SITES } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { presetWindow, customWindow, REPORT_PRESETS, type ReportPreset } from "@/lib/reports/report-window";
import { readPaymentAllocation } from "@/lib/reports/flagship-read";

export const dynamic = "force-dynamic";

/**
 * 300s, not 60. Attributing money to a clinician costs one live invoice read per
 * invoice settled in the period — Dentally publishes invoice lines on the
 * per-invoice route only, and ignores `include=invoice_items` on the index
 * (probed 2026-08-03). A 60-day all-sites run measured ~21 payment pages plus
 * ~1,900 invoice GETs: inside the observed 3,600/hour rate limit, nowhere near
 * inside 60 seconds.
 *
 * The two things that keep this bounded rather than merely long are in the read
 * layer, not here: the window is capped at ALLOCATION_MAX_WINDOW_DAYS and the
 * fan-out at INVOICE_FETCH_BUDGET, and exceeding either returns an honest
 * unavailable reason. Neither ever truncates.
 */
export const maxDuration = 300;

// GET /api/reports/payment-allocation?client=<slug>&preset=<preset> | &from=&to=
//
// Report B: money received in the period, attributed to the clinician on the
// INVOICE LINE it settled (payment → explanations[].invoice_id → /v1/invoices/{id}
// → invoice_items[].practitioner_id, calibrated live 2026-08-03). Money that
// cannot reach a clinician is returned in its own named buckets, never dropped
// and never spread. This is still NOT the pay-the-dentists figure: Dentally
// exposes no `closed` field, so no line is ever payable. Authed members with
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
  // Reports is an owner-only module (nav.ts gives it OWNER_ROLES, the page calls
  // requireModuleAccess("reports")). The page guard does not reach here, so the
  // owner gate must be repeated on the data route or a coordinator/clinician can
  // pull per-clinician money attribution the screen refuses them. Matches the
  // sibling reports/generate route.
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
