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

/**
 * Vitality Dental's three sites. `id` is the stable INTERNAL id (overlay/UI/tests
 * key on it); `dentallyId` is the REAL Dentally site_id (UUID) used only for
 * Dentally reads. The other two sites the shared key can see (Urgent Dental Care
 * N15, Romford Road "DO NOT USE") are deliberately NOT mapped, so their data is
 * dropped and never enters Vitality's view.
 */
export const SITES: Site[] = [
  { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "3286d822-68c5-48ff-b1a2-065780dfcd15", timezone: "Europe/London", openingHours: VITALITY_HOURS },
  { id: "site-rv", clientId: "vitality", name: "N17 Dental", dentallyId: "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf", timezone: "Europe/London", openingHours: VITALITY_HOURS },
  { id: "site-ng", clientId: "vitality", name: "Romford Road", dentallyId: "5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6", timezone: "Europe/London", openingHours: VITALITY_HOURS },
];

export const CLIENTS: Client[] = [
  {
    id: "vitality",
    slug: "vitality",
    name: "Vitality Dental",
    status: "live",
    dentally: { connected: true, lastSyncedAt: "2026-06-18T08:52:00Z" },
    siteIds: ["site-cc", "site-rv", "site-ng"],
    // OWNER-VERIFIED facts for public marketing surfaces. Only clinicsCount and
    // the locations line are set (both provable from this very config); the
    // rating/review/awards/press fields stay null until the practice supplies
    // verified values, and the landing page omits those elements while null.
    facts: {
      googleRating: null,
      reviewCount: null,
      clinicsCount: 3,
      locationsLine: "N15, N17 and Romford Road, London",
      awardsLine: null,
      pressMentions: [],
    },
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

/**
 * The real Dentally site_id to send when calling Dentally for one of our internal
 * sites. Falls back to the internal id itself (mock/pilot, where the mock server
 * keys on the internal id).
 */
export function dentallySiteId(internalId: string): string {
  return getSite(internalId)?.dentallyId ?? internalId;
}

/**
 * Map a Dentally site_id (UUID) from a response back to our internal site id.
 * Returns undefined when the Dentally site is NOT one of ours (another practice
 * on the shared key), so such records can be dropped.
 */
export function siteIdFromDentally(dentallyId: string): string | undefined {
  if (!dentallyId) return undefined;
  const byDentally = SITES.find((s) => s.dentallyId === dentallyId);
  if (byDentally) return byDentally.id;
  // Mock/pilot: the "dentally id" is actually an internal id already.
  return SITES.find((s) => s.id === dentallyId)?.id;
}
