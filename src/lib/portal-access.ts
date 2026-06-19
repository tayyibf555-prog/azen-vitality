/**
 * Practice-portal access matrix.
 *
 * The /owner surface is the client product. It is shared by three practice-level
 * roles, each with a different scope:
 *
 *  - client_owner   ("Owner")   full access, keeps the Operations/Management switcher.
 *  - client_manager ("Manager") fixed nav, lands on Analytics, no switcher.
 *  - client_general ("General") fixed nav, lands on the Daily brief, no switcher.
 *
 * agency_admin is intentionally absent here: that role lives in the separate
 * /agency console and, when previewing /owner, is treated as owner-level for
 * viewing (see role-guard). This is the single source of truth for which slugs a
 * practice role may visit and what its sidebar shows.
 */

import type { LucideIcon } from "lucide-react";
import { Activity, Bot } from "lucide-react";
import { CLIENT_NAV, CLIENT_MODULE_SLUGS } from "@/lib/nav";

/** The three practice-level roles that share the /owner portal. */
export type ClientRole = "client_owner" | "client_manager" | "client_general";

export interface PortalNavItem {
  /** Path segment under /owner/[client]. Empty string = the portal base. */
  slug: string;
  label: string;
  icon: LucideIcon;
}

export interface PortalAccess {
  /** Owner keeps the Operations/Management segmented control; employees do not. */
  showSwitcher: boolean;
  /** Slug the role lands on after sign-in. "" = portal base. */
  homeSlug: string;
  /** The fixed sidebar nav for employee roles. Owner derives nav elsewhere. */
  nav: PortalNavItem[];
  /** Module slugs this role is allowed to open. Used by the route guard. */
  allowedSlugs: string[];
}

/** Three new portal-only slugs that have no CLIENT_NAV entry of their own. */
export const SYSTEMS_SLUG = "systems";
export const COPILOT_SLUG = "co-pilot";
export const ANALYTICS_SLUG = "analytics";

/** Flat nav for the owner, derived from the full CLIENT_NAV (owner sees everything). */
const OWNER_NAV: PortalNavItem[] = CLIENT_NAV.flatMap((group) =>
  group.items.map((item) => ({ slug: item.slug, label: item.label, icon: item.icon })),
);

const MANAGER_NAV: PortalNavItem[] = [
  { slug: "daily-brief", label: "Daily brief", icon: navIcon("daily-brief") },
  { slug: "task-queue", label: "Tasks", icon: navIcon("task-queue") },
  { slug: SYSTEMS_SLUG, label: "Systems", icon: Activity },
  { slug: COPILOT_SLUG, label: "Co-pilot", icon: Bot },
  { slug: ANALYTICS_SLUG, label: "Analytics", icon: navIcon("") },
];

const GENERAL_NAV: PortalNavItem[] = [
  { slug: "daily-brief", label: "Daily brief", icon: navIcon("daily-brief") },
  { slug: "task-queue", label: "Tasks", icon: navIcon("task-queue") },
  { slug: "recall", label: "Recall concierge", icon: navIcon("recall") },
  { slug: "treatment-coordinator", label: "Treatment Coordinator", icon: navIcon("treatment-coordinator") },
  { slug: "reactivation", label: "Reactivation", icon: navIcon("reactivation") },
];

/** Pull the icon a slug already uses in CLIENT_NAV so the portal stays consistent. */
function navIcon(slug: string): LucideIcon {
  const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);
  return item?.icon ?? Activity;
}

export const PORTAL_ACCESS: Record<ClientRole, PortalAccess> = {
  client_owner: {
    showSwitcher: true,
    homeSlug: "",
    nav: OWNER_NAV,
    allowedSlugs: [...CLIENT_MODULE_SLUGS, SYSTEMS_SLUG, COPILOT_SLUG, ANALYTICS_SLUG],
  },
  client_manager: {
    showSwitcher: false,
    homeSlug: ANALYTICS_SLUG,
    nav: MANAGER_NAV,
    allowedSlugs: MANAGER_NAV.map((item) => item.slug),
  },
  client_general: {
    showSwitcher: false,
    homeSlug: "daily-brief",
    nav: GENERAL_NAV,
    allowedSlugs: GENERAL_NAV.map((item) => item.slug),
  },
};

/** Type guard: is this role one of the three practice-portal roles? */
export function isClientRole(role: string | undefined | null): role is ClientRole {
  return role === "client_owner" || role === "client_manager" || role === "client_general";
}
