import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { getClient } from "@/lib/mock/clients";
import { recordPageView, sanitiseSurface } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

// Authed product-usage beacon sink. The UsageBeacon (client shell) POSTs
// { clientSlug, surface } on each route change. WHO (email/role) is derived from
// the verified session — never trusted from the body — and the surface is
// re-sanitised against the nav allowlist here, so a spoofed surface or a URL id can
// never be stored. Telemetry must never break the app: every non-recordable case
// (bad json, unknown client, unknown surface) returns a quiet ok, and the write
// itself swallows errors.

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth; // 401 when enforced + signed out

  let body: { clientSlug?: unknown; surface?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: true }); // best-effort: ignore malformed beacons
  }

  const surface = sanitiseSurface(body.surface);
  if (!surface) return Response.json({ ok: true }); // unknown surface -> no-op

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug.trim() : "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: true }); // unknown client -> no-op

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied; // 403: the session may not act on this client

  await recordPageView({
    clientId: client.id,
    surface,
    userEmail: auth?.email ?? null,
    role: auth?.role ?? null,
  });
  return Response.json({ ok: true });
}
