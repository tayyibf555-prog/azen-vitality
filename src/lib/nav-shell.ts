// ---------------------------------------------------------------------------
// WHICH SHELL AM I IN, AND WHAT IS IN ITS NAVIGATION.
//
// The platform renders the SAME chrome under two route trees:
//
//   /c/<client>      the staff shell (owner, manager, coordinator, clinician)
//   /owner/<client>  the owner shell (owner + agency admin only)
//
// Until this module existed, three components each worked the tree out for
// themselves with an inline `pathname.startsWith("/owner")`, and the owner tree
// carried a SECOND sidebar component of its own. The two shells then drifted a
// whole generation apart: /c gained the section bar and the new dashboard and
// /owner did not, which the practice owner noticed before we did.
//
// So the rule lives here, once, and both levels of the navigation (the rail and
// the section bar) read the SAME function. A module cannot now appear in one
// level and not the other, and neither can appear in one tree and not the other.
//
// PURE and client-safe: no I/O, no `server-only`, no React. Everything a
// component needs is computed here and handed over; the components draw it.
// ---------------------------------------------------------------------------

import { BrainCircuit } from "lucide-react";
import type { Role } from "@/lib/types";
import {
  canRoleAccessModule,
  categoriesForRole,
  OWNER_ROLES,
  type NavItem,
  type ResolvedNavCategory,
} from "@/lib/nav";

/** The two route trees the same chrome renders under. */
export type ShellTree = "client" | "owner";

/** The URL prefix each shell lives under, before the client slug. */
export const SHELL_PREFIX: Record<ShellTree, string> = {
  client: "/c",
  owner: "/owner",
};

/**
 * Which tree a pathname belongs to.
 *
 * Matched on a whole SEGMENT (`/owner` or `/owner/...`), not a bare prefix, so a
 * future `/ownership` route could never be mistaken for the owner shell. Anything
 * that is not the owner tree is treated as the staff shell, which is the safe
 * default: the staff shell carries no owner-only entries.
 */
export function shellTreeFor(pathname: string | null | undefined): ShellTree {
  if (!pathname) return "client";
  const owner = SHELL_PREFIX.owner;
  return pathname === owner || pathname.startsWith(`${owner}/`) ? "owner" : "client";
}

/** The base path every module href in this shell hangs off. */
export function shellBase(pathname: string | null | undefined, clientSlug: string): string {
  return `${SHELL_PREFIX[shellTreeFor(pathname)]}/${clientSlug}`;
}

/**
 * Modules that exist ONLY in the owner shell, and the area they belong to.
 *
 * The Practice brain is the whole list today. It is deliberately not in
 * CLIENT_NAV — it has no /c route at all, and nav.clinician.test.ts pins that it
 * never appears in navForRole — so `categoriesForRole` cannot produce it and the
 * owner shell has to add it. It is still access-checked through the SAME
 * predicate as everything else (canRoleAccessModule, which reads
 * EXTRA_OWNER_ONLY_SLUGS), so this is a placement, not a permission.
 *
 * It sits in Operations beside "Ask the brain", which is the co-pilot that reads
 * from it: the two belong next to each other, and the owner shell no longer
 * needs an area of its own to hold them.
 */
export const OWNER_ONLY_AREA_ITEMS: readonly { areaKey: string; item: NavItem }[] = [
  {
    areaKey: "operations",
    item: {
      slug: "practice-brain",
      label: "Practice brain",
      icon: BrainCircuit,
      status: "live",
      roles: OWNER_ROLES,
    },
  },
] as const;

export interface ShellAreasInput {
  /** The current pathname, which is what decides the tree. */
  pathname: string | null | undefined;
  /** The verified role, or null for dev / enforcement off (which shows everything). */
  role: Role | null;
  /** Systems the owner has switched off, resolved server-side in the layout. */
  disabledSlugs?: ReadonlySet<string>;
}

/**
 * The areas this shell shows, for this role, with this client's systems switched
 * off honoured.
 *
 * The staff shell gets exactly `categoriesForRole`. The owner shell gets that
 * plus the owner-only extras above, appended to their area. Every consumer of the
 * navigation calls THIS, so the rail and the section bar cannot disagree.
 */
export function shellAreas(input: ShellAreasInput): ResolvedNavCategory[] {
  const areas = categoriesForRole(input.role, input.disabledSlugs);
  if (shellTreeFor(input.pathname) !== "owner") return areas;

  return areas.map((area) => {
    const extras = OWNER_ONLY_AREA_ITEMS.filter((e) => e.areaKey === area.key)
      .map((e) => e.item)
      // A null role (dev / enforcement off) shows everything, matching
      // categoriesForRole's own fallback. Otherwise the single source of truth
      // decides, exactly as it does for every CLIENT_NAV item.
      .filter((item) => !input.role || canRoleAccessModule(input.role, item.slug));
    return extras.length === 0 ? area : { ...area, items: [...area.items, ...extras] };
  });
}
