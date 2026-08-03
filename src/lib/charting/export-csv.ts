// ===========================================================================
// HISTORY EXPORT.
//
// PURE, and entirely ours: DENTALLY.md:110 lists History as exportable, every
// row is already client-side, and a CSV touches no Dentally endpoint, no table
// and no migration. It was the one History capability we could build outright.
//
// TWO DETAILS THAT ARE NOT FUSSINESS:
//   - A UTF-8 BOM, so Excel opens the file in the right encoding rather than
//     mangling an accented treatment name.
//   - The as-of stamp as the FIRST row. An exported chart printed into a
//     complaint file with no date is a chart that claims the present tense
//     forever.
// ===========================================================================

import type { HistoryLine } from "./history";

const COLUMNS = [
  "Tooth",
  "FDI",
  "Teeth as sent",
  "Surfaces",
  // ITS OWN COLUMN, and not merged into "Surfaces". That column holds a letter
  // code (MOD); this holds Dentally's own surface NUMBERS, which is the only form
  // live data ever sends. Merging them would put two vocabularies in one cell and
  // invite a reader to take a 3 for a surface name we have never confirmed.
  "Surface numbers",
  "Unrecognised surfaces",
  "Whole tooth",
  "Base chart",
  "Treatment",
  "Price",
  "Completed",
  "Plan",
  "Plan status",
  "Date",
] as const;

/** RFC4180: quote when the value holds a comma, a quote or a line break, and
 *  double any quote inside. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * The lines currently shown, as CSV.
 *
 * An EMPTY history still produces both header rows rather than an empty file:
 * an empty file is indistinguishable from a failed export, and a chart export
 * with no header could be read as a chart with no findings.
 */
export function toCsv(lines: readonly HistoryLine[], fetchedAt = ""): string {
  const rows: string[] = [
    [cell("Chart read from Dentally as of"), cell(fetchedAt)].join(","),
    COLUMNS.map((c) => cell(c)).join(","),
  ];
  for (const line of lines) {
    rows.push(
      [
        cell(line.toothLabel),
        // fdiLabel, NOT fdi. historyLines builds every line with fdi === null
        // (a line is about an ITEM, which may name several teeth), so reading
        // `fdi` left the FDI column empty on every exported row: the one column
        // that exists so an export can be reconciled against Dentally, blank.
        cell(line.fdiLabel),
        cell(line.rawTeeth),
        cell(line.surfaces),
        cell(line.surfaceIndices.join(" ")),
        cell(line.unrecognisedSurfaces.join(" ")),
        cell(yesNo(line.wholeTooth)),
        cell(yesNo(line.baseChart)),
        cell(line.nomenclature ?? ""),
        cell(line.price.toFixed(2)),
        cell(yesNo(line.completed)),
        cell(line.planLabel ?? ""),
        cell(line.planStatus ?? ""),
        cell(line.date ?? ""),
      ].join(","),
    );
  }
  // \r\n throughout, which is what Excel expects, and the BOM ahead of it.
  return `﻿${rows.join("\r\n")}\r\n`;
}

/** Safe on every filesystem, and carries the read time so two exports of the
 *  same patient are distinguishable. */
export function exportFilename(patientId: string, fetchedAt: string): string {
  const safeId = patientId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return `chart-${safeId}.csv`;
  const iso = new Date(t).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `chart-${safeId}-${stamp}.csv`;
}
