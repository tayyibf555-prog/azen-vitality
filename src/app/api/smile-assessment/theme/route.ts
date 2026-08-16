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
  ThemeNameTakenError,
  insertCustomTheme,
  listCustomThemes,
} from "@/lib/assess/custom-theme-repository";
import {
  MAX_THEME_NAME,
  describeThemeFailures,
  normaliseThemeName,
  validateThemeVars,
} from "@/lib/assess/custom-theme";

export const dynamic = "force-dynamic";

// "YOUR THEMES": the practice's own colour schemes (migration 0081).
//
// GET   list them, for the pickers.
// POST  create one — and this is the gate the whole feature turns on.
//
// FOUR GUARDS, IN THIS ORDER, on every method:
//   requireUser              somebody is signed in
//   requireClientAccess      they belong to THIS practice
//   requireModuleApiAccess   they may reach Smile Assessment at all (the page guard
//                            never runs on an API route, so this is not a repeat)
//   requireApproverRole      ...and they are the owner or the practice manager.
//
// The fourth is the one that is specific to this route. A colour scheme is not a
// day-to-day act: it is set once, it is worn by a public page paid traffic lands
// on, and it applies to every assessment that chooses it. That is an owner/manager
// decision, not a shift decision — so this route is narrower than the campaign
// routes beside it, which any role holding the module may call.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** requireUser -> requireClientAccess -> module -> approver, or the Response to return. */
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

export async function GET(request: Request): Promise<Response> {
  const access = await authorise(request);
  if (access instanceof Response) return access;

  try {
    return Response.json({ ok: true, themes: await listCustomThemes(access.clientId) });
  } catch (e) {
    // 0081 IS NOT APPLIED, AND THAT IS NOT AN ERROR TO SHOUT ABOUT ON THIS METHOD.
    //
    // The list is read on every visit to the Assessments tab, purely to draw a
    // "Your themes" group. On a deployment without the table the honest answer is
    // "this practice has no custom themes", which is true, and the picker shows
    // the seven presets exactly as it does today. The WRITE methods report the
    // missing migration instead, because there the theme IS the request — the same
    // split 0079 made between insertCampaign and setCampaignTheme.
    if (e instanceof CustomThemeTableMissingError) {
      return Response.json({ ok: true, themes: [], migrationPending: true });
    }
    throw e;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const access = await authorise(request, body.clientSlug);
  if (access instanceof Response) return access;

  const name = normaliseThemeName(body.name);
  if (!name) return bad(`name is required (up to ${MAX_THEME_NAME} characters)`);

  // THE GATE. Completeness, the colour grammar (which is the injection guard —
  // these strings become CSS custom-property values on a public page) and the same
  // WCAG AA thresholds the tuned presets clear, all at once, with every failing
  // pair named. Refused here rather than stored and discovered by a patient who
  // could not read the question.
  const checked = validateThemeVars(body.vars);
  if (!checked.ok) {
    return bad(`This colour scheme cannot be saved:\n${describeThemeFailures(checked.failures)}`, 422);
  }

  try {
    const theme = await insertCustomTheme({
      clientId: access.clientId,
      name,
      vars: checked.vars,
      createdBy: access.auth?.email ?? access.auth?.id ?? null,
    });
    return Response.json({ ok: true, theme }, { status: 201 });
  } catch (e) {
    if (e instanceof CustomThemeTableMissingError) return bad(e.message, 503);
    if (e instanceof ThemeNameTakenError) return bad(e.message, 409);
    throw e;
  }
}
