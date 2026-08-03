"use client";

import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { PERMANENT_LOWER, PERMANENT_UPPER, displayNumber } from "@/lib/charting/fdi";
import { DEFAULT_PROBE, SEXTANTS, SEXTANT_LABEL, SEXTANT_TEETH, sextantOfTooth } from "@/lib/perio/bpe";
import {
  CORRECTION_WINDOW_HOURS,
  DEFAULT_CHART_ENTRY_PREFS,
  ENTRY_ADVANCES,
  ENTRY_ADVANCE_LABEL,
  ENTRY_ARCHES,
  ENTRY_ARCH_LABEL,
  ENTRY_DIRECTIONS,
  ENTRY_DIRECTION_LABEL,
  chartEntryPrefsStorageKey,
  cycleScale,
  entryToothOrder,
  hoursLeftInCorrectionWindow,
  parseChartEntryPrefs,
  scaleFromLabels,
  serialiseChartEntryPrefs,
  withinCorrectionWindow,
} from "@/lib/perio/chart-entry-prefs";
import type { ChartEntryPrefs } from "@/lib/perio/chart-entry-prefs";
import {
  MAX_PROBING_DEPTH_MM,
  MAX_RECESSION_MM,
  MIN_RECESSION_MM,
  PerioValidationError,
  SITE_IDS,
  SITE_LABEL,
  buildPocketChart,
  liveBopScore,
  validatePocketChart,
} from "@/lib/perio/pocket-chart";
import type {
  LiveBopScore,
  PocketChartInput,
  PocketChartView,
  ToothRecordInput,
} from "@/lib/perio/pocket-chart";
import type {
  ClinicianRef,
  FurcationGrade,
  MobilityStage,
  PerioProbe,
  PerioSiteId,
  PerioToothRecord,
  SextantId,
} from "@/lib/perio/types";
import { londonDateTimeLabel } from "@/lib/time/london";
import { PerioSummary } from "./perio-summary";

// ===========================================================================
// THE SIX-POINT CHARTING SCREEN — 192 numbers, and the only feature that
// matters is how fast they go in.
//
// PERIO.md §4: "Entry speed is the whole feature... If it is slower than paper
// the hygienists will not use it, and a half-entered perio chart is worse than
// none." Everything below is arranged around that sentence.
//
// -- THE STATE MACHINE IS NOT A KEYBOARD HANDLER --------------------------
//
// The reducer at the bottom of this file accepts VALUES and COMMANDS, never
// keystrokes. `{ type: "value", value: 5 }` means "five millimetres at the
// cursor, then move on", and it does not care whether a finger, a barcode
// scanner or a transcription of an assistant reading aloud produced the 5.
// PERIO.md §4 says voice entry is the real prize and that the machine must be
// designed to be driven by a stream of numbers rather than by keystrokes, so the
// keyboard handler is a thin adapter over that seam and nothing else: it turns
// KeyboardEvents into the same actions a future voice stream will dispatch.
//
// -- HOW A DOUBLE FIGURE IS TYPED, AND WHY IT IS DENTALLY'S WAY -----------
//
// Probing depths run 0-15 but a hygienist wants one keystroke per site, so
// every system needs an answer for 10 to 15. Dentally's is a documented key,
// quoted from their own "How to create a perio exam" article:
//
//   "Should a patient require a digit higher than 9, simply press 'd' on the
//    keyboard to record a double-digit while typing the number - for example,
//    press 'd' and then 2 to record a 12."
//
// So `d` is a PREFIX: the digit after it is added to ten. That is the whole
// convention, and this grid now implements exactly it.
//
// IT DID NOT, AND THE FAILURE WAS SILENT. `d` used to select the depth FIELD
// here, while a typed 1 pended in case it was the start of 10-15. A hygienist
// with Dentally in their fingers typing `d` `2` for a 12mm pocket got: a field
// switch that usually changed nothing visible, a 2 recorded, and the cursor
// moved on. They believed they had charted a 12mm pocket. They had charted a
// 2mm one, at the wrong site, and nothing on the screen said so. The mirror
// image was just as bad: `1` then `2` meaning 1mm here and 2mm next door
// silently became a single 12mm reading.
//
// Both are gone. A digit is now always its own number; ten and above are typed
// the way Dentally types them; and nothing about the prefix is silent — it is
// shown at the cursor, it is announced, and it says so when it is cleared
// without a digit following it. The invariant this file is now written to is:
// NO KEYSTROKE SEQUENCE MAY RECORD A NUMBER THE CLINICIAN DID NOT INTEND
// WITHOUT SAYING SO.
//
// `r` therefore now TOGGLES between the depth row and the recession row, which
// is a key Dentally's article does not document at all — it is ours, so it is
// the one that moves.
//
// -- CAL IS COMPUTED AND HAS NO INPUT ------------------------------------
//
// There is no CAL row you can type into and there never may be. Attachment loss
// is probing depth + recession; a stored CAL is a number that can disagree with
// its own components and the disagreement is invisible on screen. The engine
// bans the field at compile time and refuses it at runtime; this screen simply
// never offers one. The CAL row renders what buildPocketChart computed.
//
// -- A PARTIAL CHART LOOKS PARTIAL ---------------------------------------
//
// A BPE code 3 requires ONE sextant to be charted, so a partial chart is the
// normal case. Both arches are drawn WHOLE, always: a tooth in an undeclared
// sextant renders as a struck-through column reading "not charted", and a tooth
// the caller did not list as present renders as "not present". The sextant strip
// above the grid says the same thing a third way. A clinician can therefore never
// mistake "we did not look there" for "there was nothing there", which is the
// false-completeness failure CHARTING.md 6.3 is written about.
//
// -- WHAT "AUTOSAVE" CAN AND CANNOT MEAN HERE ----------------------------
//
// It is per-site, and it is to THIS BROWSER. The periodontal store is
// append-only whole charts (there is no draft table and this build must not add
// one), so a server write per site would mint 192 clinical records for one
// examination. Instead every accepted keystroke is mirrored into sessionStorage
// so a closed lid or a stray navigation cannot cost an examination, and the
// screen states plainly - not in a tooltip - that nothing is on the patient's
// record until "Record chart" is pressed. Half a chart kept somewhere honest
// beats half a chart lost, and both beat half a chart that looks recorded.
//
// -- ATTRIBUTION -----------------------------------------------------------
//
// The chart is written against the signed-in clinician, named on screen before
// it is saved. GDC Standard 4.1.4. Where the server cannot name one, this screen
// does not offer to save and says why; it does not invent a "Team" author, and
// it does not build the local preview either, because a preview attributed to
// nobody is a fabricated record with a nice border.
//
// -- BPE IS A MANDATORY FP17 FIELD ---------------------------------------
//
// Since 1 October 2022. While claims go out of Dentally, anything recorded here
// is recorded twice. The sentence lives in PERIO_COPY.doubleEntry, which is in a
// server-only module, so it arrives here as a prop or on the save response - it
// is never copied into this file, because two versions of that statement can
// drift and only one of them is true.
//
// -- WHY THERE IS NO SCREENSHOT BEHIND THIS LAYOUT -----------------------
//
// BPE and six-point charting are clinically standardised: the BSP defines the
// form, so every UK system draws a fixed teeth x six-sites grid with the buccal
// row above the lingual one. That is not true of restorative charting, which is
// why the tooth arch waited for a reference and this did not. The layout is
// therefore the clinical standard, kept deliberately easy to reskin.
//
// -- DENTALLY'S ENTRY ERGONOMICS, WHICH ARE NOT NEGOTIABLE ----------------
//
// Their own help article ("How to create a perio exam") documents the keys a
// hygienist already has in their fingers: b bleeding, s suppuration, f cycles
// furcation, m cycles mobility, and PRESSING THE SAME KEY AGAIN CYCLES OR
// CLEARS. It also documents three settings — which arch to start with, the
// direction the chart is worked in, and whether the chart moves on by itself or
// waits for Tab — and the ability to CLONE a previous exam into a new one.
// All of that is implemented here, because the point of this whole module is
// that nobody has to relearn charting.
//
// The settings and the three rules they drive live in
// src/lib/perio/chart-entry-prefs.ts, which is a .ts precisely so vitest can
// reach them. THE SCALES THEMSELVES ARE NOT WRITTEN THERE AND ARE NOT WRITTEN
// HERE AS A RANGE: they are read off the label maps below, whose types come
// from the engine, so the day the engine widens furcation to Dentally's four
// grades the label map stops compiling until the fourth grade is named. A range
// typed as a literal is a range that goes stale silently; this one cannot.
//
// -- A CLONED READING IS NOT A MEASUREMENT --------------------------------
//
// Cloning is how a review appointment is actually charted, and it is also the
// single easiest way to write down a measurement nobody took. So a carried
// reading is drawn differently, counted on screen, and — this is the load-
// bearing part — IS NOT PART OF THE SAVED CHART until the clinician says in as
// many words that they have checked it today. Re-key a carried site and it
// stops being carried, because it has just been measured.
//
// The honest limitation, stated because it is the next thing to fix: the stored
// record has no per-site provenance field, so there is no way to write "carried
// forward from 3 June" into the database. Excluding unconfirmed carried figures
// is the strongest guarantee available without one. A `carriedFrom` on the
// stored site would be better, and it belongs to the engine and the repository.
//
// -- THE 24-HOUR CORRECTION -----------------------------------------------
//
// Dentally lets a saved exam be edited for 24 hours. We never edit. A
// correction here is a NEW record whose supersedesId names the one it replaces,
// dated and attributed, with the original left readable for ever — GDC Standard
// 4.1.5. The clinician sees the affordance they expect; the record keeps its
// whole history. Past the window the same action is still offered, labelled
// plainly as an amendment, because an append-only record may always be amended
// and a clinician who spots an error at hour 25 must not be told to leave it.
//
// -- CLIENT BOUNDARY ------------------------------------------------------
//
// This module is "use client", so EVERY PROP IT TAKES IS PLAIN DATA. No function
// props, no children, nothing a server component cannot serialise. A server
// shell can render <PocketChartEntry> directly. It also cannot import
// src/lib/perio/gate.ts, which is `import "server-only"` - which is exactly why
// the gate's answer arrives as `canSave` and its sentences arrive as strings.
// ===========================================================================

// ---------------------------------------------------------------------------
// Vocabulary. The ranges ARE the engine's — imported, never restated.
//
// They used to be written out again here as three local constants "mirroring"
// pocket-chart.ts. Two hand-written copies of one number is how the THIRD copy,
// in 0066_perio.sql's check constraint, came to allow a recession of -10 to 20
// while both of these allowed -5 to 15 and nobody noticed. There is now one
// declaration, in the engine, and a test that reads the SQL and fails if the
// database ever disagrees with it.
// ---------------------------------------------------------------------------

type EntryField = "depth" | "recession";

const FIELD_LABEL: Record<EntryField, string> = {
  depth: "probing depth",
  recession: "recession",
};

type SiteFlag = "bleeding" | "suppuration" | "plaque";

const FLAG_LABEL: Record<SiteFlag, string> = {
  bleeding: "bleeding on probing",
  suppuration: "suppuration",
  plaque: "plaque",
};

const FLAG_KEY: Record<SiteFlag, string> = {
  bleeding: "b",
  suppuration: "s",
  plaque: "p",
};

// ---------------------------------------------------------------------------
// THE SCALES. Dentally's, read off the labels that name them.
//
// The types come from the engine, so these maps are exhaustive-checked: a grade
// the engine allows and this file has not named does not compile. That is the
// whole mechanism by which "do not hard-code a range" is enforced rather than
// merely intended — the alternative, a literal `[1, 2, 3]`, would keep building
// green on the day the engine gained a fourth grade, and a hygienist would type
// a grade 4 furcation and watch nothing happen.
//
// The words are Dentally's: furcation is GRADED, mobility is STAGED.
// ---------------------------------------------------------------------------

const MOBILITY_LABEL: Record<MobilityStage, string> = {
  1: "stage 1",
  2: "stage 2",
  3: "stage 3",
};

const FURCATION_LABEL: Record<FurcationGrade, string> = {
  1: "grade 1",
  2: "grade 2",
  3: "grade 3",
  4: "grade 4",
};

const MOBILITY_SCALE = scaleFromLabels<MobilityStage>(MOBILITY_LABEL);
const FURCATION_SCALE = scaleFromLabels<FurcationGrade>(FURCATION_LABEL);

export interface SiteEntry {
  probingDepth: number | null;
  recession: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  /**
   * This reading was carried in from an earlier exam and has NOT been taken
   * today. Drawn differently, counted on screen, and excluded from the saved
   * chart until it is either re-keyed or explicitly confirmed. Cleared the
   * moment anything is typed here, because that is a measurement.
   */
  carried: boolean;
}

export interface ToothEntry {
  mobility: MobilityStage | null;
  furcation: FurcationGrade | null;
  /** The same, for the two tooth-level findings. */
  carriedFindings: boolean;
  sites: Record<PerioSiteId, SiteEntry>;
}

export type EntryValues = Record<number, ToothEntry>;

function emptySite(): SiteEntry {
  return {
    probingDepth: null,
    recession: null,
    bleeding: false,
    suppuration: false,
    plaque: false,
    carried: false,
  };
}

function emptyTooth(): ToothEntry {
  return {
    mobility: null,
    furcation: null,
    carriedFindings: false,
    sites: {
      mb: emptySite(),
      b: emptySite(),
      db: emptySite(),
      ml: emptySite(),
      l: emptySite(),
      dl: emptySite(),
    },
  };
}

function blankValues(teeth: readonly number[]): EntryValues {
  const values: EntryValues = {};
  for (const tooth of teeth) values[tooth] = emptyTooth();
  return values;
}

/**
 * Seed from an existing chart, for an amendment or a re-open. Teeth the chart
 * holds that this screen is not drawing are dropped rather than smuggled in.
 *
 * `carried` is the difference between the two things this function is used for,
 * and it is a clinical difference rather than a cosmetic one:
 *
 *   false — a CORRECTION. These are the figures of the chart being amended.
 *           They are the record, restated; they are not presented as today's
 *           measurements because the amendment is dated to the original exam it
 *           replaces and says so.
 *   true  — a CLONE. These are last time's figures on today's exam. Nobody has
 *           taken them today, so they are marked, drawn differently, and left
 *           out of the save until the clinician says otherwise.
 */
export function valuesFromRecords(
  teeth: readonly number[],
  records: readonly PerioToothRecord[] | undefined,
  carried = false,
): EntryValues {
  const values = blankValues(teeth);
  for (const record of records ?? []) {
    const tooth = values[record.tooth];
    if (!tooth) continue;
    tooth.mobility = record.mobility ?? null;
    tooth.furcation = record.furcation ?? null;
    tooth.carriedFindings =
      carried && (tooth.mobility !== null || tooth.furcation !== null);
    for (const site of record.sites) {
      const cell = tooth.sites[site.site];
      if (!cell) continue;
      cell.probingDepth = site.probingDepth ?? null;
      cell.recession = site.recession ?? null;
      cell.bleeding = Boolean(site.bleeding);
      cell.suppuration = Boolean(site.suppuration);
      cell.plaque = Boolean(site.plaque);
      // A site with no depth carries nothing, so there is nothing to mark.
      cell.carried = carried && cell.probingDepth !== null;
    }
  }
  return values;
}

/**
 * A SITE COUNTS WHEN IT WAS MEASURED TODAY.
 *
 * A carried reading has a depth and is drawn on the grid, but nobody took it at
 * this appointment. It is therefore not part of this record and must not be
 * counted as if it were — that is the whole difference between carrying a chart
 * forward and fabricating one. Confirming the carried readings clears the mark
 * and these figures then count.
 *
 * EXPORTED, AND PURE, ON PURPOSE. Dropping the `!cell.carried` clause turns last
 * visit's numbers into today's measurements, dated today and attributed to
 * today's clinician, with nothing on screen to say so. That mutation survived a
 * whole test suite while it lived inside a useCallback; out here a .ts test can
 * pin it.
 */
export function measuredToday(cell: SiteEntry | undefined): boolean {
  return cell !== undefined && cell.probingDepth !== null && !cell.carried;
}

/** What a save's `supersedesId` is allowed to be. */
export interface AmendmentTargetInput {
  /** The shell saying this whole screen amends a particular stored chart. */
  supersedesId?: string | null;
  /** A chart picked on screen for Dentally's 24-hour correction. */
  correcting?: { id: string } | null;
  /**
   * A previous exam CLONED into today's.
   *
   * Named in this signature precisely so that it can be seen NOT to be used. A
   * clone is a NEW examination of today that happens to start from last time's
   * figures; if its source id ever reached `supersedesId` the clone would retire
   * the exam it copied, and the record would lose an examination that really
   * happened. The original stays standing, and today's exam stands beside it.
   */
  carriedFrom?: { id: string } | null;
}

/** The chart this save amends, or null for a new examination. */
export function amendmentTargetId(input: AmendmentTargetInput): string | null {
  return input.supersedesId ?? input.correcting?.id ?? null;
}

/**
 * THE LIVE BLEEDING SCORE, from the entry grid as it stands.
 *
 * Dentally: "A live % Bleeding on Probing (BOP) score will appear at the top of
 * the perio chart." The engine has computed one since the day it was written —
 * liveBopScore(), tested, with its own label sentence — and nothing imported it.
 * The grid showed "N of 168 sites" instead, which is a progress bar, not a
 * clinical figure.
 *
 * CARRIED READINGS ARE NOT IN IT. A cloned site has a depth and is drawn on the
 * grid, but nobody probed it today, so it can neither raise the numerator nor
 * the denominator: a bleeding percentage that counted last visit's sites would
 * be a figure for an examination that has not happened yet. measuredToday() is
 * the same test the save uses, which is what keeps the number on screen and the
 * number on the record the same number.
 *
 * EXPORTED AND PURE so a .ts test can reach it. The mapping is the part that can
 * go wrong — dropping the carried filter, or feeding it every drawn cell so the
 * score falls as the exam moves onto unprobed teeth — and neither of those is
 * visible from the engine's own tests.
 */
export function liveBopFrom(teeth: readonly number[], values: EntryValues): LiveBopScore {
  return liveBopScore(
    teeth.map((tooth) => ({
      sites: SITE_IDS.map((site) => {
        const cell = values[tooth]?.sites[site];
        return measuredToday(cell)
          ? { probingDepth: cell!.probingDepth, bleeding: cell!.bleeding }
          : { probingDepth: null, bleeding: false };
      }),
    })),
  );
}

/** Every site and tooth-level finding still standing on last time's figures. */
export function carriedCount(teeth: readonly number[], values: EntryValues): number {
  let total = 0;
  for (const tooth of teeth) {
    const entry = values[tooth];
    if (!entry) continue;
    if (entry.carriedFindings) total += 1;
    for (const site of SITE_IDS) if (entry.sites[site].carried) total += 1;
  }
  return total;
}

/** Drop every carried mark, which is what "I have checked these today" means.
 *  Values are untouched: the figures were right, they are now also attested. */
function confirmCarried(values: EntryValues): EntryValues {
  const next: EntryValues = {};
  for (const [key, entry] of Object.entries(values)) {
    const sites = {} as Record<PerioSiteId, SiteEntry>;
    for (const site of SITE_IDS) sites[site] = { ...entry.sites[site], carried: false };
    next[Number(key)] = { ...entry, carriedFindings: false, sites };
  }
  return next;
}

// ---------------------------------------------------------------------------
// THE MACHINE. Values and commands in, state out. No React, no DOM, no clock.
//
// EVERYTHING BELOW WANTS TO LIVE IN A .ts FILE so vitest could reach it — this
// repo's runner collects src/**/*.test.ts in a node environment and cannot test
// a .tsx at all. It is here because the file split for this build put the entry
// screen in one .tsx and nothing else; the reducer is written pure and exported
// precisely so lifting it out later is a move rather than a rewrite.
// ---------------------------------------------------------------------------

export interface EntryState {
  /** The teeth this chart draws, in charting order. Cell i is
   *  teeth[floor(i/6)] at SITE_IDS[i % 6] — SITE_IDS is the engine's declared
   *  entry order around a tooth (the buccal row, then the lingual row). */
  teeth: number[];
  values: EntryValues;
  cursor: number;
  field: EntryField;
  /**
   * DENTALLY'S `d` HAS BEEN PRESSED: the next digit is a double figure and is
   * added to ten, so `d` `2` records 12.
   *
   * A boolean and not a magnitude, because there is no such thing here as a
   * half-typed number waiting to be extended. Every digit commits its own value
   * immediately, in both auto-advance modes; ten and above are typed with the
   * prefix. That is what stops `1` `2` — a 1mm pocket here and a 2mm pocket next
   * door — from silently becoming a single 12mm reading.
   *
   * The sign lives separately, in `pendingNegative`.
   */
  pendingDouble: boolean;
  /** A typed minus, waiting for the magnitude of a negative recession. */
  pendingNegative: boolean;
  /** A whole sentence, or null. Read aloud by the live region. */
  message: string | null;
  /** Bumped on every accepted action so two identical consecutive announcements
   *  are distinct states and the second is re-announced rather than going quiet.
   *  The same trick the chart's rejection region uses. */
  nonce: number;
  /** Something has been typed that is not on the patient's record yet. */
  dirty: boolean;
  /** This chart was picked up from an unsaved copy kept in the browser. Carried
   *  in the machine rather than in a second useState, because a setState fired
   *  from inside an effect is a cascading render this repo lints against. */
  restored: boolean;
  /**
   * Dentally's "auto-progress" setting. False means a recorded value stays put
   * and the cursor waits for Tab. It lives in the machine rather than being read
   * from props at every dispatch so that the reducer stays a pure function of
   * state and action — which is what makes it drivable by something other than
   * this keyboard.
   */
  autoAdvance: boolean;
}

export type EntryAction =
  /**
   * THE STREAM SEAM. A whole number (or null to clear) at the cursor.
   *
   * It advances by default whatever the auto-progress setting says, because a
   * stream of numbers read aloud by an assistant has no Tab key. The setting
   * governs the KEYBOARD, which is the thing it was written for; a caller that
   * wants the setting honoured passes `advance: false` explicitly.
   */
  | { type: "value"; value: number | null; advance?: boolean }
  /** One digit. On its own it is its own number; after `double` it is added to
   *  ten. The keyboard's adapter, and the seam a voice stream will drive. */
  | { type: "digit"; digit: number }
  /** Dentally's `d`: the next digit is a double figure. */
  | { type: "double" }
  /** A minus, ahead of a negative recession. */
  | { type: "sign" }
  | { type: "move"; by: number }
  | { type: "moveTo"; index: number }
  /** Between the buccal row and the lingual row of the same tooth. */
  | { type: "row"; delta: number }
  | { type: "field"; field: EntryField }
  /** Between the depth row and the recession row. The keyboard's `r`, which
   *  needs no knowledge of which row is showing and so keeps the key handler a
   *  pure function of the event. */
  | { type: "toggleField" }
  | { type: "flag"; flag: SiteFlag }
  | { type: "mobility" }
  | { type: "furcation" }
  | { type: "clear" }
  | { type: "reset"; teeth: number[]; values: EntryValues }
  | { type: "restore"; values: EntryValues }
  /** The traversal settings changed. Re-routes the cursor; keeps every value,
   *  because the values are keyed by tooth and the order is only a route. */
  | { type: "order"; teeth: number[]; autoAdvance: boolean }
  /** A previous exam carried into this one. Every reading arrives marked. */
  | { type: "seed"; values: EntryValues; message: string }
  /** "I have checked these today." Drops the carried marks, keeps the figures. */
  | { type: "confirmCarried"; message: string }
  | { type: "saved" };

/** Everything a keystroke can mean. `leaveGrid` is the only one that is not an
 *  action: Escape hands focus back rather than changing any state. */
export type EntryKeyOutcome = EntryAction | { type: "leaveGrid" } | null;

/**
 * WHICH KEY MEANS WHAT. Pure, exported, and out here for a reason.
 *
 * This mapping used to live inside the component's useCallback, where no test
 * in this repo could reach it — vitest collects src/**\/*.test.ts in a node
 * environment and cannot render a component to press a key at it. A mutation
 * proved the gap: rebinding `d` back to the depth field, which is the exact
 * defect this module was fixed for, left every perio test green.
 *
 * So the whole keyboard is a data mapping now, and the handler is four lines
 * that call it. The reducer already took VALUES rather than keystrokes, for the
 * voice-entry seam PERIO.md §4 asks for; this is the other half of that split.
 *
 * `d` IS DENTALLY'S DOUBLE-FIGURE KEY and nothing else. It selects no row, it
 * records nothing on its own, and if it ever means anything else again the test
 * beside this function fails.
 */
export function entryKeyAction(key: string, shiftKey = false): EntryKeyOutcome {
  if (key.length === 1 && key >= "0" && key <= "9") {
    return { type: "digit", digit: Number(key) };
  }
  switch (key) {
    case "-":
    case "_":
      return { type: "sign" };
    case "Tab":
      return { type: "move", by: shiftKey ? -1 : 1 };
    case " ":
    case "Enter":
    case "ArrowRight":
      return { type: "move", by: 1 };
    case "ArrowLeft":
      return { type: "move", by: -1 };
    case "ArrowDown":
      return { type: "row", delta: 3 };
    case "ArrowUp":
      return { type: "row", delta: -3 };
    case "Home":
      return { type: "moveTo", index: 0 };
    case "End":
      return { type: "moveTo", index: Number.MAX_SAFE_INTEGER };
    case "Backspace":
    case "Delete":
      return { type: "clear" };
    case "Escape":
      // Never trap the keyboard in a grid.
      return { type: "leaveGrid" };
    default:
      break;
  }
  switch (key.toLowerCase()) {
    // b and s are Dentally's own; p is ours, and sits with them.
    case "b":
      return { type: "flag", flag: "bleeding" };
    case "s":
      return { type: "flag", flag: "suppuration" };
    case "p":
      return { type: "flag", flag: "plaque" };
    // DENTALLY'S ARTICLE: "press 'd' and then 2 to record a 12".
    case "d":
      return { type: "double" };
    // Ours, not Dentally's, which is why it is the key that moved when `d` had
    // to be given back.
    case "r":
      return { type: "toggleField" };
    case "m":
      return { type: "mobility" };
    case "f":
      return { type: "furcation" };
    default:
      return null;
  }
}

export function cellCount(state: Pick<EntryState, "teeth">): number {
  return state.teeth.length * SITE_IDS.length;
}

export function cursorTooth(state: EntryState): number | null {
  return state.teeth[Math.floor(state.cursor / SITE_IDS.length)] ?? null;
}

export function cursorSite(state: EntryState): PerioSiteId {
  // Modulo-safe. The read-only renderer parks the cursor at -1 so that no cell
  // is highlighted, and a negative index here would hand back an undefined that
  // the type says is a site.
  const within = ((state.cursor % SITE_IDS.length) + SITE_IDS.length) % SITE_IDS.length;
  return SITE_IDS[within];
}

function withSite(
  values: EntryValues,
  tooth: number,
  site: PerioSiteId,
  patch: Partial<SiteEntry>,
): EntryValues {
  const current = values[tooth];
  if (!current) return values;
  return {
    ...values,
    [tooth]: {
      ...current,
      sites: { ...current.sites, [site]: { ...current.sites[site], ...patch } },
    },
  };
}

function clampCursor(state: EntryState, index: number): number {
  const last = cellCount(state) - 1;
  if (last < 0) return 0;
  return Math.max(0, Math.min(last, index));
}

/**
 * Drop a half-typed prefix, and SAY that it was dropped.
 *
 * There is no half-typed VALUE to write down any more — every digit commits its
 * own number the moment it is pressed — so all this clears is a `d` or a minus
 * that never got its digit. Called before every navigation, every field change
 * and every save.
 *
 * IT ANNOUNCES, and that is the point of it. `d`, Tab, `2` must not put a 2 at
 * the next site while the clinician believes they typed a 12 at this one; the
 * Tab says out loud that the prefix went nowhere.
 */
function flush(state: EntryState): EntryState {
  if (!state.pendingDouble && !state.pendingNegative) return { ...state, message: null };
  return {
    ...state,
    pendingDouble: false,
    pendingNegative: false,
    nonce: state.nonce + 1,
    message: state.pendingDouble
      ? "The double-figure d was cleared before a digit followed it, so nothing was recorded. Press d again, then the digit."
      : "The minus was cleared before a digit followed it, so nothing was recorded.",
  };
}

function commit(state: EntryState, value: number | null): EntryState {
  const tooth = cursorTooth(state);
  if (tooth === null) return state;
  const site = cursorSite(state);
  const base = { ...state, pendingDouble: false, pendingNegative: false, nonce: state.nonce + 1 };

  if (state.field === "recession") {
    if (value !== null && (value < MIN_RECESSION_MM || value > MAX_RECESSION_MM)) {
      return {
        ...base,
        message: `Recession is recorded between ${MIN_RECESSION_MM}mm and ${MAX_RECESSION_MM}mm; ${value}mm was not accepted.`,
      };
    }
    // A RECESSION WITH NO DEPTH IS REFUSED BY THE ENGINE — a finding at a site
    // that was not probed cannot be placed. Caught here so it is a sentence at
    // the keystroke rather than a rejection at the save.
    if (value !== null && state.values[tooth].sites[site].probingDepth === null) {
      return {
        ...base,
        message: `Tooth ${tooth}, ${SITE_LABEL[site]}: record the probing depth before the recession. A finding at a site that was not probed cannot be placed.`,
      };
    }
    return {
      ...base,
      // TOUCHING A CARRIED SITE MAKES IT TODAY'S. "Carried" means carried
      // forward and not touched since; the moment a clinician types here they
      // have been to this site, and leaving the mark on would then be a second
      // lie in the opposite direction.
      values: withSite(state.values, tooth, site, { recession: value, carried: false }),
      dirty: true,
      message: null,
    };
  }

  if (value !== null && (value < 0 || value > MAX_PROBING_DEPTH_MM)) {
    return {
      ...base,
      message: `A probing depth is a whole number of millimetres between 0 and ${MAX_PROBING_DEPTH_MM}; ${value}mm was not accepted.`,
    };
  }

  // CLEARING A DEPTH CLEARS EVERYTHING THAT HANGS OFF IT. Recession, bleeding,
  // suppuration and plaque are all properties OF a reading, and the engine
  // refuses a chart that carries them at a site with no depth. Leaving them
  // behind would produce a record that cannot be saved and cannot be seen to be
  // wrong.
  const patch: Partial<SiteEntry> =
    value === null
      ? {
          probingDepth: null,
          recession: null,
          bleeding: false,
          suppuration: false,
          plaque: false,
          carried: false,
        }
      : { probingDepth: value, carried: false };

  return {
    ...base,
    values: withSite(state.values, tooth, site, patch),
    dirty: true,
    message:
      value === null
        ? `Tooth ${tooth}, ${SITE_LABEL[site]} cleared, along with the recession and the findings recorded at it.`
        : null,
  };
}

function advance(state: EntryState): EntryState {
  const last = cellCount(state) - 1;
  if (state.cursor >= last) {
    return { ...state, message: "That is the last site in this chart." };
  }
  return { ...state, cursor: state.cursor + 1 };
}

/** What this field may hold. The engine's numbers, not a second opinion. */
function rangeFor(state: EntryState): { min: number; max: number } {
  return state.field === "depth"
    ? { min: 0, max: MAX_PROBING_DEPTH_MM }
    : { min: MIN_RECESSION_MM, max: MAX_RECESSION_MM };
}

/** Ten, and the reason it is named: `d` `2` is 10 + 2. */
const DOUBLE_FIGURE_BASE = 10;

/**
 * THE DIGIT ADAPTER, and the whole of the double-figure convention.
 *
 * Three paths, and each one produces exactly the number it was given:
 *
 *   after `d`  — the digit is added to ten, so `d` `2` is 12. Dentally's own
 *                documented behaviour, quoted in the file header.
 *   after `-`  — the digit is negated, for a margin coronal to the CEJ.
 *   otherwise  — the digit IS the number. `1` is 1mm and never the opening half
 *                of something longer, because a `1` that waits is a `1` that can
 *                swallow the next site's reading.
 *
 * A REFUSED VALUE NEVER MOVES THE CURSOR. `advance` used to run over the top of
 * a rejection, so the retyped number landed one site along. Anything that comes
 * back from `commit` carrying a message is a refusal, and the cursor stays.
 *
 * The auto-advance setting governs only whether an ACCEPTED value moves on;
 * "wait for Tab" leaves the cursor still and a second digit simply replaces the
 * first, which is visible in the cell and in the readout. There is no accumulator
 * any more, and that is the point: the value on screen is always the value that
 * would be saved.
 */
function applyDigit(state: EntryState, digit: number): EntryState {
  const { min, max } = rangeFor(state);

  const value = state.pendingDouble
    ? DOUBLE_FIGURE_BASE + digit
    : state.pendingNegative
      ? -digit
      : digit;

  if (value < min || value > max) {
    const typed = state.pendingDouble
      ? `d then ${digit}, which is ${value}mm,`
      : `${value}mm`;
    return {
      ...state,
      pendingDouble: false,
      pendingNegative: false,
      nonce: state.nonce + 1,
      message: `${typed} is outside ${min}mm to ${max}mm for the ${FIELD_LABEL[state.field]}, so nothing was recorded here.`,
    };
  }

  const committed = commit({ ...state, pendingDouble: false, pendingNegative: false }, value);
  if (committed.message !== null) return committed;
  return state.autoAdvance ? advance(committed) : committed;
}

export function entryReducer(state: EntryState, action: EntryAction): EntryState {
  switch (action.type) {
    case "reset":
      return {
        teeth: action.teeth,
        values: action.values,
        cursor: 0,
        field: "depth",
        pendingDouble: false,
        pendingNegative: false,
        message: null,
        nonce: state.nonce + 1,
        dirty: false,
        restored: false,
        autoAdvance: state.autoAdvance,
      };
    case "restore":
      return {
        ...state,
        values: action.values,
        nonce: state.nonce + 1,
        dirty: true,
        restored: true,
      };
    case "order": {
      // THE SAME TEETH, A DIFFERENT ROUTE. Values are keyed by tooth number, so
      // nothing typed is at risk — but the CURSOR is an index into the old
      // order, and leaving it where it was would silently move it to a different
      // tooth. It is carried by identity instead: the same tooth, the same site.
      const moved = flush(state);
      const tooth = cursorTooth(moved);
      const site = cursorSite(moved);
      const at = tooth === null ? -1 : action.teeth.indexOf(tooth);
      const cursor =
        moved.cursor < 0 || at < 0 ? moved.cursor : at * SITE_IDS.length + SITE_IDS.indexOf(site);
      return {
        ...moved,
        teeth: action.teeth,
        autoAdvance: action.autoAdvance,
        cursor,
        nonce: moved.nonce + 1,
        message: null,
      };
    }
    case "seed":
      return {
        ...state,
        values: action.values,
        cursor: 0,
        field: "depth",
        pendingDouble: false,
        pendingNegative: false,
        dirty: true,
        nonce: state.nonce + 1,
        message: action.message,
      };
    case "confirmCarried":
      return {
        ...state,
        values: confirmCarried(state.values),
        dirty: true,
        nonce: state.nonce + 1,
        message: action.message,
      };
    case "saved":
      return { ...state, dirty: false, nonce: state.nonce + 1, message: null };
    case "value": {
      const committed = commit(state, action.value);
      return action.advance === false ? committed : advance(committed);
    }
    case "digit":
      return applyDigit(state, action.digit);
    case "double": {
      // DENTALLY'S `d`. It records nothing on its own; it says the digit after it
      // is a double figure. Announced rather than silent, because a prefix a
      // clinician cannot see is a prefix they cannot tell they have lost.
      const { max } = rangeFor(state);
      if (state.pendingDouble) {
        return {
          ...state,
          nonce: state.nonce + 1,
          message: `Already waiting for the second half of a double figure. Type a digit — d then 2 records 12 — or press Tab to abandon it.`,
        };
      }
      return {
        ...state,
        pendingDouble: true,
        nonce: state.nonce + 1,
        message: `Double figure: the next digit is added to ten, so d then 2 records 12. Nothing above ${max}mm can be recorded.`,
      };
    }
    case "sign":
      if (state.field !== "recession") {
        return {
          ...state,
          nonce: state.nonce + 1,
          message: "A probing depth cannot be negative. Switch to recession first.",
        };
      }
      return {
        ...state,
        pendingNegative: true,
        pendingDouble: false,
        nonce: state.nonce + 1,
        message: null,
      };
    case "move": {
      // flush()'s own sentence survives, because "the d you pressed went nowhere"
      // is the single most important thing this grid can say.
      const moved = flush(state);
      return { ...moved, cursor: clampCursor(moved, moved.cursor + action.by) };
    }
    case "moveTo": {
      const moved = flush(state);
      return { ...moved, cursor: clampCursor(moved, action.index) };
    }
    case "row": {
      // Down moves from the buccal row to the lingual row of the SAME tooth and
      // stops there; it never leaks into the next tooth, because a cursor that
      // silently changes tooth is how a reading lands on the wrong one.
      const moved = flush(state);
      const withinTooth = moved.cursor % SITE_IDS.length;
      const next = withinTooth + action.delta;
      if (next < 0 || next >= SITE_IDS.length) return moved;
      return { ...moved, cursor: moved.cursor + action.delta };
    }
    case "field": {
      const moved = flush(state);
      return { ...moved, field: action.field, nonce: moved.nonce + 1 };
    }
    case "toggleField": {
      const moved = flush(state);
      const field: EntryField = moved.field === "depth" ? "recession" : "depth";
      return {
        ...moved,
        field,
        nonce: moved.nonce + 1,
        // Named out loud. `r` moves between two rows that both hold millimetres,
        // and a row switch nobody noticed is a recession typed into the depth.
        message: moved.message ?? `Now recording the ${FIELD_LABEL[field]}.`,
      };
    }
    case "flag": {
      const moved = flush(state);
      const tooth = cursorTooth(moved);
      if (tooth === null) return moved;
      const site = cursorSite(moved);
      const cell = moved.values[tooth].sites[site];
      if (cell.probingDepth === null) {
        return {
          ...moved,
          nonce: moved.nonce + 1,
          message: `Tooth ${tooth}, ${SITE_LABEL[site]}: record the probing depth first. A finding at a site that was not probed cannot be placed.`,
        };
      }
      return {
        ...moved,
        // b and s are Dentally's own keys, and pressing one again clears it —
        // which is what a toggle is. `carried` goes with it: a finding recorded
        // at a carried site is a site the clinician has just been to.
        values: withSite(moved.values, tooth, site, {
          [action.flag]: !cell[action.flag],
          carried: false,
        }),
        dirty: true,
        nonce: moved.nonce + 1,
        message: `${FLAG_LABEL[action.flag]} ${cell[action.flag] ? "cleared" : "recorded"} at tooth ${tooth}, ${SITE_LABEL[site]}.`,
      };
    }
    case "mobility": {
      const moved = flush(state);
      const tooth = cursorTooth(moved);
      if (tooth === null) return moved;
      // m CYCLES, AND PRESSING IT PAST THE END CLEARS — Dentally's own rule.
      // The scale is the engine's, never a range written here.
      const next = cycleScale(MOBILITY_SCALE, moved.values[tooth].mobility);
      return {
        ...moved,
        values: {
          ...moved.values,
          [tooth]: { ...moved.values[tooth], mobility: next, carriedFindings: false },
        },
        dirty: true,
        nonce: moved.nonce + 1,
        message: `Tooth ${tooth}: mobility ${next === null ? "not recorded" : MOBILITY_LABEL[next]}.`,
      };
    }
    case "furcation": {
      const moved = flush(state);
      const tooth = cursorTooth(moved);
      if (tooth === null) return moved;
      // A SINGLE-ROOTED TOOTH HAS NO FURCATION TO GRADE, and the engine refuses a
      // furcation grade on one as a mis-keyed tooth. Refused here too, in words.
      if (displayNumber(tooth) <= 3) {
        return {
          ...moved,
          nonce: moved.nonce + 1,
          message: `Tooth ${tooth} is single-rooted, so it has no furcation to grade.`,
        };
      }
      const next = cycleScale(FURCATION_SCALE, moved.values[tooth].furcation);
      return {
        ...moved,
        values: {
          ...moved.values,
          [tooth]: { ...moved.values[tooth], furcation: next, carriedFindings: false },
        },
        dirty: true,
        nonce: moved.nonce + 1,
        message: `Tooth ${tooth}: furcation ${next === null ? "not recorded" : FURCATION_LABEL[next]}.`,
      };
    }
    case "clear":
      // Backspace clears the site AND abandons any prefix. commit() drops both
      // on its own, so there is nothing for flush() to announce.
      return commit({ ...state, pendingDouble: false, pendingNegative: false }, null);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Which teeth this chart draws
// ---------------------------------------------------------------------------

/** Both arches, right to left, upper then lower. The order the cursor sweeps. */
const ARCH_ORDER: readonly number[] = [...PERMANENT_UPPER, ...PERMANENT_LOWER];

type ColumnStatus = "chartable" | "not-declared" | "not-present";

function columnStatus(
  tooth: number,
  declared: ReadonlySet<SextantId>,
  present: ReadonlySet<number>,
): ColumnStatus {
  if (!present.has(tooth)) return "not-present";
  const sextant = sextantOfTooth(tooth);
  // A third molar belongs to no sextant, so no sextant can declare it. It is
  // chartable when the caller says it is in the mouth, and the engine reports it
  // separately — in the whole-chart figures and in no sextant's.
  if (sextant === null) return "chartable";
  return declared.has(sextant) ? "chartable" : "not-declared";
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Fixed geometry. Inline styles rather than Tailwind arbitrary values, because
 *  Tailwind v4 scans raw source and an interpolated class is never generated. */
const SITE_COLUMN_PX = 30;
const GUTTER_PX = 92;

/** Three sub-columns per tooth — the buccal row uses them for mb·b·db and the
 *  lingual row for ml·l·dl, which is what makes the two rows read as one tooth. */
const SITES_PER_ROW = SITE_IDS.length / 2;

function templateFor(teethInArch: number) {
  return `${GUTTER_PX}px repeat(${teethInArch * SITES_PER_ROW}, ${SITE_COLUMN_PX}px)`;
}

function RowLabel({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "quiet" }) {
  return (
    <div
      className={
        tone === "quiet"
          ? "sticky left-0 z-10 flex items-center bg-card pr-2 text-[10px] uppercase tracking-[0.05em] text-faint"
          : "sticky left-0 z-10 flex items-center bg-card pr-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted"
      }
    >
      {children}
    </div>
  );
}

function BlockedSpan({ status }: { status: Exclude<ColumnStatus, "chartable"> }) {
  return (
    <div
      className={
        status === "not-present"
          ? "flex items-center justify-center border-b border-l border-line bg-card-muted text-[9px] text-faint"
          : "flex items-center justify-center border-b border-l border-line bg-cream text-[9px] text-faint"
      }
      style={{ gridColumn: "span 3" }}
      aria-hidden
    >
      ·
    </div>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/** The settings machine. Two actions: what storage held, and what the clinician
 *  just changed. Pure, like the entry machine, and for the same reason. */
type PrefsAction =
  | { type: "load"; prefs: ChartEntryPrefs }
  | { type: "patch"; patch: Partial<ChartEntryPrefs> };

function prefsReducer(state: ChartEntryPrefs, action: PrefsAction): ChartEntryPrefs {
  return action.type === "load" ? action.prefs : { ...state, ...action.patch };
}

/**
 * A chart already on the record, as the route's `charts` action returns it.
 *
 * Declared here rather than imported from the repository because that module is
 * server-only and this one is a client island; it is the same shape narrowed to
 * what this screen reads, and every field is plain data off the wire.
 */
interface ExamHeader {
  id: string;
  recorded: { at: string; clinician: { name: string; gdcNumber: string | null } };
  supersedesId: string | null;
  amendmentReason: string | null;
}

export interface PocketChartEntryProps {
  /** Scope. Every read and write this screen makes carries all three. */
  client: string;
  siteId: string;
  patientId: string;
  /**
   * The sextants this chart SETS OUT to cover. A BPE code 3 charts one; a code 4
   * charts all six. Declaring the scope is what makes a partial chart legible as
   * a deliberate partial chart rather than an abandoned full one.
   */
  sextants: readonly SextantId[];
  /**
   * FDI numbers of the teeth in the mouth. Defaults to the teeth of the declared
   * sextants, which excludes third molars — pass them explicitly to chart one.
   */
  presentTeeth?: readonly number[];
  /**
   * The clinician the record will be attributed to. GDC Standard 4.1.4.
   * Null when the server cannot name one: saving is then refused and the local
   * preview is not built either, because a preview attributed to nobody is a
   * fabricated record.
   */
  clinician: ClinicianRef | null;
  /**
   * An ISO-8601 instant supplied by the caller, used ONLY to build the local
   * preview. No module in this feature reads the clock in a render path. The
   * saved record is stamped by the server.
   */
  openedAt: string;
  probe?: PerioProbe;
  /** Whether the practice records perio in this platform at all. isPerioEnabled()
   *  is server-only, so its answer arrives as this boolean. */
  canSave: boolean;
  /** PERIO_COPY.disabled, or whatever else explains a false `canSave`. */
  readOnlyNotice?: string | null;
  /** PERIO_COPY.doubleEntry. Optional because the shell normally shows it once
   *  above the whole tab; never hard-coded here. */
  fp17Notice?: string | null;
  /** Seed for a re-open or an amendment. */
  initialTeeth?: readonly PerioToothRecord[];
  /** Set when this chart amends a stored one. An amendment must say why. */
  supersedesId?: string | null;
  trigger?: "bpe-3" | "bpe-4" | "maintenance-annual" | "other" | null;
  bpeExamId?: string | null;
}

export function PocketChartEntry(props: PocketChartEntryProps) {
  const {
    client,
    siteId,
    patientId,
    sextants,
    presentTeeth,
    clinician,
    openedAt,
    canSave,
    readOnlyNotice,
    fp17Notice,
    initialTeeth,
    supersedesId,
    trigger,
    bpeExamId,
  } = props;

  const declared = useMemo(() => new Set(sextants), [sextants]);
  const present = useMemo(() => {
    if (presentTeeth) return new Set(presentTeeth);
    const fallback = new Set<number>();
    for (const sextant of sextants) for (const tooth of SEXTANT_TEETH[sextant]) fallback.add(tooth);
    return fallback;
  }, [presentTeeth, sextants]);

  /** The teeth this chart draws, in ANATOMICAL order. The grid's columns and
   *  the browser draft's key both hang off this, so neither moves when a
   *  traversal setting changes. */
  const chartTeeth = useMemo(
    () => ARCH_ORDER.filter((tooth) => columnStatus(tooth, declared, present) === "chartable"),
    [declared, present],
  );
  const teethKey = chartTeeth.join(",");

  // ---- Dentally's entry settings ----------------------------------------
  //
  // Rendered from the defaults on the server and on the first client pass, then
  // replaced from storage in an effect. Reading localStorage during render is a
  // hydration mismatch, and the default order happens to be the order the
  // reducer already starts in, so nothing visibly moves.
  // A reducer rather than a useState, for a reason this repo has already been
  // bitten by: the lint (and React) forbid a setState called straight out of an
  // effect body, because it cascades a second render. A dispatch is the
  // sanctioned way to move state from an external system — here, storage — into
  // React, and it is the same shape the entry machine already uses.
  const [prefs, dispatchPrefs] = useReducer(prefsReducer, DEFAULT_CHART_ENTRY_PREFS);
  const prefsKey = chartEntryPrefsStorageKey(siteId, clinician?.id ?? null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(prefsKey);
    } catch {
      return; // storage disabled; the defaults are a perfectly good way to chart
    }
    if (raw === null) return;
    dispatchPrefs({ type: "load", prefs: parseChartEntryPrefs(raw) });
  }, [prefsKey]);

  const updatePrefs = useCallback(
    (patch: Partial<ChartEntryPrefs>) => {
      dispatchPrefs({ type: "patch", patch });
    },
    [],
  );

  // Written out AFTER the change has been applied, not inside the reducer: a
  // reducer that touches storage is a reducer that cannot be run twice, and
  // React runs them twice on purpose.
  useEffect(() => {
    if (typeof window === "undefined" || prefs === DEFAULT_CHART_ENTRY_PREFS) return;
    try {
      window.localStorage.setItem(prefsKey, serialiseChartEntryPrefs(prefs));
    } catch {
      /* the setting still applies to this session; it just is not kept */
    }
  }, [prefs, prefsKey]);

  /** The route the cursor takes. Only the route: the grid is drawn anatomically
   *  whatever this says, because columns that move when a setting changes are
   *  columns a clinician has to re-read before every reading. */
  const sweepTeeth = useMemo(
    () =>
      entryToothOrder(
        prefs,
        chartTeeth.filter((t) => PERMANENT_UPPER.includes(t)),
        chartTeeth.filter((t) => PERMANENT_LOWER.includes(t)),
      ),
    [prefs, chartTeeth],
  );
  const sweepKey = sweepTeeth.join(",");

  const [state, dispatch] = useReducer(entryReducer, null, (): EntryState => ({
    teeth: chartTeeth,
    values: valuesFromRecords(chartTeeth, initialTeeth),
    cursor: 0,
    field: "depth",
    pendingDouble: false,
    pendingNegative: false,
    message: null,
    nonce: 0,
    dirty: false,
    restored: false,
    autoAdvance: DEFAULT_CHART_ENTRY_PREFS.advance === "auto",
  }));

  const [probe, setProbe] = useState<PerioProbe>(props.probe ?? DEFAULT_PROBE);
  const [probeNote, setProbeNote] = useState("");
  const [amendmentReason, setAmendmentReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // The tooth set changed under us (a different sextant selection upstream).
  // Reset rather than reconcile: a cursor pointing into the old tooth list is a
  // reading about to land on the wrong tooth.
  const lastTeethKey = useRef(teethKey);
  useEffect(() => {
    if (lastTeethKey.current === teethKey) return;
    lastTeethKey.current = teethKey;
    dispatch({ type: "reset", teeth: sweepTeeth, values: valuesFromRecords(chartTeeth, initialTeeth) });
  }, [teethKey, sweepTeeth, chartTeeth, initialTeeth]);

  // A setting changed. Re-route the cursor; keep every value.
  const autoAdvance = prefs.advance === "auto";
  const lastRoute = useRef(`${sweepKey}|${String(autoAdvance)}`);
  useEffect(() => {
    const route = `${sweepKey}|${String(autoAdvance)}`;
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    dispatch({ type: "order", teeth: sweepTeeth, autoAdvance });
  }, [sweepKey, autoAdvance, sweepTeeth]);

  // ---- per-site autosave, to THIS BROWSER ONLY --------------------------
  //
  // sessionStorage, not localStorage: a surgery machine is shared, and a
  // half-typed periodontal chart should not survive the tab that was typing it.
  const storageKey = `perio:chart-draft:${patientId}:${siteId}`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(storageKey);
    } catch {
      return; // storage disabled; entry still works, it just is not kept
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { teeth?: string; values?: EntryValues };
      if (parsed.teeth !== teethKey || !parsed.values) return;
      dispatch({ type: "restore", values: parsed.values });
    } catch {
      /* a draft we cannot read is a draft we do not use */
    }
    // Deliberately once per patient/site/tooth-set: a restore that re-ran on
    // every keystroke would fight the clinician for the cursor.
  }, [storageKey, teethKey]);

  useEffect(() => {
    if (typeof window === "undefined" || !state.dirty) return;
    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({ teeth: teethKey, values: state.values }),
      );
    } catch {
      /* nothing to do; the screen already says a draft is browser-only */
    }
  }, [state.values, state.dirty, storageKey, teethKey]);

  // ---- the exams already on the record ----------------------------------
  //
  // Read for two reasons that share one request: cloning a previous exam into
  // today's, and offering Dentally's 24-hour correction on the standing one.
  //
  // FAILURE IS SHOWN, NEVER SWALLOWED. An empty history and a history that could
  // not be read look identical on screen unless one of them says so, and
  // "no previous exam" is a claim about the patient.
  const scope = `client=${encodeURIComponent(client)}&siteId=${encodeURIComponent(siteId)}&patientId=${encodeURIComponent(patientId)}`;
  const [history, setHistory] = useState<ExamHeader[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyRead, setHistoryRead] = useState(false);
  const [carriedFrom, setCarriedFrom] = useState<ExamHeader | null>(null);
  const [correcting, setCorrecting] = useState<ExamHeader | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [carriedConfirmed, setCarriedConfirmed] = useState(false);

  useEffect(() => {
    if (!canSave) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/perio/charts?${scope}`);
        const body = (await response.json()) as { ok?: boolean; charts?: ExamHeader[] };
        if (!live) return;
        if (!response.ok || !body.ok || !Array.isArray(body.charts)) {
          setHistoryFailed(true);
        } else {
          setHistory(body.charts);
        }
      } catch {
        if (live) setHistoryFailed(true);
      } finally {
        if (live) setHistoryRead(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [scope, canSave]);

  /** Newest first, whatever order the route returned them in. */
  const exams = useMemo(
    () => [...history].sort((a, b) => (a.recorded.at < b.recorded.at ? 1 : -1)),
    [history],
  );
  const standing = exams[0] ?? null;

  /**
   * The chart Dentally would still let you edit. Measured against `openedAt` —
   * the instant the caller stamped this screen with — because no module in this
   * feature reads the clock, and a stale-by-minutes window only ever errs toward
   * the plainly-labelled amendment.
   */
  const correctionOpen = standing ? withinCorrectionWindow(standing.recorded.at, openedAt) : false;
  const correctionHoursLeft = standing
    ? hoursLeftInCorrectionWindow(standing.recorded.at, openedAt)
    : null;

  /** Pull a stored chart's teeth. Shared by clone and correction, which differ
   *  only in whether the readings arrive marked as carried. */
  const loadExam = useCallback(
    async (exam: ExamHeader, carried: boolean): Promise<void> => {
      setSeedBusy(true);
      setSaveIssues([]);
      try {
        const response = await fetch(`/api/perio/chart?id=${encodeURIComponent(exam.id)}&${scope}`);
        const body = (await response.json()) as {
          ok?: boolean;
          chart?: { teeth?: PerioToothRecord[] };
        };
        if (!response.ok || !body.ok || !body.chart?.teeth) {
          setSaveIssues([
            "That chart could not be read, so nothing has been carried into this one. Nothing on this screen has changed.",
          ]);
          return;
        }
        const values = valuesFromRecords(chartTeeth, body.chart.teeth, carried);
        setCarriedConfirmed(false);
        if (carried) {
          setCarriedFrom(exam);
          setCorrecting(null);
          dispatch({
            type: "seed",
            values,
            message: `Carried in from the exam of ${londonDateTimeLabel(exam.recorded.at)}. Nothing here has been measured today: re-probe each site, or confirm that you have checked them.`,
          });
        } else {
          setCorrecting(exam);
          setCarriedFrom(null);
          dispatch({
            type: "seed",
            values,
            message: `Correcting the exam of ${londonDateTimeLabel(exam.recorded.at)}. The original stays on the record; this is recorded as a dated amendment.`,
          });
        }
      } catch {
        setSaveIssues([
          "That chart could not be read, so nothing has been carried into this one. Nothing on this screen has changed.",
        ]);
      } finally {
        setSeedBusy(false);
      }
    },
    [scope, chartTeeth],
  );

  /**
   * The amendment this save is. The prop still wins when the caller set one —
   * it is the shell saying what this screen is for — and the correction picked
   * on screen fills in when it did not.
   */
  const amends = amendmentTargetId({ supersedesId, correcting, carriedFrom });

  const carriedStanding = carriedCount(state.teeth, state.values);

  // ---- the keyboard adapter ---------------------------------------------
  //
  // FOUR LINES, AND NOT ONE RULE. Which key means what is entryKeyAction()
  // above: pure, exported, and tested, because the version of this mapping that
  // lived inside this callback could not be reached by any test in the repo —
  // and a mutation that pointed `d` back at the depth field, which is the very
  // defect this module was fixed for, left the whole perio suite green.
  //
  // Everything it returns has a non-keyboard equivalent, which is the point: a
  // voice stream dispatches the same actions without going near this function.
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = entryKeyAction(event.key, event.shiftKey);
    if (action === null) return;
    if (action.type === "leaveGrid") {
      // Never trap the keyboard in a grid. Escape hands focus back, and is not
      // preventDefault'd, because it belongs to the browser as well.
      gridRef.current?.blur();
      return;
    }
    event.preventDefault();
    dispatch(action);
  }, []);

  // ---- what has actually been recorded ----------------------------------

  /**
   * A SITE COUNTS WHEN IT WAS MEASURED TODAY.
   *
   * A carried reading has a depth and is drawn on the grid, but nobody took it
   * at this appointment, so it is not part of this record and must not be
   * counted as if it were. Confirming the carried readings clears the mark and
   * these figures then count — which is the whole difference between carrying a
   * chart forward and fabricating one.
   */
  const measured = useCallback(
    (tooth: number, site: PerioSiteId): boolean => measuredToday(state.values[tooth]?.sites[site]),
    [state.values],
  );

  const recordedTeeth = useMemo(
    () => state.teeth.filter((tooth) => SITE_IDS.some((site) => measured(tooth, site))),
    [state.teeth, measured],
  );

  /** Dentally's live BOP, at the top of the chart, recomputed on every keystroke
   *  because the engine's function is pure and cheap. */
  const liveBop = useMemo(
    () => liveBopFrom(state.teeth, state.values),
    [state.teeth, state.values],
  );

  /**
   * The sextants that actually hold a reading — NOT the ones declared.
   *
   * The route refuses a chart that declares a sextant and records nothing in it,
   * and it is right to: "the upper left was examined and was fine" is what an
   * empty declared sextant reads as to the next clinician. So the saved chart
   * declares exactly what it holds, and the gap between that and what the
   * clinician set out to do is shown on screen instead of stored as a claim.
   */
  const recordedSextants = useMemo(
    () => SEXTANTS.filter((s) => recordedTeeth.some((t) => sextantOfTooth(t) === s)),
    [recordedTeeth],
  );
  const declaredButEmpty = useMemo(
    () => SEXTANTS.filter((s) => declared.has(s) && !recordedSextants.includes(s)),
    [declared, recordedSextants],
  );

  const sitesRecorded = useMemo(
    () =>
      state.teeth.reduce(
        (total, tooth) => total + SITE_IDS.filter((site) => measured(tooth, site)).length,
        0,
      ),
    [state.teeth, measured],
  );
  const totalCells = state.teeth.length * SITE_IDS.length;

  const chartInput = useMemo((): PocketChartInput | null => {
    if (!clinician || recordedTeeth.length === 0) return null;
    const teeth: ToothRecordInput[] = recordedTeeth.map((tooth) => {
      const entry = state.values[tooth];
      return {
        tooth,
        // Tooth-level findings carried in from an earlier exam go the same way
        // as carried sites: out, until they are re-cycled or confirmed.
        mobility: entry.carriedFindings ? null : entry.mobility,
        furcation: entry.carriedFindings ? null : entry.furcation,
        sites: SITE_IDS.filter((site) => measured(tooth, site)).map((site) => ({
          site,
          probingDepth: entry.sites[site].probingDepth,
          recession: entry.sites[site].recession,
          bleeding: entry.sites[site].bleeding,
          suppuration: entry.sites[site].suppuration,
          plaque: entry.sites[site].plaque,
        })),
      };
    });
    return {
      sextants: recordedSextants,
      teeth,
      recorded: { clinician, at: openedAt },
      probe,
      patientId,
      siteId,
      supersedesId: amends,
      amendmentReason: amends ? amendmentReason : null,
    };
  }, [
    clinician,
    recordedTeeth,
    recordedSextants,
    state.values,
    measured,
    openedAt,
    probe,
    patientId,
    siteId,
    amends,
    amendmentReason,
  ]);

  /** THE LIVE PREVIEW IS THE ENGINE'S OWN VIEW, not a second summary. Built on
   *  every change because buildPocketChart is pure and cheap; null while the
   *  chart is not yet valid, which is a normal state mid-examination. */
  const preview = useMemo((): PocketChartView | null => {
    if (!chartInput) return null;
    try {
      return buildPocketChart(chartInput);
    } catch {
      return null;
    }
  }, [chartInput]);

  const liveIssues = useMemo(
    () => (chartInput ? validatePocketChart(chartInput) : []),
    [chartInput],
  );

  // ---- saving -------------------------------------------------------------

  const save = useCallback(async () => {
    setSaveIssues([]);
    setSaveNotice(null);
    if (!chartInput) {
      setSaveIssues([
        "Nothing has been recorded yet, so there is no chart to write. A chart with no readings says nothing about this mouth.",
      ]);
      return;
    }
    // The engine's own validation, run here so the clinician sees every problem
    // at once instead of one round trip at a time. The server runs it again — it
    // is the enforcer, this is only the courtesy.
    const issues = validatePocketChart(chartInput);
    if (issues.length > 0) {
      setSaveIssues(issues);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/perio/chart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client,
          siteId,
          patientId,
          sextants: chartInput.sextants,
          teeth: chartInput.teeth,
          probe,
          probeNote: probe === "other" ? probeNote : null,
          trigger: trigger ?? null,
          bpeExamId: bpeExamId ?? null,
          supersedesId: amends,
          amendmentReason: amends ? amendmentReason : null,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        issues?: string[];
        notice?: string;
        chart?: { id?: string };
      };
      if (!response.ok || !body.ok) {
        setSaveIssues(body.issues ?? [body.error ?? "That periodontal record was not saved."]);
        return;
      }
      // The double-entry sentence comes back on every successful write. Shown
      // here rather than remembered, so it cannot be switched off by forgetting
      // to pass a prop.
      setSaveNotice(body.notice ?? null);
      setSavedId(body.chart?.id ?? null);
      // The clone and the correction are finished with. Leaving either set would
      // point the NEXT save at a chart that has already been superseded.
      setCarriedFrom(null);
      setCorrecting(null);
      dispatch({ type: "saved" });
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* the record is written; the browser copy is now the stale one */
      }
    } catch {
      setSaveIssues([
        "That periodontal record was not saved. Nothing has been stored, and nothing has been sent to Dentally.",
      ]);
    } finally {
      setSaving(false);
    }
  }, [
    chartInput,
    client,
    siteId,
    patientId,
    probe,
    probeNote,
    trigger,
    bpeExamId,
    amends,
    amendmentReason,
    storageKey,
  ]);

  // ---- render -------------------------------------------------------------

  const activeTooth = cursorTooth(state);
  const activeSite = cursorSite(state);
  const activeEntry = activeTooth === null ? null : state.values[activeTooth];
  const activeCell = activeEntry ? activeEntry.sites[activeSite] : null;

  return (
    <section className="space-y-3" aria-label="Six-point periodontal chart">
      {/* WHAT THIS SCREEN IS AND WHO IT IS ATTRIBUTED TO, before anything else. */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 rounded-xl border border-line bg-card px-4 py-3 shadow-sm">
        <div className="space-y-0.5">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-navy">
            Six-point chart
          </h3>
          <p className="text-[11.5px] leading-tight text-muted">
            {clinician ? (
              <>
                Recording as <span className="font-medium text-navy">{clinician.name}</span>
                {clinician.gdcNumber ? ` · GDC ${clinician.gdcNumber}` : ""}
              </>
            ) : (
              "No signed-in clinician, so nothing here can be recorded."
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            Probe
            <select
              className="rounded border border-line bg-card px-1.5 py-1 text-[11.5px] text-navy"
              value={probe}
              onChange={(event) => setProbe(event.target.value as PerioProbe)}
              disabled={!canSave}
            >
              <option value="who-621">WHO 621</option>
              <option value="who-cpi">WHO CPI</option>
              <option value="other">other</option>
            </select>
          </label>
          {probe === "other" ? (
            <input
              className="rounded border border-line bg-card px-2 py-1 text-[11.5px] text-navy"
              placeholder="which probe"
              value={probeNote}
              onChange={(event) => setProbeNote(event.target.value)}
              disabled={!canSave}
            />
          ) : null}
          {/* THE LIVE BOP SCORE, AT THE TOP OF THE CHART, which is where
              Dentally puts it and what it is for: "a live % Bleeding on Probing
              (BOP) score will appear at the top of the perio chart", so nobody
              counts bleeding sites by hand at the end.

              THE ENGINE'S FIGURE AND THE ENGINE'S SENTENCE. liveBopScore() knows
              that the denominator is the sites PROBED SO FAR and that an
              unprobed mouth has no score rather than a score of 0% — both of
              which are clinical statements, and neither of which is restated
              here. The site count stays beside it as progress, which is a
              different thing and now visibly a different thing. */}
          <div className="flex items-baseline gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">
                Bleeding on probing (live)
              </div>
              {/* NO THRESHOLD COLOUR. Ten percent is the BSP's line between
                  periodontal health and gingivitis, and painting it here would
                  be a diagnosis made by a stylesheet — stated nowhere, owned by
                  nobody. The figure is printed; the clinician reads it. */}
              <div className="text-[17px] font-semibold leading-tight tabular-nums text-navy">
                {liveBop.percent === null ? "—" : `${liveBop.percent}%`}
              </div>
            </div>
            <span className="max-w-[22rem] text-[11px] leading-tight text-faint">
              {liveBop.label}
            </span>
          </div>
          <span className="text-[11.5px] tabular-nums text-faint">
            {sitesRecorded} of {totalCells} sites
          </span>
        </div>
      </header>

      {/* DENTALLY'S ENTRY SETTINGS. Three of them, kept for this clinician
          rather than for this patient, because they describe a pair of hands. */}
      <EntrySettings prefs={prefs} canEdit={canSave} onChange={updatePrefs} />

      {/* THE EXAMS ALREADY ON THE RECORD: the 24-hour correction, the clone, and
          whether the standing one has been amended. */}
      <ExamHistoryBar
        exams={exams}
        standing={standing}
        correctionOpen={correctionOpen}
        correctionHoursLeft={correctionHoursLeft}
        failed={historyFailed}
        read={historyRead}
        busy={seedBusy}
        canEdit={canSave && Boolean(clinician)}
        carriedFrom={carriedFrom}
        correcting={correcting}
        onClone={(exam) => void loadExam(exam, true)}
        onCorrect={(exam) => void loadExam(exam, false)}
      />

      {/* CARRIED READINGS. Counted, named, and out of the record until checked. */}
      {carriedStanding > 0 ? (
        <div className="space-y-2 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-snug text-status-amber">
          <p>
            <strong className="font-semibold">
              {carriedStanding} reading{carriedStanding === 1 ? "" : "s"} carried forward
            </strong>
            {carriedFrom ? ` from the exam of ${londonDateTimeLabel(carriedFrom.recorded.at)}` : ""},
            and not measured today. They are drawn faintly and marked{" "}
            <span aria-hidden>·c</span>. They are <strong className="font-semibold">not</strong> part
            of this record: re-probe a site and its figure becomes today&rsquo;s, or confirm below
            that you have checked them all.
          </p>
          <label className="flex items-start gap-2 text-[11.5px]">
            <input
              type="checkbox"
              checked={carriedConfirmed}
              onChange={(event) => setCarriedConfirmed(event.target.checked)}
              disabled={!canSave}
            />
            <span>
              I have checked the carried readings at this appointment and they are today&rsquo;s
              findings.
            </span>
          </label>
          <button
            type="button"
            disabled={!canSave || !carriedConfirmed}
            onClick={() =>
              dispatch({
                type: "confirmCarried",
                message: `${carriedStanding} carried reading${carriedStanding === 1 ? "" : "s"} confirmed as checked today, and now part of this chart.`,
              })
            }
            className="rounded-md border border-line bg-card px-2.5 py-1 text-[11.5px] font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-50"
          >
            Confirm the carried readings
          </button>
        </div>
      ) : null}

      {!canSave ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-snug text-status-amber">
          {readOnlyNotice ??
            "This chart is read-only here. Nothing typed on this screen will be recorded."}
        </p>
      ) : null}

      {fp17Notice ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-snug text-status-amber">
          {fp17Notice}
        </p>
      ) : null}

      {/* THE SEXTANT STRIP. Six boxes in two rows of three, laid out as a BPE
          grid is written and spoken, saying for each one: charted, declared and
          still empty, or not part of this chart at all. */}
      <SextantStrip declared={declared} recorded={recordedSextants} />

      {declaredButEmpty.length > 0 ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-snug text-status-amber">
          You set out to chart the{" "}
          {declaredButEmpty.map((s) => SEXTANT_LABEL[s]).join(", ")} sextant
          {declaredButEmpty.length === 1 ? "" : "s"} and nothing has been recorded there yet. A
          sextant with no readings is unexamined, which is not the same as healthy, so it will not
          be written into the chart as covered.
        </p>
      ) : null}

      {/* THE CURSOR READOUT. What a clinician looks at while their eyes are in
          the patient's mouth, so it is the largest type on the screen. */}
      <CursorBar
        tooth={activeTooth}
        site={activeSite}
        field={state.field}
        cell={activeCell}
        entry={activeEntry}
        pendingDouble={state.pendingDouble}
        pendingNegative={state.pendingNegative}
        canEdit={canSave}
        onField={(field) => dispatch({ type: "field", field })}
        onFlag={(flag) => dispatch({ type: "flag", flag })}
        onMobility={() => dispatch({ type: "mobility" })}
        onFurcation={() => dispatch({ type: "furcation" })}
      />

      {/* The live region. Keyed on the nonce so identical consecutive messages
          are distinct states and the second one is announced rather than lost. */}
      <p className="sr-only" role="status" aria-live="polite" key={state.nonce}>
        {state.message ??
          (activeTooth === null
            ? "No tooth is being charted."
            : `Tooth ${activeTooth}, ${SITE_LABEL[activeSite]}, ${FIELD_LABEL[state.field]}.`)}
      </p>

      {state.message ? (
        <p className="rounded-lg border border-tint-royal-line bg-tint-royal px-3 py-2 text-[12px] leading-snug text-status-royal">
          {state.message}
        </p>
      ) : null}

      <div
        ref={gridRef}
        role="grid"
        tabIndex={0}
        aria-label={`Six-point chart entry grid. Digits record the value at the cursor and ${state.autoAdvance ? "move on" : "wait for Tab"}. For ten and above press d and then a digit, which is added to ten, so d then 2 records 12. r switches between probing depth and recession. b bleeding, s suppuration, f furcation, m mobility; pressing the same key again cycles or clears. Escape leaves the grid.`}
        onKeyDown={canSave ? onKeyDown : undefined}
        className="space-y-3 rounded-xl border border-line bg-card p-3 shadow-sm outline-none focus-visible:border-blue-royal"
      >
        <ArchGrid
          title="Upper"
          arch={PERMANENT_UPPER}
          declared={declared}
          present={present}
          state={state}
          onCell={(tooth, site) => dispatch({ type: "moveTo", index: cellIndex(state, tooth, site) })}
        />
        <ArchGrid
          title="Lower"
          arch={PERMANENT_LOWER}
          declared={declared}
          present={present}
          state={state}
          onCell={(tooth, site) => dispatch({ type: "moveTo", index: cellIndex(state, tooth, site) })}
        />
      </div>

      <KeyLegend autoAdvance={state.autoAdvance} />

      <p className="text-[11.5px] leading-snug text-muted">
        {state.restored ? "Restored from an unsaved chart kept in this browser. " : ""}
        Every keystroke is kept in this browser only. Nothing is on the patient&rsquo;s record until
        you press Record chart, and nothing on this screen is sent to Dentally.
      </p>

      {/* SAVE. Everything that would stop it is printed before it is pressed. */}
      <div className="space-y-2 rounded-xl border border-line bg-card p-3 shadow-sm">
        {amends ? (
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
              Why this chart is being amended (GDC 4.1.5)
            </span>
            <textarea
              className="w-full rounded border border-line bg-card px-2 py-1.5 text-[12px] text-navy"
              rows={2}
              value={amendmentReason}
              onChange={(event) => setAmendmentReason(event.target.value)}
              disabled={!canSave}
            />
            <span className="block text-[11px] text-faint">
              {correcting
                ? `The exam of ${londonDateTimeLabel(correcting.recorded.at)}, recorded by ${correcting.recorded.clinician.name}, stays on the record and is not overwritten. This correction is dated and attributed to you.`
                : "The chart this replaces stays on the record and is not overwritten."}
            </span>
          </label>
        ) : null}

        {liveIssues.length > 0 ? (
          <ul className="space-y-1 text-[11.5px] leading-snug text-status-amber">
            {liveIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}

        {saveIssues.length > 0 ? (
          <ul className="space-y-1 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[11.5px] leading-snug text-status-red">
            {saveIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}

        {saveNotice ? (
          <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[11.5px] leading-snug text-status-amber">
            {saveNotice}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave || saving || !clinician || recordedTeeth.length === 0}
            className="rounded-lg bg-blue-royal px-3.5 py-1.5 text-[12.5px] font-semibold text-on-navy disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving
              ? "Recording…"
              : correcting
                ? "Record correction"
                : amends
                  ? "Record amendment"
                  : "Record chart"}
          </button>
          <span className="text-[11.5px] text-faint">
            {savedId
              ? "Recorded. This chart is now on the patient's record in this platform."
              : state.dirty
                ? "Not yet on the record."
                : "Nothing to record yet."}
          </span>
        </div>
      </div>

      {/* THE LIVE SUMMARY, built by the engine from what has been typed so far.
          It carries its own scope sentence, which while a chart is half-entered
          is the most important sentence on the page. */}
      {preview ? (
        <PerioSummary chart={preview} title="Live preview — not yet on the record" />
      ) : (
        <p className="rounded-lg border border-line bg-card-muted px-3 py-2 text-[12px] leading-snug text-muted">
          {clinician
            ? "No summary yet: a chart needs at least one probing depth before any figure means anything."
            : "No summary is shown, because a periodontal chart with no named clinician is not a record (GDC Standard 4.1.4)."}
        </p>
      )}
    </section>
  );
}

/** Where a tooth-and-site sits in the cursor's flat order. */
function cellIndex(state: EntryState, tooth: number, site: PerioSiteId): number {
  const toothIndex = state.teeth.indexOf(tooth);
  if (toothIndex < 0) return state.cursor;
  return toothIndex * SITE_IDS.length + SITE_IDS.indexOf(site);
}

// ---------------------------------------------------------------------------
// The sextant strip
// ---------------------------------------------------------------------------

function SextantStrip({
  declared,
  recorded,
}: {
  declared: ReadonlySet<SextantId>;
  recorded: readonly SextantId[];
}) {
  const cell = (sextant: SextantId) => {
    const isRecorded = recorded.includes(sextant);
    const isDeclared = declared.has(sextant);
    const skin = isRecorded
      ? "border-tint-green-line bg-tint-green text-status-green"
      : isDeclared
        ? "border-tint-amber-line bg-tint-amber text-status-amber"
        : "border-line bg-card-muted text-faint";
    return (
      <div key={sextant} className={`rounded-md border px-2 py-1.5 ${skin}`}>
        <div className="text-[10px] font-semibold uppercase tracking-[0.05em]">{sextant}</div>
        <div className="text-[10.5px] leading-tight">{SEXTANT_LABEL[sextant]}</div>
        <div className="text-[10px] leading-tight">
          {isRecorded ? "charted" : isDeclared ? "declared, empty" : "not charted"}
        </div>
      </div>
    );
  };
  // Two rows of three, upper then lower, which is how a BPE grid is drawn.
  return (
    <div className="grid grid-cols-3 gap-1.5" aria-label="Sextant coverage">
      {(["UR", "UA", "UL"] as SextantId[]).map(cell)}
      {(["LR", "LA", "LL"] as SextantId[]).map(cell)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The cursor readout
// ---------------------------------------------------------------------------

function CursorBar({
  tooth,
  site,
  field,
  cell,
  entry,
  pendingDouble,
  pendingNegative,
  canEdit,
  onField,
  onFlag,
  onMobility,
  onFurcation,
}: {
  tooth: number | null;
  site: PerioSiteId;
  field: EntryField;
  cell: SiteEntry | null;
  entry: ToothEntry | null;
  pendingDouble: boolean;
  pendingNegative: boolean;
  canEdit: boolean;
  onField: (field: EntryField) => void;
  onFlag: (flag: SiteFlag) => void;
  onMobility: () => void;
  onFurcation: () => void;
}) {
  const cal =
    cell && cell.probingDepth !== null && cell.recession !== null
      ? cell.probingDepth + cell.recession
      : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-band-line bg-band px-4 py-2.5">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">At</div>
        <div className="text-[17px] font-semibold leading-tight text-navy">
          {tooth === null ? "—" : `${tooth} · ${SITE_LABEL[site]}`}
        </div>
      </div>

      <div className="flex gap-1.5">
        {(["depth", "recession"] as EntryField[]).map((option) => (
          <button
            key={option}
            type="button"
            disabled={!canEdit}
            onClick={() => onField(option)}
            className={
              field === option
                ? "rounded-md bg-blue-royal px-2.5 py-1 text-[11.5px] font-semibold text-on-navy"
                : "rounded-md border border-line bg-card px-2.5 py-1 text-[11.5px] text-muted"
            }
          >
            {FIELD_LABEL[option]}
          </button>
        ))}
      </div>

      <div className="flex items-baseline gap-3">
        <Readout label="Depth" value={cell?.probingDepth ?? null} />
        <Readout label="Recession" value={cell?.recession ?? null} />
        {/* COMPUTED. There is no input here and there never may be. */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">
            CAL (computed)
          </div>
          <div className="text-[15px] font-semibold leading-tight tabular-nums text-navy">
            {cal === null ? "—" : `${cal}mm`}
          </div>
        </div>
      </div>

      {/* A PREFIX A CLINICIAN CANNOT SEE IS A PREFIX THEY CANNOT TELL THEY HAVE
          LOST. `d` and `−` record nothing on their own, so what is showing here
          is the difference between a 12 and a 2. */}
      {pendingDouble || pendingNegative ? (
        <span className="rounded-md border border-tint-royal-line bg-tint-royal px-2 py-0.5 text-[11.5px] font-semibold text-status-royal">
          {pendingDouble
            ? "1_ — double figure: the next digit is added to ten (d then 2 records 12)"
            : "−_ — the next digit is negative"}
        </span>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {(["bleeding", "suppuration", "plaque"] as SiteFlag[]).map((flag) => {
          const on = Boolean(cell?.[flag]);
          return (
            <button
              key={flag}
              type="button"
              disabled={!canEdit}
              onClick={() => onFlag(flag)}
              aria-pressed={on}
              className={
                on
                  ? "rounded-md border border-tint-red-line bg-tint-red px-2 py-1 text-[11.5px] font-semibold text-status-red"
                  : "rounded-md border border-line bg-card px-2 py-1 text-[11.5px] text-muted"
              }
            >
              {FLAG_LABEL[flag]} ({FLAG_KEY[flag]})
            </button>
          );
        })}
        <button
          type="button"
          disabled={!canEdit}
          onClick={onMobility}
          className="rounded-md border border-line bg-card px-2 py-1 text-[11.5px] text-muted"
        >
          mobility{" "}
          {entry === null || entry.mobility === null ? "—" : MOBILITY_LABEL[entry.mobility]} (m)
        </button>
        <button
          type="button"
          disabled={!canEdit || tooth === null || displayNumber(tooth) <= 3}
          onClick={onFurcation}
          className="rounded-md border border-line bg-card px-2 py-1 text-[11.5px] text-muted disabled:opacity-50"
        >
          furcation{" "}
          {entry === null || entry.furcation === null ? "—" : FURCATION_LABEL[entry.furcation]} (f)
        </button>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">{label}</div>
      <div className="text-[15px] font-semibold leading-tight tabular-nums text-navy">
        {value === null ? "—" : `${value}mm`}
      </div>
    </div>
  );
}

function KeyLegend({ autoAdvance }: { autoAdvance: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-card-muted px-3 py-2 text-[11px] leading-snug text-muted">
      <span>
        <strong className="text-navy">0–9</strong>{" "}
        {autoAdvance
          ? "record and move on"
          : "record here and wait for Tab; another digit replaces it"}
      </span>
      {/* DENTALLY'S OWN KEY, and the reason it is first among the letters: a
          hygienist arrives with it already in their fingers. */}
      <span>
        <strong className="text-navy">d</strong> then a digit — a double figure, added to ten (d 2
        records 12)
      </span>
      <span>
        <strong className="text-navy">Tab / → ←</strong> next and previous site
      </span>
      <span>
        <strong className="text-navy">↓ ↑</strong> buccal row to lingual row
      </span>
      <span>
        <strong className="text-navy">r</strong> switch between depth and recession
      </span>
      <span>
        <strong className="text-navy">b s p</strong> bleeding, suppuration, plaque — again to clear
      </span>
      <span>
        <strong className="text-navy">m f</strong> mobility, furcation — again to cycle, past the end
        to clear
      </span>
      <span>
        <strong className="text-navy">−</strong> negative recession
      </span>
      <span>
        <strong className="text-navy">Backspace</strong> clear the site
      </span>
      <span>
        <strong className="text-navy">Esc</strong> leave the grid, then Tab to reach the buttons
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dentally's three entry settings
// ---------------------------------------------------------------------------

function EntrySettings({
  prefs,
  canEdit,
  onChange,
}: {
  prefs: ChartEntryPrefs;
  canEdit: boolean;
  onChange: (patch: Partial<ChartEntryPrefs>) => void;
}) {
  const select = "rounded border border-line bg-card px-1.5 py-1 text-[11.5px] text-navy";
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card-muted px-3 py-2 text-[11.5px] text-muted"
      aria-label="Charting settings"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-faint">
        How you chart
      </span>
      <label className="flex items-center gap-1.5">
        Start with
        <select
          className={select}
          value={prefs.startArch}
          disabled={!canEdit}
          onChange={(event) => onChange({ startArch: event.target.value as ChartEntryPrefs["startArch"] })}
        >
          {ENTRY_ARCHES.map((arch) => (
            <option key={arch} value={arch}>
              {ENTRY_ARCH_LABEL[arch]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Direction
        <select
          className={select}
          value={prefs.direction}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({ direction: event.target.value as ChartEntryPrefs["direction"] })
          }
        >
          {ENTRY_DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {ENTRY_DIRECTION_LABEL[direction]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        After a reading
        <select
          className={select}
          value={prefs.advance}
          disabled={!canEdit}
          onChange={(event) => onChange({ advance: event.target.value as ChartEntryPrefs["advance"] })}
        >
          {ENTRY_ADVANCES.map((advance) => (
            <option key={advance} value={advance}>
              {ENTRY_ADVANCE_LABEL[advance]}
            </option>
          ))}
        </select>
      </label>
      {/* The columns do NOT move. Said out loud, because a clinician who changes
          the direction and sees the grid unchanged would otherwise assume the
          setting did nothing. */}
      <span className="text-[11px] text-faint">
        Kept for you, not for this patient. The grid is always drawn in anatomical order; only the
        cursor&rsquo;s route through it changes.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The exams already on the record: the 24-hour correction, and the clone
// ---------------------------------------------------------------------------

function ExamHistoryBar({
  exams,
  standing,
  correctionOpen,
  correctionHoursLeft,
  failed,
  read,
  busy,
  canEdit,
  carriedFrom,
  correcting,
  onClone,
  onCorrect,
}: {
  exams: readonly ExamHeader[];
  standing: ExamHeader | null;
  correctionOpen: boolean;
  correctionHoursLeft: number | null;
  failed: boolean;
  read: boolean;
  busy: boolean;
  canEdit: boolean;
  carriedFrom: ExamHeader | null;
  correcting: ExamHeader | null;
  onClone: (exam: ExamHeader) => void;
  onCorrect: (exam: ExamHeader) => void;
}) {
  // A READ THAT FAILED IS NOT AN ABSENCE OF EXAMS. Saying "no previous chart" on
  // a request that never came back is a claim about the patient made out of a
  // network error, and it is the exact failure CHARTING.md §6.3 is written about.
  if (failed) {
    return (
      <p className="rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[12px] leading-snug text-status-red">
        The periodontal charts already on this record could not be read, so neither the correction
        window nor cloning a previous exam is offered here. This is not a statement that there are
        none — check before you assume this is a first chart.
      </p>
    );
  }
  if (!read || exams.length === 0) return null;

  return (
    <div className="space-y-2 rounded-lg border border-line bg-card px-3 py-2.5 text-[12px] leading-snug text-muted">
      {standing ? (
        <p>
          Standing chart recorded{" "}
          <span className="font-medium text-navy">{londonDateTimeLabel(standing.recorded.at)}</span>{" "}
          by <span className="font-medium text-navy">{standing.recorded.clinician.name}</span>
          {standing.supersedesId ? (
            // GDC 4.1.5, on screen: an amendment is visible and dated, and the
            // chart it replaced is still there.
            <>
              {" "}
              — <span className="font-medium text-status-amber">this is an amendment</span> of an
              earlier chart, which stays on the record
              {standing.amendmentReason ? `: ${standing.amendmentReason}` : "."}
            </>
          ) : (
            "."
          )}
        </p>
      ) : null}

      {standing && correctionOpen ? (
        <p className="text-[11.5px] text-faint">
          Dentally lets an exam be edited for {CORRECTION_WINDOW_HOURS} hours; about{" "}
          {correctionHoursLeft} left. Here a correction is recorded as a dated, attributed amendment
          and the original stays readable — the record keeps its whole history.
        </p>
      ) : standing ? (
        <p className="text-[11.5px] text-faint">
          The {CORRECTION_WINDOW_HOURS}-hour window Dentally would allow has passed. A change is
          still recorded, as a dated amendment — an error spotted late is not an error to leave.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {standing ? (
          <button
            type="button"
            disabled={!canEdit || busy || correcting?.id === standing.id}
            onClick={() => onCorrect(standing)}
            className="rounded-md border border-line bg-card px-2.5 py-1 text-[11.5px] font-semibold text-navy disabled:cursor-not-allowed disabled:opacity-50"
          >
            {correcting?.id === standing.id
              ? "Correcting this exam"
              : correctionOpen
                ? "Correct this exam"
                : "Amend this exam"}
          </button>
        ) : null}
        {exams.map((exam) => (
          <button
            key={exam.id}
            type="button"
            disabled={!canEdit || busy || carriedFrom?.id === exam.id}
            onClick={() => onClone(exam)}
            className="rounded-md border border-line bg-card px-2.5 py-1 text-[11.5px] text-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {carriedFrom?.id === exam.id ? "Carried in from " : "Clone "}
            {londonDateTimeLabel(exam.recorded.at)}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-faint">
        Cloning starts a NEW exam dated today and attributed to you; it never edits the one it came
        from. Every figure it carries in arrives marked as not measured today.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One arch
// ---------------------------------------------------------------------------

function ArchGrid({
  title,
  arch,
  declared,
  present,
  state,
  onCell,
}: {
  title: string;
  arch: readonly number[];
  declared: ReadonlySet<SextantId>;
  present: ReadonlySet<number>;
  state: EntryState;
  onCell: (tooth: number, site: PerioSiteId) => void;
}) {
  const template = templateFor(arch.length);
  const activeTooth = cursorTooth(state);
  const activeSite = cursorSite(state);

  const statuses = arch.map((tooth) => columnStatus(tooth, declared, present));

  /** One row of six-site cells for one half of the tooth. */
  const siteRow = (
    key: string,
    label: string,
    sites: readonly PerioSiteId[],
    render: (tooth: number, site: PerioSiteId) => ReactNode,
    quiet = false,
  ) => (
    <div key={key} className="contents">
      <RowLabel tone={quiet ? "quiet" : "plain"}>{label}</RowLabel>
      {arch.map((tooth, index) => {
        const status = statuses[index];
        if (status !== "chartable") {
          return <BlockedSpan key={tooth} status={status} />;
        }
        // A keyed Fragment, not a bare nested array: the three sub-columns of one
        // tooth are one list entry, and React needs to be told so.
        return (
          <Fragment key={tooth}>
            {sites.map((site) => (
              <div key={`${tooth}-${site}`}>{render(tooth, site)}</div>
            ))}
          </Fragment>
        );
      })}
    </div>
  );

  const valueCell = (tooth: number, site: PerioSiteId, field: EntryField) => {
    const cell = state.values[tooth]?.sites[site];
    const value = field === "depth" ? cell?.probingDepth ?? null : cell?.recession ?? null;
    const isActive = tooth === activeTooth && site === activeSite && state.field === field;
    // The double-figure prefix, drawn in the cell it is about: "1_" is a number
    // half typed, and it is visibly not a 1.
    const pending = isActive && state.pendingDouble ? "1_" : null;
    const deep = field === "depth" && value !== null && value >= 4;
    const veryDeep = field === "depth" && value !== null && value >= 6;
    // CARRIED FORWARD, NOT MEASURED TODAY. Drawn quietly, in italic, on the
    // dimmer ground, and SAID in the accessible name — a colour difference alone
    // is not a statement that a reading was not taken.
    const carried = Boolean(cell?.carried) && value !== null;
    return (
      <button
        type="button"
        onClick={() => onCell(tooth, site)}
        tabIndex={-1}
        aria-label={`Tooth ${tooth}, ${SITE_LABEL[site]}, ${FIELD_LABEL[field]}${
          value === null
            ? ", not recorded"
            : carried
              ? `, ${value} millimetres carried forward from an earlier exam, not measured today`
              : `, ${value} millimetres`
        }`}
        className={[
          "flex h-6 w-full items-center justify-center border-b border-l text-[11.5px] tabular-nums",
          isActive
            ? "border-blue-royal bg-blue-royal font-semibold text-on-navy"
            : carried
              ? "border-line bg-card-muted italic text-faint"
              : veryDeep
                ? "border-line bg-tint-red font-semibold text-status-red"
                : deep
                  ? "border-line bg-tint-amber font-semibold text-status-amber"
                  : "border-line bg-card text-ink",
        ].join(" ")}
      >
        {pending ?? (value === null ? "" : value)}
      </button>
    );
  };

  const calCell = (tooth: number, site: PerioSiteId) => {
    const cell = state.values[tooth]?.sites[site];
    // COMPUTED, NEVER TYPED. Null when either component is missing, because a
    // CAL derived from a guessed zero is a fabricated measurement.
    const cal =
      cell && cell.probingDepth !== null && cell.recession !== null
        ? cell.probingDepth + cell.recession
        : null;
    return (
      <div className="flex h-5 w-full items-center justify-center border-b border-l border-line bg-card-muted text-[10.5px] tabular-nums text-muted">
        {cal === null ? "" : cal}
      </div>
    );
  };

  const flagCell = (tooth: number, site: PerioSiteId) => {
    const cell = state.values[tooth]?.sites[site];
    // The `c` is the carried mark, in the row where there is room for a letter.
    // The depth cell above it carries the same fact in its accessible name.
    return (
      <div
        className={
          cell?.carried
            ? "flex h-4 w-full items-center justify-center gap-0.5 border-b border-l border-line bg-card-muted"
            : "flex h-4 w-full items-center justify-center gap-0.5 border-b border-l border-line bg-card"
        }
        title={cell?.carried ? "carried forward from an earlier exam, not measured today" : undefined}
      >
        <Dot on={Boolean(cell?.bleeding)} tone="red" title="bleeding on probing" />
        <Dot on={Boolean(cell?.suppuration)} tone="amber" title="suppuration" />
        <Dot on={Boolean(cell?.plaque)} tone="blue" title="plaque" />
        {cell?.carried ? (
          <span aria-hidden className="text-[8px] italic leading-none text-faint">
            c
          </span>
        ) : null}
      </div>
    );
  };

  const buccal: readonly PerioSiteId[] = SITE_IDS.slice(0, 3);
  const lingual: readonly PerioSiteId[] = SITE_IDS.slice(3, 6);

  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
        {title} arch
      </h4>
      <div className="overflow-x-auto">
        <div className="grid min-w-max" style={{ gridTemplateColumns: template }}>
          {/* Tooth numbers, and what each column is. */}
          <RowLabel>Tooth</RowLabel>
          {arch.map((tooth, index) => {
            const status = statuses[index];
            return (
              <div
                key={tooth}
                style={{ gridColumn: "span 3" }}
                className={
                  status === "chartable"
                    ? "border-b border-l border-line bg-card px-0.5 py-0.5 text-center text-[11.5px] font-semibold tabular-nums text-navy"
                    : "border-b border-l border-line bg-card-muted px-0.5 py-0.5 text-center text-[11.5px] tabular-nums text-faint line-through"
                }
                title={
                  status === "chartable"
                    ? `Tooth ${tooth}`
                    : status === "not-present"
                      ? `Tooth ${tooth} is not in the mouth`
                      : `Tooth ${tooth} is not in a sextant this chart covers`
                }
              >
                {tooth}
                {status !== "chartable" ? (
                  <span className="block text-[8.5px] uppercase leading-none tracking-[0.04em] no-underline">
                    {status === "not-present" ? "absent" : "not charted"}
                  </span>
                ) : null}
              </div>
            );
          })}

          {/* Site ids, so the reader never has to remember which of the three
              columns is mesial. Printed once above each row-block, because the
              buccal block and the lingual block occupy the SAME three columns
              with different sites in them — a single header would be a lie for
              half the grid. SITE_IDS order, which is also the cursor's order. */}
          {siteRow("b-sites", "Site", buccal, siteHeaderCell, true)}

          {siteRow("b-pd", "Buccal depth", buccal, (t, s) => valueCell(t, s, "depth"))}
          {siteRow("b-rec", "Buccal recession", buccal, (t, s) => valueCell(t, s, "recession"), true)}
          {siteRow("b-cal", "Buccal CAL", buccal, calCell, true)}
          {siteRow("b-flag", "Buccal findings", buccal, flagCell, true)}

          {/* Tooth-level findings sit between the two rows, where the tooth is.
              M and F are the abbreviations; the numbers are the ENGINE's scale,
              printed as they come, so a fourth furcation grade shows up here the
              day the engine allows one without this row being found and edited.
              The words behind them are in the title. */}
          <RowLabel>Mobility / furcation</RowLabel>
          {arch.map((tooth, index) => {
            const status = statuses[index];
            if (status !== "chartable") return <BlockedSpan key={tooth} status={status} />;
            const entry = state.values[tooth];
            return (
              <div
                key={`${tooth}-mf`}
                style={{ gridColumn: "span 3" }}
                className={
                  tooth === activeTooth
                    ? "border-b border-l border-blue-royal bg-tint-royal text-center text-[10px] leading-5 text-status-royal"
                    : entry?.carriedFindings
                      ? "border-b border-l border-line bg-card-muted text-center text-[10px] italic leading-5 text-faint"
                      : "border-b border-l border-line bg-card text-center text-[10px] leading-5 text-muted"
                }
                title={
                  entry?.carriedFindings
                    ? `Tooth ${tooth}: mobility and furcation carried forward from an earlier exam, not assessed today`
                    : `Tooth ${tooth}: mobility ${entry?.mobility === null || entry === undefined ? "not recorded" : MOBILITY_LABEL[entry.mobility]}, furcation ${entry?.furcation === null || entry === undefined ? "not recorded" : FURCATION_LABEL[entry.furcation]}`
                }
              >
                {entry?.mobility === null || entry === undefined ? "·" : `M${entry.mobility}`}
                {" / "}
                {entry?.furcation === null || entry === undefined ? "·" : `F${entry.furcation}`}
                {entry?.carriedFindings ? <span aria-hidden> ·c</span> : null}
              </div>
            );
          })}

          {siteRow("l-sites", "Site", lingual, siteHeaderCell, true)}
          {siteRow("l-pd", "Lingual depth", lingual, (t, s) => valueCell(t, s, "depth"))}
          {siteRow("l-rec", "Lingual recession", lingual, (t, s) => valueCell(t, s, "recession"), true)}
          {siteRow("l-cal", "Lingual CAL", lingual, calCell, true)}
          {siteRow("l-flag", "Lingual findings", lingual, flagCell, true)}
        </div>
      </div>
    </div>
  );
}

/** The abbreviation that names a column. Its own function so the buccal and the
 *  lingual header rows cannot drift apart. */
function siteHeaderCell(_tooth: number, site: PerioSiteId): ReactNode {
  return (
    <div
      className="flex h-4 w-full items-center justify-center border-b border-l border-line bg-card text-[8.5px] uppercase tracking-[0.04em] text-faint"
      title={SITE_LABEL[site]}
    >
      {site}
    </div>
  );
}

function Dot({ on, tone, title }: { on: boolean; tone: "red" | "amber" | "blue"; title: string }) {
  const skin = on
    ? tone === "red"
      ? "bg-danger"
      : tone === "amber"
        ? "bg-warning"
        : "bg-blue-dark"
    : "bg-line-strong";
  return <span title={title} aria-hidden className={`h-1.5 w-1.5 rounded-full ${skin}`} />;
}

// ---------------------------------------------------------------------------
// Read-only rendering of a stored chart
// ---------------------------------------------------------------------------

/**
 * A chart that is on the record, drawn in the same grid, with no inputs.
 *
 * This is what the tab shows when the gate is off, and what history shows for an
 * older chart. It reuses the entry grid deliberately: a clinician comparing what
 * they typed with what was stored should be looking at the same shape, and a
 * second read-only renderer is a second chance for the two to disagree.
 */
export function PocketChartReadOnly({
  chart,
  presentTeeth,
  fp17Notice,
  title,
}: {
  chart: PocketChartView;
  presentTeeth?: readonly number[];
  fp17Notice?: string | null;
  title?: string;
}) {
  const declared = useMemo(() => new Set(chart.declaredSextants), [chart.declaredSextants]);
  const present = useMemo(() => {
    if (presentTeeth) return new Set(presentTeeth);
    return new Set(chart.teeth.map((t) => t.tooth));
  }, [presentTeeth, chart.teeth]);

  const teeth = useMemo(
    () => ARCH_ORDER.filter((tooth) => columnStatus(tooth, declared, present) === "chartable"),
    [declared, present],
  );

  const state = useMemo((): EntryState => {
    const values = blankValues(teeth);
    for (const tooth of chart.teeth) {
      const entry = values[tooth.tooth];
      if (!entry) continue;
      entry.mobility = tooth.mobility;
      entry.furcation = tooth.furcation;
      for (const site of tooth.sites) {
        entry.sites[site.site] = {
          probingDepth: site.probingDepth,
          recession: site.recession,
          bleeding: site.bleeding,
          suppuration: site.suppuration,
          plaque: site.plaque,
          // A STORED CHART HOLDS NO CARRIED READINGS, by construction: nothing
          // carried is ever written, so nothing read back can be.
          carried: false,
        };
      }
    }
    return {
      teeth,
      values,
      // The cursor is parked off the first cell rather than highlighting one: a
      // highlighted cell on a read-only chart reads as an editable one.
      cursor: -1,
      field: "depth",
      pendingDouble: false,
      pendingNegative: false,
      message: null,
      nonce: 0,
      dirty: false,
      restored: false,
      // Nothing here is typed into, so the setting has nothing to govern.
      autoAdvance: true,
    };
  }, [teeth, chart.teeth]);

  return (
    <section className="space-y-3" aria-label={title ?? "Six-point chart"}>
      <div className="space-y-3 rounded-xl border border-line bg-card p-3 shadow-sm">
        <ArchGrid
          title="Upper"
          arch={PERMANENT_UPPER}
          declared={declared}
          present={present}
          state={state}
          onCell={() => undefined}
        />
        <ArchGrid
          title="Lower"
          arch={PERMANENT_LOWER}
          declared={declared}
          present={present}
          state={state}
          onCell={() => undefined}
        />
      </div>
      <PerioSummary chart={chart} title={title} fp17Notice={fp17Notice} />
    </section>
  );
}

/** Re-exported so a caller can turn a stored chart into the view these
 *  components take without importing the engine a second time — and so the
 *  refusal type is catchable at the same import. */
export { buildPocketChart, PerioValidationError };
