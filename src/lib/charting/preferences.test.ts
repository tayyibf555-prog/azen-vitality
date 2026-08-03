import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  preferencesStorageKey,
  serialisePreferences,
} from "./preferences";

describe("chart preferences", () => {
  it("ships with the chart unlocked, hover on and the list alphabetical", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      locked: false,
      combined: false,
      hover: true,
      panelCollapsed: false,
      favouritesFirst: false,
      sort: "name",
    });
  });

  // A preference added with no default arrives as undefined, and an undefined
  // `locked` reads as false, which quietly unlocks a chart somebody locked.
  it("has a default for every key, and no key with no default", () => {
    expect(Object.keys(DEFAULT_PREFERENCES).sort()).toEqual([
      "combined",
      "favouritesFirst",
      "hover",
      "locked",
      "panelCollapsed",
      "sort",
    ]);
    for (const value of Object.values(DEFAULT_PREFERENCES)) {
      expect(value).not.toBeUndefined();
    }
  });

  it("round-trips", () => {
    const prefs = { ...DEFAULT_PREFERENCES, locked: true, combined: true, sort: "code" as const };
    expect(parsePreferences(serialisePreferences(prefs))).toEqual(prefs);
  });

  it("fills the missing keys from the defaults rather than returning a half object", () => {
    expect(parsePreferences('{"locked":true}')).toEqual({ ...DEFAULT_PREFERENCES, locked: true });
    expect(parsePreferences({ hover: false })).toEqual({ ...DEFAULT_PREFERENCES, hover: false });
  });

  // A corrupt display preference must never blank a clinical screen.
  it("returns the defaults for malformed, absent or wrongly-typed storage rather than throwing", () => {
    for (const raw of ["", "not json", "null", "[]", "42", '"a string"', null, undefined, 7]) {
      expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
    }
    expect(parsePreferences('{"locked":"yes","sort":"colour"}')).toEqual(DEFAULT_PREFERENCES);
  });

  it("keys storage per site and per patient, so one patient's view never leaks onto another", () => {
    expect(preferencesStorageKey("site-cc", "pat-001")).toBe("chart-prefs:site-cc:pat-001");
    expect(preferencesStorageKey("site-cc", "pat-001")).not.toBe(
      preferencesStorageKey("site-cc", "pat-002"),
    );
  });
});
