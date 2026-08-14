import type { MonthReport, StaffMonthRow } from "./types";

// ===========================================================================
// THE MONTH, AS A CSV A BOOKKEEPER CAN OPEN.
//
// Follows the one CSV precedent in this codebase, src/lib/charting/export-csv.ts,
// line for line rather than inventing a second pattern:
//   * a UTF-8 BOM, so Excel opens it in the right encoding instead of mangling
//     an accented name;
//   * RFC4180 quoting (a value holding a comma, a quote or a newline is quoted,
//     and inner quotes are doubled);
//   * CRLF line endings, which is what Excel expects;
//   * an as-of stamp in the header block, because an exported payroll figure
//     with no date claims the present tense forever.
//
// ONE ADDITION TO THE PRECEDENT, AND IT IS DELIBERATE: a Status line. A month
// with a missed clock-out in it is PROVISIONAL, and the moment these figures
// leave the platform as a file nothing else carries that fact. A bookkeeper
// paying from a spreadsheet cannot be expected to remember a banner they saw on
// a screen.
//
// Money is written as a plain decimal ("12.50") with the unit in the column
// header, not as "£12.50": a spreadsheet sums the first and refuses the second.
// The digits come from integer pence, never from a float.
//
// PURE. The download itself is client side (a Blob and an anchor), exactly as
// chart-history.tsx does it; there is no server CSV route in this codebase.
// ===========================================================================

const HOURS_COLUMNS = ["Name", "Role", "Site", "Days worked", "Sessions", "Hours", "Minutes", "Needs a decision"] as const;
const COST_COLUMNS = ["Rate per hour (£)", "Cost (£)"] as const;

/** RFC4180: quote when the value holds a comma, a quote or a line break. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Whole minutes as decimal hours ("8.00", "7.75"), by integer arithmetic.
 *
 * `minutes / 60` then `toFixed(2)` is the obvious form and it rounds a float; a
 * column of those does not always add up to the total printed beneath it.
 */
export function decimalHours(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0.00";
  const hundredths = Math.round((minutes * 100) / 60);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Integer pence as a plain decimal ("12.50"). Empty string for "not known". */
export function penceCell(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  const abs = Math.abs(Math.round(pence));
  const sign = pence < 0 ? "-" : "";
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * One line saying whether these figures may be paid from.
 *
 * Written from the report's own blockers, so the file and the screen cannot
 * disagree about whether the month is settled.
 */
export function statusLine(report: MonthReport): string {
  if (!report.ready) return "Could not be read: clocking is not switched on for this practice.";
  if (report.finalisable) return "Complete: nothing outstanding at the time of export.";
  return `Provisional. ${report.blockers.join(" ")}`;
}

/**
 * The month as CSV.
 *
 * Takes the whole report rather than a bare row list, because three of the
 * things a reader needs (the month, whether cost is included at all, and whether
 * the figures are settled) live on the report and must not be re-derived here
 * where they could drift from the screen.
 *
 * COST COLUMNS ARE OMITTED ENTIRELY when the caller had no pay access: the rows
 * they were built from never carried the fields, so there is nothing to leave
 * blank. An export by a practice manager simply has eight columns.
 *
 * An EMPTY month still produces the header block and the column row: an empty
 * file is indistinguishable from a failed export.
 */
export function toHoursCsv(report: MonthReport, fetchedAt = ""): string {
  const columns: string[] = [...HOURS_COLUMNS, ...(report.includesCost ? COST_COLUMNS : [])];

  const rows: string[] = [
    [cell("Hours for the month"), cell(report.month)].join(","),
    [cell("Read as of"), cell(fetchedAt)].join(","),
    [cell("Status"), cell(statusLine(report))].join(","),
    [cell("Payroll boundary"), cell("Hours and cost only. Not payroll: nothing here is submitted to HMRC.")].join(","),
    columns.map(cell).join(","),
  ];

  for (const row of report.rows) {
    rows.push(line(row, report.includesCost));
  }

  return `﻿${rows.join("\r\n")}\r\n`;
}

function line(row: StaffMonthRow, includesCost: boolean): string {
  const cells = [
    cell(row.name),
    cell(row.role),
    cell(row.siteId ?? "Any site"),
    cell(String(row.daysWorked)),
    cell(String(row.sessions)),
    cell(decimalHours(row.closedMinutes)),
    cell(String(row.closedMinutes)),
    cell(String(row.openOrUnresolvedCount)),
  ];
  if (includesCost) {
    cells.push(cell(penceCell(row.ratePence)), cell(penceCell(row.costPence)));
  }
  return cells.join(",");
}

/**
 * Safe on every filesystem, and carries the read time so two exports of the same
 * month are distinguishable.
 *
 * The dot is NOT in the allowed set (the charting precedent allows it): a client
 * slug of "../../etc" would otherwise survive as "..-..-etc", which has no path
 * separators left but is still the traversal shape, and a download filename is
 * handed straight to a save dialog.
 */
export function hoursExportFilename(clientSlug: string, month: string, fetchedAt: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-");
  const safeClient = safe(clientSlug);
  const safeMonth = safe(month);
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return `hours-${safeClient}-${safeMonth}.csv`;
  const iso = new Date(t).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `hours-${safeClient}-${safeMonth}-${stamp}.csv`;
}
