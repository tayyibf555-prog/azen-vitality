import { describe, it, expect } from "vitest";
import {
  detectDelimiter,
  fieldForHeader,
  parseCategory,
  parseCsvRows,
  parseUkDate,
  planAssetImport,
  resolveSite,
  type SiteOption,
} from "./csv";

// ===========================================================================
// THE IMPORTER IS TESTED AGAINST THE SPREADSHEET A PRACTICE ACTUALLY KEEPS,
// not against the one we would have designed.
//
// The header sets below are the real shapes: a CQC-style register, an insurance
// schedule, an engineer's service list, and the messy one with trailing spaces,
// a BOM, semicolons and a blank row in the middle. If a future edit makes the
// importer stricter, one of these stops mapping and this file says which.
// ===========================================================================

const SITES: SiteOption[] = [
  { id: "site-cc", name: "N15 Vitality Dental" },
  { id: "site-rv", name: "N17 Dental" },
  { id: "site-ng", name: "Romford Road" },
];

// ---------------------------------------------------------------------------
// 1. HEADERS.
// ---------------------------------------------------------------------------

describe("1. the header mapping covers the names a practice really uses", () => {
  const CASES: [header: string, field: string][] = [
    ["Item", "name"],
    ["Item Name", "name"],
    ["Equipment", "name"],
    ["Asset Description", "name"], // "description" wins; "asset" is the same field anyway
    ["Description", "name"],
    ["Category", "category"],
    ["Equipment Type", "category"],
    ["Make", "make"],
    ["Manufacturer", "make"],
    ["Model No.", "model"],
    ["Model Number", "model"],
    ["Serial No", "serial"],
    ["Serial Number", "serial"],
    ["S/N", "serial"],
    ["Asset Tag", "serial"],
    ["Site", "site"],
    ["Practice", "site"],
    ["Branch", "site"],
    ["Room", "room"],
    ["Location", "room"],
    ["Surgery", "room"],
    ["Supplier", "supplier"],
    ["Maintained By", "supplier"],
    ["Service Company", "supplier"],
    ["Telephone", "supplierPhone"],
    ["Contact Number", "supplierPhone"],
    ["Purchase Date", "purchasedOn"],
    ["Date Purchased", "purchasedOn"],
    ["Installed", "purchasedOn"],
    ["Last Service", "lastServicedOn"],
    ["Last Serviced", "lastServicedOn"],
    ["Service Date", "lastServicedOn"],
    ["Next Service Due", "nextServiceDue"],
    ["Service Due", "nextServiceDue"],
    ["Next Due", "nextServiceDue"],
    ["Expiry Date", "nextServiceDue"],
    ["Notes", "notes"],
    ["Comments", "notes"],
    ["Remarks", "notes"],
  ];

  it.each(CASES)("maps %j to %s", (header, field) => {
    expect(fieldForHeader(header)).toBe(field);
  });

  it("ignores casing, punctuation and stray whitespace in a header", () => {
    expect(fieldForHeader("  SERIAL_NO  ")).toBe("serial");
    expect(fieldForHeader("serial-number")).toBe("serial");
    expect(fieldForHeader("Serial No.")).toBe("serial");
  });

  it("returns null for a column we do not know, rather than guessing", () => {
    // An unmapped column is reported to the practice; a wrongly-mapped one is
    // silently wrong data in a register somebody will rely on.
    expect(fieldForHeader("Cost Centre")).toBeNull();
    expect(fieldForHeader("")).toBeNull();
  });

  it('"Location" is the ROOM, and only the unambiguous words are the SITE', () => {
    // Stated as a test because it is a judgement call: a wrong room is cosmetic,
    // a wrong site puts an asset in the wrong building.
    expect(fieldForHeader("Location")).toBe("room");
    expect(fieldForHeader("Site")).toBe("site");
    expect(fieldForHeader("Practice")).toBe("site");
  });
});

// ---------------------------------------------------------------------------
// 2. DATES.
// ---------------------------------------------------------------------------

describe("2. dates are read UK-first, or not at all", () => {
  it("reads UK day-first dates", () => {
    expect(parseUkDate("03/04/2026")).toBe("2026-04-03"); // 3 April, not 4 March
    expect(parseUkDate("3/4/26")).toBe("2026-04-03");
    expect(parseUkDate("31-12-2025")).toBe("2025-12-31");
    expect(parseUkDate("01.02.2026")).toBe("2026-02-01");
  });

  it("reads ISO dates without applying the UK ordering to them", () => {
    expect(parseUkDate("2026-04-03")).toBe("2026-04-03");
  });

  it("reads a written month", () => {
    expect(parseUkDate("12 Mar 2025")).toBe("2025-03-12");
    expect(parseUkDate("12 March 2025")).toBe("2025-03-12");
    expect(parseUkDate("1 Sept 2026")).toBe("2026-09-01");
  });

  it("REFUSES rather than guesses", () => {
    // Each of these has a plausible "helpful" reading, and every one of them
    // would put a wrong date in a service-due column somebody acts on.
    expect(parseUkDate("March 2025")).toBeNull(); // a month is not a date
    expect(parseUkDate("31/02/2026")).toBeNull(); // 31 February must not roll into March
    expect(parseUkDate("asap")).toBeNull();
    expect(parseUkDate("TBC")).toBeNull();
    expect(parseUkDate("")).toBeNull();
    expect(parseUkDate("13/13/2026")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. CATEGORIES AND SITES.
// ---------------------------------------------------------------------------

describe("3. categories and sites", () => {
  it("maps the practice's own words onto the closed vocabulary", () => {
    expect(parseCategory("Autoclave")).toBe("sterilisation");
    expect(parseCategory("Steriliser")).toBe("sterilisation");
    expect(parseCategory("Decontamination")).toBe("sterilisation");
    expect(parseCategory("X-Ray")).toBe("imaging");
    expect(parseCategory("Radiography")).toBe("imaging");
    expect(parseCategory("Dental Chair")).toBe("surgery");
    expect(parseCategory("Compressor")).toBe("compressed_air_suction");
    expect(parseCategory("Suction")).toBe("compressed_air_suction");
    expect(parseCategory("Handpieces")).toBe("handpieces");
    expect(parseCategory("IT")).toBe("it_hardware");
    expect(parseCategory("Defibrillator")).toBe("emergency");
  });

  it("falls back to Other rather than inventing a category", () => {
    expect(parseCategory("Widgets")).toBe("other");
    expect(parseCategory("")).toBe("other");
  });

  it("resolves the site names a practice types", () => {
    expect(resolveSite("N15", SITES)).toBe("site-cc");
    expect(resolveSite("N15 Vitality Dental", SITES)).toBe("site-cc");
    expect(resolveSite("Romford", SITES)).toBe("site-ng");
    expect(resolveSite("romford road", SITES)).toBe("site-ng");
  });

  it("returns null for an unknown or AMBIGUOUS site rather than picking one", () => {
    expect(resolveSite("Barking", SITES)).toBeNull();
    // "N1" is a prefix of both N15 and N17: two matches is not a match.
    expect(resolveSite("N1", SITES)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. WHOLE FILES.
// ---------------------------------------------------------------------------

const CQC_REGISTER = [
  "Item,Category,Make,Model No.,Serial No,Site,Location,Supplier,Purchase Date,Last Service,Next Service Due,Notes",
  'Autoclave 1,Steriliser,W&H,Lisa 500,A1400273,N15,Decon room,DentalTech Ltd,14/06/2021,02/03/2026,02/03/2027,"Vacuum class B, 22L"',
  "Compressor,Compressor,Durr,Duo Tandem,C-99120,N15,Plant room,Durr Service,01/09/2019,11/11/2025,11/11/2026,",
  "OPG,Radiography,Planmeca,ProMax 2D,PM-88213,N17,Surgery 3,Imaging Care,,05/05/2026,05/05/2027,Annual RPA check",
].join("\n");

describe("4. a real CQC-style register imports cleanly", () => {
  const plan = planAssetImport(CQC_REGISTER, SITES);

  it("maps every column and reports none unmapped", () => {
    expect(plan.missingNameColumn).toBe(false);
    expect(plan.unmappedHeaders).toEqual([]);
    expect(plan.headers.map((h) => h.field)).toEqual([
      "name", "category", "make", "model", "serial", "site", "room",
      "supplier", "purchasedOn", "lastServicedOn", "nextServiceDue", "notes",
    ]);
  });

  it("produces one asset per row, with the dates in ISO and the site resolved", () => {
    expect(plan.rows).toHaveLength(3);
    expect(plan.skipped).toEqual([]);
    const [autoclave, , opg] = plan.rows;
    expect(autoclave.name).toBe("Autoclave 1");
    expect(autoclave.category).toBe("sterilisation");
    expect(autoclave.make).toBe("W&H");
    expect(autoclave.serial).toBe("A1400273");
    expect(autoclave.siteId).toBe("site-cc");
    expect(autoclave.room).toBe("Decon room");
    expect(autoclave.purchasedOn).toBe("2021-06-14");
    expect(autoclave.nextServiceDue).toBe("2027-03-02");
    expect(autoclave.notes).toBe("Vacuum class B, 22L"); // the quoted comma survived
    expect(autoclave.warnings).toEqual([]);
    expect(opg.siteId).toBe("site-rv");
    expect(opg.purchasedOn).toBeNull(); // the cell was empty, and empty is not a warning
    expect(opg.warnings).toEqual([]);
  });
});

describe("4b. the messy file still imports, and says what it could not read", () => {
  const MESSY = [
    "﻿Equipment;Type;Manufacturer;Asset Tag;Practice;Surgery;Maintained By;Service Due;Comments",
    "Handpiece set ;Handpieces;NSK; ;Barking;Surgery 1;NSK UK;asap;needs oiling",
    "",
    "  ;Other;;;;;;;",
    'Suction pump;Suction;Durr;S-7781;N15;Plant room;Durr Service;01/07/2027;"Serviced ""out of hours"""',
  ].join("\r\n");

  const plan = planAssetImport(MESSY, SITES);

  it("detects the semicolon delimiter Excel writes in another locale", () => {
    expect(plan.delimiter).toBe(";");
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a,b,c")).toBe(",");
    expect(detectDelimiter("only-one-column")).toBe(",");
  });

  it("skips the blank row and the row with no item name, naming the line", () => {
    expect(plan.rows.map((r) => r.name)).toEqual(["Handpiece set", "Suction pump"]);
    expect(plan.skipped).toEqual([{ line: 4, reason: "no item name on this row" }]);
  });

  it("warns about the unreadable date and the unknown site, and imports the row anyway", () => {
    // A row is never LOST because one cell was odd. The register is more useful
    // with the asset in it and a warning than with the asset missing.
    const handpiece = plan.rows[0];
    expect(handpiece.nextServiceDue).toBeNull();
    expect(handpiece.warnings).toEqual([
      'site "Barking" did not match one of your sites, so it was left unassigned',
      'next service date "asap" was not a date we could read, so it was left blank',
    ]);
    expect(handpiece.siteId).toBeNull();
  });

  it("handles the BOM, CRLF, trailing spaces and doubled quotes", () => {
    expect(plan.headers[0].field).toBe("name"); // BOM did not break "Equipment"
    expect(plan.rows[0].name).toBe("Handpiece set"); // trailing space trimmed
    expect(plan.rows[1].notes).toBe('Serviced "out of hours"');
  });
});

describe("4c. a file with no item column is refused as a whole", () => {
  const plan = planAssetImport("Cost Centre,Value\nA,100", SITES);
  it("says so rather than importing nameless rows", () => {
    expect(plan.missingNameColumn).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.skipped[0].reason).toBe("no item-name column in this file");
    expect(plan.unmappedHeaders).toEqual(["Cost Centre", "Value"]);
  });

  it("an empty file is a plan with nothing in it, not a crash", () => {
    const empty = planAssetImport("", SITES);
    expect(empty.rows).toEqual([]);
    expect(empty.missingNameColumn).toBe(true);
  });
});

describe("4d. the row splitter", () => {
  it("keeps a delimiter inside quotes, and a newline inside quotes", () => {
    expect(parseCsvRows('a,"b,c",d', ",")).toEqual([["a", "b,c", "d"]]);
    expect(parseCsvRows('a,"line1\nline2",c', ",")).toEqual([["a", "line1\nline2", "c"]]);
  });
});
