import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { patchOverlay, type OverlayPatch } from "@/lib/task-queue/repository";

export const dynamic = "force-dynamic";

// Mutate the persisted overlay for one computed task. requireUser +
// requireClientAccess; the client is resolved from body.clientSlug (or ?client=).
// The candidate task itself is never stored, only this overlay (done/snoozed/
// assigned), keyed by its stable taskKey.

const ACTIONS = ["complete", "dismiss", "snooze", "reopen", "claim", "unclaim"] as const;
type Action = (typeof ACTIONS)[number];

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // The task queue is the coordinators' work list (chase this lead, call this patient)
  // and is outside CLINICIAN_SLUGS.
  const moduleDenied = requireModuleApiAccess(auth, "task-queue");
  if (moduleDenied) return moduleDenied;

  const taskKey = str(body.taskKey, 200);
  if (!taskKey) return bad("taskKey is required");

  const action = str(body.action, 20) as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return bad(`action must be one of: ${ACTIONS.join(", ")}`);
  }

  const actor = auth?.email ?? auth?.id ?? null;

  let patch: OverlayPatch;
  switch (action) {
    case "complete":
      patch = { status: "done" };
      break;
    case "dismiss":
      patch = { status: "dismissed" };
      break;
    case "snooze": {
      // Clamp to [1 min, 1 year]; an unbounded/non-finite value would overflow the
      // Date range and throw a RangeError (uncaught -> 500) before the try below.
      const raw = typeof body.snoozeMinutes === "number" && Number.isFinite(body.snoozeMinutes)
        ? body.snoozeMinutes
        : 1440;
      const minutes = Math.min(Math.max(Math.round(raw), 1), 60 * 24 * 365);
      patch = {
        status: "snoozed",
        snoozedUntil: new Date(Date.now() + minutes * 60000).toISOString(),
      };
      break;
    }
    case "reopen":
      patch = { status: "open", snoozedUntil: null };
      break;
    case "claim":
      patch = { status: "open", assignee: actor };
      break;
    case "unclaim":
      patch = { assignee: null };
      break;
  }

  const note = str(body.note, 280);
  if (note !== undefined) patch.note = note;

  try {
    const overlay = await patchOverlay(client.id, taskKey, patch, actor);
    return Response.json({ ok: true, overlay });
  } catch {
    return bad("could not update the task", 500);
  }
}
