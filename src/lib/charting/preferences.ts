// ===========================================================================
// CHART PREFERENCES: Dentally's chevron and cog menu.
//
// PURE. DISPLAY ONLY. Nothing clinical is stored here, which is exactly why
// localStorage is the right home and no migration is needed.
//
// EVERY PREFERENCE HAS A REAL CONSUMER, because one carried with no behaviour
// is furniture:
//   locked          -> chartReducer rule 7 refuses every charting intent.
//   combined        -> archRows draws BOTH dentitions, so a mixed-dentition
//                      child's chart is not half missing.
//   hover           -> suppresses the per-tooth history tooltip.
//   panelCollapsed  -> the reference's collapse control on the left panel.
//   favouritesFirst -> filterTreatments floats favourites to the top.
//   sort            -> name or code.
// ===========================================================================

import type { ChartPreferences } from "./types";

export const DEFAULT_PREFERENCES: ChartPreferences = {
  locked: false,
  combined: false,
  hover: true,
  panelCollapsed: false,
  favouritesFirst: false,
  sort: "name",
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Tolerates corrupt, partial or wrongly-typed storage and fills from the
 * defaults rather than throwing: a broken display preference must never blank a
 * clinical screen. Accepts the raw JSON string or an already-parsed object.
 */
export function parsePreferences(raw: unknown): ChartPreferences {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_PREFERENCES };
  }
  const v = value as Record<string, unknown>;
  return {
    locked: bool(v.locked, DEFAULT_PREFERENCES.locked),
    combined: bool(v.combined, DEFAULT_PREFERENCES.combined),
    hover: bool(v.hover, DEFAULT_PREFERENCES.hover),
    panelCollapsed: bool(v.panelCollapsed, DEFAULT_PREFERENCES.panelCollapsed),
    favouritesFirst: bool(v.favouritesFirst, DEFAULT_PREFERENCES.favouritesFirst),
    sort: v.sort === "code" || v.sort === "name" ? v.sort : DEFAULT_PREFERENCES.sort,
  };
}

export function serialisePreferences(prefs: ChartPreferences): string {
  return JSON.stringify(prefs);
}

/** Per site AND per patient, so one patient's view never carries onto another. */
export function preferencesStorageKey(siteId: string, patientId: string): string {
  return `chart-prefs:${siteId}:${patientId}`;
}
