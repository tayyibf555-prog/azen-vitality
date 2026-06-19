"use client";

import { useEffect } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/mock-auth";
import { PORTAL_ACCESS } from "@/lib/portal-access";

/**
 * Client-side access guard for the /owner portal.
 *
 * Owners (and agency_admin previewing) roam freely. The two employee roles are
 * pinned to the slugs in their PORTAL_ACCESS matrix: visiting anything else,
 * including the portal base, bounces them to their home slug. Renders nothing.
 */
export function RoleGuard() {
  const { user } = useAuth();
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const router = useRouter();

  const client = params.client;
  const role = user?.role;

  useEffect(() => {
    // No session: let the page render; the login flow handles redirection.
    if (!user || !role) return;

    // Owner and agency_admin (previewing as owner-level) are unrestricted.
    if (role !== "client_manager" && role !== "client_general") return;

    const access = PORTAL_ACCESS[role];

    // Derive the current module slug: the segment right after the client. Base
    // path (no segment after the client) is "" and is NOT allowed for employees.
    const base = `/owner/${client}`;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
    const slug = rest.split("/")[0] ?? "";

    if (!access.allowedSlugs.includes(slug)) {
      router.replace(`/owner/${client}/${access.homeSlug}`);
    }
  }, [user, role, client, pathname, router]);

  return null;
}
