import { getCapture, setCaptureStatus } from "@/lib/after-hours/repository";
import type { CaptureStatus } from "@/lib/after-hours/types";
import { requireUser, requireSiteAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
/** Site guard against the capture's real site; no-op when enforcement is off (auth null). */
function siteDenied(auth: AuthedUser | null, siteId: string): Response | null {
  return auth ? requireSiteAccess(auth, siteId) : null;
}

// Action -> the status it sets.
const STATUS_BY_ACTION: Record<string, CaptureStatus> = {
  "mark-followed-up": "followed_up",
  "mark-booked": "booked",
  close: "closed",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  const next = STATUS_BY_ACTION[action];
  if (!next) return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const captureId = body.captureId;
  if (typeof captureId !== "string" || captureId === "") return badRequest("captureId is required");

  // Authenticate once, then authorize against the capture's real site.
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  // After-hours capture is outside CLINICIAN_SLUGS, and the site check below cannot
  // stand in for that: a clinician holds every site of their own practice.
  const moduleDenied = requireModuleApiAccess(auth, "after-hours");
  if (moduleDenied) return moduleDenied;

  const capture = await getCapture(captureId);
  if (!capture) return Response.json({ error: "Capture not found" }, { status: 404 });
  const denied = siteDenied(auth, capture.siteId);
  if (denied) return denied;

  const _clientId = getSite(capture.siteId)?.clientId;
  if (_clientId && !(await isSystemEnabled(_clientId, "after-hours"))) {
    return Response.json({ ok: false, error: "This system is switched off." }, { status: 409 });
  }

  await setCaptureStatus(captureId, next);
  return Response.json({ ok: true });
}
