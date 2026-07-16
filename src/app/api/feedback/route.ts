import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { getClient, CLIENTS } from "@/lib/mock/clients";
import { insertFeedback, listFeedback, setFeedbackStatus } from "@/lib/feedback/repository";
import { notifyFeedbackWebhook } from "@/lib/feedback/webhook";
import { FEEDBACK_SEVERITIES, type FeedbackSeverity } from "@/lib/feedback/types";

export const dynamic = "force-dynamic";

const MAX_NOTE = 2000;

function bad(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

function isSeverity(v: unknown): v is FeedbackSeverity {
  return typeof v === "string" && (FEEDBACK_SEVERITIES as string[]).includes(v);
}

// POST /api/feedback  { clientSlug, pagePath, note, severity }  -> save a quick
// in-app report from the floating "Report an issue" widget (mounted in the c/
// and owner/ authed shells). requireUser gates it like every other authed write;
// the author's id/email/role are always stamped from the verified session, never
// trusted from the body (mirrors patient-notes' authorId/authorName).
export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  let body: { clientSlug?: unknown; pagePath?: unknown; note?: unknown; severity?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug.trim() : "";
  const client = getClient(clientSlug);
  if (!client) return bad("unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const pagePath = typeof body.pagePath === "string" ? body.pagePath.trim().slice(0, 300) : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const severity: FeedbackSeverity = isSeverity(body.severity) ? body.severity : "bug";
  if (!note) return bad("note is required");
  if (note.length > MAX_NOTE) return bad("note is too long");

  let item;
  try {
    item = await insertFeedback({
      clientId: client.id,
      userId: auth?.id ?? null,
      userEmail: auth?.email ?? null,
      role: auth?.role ?? null,
      pagePath: pagePath || "unknown",
      note,
      severity,
    });
  } catch (err) {
    console.error("[feedback] insert failed", err);
    return bad("could not save your feedback", 500);
  }

  // Fire-and-forget: not awaited. notifyFeedbackWebhook never throws by its own
  // contract, but the row is already saved either way, so guard the call site
  // too — a webhook regression must never turn into a 500 for the submitter.
  try {
    notifyFeedbackWebhook(item, client.name);
  } catch {
    // See above: swallow unconditionally.
  }

  return Response.json({ ok: true });
}

// GET /api/feedback  -> every report across every client, newest first. The
// agency console's cross-client list, so agency_admin only (auth is null only
// when enforcement is off, i.e. local/dev, where everything is already open).
export async function GET(): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  if (auth && auth.role !== "agency_admin") return bad("forbidden", 403);

  try {
    const items = await listFeedback();
    const withClientName = items.map((i) => ({
      ...i,
      clientName: CLIENTS.find((c) => c.id === i.clientId)?.name ?? i.clientId,
    }));
    return Response.json({ ok: true, items: withClientName });
  } catch (err) {
    console.error("[feedback] list failed", err);
    return Response.json({ ok: false, items: [] }, { status: 500 });
  }
}

// PATCH /api/feedback  { id, status }  -> change a report's status (e.g. mark
// done). Same route as the list, agency_admin only.
export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  if (auth && auth.role !== "agency_admin") return bad("forbidden", 403);

  let body: { id?: unknown; status?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON");
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!id || !status) return bad("id and status are required");

  try {
    await setFeedbackStatus(id, status);
  } catch (err) {
    console.error("[feedback] status update failed", err);
    return bad("could not update", 500);
  }
  return Response.json({ ok: true });
}
