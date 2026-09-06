import type { InterestTreatmentKey } from "./types";

// ===========================================================================
// THE INTEREST LIST AS A FILE — ONE FORMATTER, ONE DOOR (ruling W3/29).
//
// This module used to be four exported functions inside
// src/components/client/previsit/previsit-workspace.tsx, building a CSV in the
// browser out of the rows the page had already rendered, WHILE the guarded
// server route built a different CSV out of its own read. Two formats over one
// list: different columns, different provenance rows, different completeness
// sentences, and no way for a practice to know which file it had. W3/29 settles
// it — one export, the server route, and the on-screen controls call it — so the
// formatting lives here, next to the repository read that feeds it, and the
// client keeps nothing.
//
// PURE, and deliberately server-neutral: no `server-only` marker, no I/O, no
// React. The route imports it; so may a test. Nothing here reads a session or a
// site, because a formatter that resolved its own scope would be a second place
// for the scope to be wrong.
//
// ---------------------------------------------------------------------------
// WHY THE ROW STAMP IS AN ISO INSTANT AND NOT "3 Sep 2026".
// ---------------------------------------------------------------------------
// A campaign list gets sorted, filtered and split by date in a spreadsheet, and
// "3 Sep 2026" sorts alphabetically — September before March. The exported file
// is worked, not read like prose, so the column keeps the instant it happened at.
// The provenance row at the top is the sentence a human reads.
// ===========================================================================

/** One person on the list, in the words the file prints. */
export interface InterestExportRow {
  patientName: string;
  dentallyPatientId: string;
  siteName: string;
  treatmentLabel: string;
  /** ISO 8601, exactly as stored. See the header. */
  createdAt: string;
}

/**
 * RFC4180 quoting, plus the spreadsheet guard.
 *
 * The quoting is the house style from src/lib/charting/export-csv.ts: quote when
 * the value holds a comma, a quote or a line break, and double any quote inside.
 *
 * THE GUARD IS THE HALF THAT IS NOT FUSSINESS. A cell beginning `=`, `+`, `-`,
 * `@` or a control character is a FORMULA to Excel, Numbers and Sheets, and every
 * value in this file is text somebody else typed — the patient name comes off the
 * Dentally record, which is data and never instructions (charter §0/8). A leading
 * apostrophe is the standard mitigation: the spreadsheet shows the text and runs
 * nothing, and only a cell that would otherwise execute is touched, so an ordinary
 * name is untouched.
 */
export function interestCsvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const INTEREST_EXPORT_COLUMNS = [
  "Patient name",
  "Dentally patient ID",
  "Site",
  "Treatment",
  "Said yes on",
] as const;

/**
 * A count in the words a practice may act on: "142", or "at least 20,000".
 *
 * The whole of charter §0/5 in one function. A capped read is a FLOOR, and a
 * floor printed as a figure is the number somebody sizes a campaign on.
 */
export function interestPeopleLabel(people: number, capped: boolean): string {
  const figure = people.toLocaleString("en-GB");
  return capped ? `at least ${figure}` : figure;
}

/**
 * ONE ROW PER PERSON PER TREATMENT, keeping their most recent yes.
 *
 * A patient who filled the form in before two appointments and said yes to
 * whitening both times is ONE person to ring, and a file with them in twice is a
 * file somebody works twice. The list arrives newest first, so the row kept is
 * their most recent yes — the one worth quoting back to them.
 *
 * The key cannot collide: treatment keys come from the closed INTEREST_TREATMENTS
 * set and a Dentally patient id is a number, so "|" occurs in neither half.
 */
export function interestAudience(rows: InterestExportRow[]): InterestExportRow[] {
  const seen = new Set<string>();
  const out: InterestExportRow[] = [];
  for (const r of rows) {
    const key = `${r.treatmentLabel}|${r.dentallyPatientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * The file itself: a stamp row, a column header, and one row per person.
 *
 * IT STATES WHAT IT IS BEFORE IT STATES WHO IS IN IT. A spreadsheet of patient
 * names outlives the screen it came off, so the first row carries what the list
 * is, which sites it covers, when it was taken and — in words, never as a bare
 * figure — how many people are in it and whether that is the whole of them.
 *
 * AN EMPTY LIST STILL PRODUCES BOTH HEADER ROWS. An empty file is
 * indistinguishable from a failed export.
 *
 * A UTF-8 BOM and CRLF endings, for the same reason src/lib/charting/
 * export-csv.ts uses them: Excel mangles an accented name without them.
 */
export function interestCsvDocument(input: {
  /** "Whitening", or "All treatments". */
  listLabel: string;
  /** The site switcher's own words for the scope this was read under. */
  scopeLabel: string;
  exportedAt: Date;
  rows: InterestExportRow[];
  /** True when the read stopped at its ceiling: these are the most recent N. */
  capped: boolean;
}): string {
  const people = interestPeopleLabel(input.rows.length, input.capped);
  const header = [
    interestCsvCell("Interest list"),
    interestCsvCell(input.listLabel),
    interestCsvCell("Sites"),
    interestCsvCell(input.scopeLabel),
    interestCsvCell("Exported"),
    interestCsvCell(input.exportedAt.toISOString()),
    interestCsvCell("People"),
    interestCsvCell(people),
    interestCsvCell(
      input.capped
        ? "This file holds the most recent people who said yes and there are more behind them."
        : "This is the whole list.",
    ),
  ].join(",");

  const lines = input.rows.map((r) =>
    [
      interestCsvCell(r.patientName),
      interestCsvCell(r.dentallyPatientId),
      interestCsvCell(r.siteName),
      interestCsvCell(r.treatmentLabel),
      interestCsvCell(r.createdAt),
    ].join(","),
  );

  return `﻿${[header, INTEREST_EXPORT_COLUMNS.map((c) => interestCsvCell(c)).join(","), ...lines].join("\r\n")}\r\n`;
}

/**
 * ONE CELL OF THE CLIPBOARD FORM, and it exists for the same reason
 * `interestCsvCell` does: every value here is text somebody else typed, and the
 * patient name comes off the Dentally record, which is data and never
 * instructions (charter §0/8).
 *
 * IT GUARDS THE STRUCTURE FIRST, WHICH THE CSV CELL DID NOT HAVE TO. A CSV cell
 * holding a newline is legal — RFC4180 quoting carries it, and
 * `interestCsvCell` does exactly that. A tab-separated, unquoted, one-line-per-
 * person paste has no such escape: a name with an embedded newline in it (a
 * paste accident at registration is the ordinary cause, and this platform never
 * edits the field) SPLITS INTO A SECOND ROW whose first column is the tail of
 * somebody's name rather than a Dentally id, and a tab in the name adds a third
 * column. The paste then holds more rows than the count printed beside the
 * button, which is `interestPeopleLabel(people.length)` — two numbers for one
 * list, and the one the practice uploads is the wrong one. So every separator
 * becomes a space: one person, one line, two columns, always.
 *
 * AND THEN THE SPREADSHEET GUARD, identically to `interestCsvCell`, because the
 * function's own header names a spreadsheet as a paste target. A leading `=`,
 * `+`, `-` or `@` is a formula to Excel, Numbers and Sheets; the apostrophe
 * makes it text and touches nothing that would not otherwise execute.
 */
export function interestAudienceCell(value: string): string {
  // Every C0 control, DEL, every C1 control, and the two Unicode line breaks a
  // paste can carry, collapsed to a single space. Written as escapes so this
  // file holds no control characters of its own (a source-hygiene rule this
  // programme has already been bitten by).
  const flat = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

/**
 * The clipboard form: Dentally id and name, tab separated, one per line.
 *
 * TWO COLUMNS AND NO HEADER, because this is the thing that gets pasted into
 * somebody else's tool — a spreadsheet, an ad platform's audience box, a message
 * to the coordinator. The Dentally id leads because it is the half that is
 * unique; the name is there so a person can see whose list this is.
 *
 * NO PROVENANCE ROW, deliberately: a pasted audience is a column of ids, and a
 * sentence at the top of it becomes a row in somebody's campaign. The count and
 * its "at least" travel beside the paste, on the screen, in the same words this
 * module's `interestPeopleLabel` gives the file.
 *
 * BOTH COLUMNS GO THROUGH `interestAudienceCell`. The id is a number today and
 * the guard is free; a formatter that trusted one of its two inputs would be a
 * formatter somebody has to re-check the day that stops being true.
 */
export function interestAudienceText(rows: InterestExportRow[]): string {
  return rows
    .map((r) => `${interestAudienceCell(r.dentallyPatientId)}\t${interestAudienceCell(r.patientName)}`)
    .join("\n");
}

/** Safe on every filesystem, and stamped so two exports are distinguishable. */
export function interestExportFilename(
  treatment: InterestTreatmentKey | string | null,
  at: Date,
  extension: "csv" | "txt" = "csv",
): string {
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  const safe = String(treatment ?? "all").replace(/[^a-zA-Z0-9._-]/g, "-");
  return `interest-${safe}-${stamp}.${extension}`;
}
