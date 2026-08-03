import { requireUser, requireClientAccess, requireModuleApiAccess, requireOwnerRole } from "@/lib/auth/guard";
import {
  getDailyContactLimit,
  setDailyContactLimit,
  countContactedToday,
  MAX_DAILY_CONTACT_LIMIT,
} from "@/lib/reactivation/settings";

export const dynamic = "force-dynamic";

// GET /api/reactivation/settings?client=<slug>
// -> { ok, limit, usedToday, remaining }. Any signed-in user of the client may read
// (the worklist shows the day's budget to coordinators too).
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const client = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!client) return Response.json({ ok: false, error: "client required" }, { status: 400 });

  const forbidden = requireClientAccess(user, client);
  if (forbidden) return forbidden;
  // "Any signed-in user of the client" predates the clinician role: the GET has no
  // owner gate, so this is the only thing keeping the daily contact budget out of a
  // module the clinician has no business in. (The POST is separately owner-only.)
  const moduleDenied = requireModuleApiAccess(user, "reactivation");
  if (moduleDenied) return moduleDenied;

  const [limit, usedToday] = await Promise.all([
    getDailyContactLimit(client),
    countContactedToday(new Date()),
  ]);
  return Response.json({ ok: true, limit, usedToday, remaining: Math.max(0, limit - usedToday) });
}

// POST /api/reactivation/settings  { client, limit }
// Owner-only: how many dormant patients may be contacted per day is an owner call.
export async function POST(request: Request): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const ownerOnly = requireOwnerRole(user);
  if (ownerOnly) return ownerOnly;

  const body = (await request.json().catch(() => null)) as { client?: unknown; limit?: unknown } | null;
  const client = typeof body?.client === "string" ? body.client.trim() : "";
  const limit = body?.limit;
  if (!client) return Response.json({ ok: false, error: "client required" }, { status: 400 });
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_CONTACT_LIMIT) {
    return Response.json(
      { ok: false, error: `limit must be a whole number between 0 and ${MAX_DAILY_CONTACT_LIMIT}` },
      { status: 400 },
    );
  }

  const forbidden = requireClientAccess(user, client);
  if (forbidden) return forbidden;

  try {
    await setDailyContactLimit(client, limit);
  } catch (err) {
    console.error("[reactivation] setDailyContactLimit failed", err);
    return Response.json({ ok: false, error: "save failed" }, { status: 500 });
  }
  return Response.json({ ok: true, limit });
}
