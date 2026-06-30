// Small presentation helpers for the onboarding flow. Kept out of the steps/types so
// the public page can brand itself (heading, copy) from the resolved client without
// pulling in the repository or the Supabase client.

import type { Client } from "@/lib/types";

/**
 * The practice name to show on the branded onboarding page, derived from the client.
 * Falls back to a neutral label so the page never renders an empty heading.
 */
export function practiceName(client: Client | null | undefined): string {
  return client?.name?.trim() || "our practice";
}
