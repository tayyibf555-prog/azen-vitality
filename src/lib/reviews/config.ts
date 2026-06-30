// Practice-facing config for the review request. The Google review link is a
// placeholder from the environment until the client supplies their real one; the
// copy is never sent with a missing link (the attend/sweep routes guard on it).

/** The practice's Google review link, from env. Empty string when unset. */
export function reviewLink(): string {
  return process.env.REVIEW_LINK_URL ?? "";
}

/**
 * The practice name to use in the copy. Prefers an explicit env override, then the
 * client's display name, then a neutral fallback so we never address the patient
 * from a blank practice.
 */
export function practiceName(clientName?: string | null): string {
  return process.env.REVIEW_PRACTICE_NAME || clientName || "our practice";
}
