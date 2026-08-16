import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  MetaPixelTableMissingError,
  getMetaPixelSettings,
  upsertMetaPixelSettings,
} from "@/lib/assess/meta-pixel-repository";
import { describePixelConfigFailures, validatePixelConfig } from "@/lib/assess/meta-pixel";

export const dynamic = "force-dynamic";

// META CONVERSION TRACKING, the practice's settings (migration 0083).
//
// GET  read them, for the Tracking tab of the Meta Ads section.
// PUT  write them — and this is the gate the whole feature turns on.
//
// FOUR GUARDS, IN THIS ORDER, on both methods:
//   requireUser              somebody is signed in
//   requireClientAccess      they belong to THIS practice
//   requireModuleApiAccess   they may reach Meta Ads at all (the page guard never
//                            runs on an API route, so this is not a repeat)
//   requireOwnerRole         ...and they are the owner or the agency.
//
// The fourth is not redundant beside the third, and the reason is worth stating
// because a reader will otherwise delete it: "meta-ads" is owner-only in
// CLIENT_NAV *today*, so the module gate happens to refuse everyone the role guard
// refuses. That is a fact about a nav table, not a property of this route. Opening
// the Meta Ads tab to a practice manager one day would be an entirely reasonable
// decision — and it must not silently hand them the switch that starts sending
// patient conversions to Facebook. So the route states its own bar.
//
// WHAT THIS ROUTE NEVER RETURNS: the Conversions API access token. It has no field
// on MetaPixelConfig and is not read anywhere in this file; it lives in the
// environment and is read only inside the server-only sender. The pixel id IS
// returned, because it is public by nature — it is printed into the page for
// anyone to read.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** requireUser -> requireClientAccess -> module -> owner, or the Response to return. */
async function authorise(
  request: Request,
  bodyClientSlug?: unknown,
): Promise<{ auth: AuthedUser | null; clientId: string } | Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug =
    (typeof bodyClientSlug === "string" ? bodyClientSlug.trim() : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const moduleDenied = requireModuleApiAccess(auth, "meta-ads");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  return { auth, clientId: client.id };
}

export async function GET(request: Request): Promise<Response> {
  const access = await authorise(request);
  if (access instanceof Response) return access;

  try {
    return Response.json({ ok: true, settings: await getMetaPixelSettings(access.clientId) });
  } catch (e) {
    // 0083 IS NOT APPLIED, AND ON THIS METHOD THAT IS NOT AN ERROR TO SHOUT ABOUT.
    //
    // The honest answer to "is tracking on?" on a deployment without the table is
    // "no", which is true, and it is what the public pages behave as. The tab then
    // renders its off state, with `migrationPending` so it can say the switch will
    // not save yet rather than offering one that 503s. The WRITE method reports the
    // missing migration instead, because there the setting IS the request — the
    // same split 0081's theme routes make.
    if (e instanceof MetaPixelTableMissingError) {
      return Response.json({
        ok: true,
        settings: {
          enabled: false,
          pixelId: null,
          advancedMatching: false,
          updatedBy: null,
          updatedAt: null,
        },
        migrationPending: true,
      });
    }
    throw e;
  }
}

export async function PUT(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const access = await authorise(request, body.clientSlug);
  if (access instanceof Response) return access;

  // THE GATE. The digits-only pixel grammar and the "advanced matching cannot be
  // orphaned" rule, both at once, with every failure named. Refused here rather
  // than stored and discovered as a script tag that does nothing on a live page.
  const checked = validatePixelConfig(body);
  if (!checked.ok) {
    return bad(`These tracking settings cannot be saved:\n${describePixelConfigFailures(checked.failures)}`, 422);
  }

  try {
    const settings = await upsertMetaPixelSettings({
      clientId: access.clientId,
      // The VALIDATED config is what is stored, never the body.
      config: checked.config,
      updatedBy: access.auth?.email ?? access.auth?.id ?? null,
    });
    return Response.json({ ok: true, settings });
  } catch (e) {
    if (e instanceof MetaPixelTableMissingError) return bad(e.message, 503);
    throw e;
  }
}
