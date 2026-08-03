import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { getChecklistState, setChecklistItem } from "@/lib/getting-started/repository";

export const dynamic = "force-dynamic";

// GET /api/getting-started?client=<slug> -> { ok, state: { itemKey: true } }
// Any signed-in user of the client may read the progress.
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const client = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!client) return Response.json({ ok: false, error: "client required" }, { status: 400 });

  const forbidden = requireClientAccess(user, client);
  if (forbidden) return forbidden;
  // "Open to every role" means the three roles the nav item is open to. The
  // go-live checklist is practice-management work and sits outside CLINICIAN_SLUGS.
  const moduleDenied = requireModuleApiAccess(user, "getting-started");
  if (moduleDenied) return moduleDenied;

  const state = await getChecklistState(client);
  return Response.json({ ok: true, state });
}

// POST /api/getting-started  { client, key, checked } -> { ok }
// Open to every role with access to this client (not requireOwnerRole): the
// practice coordinator is normally the one who works through the checklist day
// to day, same as the nav item's visibility (src/lib/nav.ts). requireClientAccess
// below is still the real gate against a foreign client.
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const body = (await request.json().catch(() => null)) as
    | { client?: unknown; key?: unknown; checked?: unknown }
    | null;
  const client = typeof body?.client === "string" ? body.client.trim() : "";
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const checked = Boolean(body?.checked);
  if (!client || !key) {
    return Response.json({ ok: false, error: "client and key required" }, { status: 400 });
  }

  const forbidden = requireClientAccess(user, client);
  if (forbidden) return forbidden;
  const moduleDenied = requireModuleApiAccess(user, "getting-started");
  if (moduleDenied) return moduleDenied;

  try {
    await setChecklistItem(client, key, checked, user?.email ?? null);
  } catch (err) {
    console.error("[getting-started] save failed", err);
    return Response.json({ ok: false, error: "save failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
