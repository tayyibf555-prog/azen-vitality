import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { generateTasks } from "@/lib/task-queue/generate";
import type { TaskKind } from "@/lib/task-queue/types";

export const dynamic = "force-dynamic";

// The one prioritised worklist: every actionable item across the practice, computed
// on read by generateTasks (already sorted by priority). requireUser +
// requireClientAccess; the client is resolved from ?client=.

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // The task queue is the coordinators' work list and is outside CLINICIAN_SLUGS.
  const moduleDenied = requireModuleApiAccess(auth, "task-queue");
  if (moduleDenied) return moduleDenied;

  const tasks = await generateTasks({
    clientId: client.id,
    clientSlug,
    siteIds: await getViewSiteIds(client.id),
    nowIso: new Date().toISOString(),
  });

  // Per-kind counts for the filter chips, preserving the priority-sorted order in
  // which each kind first appears.
  const byKindMap = new Map<TaskKind, number>();
  for (const t of tasks) byKindMap.set(t.kind, (byKindMap.get(t.kind) ?? 0) + 1);
  const byKind = Array.from(byKindMap, ([kind, count]) => ({ kind, count }));

  return Response.json({
    ok: true,
    tasks,
    counts: { total: tasks.length, byKind },
  });
}
