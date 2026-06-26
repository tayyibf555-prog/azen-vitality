import { getCapture, setCaptureStatus } from "@/lib/after-hours/repository";
import type { CaptureStatus } from "@/lib/after-hours/types";
import { requireUser, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";

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

  const capture = await getCapture(captureId);
  if (!capture) return Response.json({ error: "Capture not found" }, { status: 404 });
  const denied = siteDenied(auth, capture.siteId);
  if (denied) return denied;

  await setCaptureStatus(captureId, next);
  return Response.json({ ok: true });
}
