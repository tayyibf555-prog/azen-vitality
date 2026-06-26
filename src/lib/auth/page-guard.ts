import "server-only";
import { redirect } from "next/navigation";
import { authEnforced } from "./guard";
import { canAccessClient, getAuthEmail, getSessionUser } from "./session";
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
