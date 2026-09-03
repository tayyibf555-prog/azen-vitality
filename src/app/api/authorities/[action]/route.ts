import { getClient } from "@/lib/mock";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
} from "@/lib/auth/guard";
import { validateAuthority, AUTHORITY_BODY_MAX_CHARS } from "@/lib/knowledge/authorities";
import {
  archiveAuthority,
  createAuthority,
  listAllAuthorities,
  updateAuthority,
} from "@/lib/knowledge/repository";

export const dynamic = "force-dynamic";

// ===========================================================================
// THE APPROVED-AUTHORITIES API. OWNER ONLY, ALL FOUR ACTIONS.
//
// This list decides what external context the co-pilot may lean on when it
// answers a clinician or a practice manager. Deciding that is the principal's
// job and nobody else's: a coordinator who could add an "authority" could put
// words into every answer the co-pilot gives the whole practice, which is a
// larger power than anything else on her surface. So the gate is
// `requireOwnerRole`, on the READ as well as the writes — the list is the
// owner's working notes about sources, not a staff reference shelf.
//
// FOUR GUARDS, IN THIS ORDER, AND EACH ONE ANSWERS A DIFFERENT QUESTION:
//
//   requireUser            is anyone signed in?            (401)
//   requireClientAccess    do they belong to THIS practice? (403 — tenancy)
//   requireModuleApiAccess may their role reach the co-pilot module at all?
//                          (403 — this is the line the API-guard coverage sweep
//                          reads, so the module lock is expressed here the same
//                          way it is expressed on every other module's routes,
//                          rather than in a shape unique to this file)
//   requireOwnerRole       and, narrower still, are they the owner?  (403)
//
// The module gate is deliberately not redundant with the owner gate even though
// the owner gate is stricter: /api/copilot carries the same pair for the same
// reason. Uniformity is the point — a reviewer sweeping for module locks finds
// one here.
//
// Every guard is a no-op when auth enforcement is off (requireUser returns null
// and the rest pass null through), so the un-enforced local demo is unchanged,
// matching every other route in this codebase.
// ===========================================================================

/**
 * A hard cap on the request body, in bytes, applied BEFORE anything is parsed.
 *
 * Comfortably above the two content ceilings (2,000 + 4,000 characters) plus the
 * short fields, so a body that is merely over a ceiling still reaches
 * `validateAuthority` and gets the plain-English refusal naming the limit and the
 * count. What this stops is the other thing: a megabyte of pasted PDF arriving
 * to be parsed, held in memory and then refused anyway.
 */
const MAX_BODY_BYTES = 32_000;

function ok<T extends object>(data: T) {
  return Response.json({ ok: true, ...data });
}
function fail(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status });
}

interface Body {
  client?: unknown;
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  publisher?: unknown;
  reference?: unknown;
  summary?: unknown;
  principles?: unknown;
}

export async function POST(request: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;

  // NOTHING IN THIS FUNCTION LOGS OR ECHOES A BODY. The two long fields are the
  // practice's own writing about a copyrighted source; a console.error carrying
  // one would copy it into a log store nobody governs, and an error response
  // quoting it back would put it somewhere it was never meant to go. Refusals
  // below carry COUNTS and limits, never content.
  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return fail(
      `That is too much text to send at once. A summary may be up to ${AUTHORITY_BODY_MAX_CHARS.summary} ` +
        `characters and the principles up to ${AUTHORITY_BODY_MAX_CHARS.principles}.`,
      413,
    );
  }
  let body: Body;
  try {
    body = raw ? (JSON.parse(raw) as Body) : {};
  } catch {
    return fail("bad json");
  }

  // The practice comes from a SLUG resolved through getClient, never from a raw
  // client id in the body: an unknown or omitted slug is refused rather than
  // quietly becoming a query against some other practice's rows.
  const slug = typeof body.client === "string" ? body.client : "";
  const client = slug ? getClient(slug) : undefined;
  if (!client) return fail("unknown client");

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  const moduleDenied = requireModuleApiAccess(auth, "co-pilot");
  if (moduleDenied) return moduleDenied;
  const ownerDenied = requireOwnerRole(auth);
  if (ownerDenied) return ownerDenied;

  const actor = auth?.id ?? null;

  try {
    if (action === "list") {
      return ok({ authorities: await listAllAuthorities(client.id) });
    }

    if (action === "create") {
      const validated = validateAuthority(body);
      if (!validated.ok) return fail(validated.error);
      return ok({ authority: await createAuthority(client.id, validated.value, actor) });
    }

    if (action === "update") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return fail("Missing id.");
      const validated = validateAuthority(body);
      if (!validated.ok) return fail(validated.error);
      const authority = await updateAuthority(client.id, id, validated.value);
      // Scoped by client_id AND id, so "not found" also covers "belongs to another
      // practice" — indistinguishable on purpose.
      if (!authority) return fail("That source could not be found.", 404);
      return ok({ authority });
    }

    if (action === "archive") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return fail("Missing id.");
      const authority = await archiveAuthority(client.id, id);
      if (!authority) return fail("That source could not be found.", 404);
      return ok({ authority });
    }

    return fail(`Unknown action: ${action}`, 404);
  } catch {
    // The caught error may carry a database message quoting the row, so it is not
    // forwarded. See the no-echo note at the top.
    return fail("That could not be saved just now.", 500);
  }
}
