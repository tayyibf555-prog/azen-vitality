import type { Client, OpeningHours, Site } from "@/lib/types";

/**
 * Standard pilot opening hours: Mon-Fri 9:00-17:30, Sat morning, closed Sunday.
 * Shared across the vitality sites; a real deployment configures these per site.
 */
const VITALITY_HOURS: OpeningHours = {
  monday: "09:00-17:30",
  tuesday: "09:00-17:30",
  wednesday: "09:00-17:30",
  thursday: "09:00-17:30",
  friday: "09:00-17:30",
  saturday: "09:00-13:00",
  sunday: null,
};

/**
 * Fixed reference "now" so all relative timestamps render deterministically.
 * Matches the build date. Real data will use the live clock.
 */
export const NOW = new Date("2026-06-18T09:00:00Z");

/** Generic site names, no hardcoded city (pilot location stays configurable). */
export const SITES: Site[] = [
  { id: "site-cc", clientId: "vitality", name: "City Centre", timezone: "Europe/London", openingHours: VITALITY_HOURS },
  { id: "site-rv", clientId: "vitality", name: "Riverside", timezone: "Europe/London", openingHours: VITALITY_HOURS },
  { id: "site-ng", clientId: "vitality", name: "Northgate", timezone: "Europe/London", openingHours: VITALITY_HOURS },
];

export const CLIENTS: Client[] = [
  {
    id: "vitality",
    slug: "vitality",
    name: "Vitality Dental",
    status: "live",
    dentally: { connected: true, lastSyncedAt: "2026-06-18T08:52:00Z" },
    siteIds: ["site-cc", "site-rv", "site-ng"],
  },
];

export function getClient(slug: string): Client | undefined {
  return CLIENTS.find((c) => c.slug === slug || c.id === slug);
}

export function getSites(clientId: string): Site[] {
  return SITES.filter((s) => s.clientId === clientId);
}

export function getSite(siteId: string): Site | undefined {
  return SITES.find((s) => s.id === siteId);
}
