// ===========================================================================
// THE CSV IMPORT: THE PRACTICE'S OWN SPREADSHEET, NOT OURS.
//
// Every practice that has an equipment register already has it in a spreadsheet,
// and it was not written for us. The columns are called what the practice manager
// called them, the dates are UK dates typed by hand, the sites are "N15" and
// "Romford" rather than site ids, and there are blank rows where somebody left a
// gap. An importer that demands our column names is an importer nobody uses, and
// a practice that has to re-key 60 assets is a practice that never switches the
// module on.
//
// So this file is tolerant about the SHAPE and strict about the CONTENT:
//
//   TOLERANT   header synonyms, any casing, any punctuation in a header, BOM,
//              CRLF, quoted fields with commas and doubled quotes, blank rows,
//              and semicolon delimiters (which is what Excel writes in a
//              non-UK locale and what arrives when somebody's laptop is set up
//              differently from the front desk's).
//
//   STRICT     a date it cannot read becomes NULL and a WARNING on that row.
//              It never guesses. The whole point of a service-due column is that
//              somebody acts on it, and a misread "03/04/26" that quietly lands
//              as 4 March instead of 3 April is worse than a blank cell, because
//              a blank cell gets noticed.
//
// EVERYTHING HERE IS PURE. No database, no session, no I/O — which is what lets
// the API route show the practice exactly what WILL happen before anything is
// written, and lets `csv.test.ts` drive the real parser with the real headers.
// ===========================================================================

import { ASSET_CATEGORIES, type AssetCategory } from "./types";

/** The register fields a column can map onto. */
export type AssetField =
  | "name"
  | "category"
  | "make"
  | "model"
  | "serial"
  | "site"
  | "room"
  | "supplier"
  | "supplierPhone"
  | "purchasedOn"
  | "lastServicedOn"
  | "nextServiceDue"
  | "notes";

/**
 * Header synonyms, keyed by the field.
 *
 * Compared after `normaliseHeader`, which lower-cases and strips everything that
 * is not a letter or a digit — so "Serial No.", "serial_no", "SERIAL NO" and
 * "Serial-No" are one entry, not four.
 *
 * ORDER MATTERS INSIDE A FIELD ONLY FOR READABILITY; ACROSS FIELDS IT DECIDES
 * TIES, and there is one tie that matters: "location". A CQC register uses it for
 * the room ("Surgery 2"), a multi-site practice uses it for the site. It is
 * mapped to ROOM, because that is the commoner meaning and because a wrong room
 * is a cosmetic error while a wrong site puts an asset in the wrong building.
 * `site` keeps the unambiguous words: site, practice, branch, clinic.
 */
const HEADER_SYNONYMS: Record<AssetField, string[]> = {
  name: ["item", "itemname", "itemdescription", "name", "equipment", "equipmentname", "asset", "assetname", "assetdescription", "description", "device", "machine"],
  category: ["category", "type", "equipmenttype", "assettype", "group", "class"],
  make: ["make", "manufacturer", "brand", "vendor"],
  model: ["model", "modelno", "modelnumber", "modelnum", "type model"],
  serial: ["serial", "serialno", "serialnumber", "sn", "serialnum", "assettag", "assetnumber", "assetid", "assetno", "barcode"],
  site: ["site", "practice", "branch", "clinic", "surgeryaddress", "premises"],
  room: ["room", "location", "surgery", "where", "position", "placed", "area"],
  supplier: ["supplier", "servicecompany", "maintainedby", "engineer", "serviceprovider", "contractor", "company"],
  supplierPhone: ["supplierphone", "phone", "telephone", "tel", "contactnumber", "servicenumber", "contactphone"],
  purchasedOn: ["purchasedate", "purchased", "datepurchased", "bought", "installdate", "installed", "installationdate", "commissioned", "acquired"],
  lastServicedOn: ["lastservice", "lastserviced", "servicedate", "lastmaintenance", "lastserviceddate", "lastinspection", "lasttest", "lastpat"],
  nextServiceDue: ["nextservice", "nextservicedue", "servicedue", "due", "nextdue", "nextinspection", "nexttest", "duedate", "nextpat", "renewaldate", "expiry", "expirydate"],
  notes: ["notes", "comments", "remarks", "note", "comment", "detail", "details", "additionalinformation"],
};

/** Category synonyms -> our closed vocabulary. Anything unmatched becomes `other`. */
const CATEGORY_SYNONYMS: Record<string, AssetCategory> = {
  sterilisation: "sterilisation",
  sterilization: "sterilisation",
  steriliser: "sterilisation",
  sterilizer: "sterilisation",
  autoclave: "sterilisation",
  decontamination: "sterilisation",
  decon: "sterilisation",
  washerdisinfector: "sterilisation",
  imaging: "imaging",
  radiography: "imaging",
  xray: "imaging",
  radiology: "imaging",
  opg: "imaging",
  cbct: "imaging",
  scanner: "imaging",
  surgery: "surgery",
  chair: "surgery",
  dentalchair: "surgery",
  dentalunit: "surgery",
  handpiece: "handpieces",
  handpieces: "handpieces",
  instruments: "handpieces",
  instrument: "handpieces",
  compressor: "compressed_air_suction",
  suction: "compressed_air_suction",
  aspirator: "compressed_air_suction",
  compressedair: "compressed_air_suction",
  vacuum: "compressed_air_suction",
  water: "water",
  waterline: "water",
  waterlines: "water",
  ro: "water",
  reverseosmosis: "water",
  it: "it_hardware",
  ithardware: "it_hardware",
  computer: "it_hardware",
  computers: "it_hardware",
  hardware: "it_hardware",
  printer: "it_hardware",
  network: "it_hardware",
  facilities: "facilities",
  building: "facilities",
  premises: "facilities",
  fire: "facilities",
  boiler: "facilities",
  emergency: "emergency",
  resus: "emergency",
  resuscitation: "emergency",
  defibrillator: "emergency",
  aed: "emergency",
  medicalgas: "emergency",
  other: "other",
};

export function normaliseHeader(raw: string): string {
  return raw.replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The field a header maps to, or null when we do not recognise it. */
export function fieldForHeader(raw: string): AssetField | null {
  const key = normaliseHeader(raw);
  if (!key) return null;
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [AssetField, string[]][]) {
    if (synonyms.some((s) => s.replace(/[^a-z0-9]/g, "") === key)) return field;
  }
  return null;
}

/**
 * Which delimiter this file uses.
 *
 * Decided from the HEADER LINE only, and by counting: a comma-delimited file with
 * semicolons inside a notes field must not be read as semicolon-delimited, and a
 * semicolon file (Excel's default in much of Europe, and what arrives when one
 * laptop in the practice is set up differently) has semicolons in the header row
 * and commas only inside decimal numbers.
 */
export function detectDelimiter(headerLine: string): "," | ";" | "\t" {
  const counts: [string, number][] = [
    [",", (headerLine.match(/,/g) ?? []).length],
    [";", (headerLine.match(/;/g) ?? []).length],
    ["\t", (headerLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const [best, count] = counts[0];
  return count > 0 ? (best as "," | ";" | "\t") : ",";
}

/**
 * RFC-4180-ish row splitter: quoted fields, doubled quotes inside them, embedded
 * newlines, CRLF. Written out rather than pulled in, because it is forty lines
 * and the dependency it replaces would be the second parser in the tree (there is
 * already one in src/lib/hours/csv.ts, which formats rather than parses).
 */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A date, or null. NEVER a guess.
 *
 * UK-FIRST, AND SAID OUT LOUD. `03/04/2026` is 3 April, because the practice is
 * in London and the spreadsheet was typed there. That single decision is the one
 * ambiguity in this file, it is not resolvable from the data, and it is stated in
 * the UI beside the import so nobody has to read this comment to know it.
 *
 * A two-digit year is windowed 2000-2099: an equipment register with a 1970s
 * purchase date typed as "75" does not exist, and a service due date certainly
 * does not.
 */
export function parseUkDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // ISO first: unambiguous, so it never reaches the UK-order branch.
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return isoIfValid(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = value.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    return isoIfValid(year, month, day);
  }

  // "12 Mar 2025", "12 March 2025", "Mar 2025" is NOT accepted: a month with no
  // day is not a date, and defaulting it to the 1st invents a fact.
  const named = value.match(/^(\d{1,2})[\s\-]?([a-z]{3,9})[\s\-,]+(\d{2,4})$/i);
  if (named) {
    const month = MONTHS[named[2].slice(0, 4).toLowerCase()] ?? MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    let year = Number(named[3]);
    if (year < 100) year += 2000;
    return isoIfValid(year, month, Number(named[1]));
  }

  return null;
}

function isoIfValid(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 31 February rather than letting Date roll it into March.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Map a practice's own category word onto the closed vocabulary. */
export function parseCategory(raw: string): AssetCategory {
  const key = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return "other";
  if ((ASSET_CATEGORIES as readonly string[]).includes(key)) return key as AssetCategory;
  if (CATEGORY_SYNONYMS[key]) return CATEGORY_SYNONYMS[key];
  // A partial match, so "Autoclaves & sterilisers" and "X-ray equipment" land
  // somewhere sensible rather than all becoming "other".
  for (const [word, category] of Object.entries(CATEGORY_SYNONYMS)) {
    if (word.length >= 4 && key.includes(word)) return category;
  }
  return "other";
}

/** A site the client actually has, for resolving "N15" / "Romford" to a site id. */
export interface SiteOption {
  id: string;
  name: string;
}

/**
 * Resolve the practice's own word for a site to a site id, or null.
 *
 * Exact-ish first (normalised equality), then containment either way, so both
 * "N15" -> "N15 Vitality Dental" and "Vitality Dental N15" -> the same site
 * resolve. An AMBIGUOUS value (matching two sites) returns null rather than
 * picking one: putting an asset in the wrong building is the error this whole
 * function exists to avoid.
 */
export function resolveSite(raw: string, sites: SiteOption[]): string | null {
  const value = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!value) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = sites.filter((s) => norm(s.name) === value || norm(s.id) === value);
  if (exact.length === 1) return exact[0].id;
  const partial = sites.filter((s) => norm(s.name).includes(value) || value.includes(norm(s.name)));
  return partial.length === 1 ? partial[0].id : null;
}

// ---------------------------------------------------------------------------

export interface ParsedAssetRow {
  /** 1-based line in the uploaded file, so a warning points at a real line. */
  line: number;
  name: string;
  category: AssetCategory;
  make: string | null;
  model: string | null;
  serial: string | null;
  siteId: string | null;
  room: string | null;
  supplier: string | null;
  supplierPhone: string | null;
  purchasedOn: string | null;
  lastServicedOn: string | null;
  nextServiceDue: string | null;
  notes: string | null;
  /** Anything the practice should look at. Never blocks the row. */
  warnings: string[];
}

export interface CsvImportPlan {
  /** Every column, in file order, and what it mapped to (null = ignored). */
  headers: { raw: string; field: AssetField | null }[];
  rows: ParsedAssetRow[];
  /** Rows that could not become an asset at all, with the reason. */
  skipped: { line: number; reason: string }[];
  /** Header text we did not recognise, surfaced so the practice can rename it. */
  unmappedHeaders: string[];
  /** True when no column mapped to `name`, which makes the whole file unusable. */
  missingNameColumn: boolean;
  delimiter: string;
}

const MAX_FIELD = 500;

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().slice(0, MAX_FIELD);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn an uploaded CSV into a plan: what each column means, what each row will
 * become, and what could not be read. Nothing is written by this function, and
 * nothing about it depends on a database — the route shows the plan, the person
 * looks at it, and only then is anything inserted.
 */
export function planAssetImport(text: string, sites: SiteOption[]): CsvImportPlan {
  const lines = text.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim().length > 0) ?? "";
  const delimiter = detectDelimiter(firstLine);
  // NOT pre-filtered. A blank row in the middle of a spreadsheet is normal, and
  // dropping it before numbering would shift every warning below it onto the
  // wrong line — which makes "row 12 has a bad date" a sentence the practice
  // manager cannot act on. Blank rows are skipped INSIDE the loop instead, with
  // the file's own line numbers intact.
  const rows = parseCsvRows(text, delimiter);
  const headerIndex = rows.findIndex((r) => r.some((cell) => cell.trim().length > 0));

  if (headerIndex === -1) {
    return { headers: [], rows: [], skipped: [], unmappedHeaders: [], missingNameColumn: true, delimiter };
  }

  const headerRow = rows[headerIndex];
  const headers = headerRow.map((raw) => ({ raw: raw.trim(), field: fieldForHeader(raw) }));
  const index = new Map<AssetField, number>();
  headers.forEach((h, i) => {
    // FIRST WINS. A spreadsheet with "Notes" and "Notes 2" maps the first and
    // ignores the second, rather than silently keeping whichever came last.
    if (h.field && !index.has(h.field)) index.set(h.field, i);
  });

  const unmappedHeaders = headers.filter((h) => !h.field && h.raw.length > 0).map((h) => h.raw);
  const missingNameColumn = !index.has("name");

  const parsed: ParsedAssetRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  const at = (row: string[], field: AssetField): string | null => {
    const i = index.get(field);
    return i === undefined ? null : clean(row[i]);
  };

  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const line = r + 1;
    if (!row.some((cell) => cell.trim().length > 0)) continue; // a blank line is not a problem
    const name = at(row, "name");
    if (!name) {
      skipped.push({ line, reason: missingNameColumn ? "no item-name column in this file" : "no item name on this row" });
      continue;
    }

    const warnings: string[] = [];

    const date = (field: AssetField, label: string): string | null => {
      const raw = at(row, field);
      if (!raw) return null;
      const iso = parseUkDate(raw);
      if (!iso) warnings.push(`${label} "${raw}" was not a date we could read, so it was left blank`);
      return iso;
    };

    const rawSite = at(row, "site");
    let siteId: string | null = null;
    if (rawSite) {
      siteId = resolveSite(rawSite, sites);
      if (!siteId) warnings.push(`site "${rawSite}" did not match one of your sites, so it was left unassigned`);
    }

    const rawCategory = at(row, "category");
    const category = rawCategory ? parseCategory(rawCategory) : "other";
    // Warn only when the practice WROTE something and it did not land — a blank
    // category column, or one that literally says "Other", is not a problem.
    if (rawCategory && category === "other" && rawCategory.trim().toLowerCase() !== "other") {
      warnings.push(`category "${rawCategory}" was not recognised, so it was filed under Other`);
    }

    parsed.push({
      line,
      name,
      category,
      make: at(row, "make"),
      model: at(row, "model"),
      serial: at(row, "serial"),
      siteId,
      room: at(row, "room"),
      supplier: at(row, "supplier"),
      supplierPhone: at(row, "supplierPhone"),
      purchasedOn: date("purchasedOn", "purchase date"),
      lastServicedOn: date("lastServicedOn", "last service date"),
      nextServiceDue: date("nextServiceDue", "next service date"),
      notes: at(row, "notes"),
      warnings,
    });
  }

  return { headers, rows: parsed, skipped, unmappedHeaders, missingNameColumn, delimiter };
}
