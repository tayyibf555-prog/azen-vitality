import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { SYSTEMS, isControllableSystem } from "@/lib/systems/catalog";
import { getSystemStates, setSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// Owner-only control panel for the per-system kill switch.
//   GET  /api/systems?client=<slug>         -> catalog + each system's on/off state
//   POST /api/systems  { client, slug, enabled } -> flip one system
// Both are requireUser + requireClientAccess + requireOwnerRole, so only the
// practice owner (or an agency admin) can read or change the switches.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  try {
    const states = await getSystemStates(client.id);
    const byState = new Map(states.map((s) => [s.slug, s]));
    // Merge catalog (label/group/halts) with the stored state (enabled/when/who).
    const systems = SYSTEMS.map((s) => {
      const st = byState.get(s.slug);
      return {
        slug: s.slug,
        label: s.label,
        group: s.group,
        halts: s.halts,
        enabled: st?.enabled ?? true,
        updatedAt: st?.updatedAt ?? null,
        updatedBy: st?.updatedBy ?? null,
      };
    });
    return Response.json({ ok: true, systems });
  } catch (e) {
    console.error("[systems] GET failed", e);
    return bad("could not load system controls", 500);
  }
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

  const clientSlug =
    (typeof body.client === "string" ? body.client : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  // THE PER-PERSON GATE on the kill switch itself. Switching a system off halts
  // its work everywhere and hides its module; switching one back ON re-arms
  // patient messaging. The GET is not gated — seeing which systems are running is
  // not changing one.
  const capabilityDenied = await requireCapability(auth, "system.toggle");
  if (capabilityDenied) return capabilityDenied;

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!isControllableSystem(slug)) return bad("Unknown system");
  if (typeof body.enabled !== "boolean") return bad("enabled must be a boolean");

  try {
    await setSystemEnabled(client.id, slug, body.enabled, auth?.email ?? auth?.id ?? null);
    return Response.json({ ok: true, slug, enabled: body.enabled });
  } catch (e) {
    console.error(`[systems] POST toggle ${slug} failed`, e);
    return bad("could not update the system", 500);
  }
}
