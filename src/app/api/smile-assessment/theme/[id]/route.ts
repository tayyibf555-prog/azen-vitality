import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireApproverRole,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  CustomThemeTableMissingError,
  ThemeInUseError,
  ThemeNameTakenError,
  campaignsUsingTheme,
  deleteCustomTheme,
  updateCustomTheme,
} from "@/lib/assess/custom-theme-repository";
import {
  MAX_THEME_NAME,
  describeThemeFailures,
  normaliseThemeName,
  parseCustomThemeRef,
  customThemeRef,
  validateThemeVars,
  type CustomTheme,
} from "@/lib/assess/custom-theme";

export const dynamic = "force-dynamic";

// One of the practice's own colour schemes (migration 0081).
//
// PATCH  rename and/or re-colour it. New colours clear the SAME gate a new theme
//        clears — an edit is not a way around the AA bar.
// DELETE remove it, unless a campaign is wearing it.
//
// Same four guards as the parent route, in the same order, and for the same
// reasons: requireUser -> requireClientAccess -> requireModuleApiAccess
// ("smile-assessment") -> requireApproverRole. Every query underneath is scoped by
// client_id as well, so an id from another practice resolves to "not found" rather
// than to somebody else's theme.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

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
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  return { auth, clientId: client.id };
}

/**
 * The path segment as a theme id.
 *
 * Parsed through the SAME function that reads a stored `custom:<uuid>` reference,
 * so the route and the column agree on what an id is and nothing but a uuid ever
 * reaches a query. The segment itself is bare (`/theme/<uuid>`), so the prefix is
 * added before parsing rather than expected from the caller.
 */
function themeId(segment: string): string | null {
  return parseCustomThemeRef(customThemeRef(segment));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: raw } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const access = await authorise(request, body.clientSlug);
  if (access instanceof Response) return access;

  const id = themeId(raw);
  if (!id) return bad("Colour scheme not found", 404);

  // PRESENCE, NOT TRUTHINESS — the same rule the campaign PATCH follows. Renaming
  // a theme and re-colouring it are unrelated acts and neither may imply the other.
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasVars = Object.prototype.hasOwnProperty.call(body, "vars");
  if (!hasName && !hasVars) return bad("name or vars is required");

  const patch: { name?: string; vars?: CustomTheme["vars"] } = {};

  if (hasName) {
    const name = normaliseThemeName(body.name);
    if (!name) return bad(`name is required (up to ${MAX_THEME_NAME} characters)`);
    patch.name = name;
  }

  if (hasVars) {
    // THE SAME GATE AS CREATION. An edit that could store colours a create could
    // not would make the bar advisory: build a passing theme, then edit it dark.
    const checked = validateThemeVars(body.vars);
    if (!checked.ok) {
      return bad(`This colour scheme cannot be saved:\n${describeThemeFailures(checked.failures)}`, 422);
    }
    patch.vars = checked.vars;
  }

  try {
    const theme = await updateCustomTheme(access.clientId, id, patch);
    if (!theme) return bad("Colour scheme not found", 404);
    return Response.json({ ok: true, theme });
  } catch (e) {
    if (e instanceof CustomThemeTableMissingError) return bad(e.message, 503);
    if (e instanceof ThemeNameTakenError) return bad(e.message, 409);
    throw e;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await authorise(request);
  if (access instanceof Response) return access;

  const { id: raw } = await params;
  const id = themeId(raw);
  if (!id) return bad("Colour scheme not found", 404);

  try {
    // ============================================================================
    // DELETING A THEME THAT IS IN USE IS REFUSED, NOT ABSORBED.
    //
    // The alternative was available and cheaper: let the delete through and let the
    // public page fall back to the shipped default, which it already does for a
    // retired preset key and would do here too (resolveCustomTheme returns null for
    // a row that is gone). It was rejected because of WHERE that fallback lands.
    //
    // A campaign's public URL is an ad destination with money pointed at it. Under
    // the fallback, one click in a settings-shaped list silently re-colours every
    // live funnel wearing that scheme, with nothing on screen having said so and no
    // way to put it back except by rebuilding the theme colour by colour. "Delete
    // this thing" is not consent to "re-colour those pages".
    //
    // So the delete is refused with the campaigns NAMED, and the owner moves them
    // first — which takes them past the re-colour row on each card, where the
    // preview shows what the new scheme looks like before they leave. The fallback
    // stays in the renderer regardless, as defence in depth for a row deleted by
    // hand or lost to a restore.
    // ============================================================================
    const inUse = await campaignsUsingTheme(access.clientId, id);
    if (inUse.length > 0) throw new ThemeInUseError(inUse);

    const removed = await deleteCustomTheme(access.clientId, id);
    if (!removed) return bad("Colour scheme not found", 404);
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof ThemeInUseError) return bad(e.message, 409);
    if (e instanceof CustomThemeTableMissingError) return bad(e.message, 503);
    throw e;
  }
}
