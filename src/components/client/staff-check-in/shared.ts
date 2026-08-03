import { getSites } from "@/lib/mock/clients";
import type { Tone } from "@/components/primitives";
import type { AnomalyKind, TodayState } from "@/lib/clock/types";

// Presentation constants for the staff check-in screens. Labels and tones only:
// every rule about WHICH state a person is in, and which exceptions they have,
// is decided in src/lib/clock/pairing.ts where it is under test.

/** The heading each group of people sits under. */
export const STATE_LABEL: Record<TodayState, string> = {
  in: "In now",
  expected: "Expected",
  out: "Clocked out",
  off: "Not in today",
};

/** The status dot beside a person's name. */
export const STATE_DOT: Record<TodayState, string> = {
  in: "bg-status-green",
  expected: "bg-status-blue",
  out: "bg-line-strong",
  off: "bg-line-strong",
};

/** The order the groups are shown in: who is here first, who is missing next. */
export const STATE_ORDER: TodayState[] = ["in", "expected", "out", "off"];

/**
 * Exceptions are raised QUIETLY. Nothing here blocks anybody or accuses them:
 * attendance oddities are for a human to explain, so the loudest tone in use is
 * amber, and there is no red anywhere on this screen.
 */
export const ANOMALY_TONE: Record<AnomalyKind, Tone> = {
  "never-clocked-out": "warning",
  "over-max-length": "warning",
  "no-rostered-shift": "neutral",
  "early-start": "neutral",
  "missing-clock-in": "warning",
};

/** The action a button offers, worded for the person pressing it. */
export const KIND_LABEL: Record<"in" | "out", string> = {
  in: "Clock in",
  out: "Clock out",
};

/** How a recorded tap reads in the activity list. */
export const SOURCE_LABEL: Record<string, string> = {
  manual: "Self",
  admin: "Recorded by a manager",
  nfc: "NFC tag",
  kiosk: "Reception kiosk",
};

/** Title-case a rota role for display, e.g. "dentist" to "Dentist". */
export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** A site id as its human name; floating staff have no site. */
export function siteLabel(clientSlug: string, siteId: string | null): string {
  if (!siteId) return "Any site";
  return getSites(clientSlug).find((s) => s.id === siteId)?.name ?? siteId;
}
