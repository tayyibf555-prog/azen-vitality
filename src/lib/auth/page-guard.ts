import "server-only";
import { notFound, redirect } from "next/navigation";
import { authEnforced } from "./guard";
import { canAccessClient, getAuthEmail, getSessionUser } from "./session";
import { canRoleAccessModule } from "@/lib/nav";
import type { Role } from "@/lib/types";

/**
 * Server-side authorization for a route group, so the page layer matches the
 * API layer (the proxy only checks "is anyone signed in"). No-op until
 * enforcement is on, mirroring the API guard, so the un-enforced demo keeps
 * rendering. On failure it redirects rather than throwing:
 *
 * - signed-in-but-unprovisioned -> /login?error=no_profile (visible, not a
 *   silent bounce that looks like a wrong password),
 * - truly anonymous -> /login,
 * - wrong role / wrong client -> "/" which sends the user to their own home
 *   (no loop, because "/" routes by the user's actual role).
 */
export async function guardPage(opts: { roles: Role[]; clientSlug?: string }): Promise<void> {
  if (!authEnforced()) return;
  const user = await getSessionUser();
  if (!user) {
    const email = await getAuthEmail();
    redirect(email ? "/login?error=no_profile" : "/login");
  }
  if (!opts.roles.includes(user.role)) redirect("/");
  if (opts.clientSlug && !canAccessClient(user, opts.clientSlug)) redirect("/");
}

/**
 * Per-module authorization, so directly visiting an owner-only module's URL as a
 * coordinator is blocked, not merely hidden in the sidebar. Layered on top of the
 * layout's `guardPage` (which has already confirmed the user is signed in and may
 * access this client). No-op until enforcement is on, mirroring the rest of the
 * auth layer, so the un-enforced demo keeps rendering every module.
 *
 * On a role that may not reach the slug we `notFound()` — a coordinator should not
 * even learn the owner-only module exists. Owner/agency roles pass through, so
 * there is no functional change for them.
 */
export async function requireModuleAccess(slug: string): Promise<void> {
  if (!authEnforced()) return;
  const user = await getSessionUser();
  // A missing user is the layout guard's concern (it redirects to /login); here we
  // only enforce role -> module. If somehow unresolved, fall through to notFound.
  if (!user || !canRoleAccessModule(user.role, slug)) notFound();
}
