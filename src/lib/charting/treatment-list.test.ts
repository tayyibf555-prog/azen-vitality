import { describe, it, expect } from "vitest";
import {
  ALPHABET_KEYS,
  alphabetBuckets,
  bucketKeyOf,
  filterTreatments,
  parseFavourites,
  serialiseFavourites,
  treatmentKey,
} from "./treatment-list";
import type { TreatmentRow } from "./types";

const ROWS: TreatmentRow[] = [
  { id: "t1", code: "0000", name: "Bridge Abutment", categoryId: "c-restorative", price: 0 },
  { id: "t2", code: "103", name: "NuSmile Consultation", categoryId: "c-consult", price: 45 },
  { id: "t3", code: "121", name: "NHS Urgent Filling", categoryId: "c-restorative", price: 25.8 },
  { id: "t4", code: "212", name: "Amalgam 121 review", categoryId: "c-restorative", price: 30 },
  { id: "t5", code: "999", name: "Zirconia Crown", categoryId: "c-lab", price: 450 },
];

describe("filterTreatments", () => {
  it("is alphabetical by name by default, because the reference list is", () => {
    expect(filterTreatments(ROWS, {}).map((r) => r.name)).toEqual([
      "Amalgam 121 review",
      "Bridge Abutment",
      "NHS Urgent Filling",
      "NuSmile Consultation",
      "Zirconia Crown",
    ]);
  });

  it("sorts by code when asked, and the two orders genuinely differ", () => {
    expect(filterTreatments(ROWS, { sort: "code" }).map((r) => r.code)).toEqual([
      "0000",
      "103",
      "121",
      "212",
      "999",
    ]);
  });

  // The code is what a dentist types. A row that merely mentions the digits in
  // its name must not outrank the row whose code IS the digits.
  it("ranks a code-prefix match above a name match for the same query", () => {
    const hits = filterTreatments(ROWS, { query: "121" });
    expect(hits.map((r) => r.code)).toEqual(["121", "212"]);
  });

  it("matches on name as well as code, case-insensitively", () => {
    expect(filterTreatments(ROWS, { query: "crown" }).map((r) => r.code)).toEqual(["999"]);
    expect(filterTreatments(ROWS, { query: "NUSMILE" }).map((r) => r.code)).toEqual(["103"]);
    expect(filterTreatments(ROWS, { query: "zzz" })).toEqual([]);
  });

  it("composes the category filter with favourites rather than one overriding the other", () => {
    const favourites = new Set(["t3", "t5"]);
    const both = filterTreatments(ROWS, {
      categoryId: "c-restorative",
      favourites,
      favouritesOnly: true,
    });
    // t5 is a favourite but not restorative; t1 and t4 are restorative but not
    // favourites. Only t3 satisfies both.
    expect(both.map((r) => r.id)).toEqual(["t3"]);
  });

  it("treats an empty category as All rather than as no category", () => {
    expect(filterTreatments(ROWS, { categoryId: null })).toHaveLength(ROWS.length);
    expect(filterTreatments(ROWS, { categoryId: "" })).toHaveLength(ROWS.length);
    expect(filterTreatments(ROWS, { categoryId: "c-lab" })).toHaveLength(1);
  });

  it("floats favourites to the top without dropping anything, when favouritesFirst is on", () => {
    const out = filterTreatments(ROWS, { favourites: new Set(["t5"]), favouritesFirst: true });
    expect(out).toHaveLength(ROWS.length);
    expect(out[0].id).toBe("t5");
    expect(out.slice(1).map((r) => r.name)).toEqual([
      "Amalgam 121 review",
      "Bridge Abutment",
      "NHS Urgent Filling",
      "NuSmile Consultation",
    ]);
  });

  it("does not mutate the rows it was given", () => {
    const before = ROWS.map((r) => r.id);
    filterTreatments(ROWS, { sort: "code" });
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });
});

describe("alphabetBuckets", () => {
  it("always renders all thirty-seven keys, because a rail that changes shape is not an index", () => {
    expect(ALPHABET_KEYS).toHaveLength(37);
    expect(ALPHABET_KEYS[0]).toBe("star");
    expect(ALPHABET_KEYS.slice(1, 11)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(ALPHABET_KEYS[36]).toBe("Z");
    expect(alphabetBuckets(ROWS).map((b) => b.key)).toEqual([...ALPHABET_KEYS]);
  });

  it("counts honestly, so an empty bucket can be disabled rather than jumping nowhere", () => {
    const byKey = Object.fromEntries(alphabetBuckets(ROWS).map((b) => [b.key, b.count]));
    expect(byKey.A).toBe(1);
    expect(byKey.B).toBe(1);
    expect(byKey.N).toBe(2);
    expect(byKey.Z).toBe(1);
    expect(byKey.Q).toBe(0);
    expect(byKey["0"]).toBe(0);
  });

  it("counts favourites into the star bucket when it is given the set, and prints a star not the word", () => {
    expect(alphabetBuckets(ROWS, new Set(["t1", "t5"]))[0]).toEqual({
      key: "star",
      label: "★",
      count: 2,
    });
    expect(alphabetBuckets(ROWS)[0].count).toBe(0);
    expect(alphabetBuckets(ROWS)[1]).toEqual({ key: "0", label: "0", count: 0 });
  });

  it("buckets on the name's first alphanumeric character, so punctuation does not create a phantom key", () => {
    expect(bucketKeyOf({ ...ROWS[0], name: "Bridge" })).toBe("B");
    expect(bucketKeyOf({ ...ROWS[0], name: "  zirconia" })).toBe("Z");
    expect(bucketKeyOf({ ...ROWS[0], name: "(temporary) crown" })).toBe("T");
    expect(bucketKeyOf({ ...ROWS[0], name: "3M restoration" })).toBe("3");
  });

  // Neither null nor a 38th key: a null drops the row out of the grouped list,
  // and a key outside the 37 puts it in a group the rail can never reach.
  // Either way a treatment vanishes from the list, which is worse than one
  // filed oddly.
  it("still files a name with no letters or digits under a key the rail can reach", () => {
    const odd = { ...ROWS[0], id: "odd", name: "///" };
    expect(ALPHABET_KEYS).toContain(bucketKeyOf(odd));
    const byKey = Object.fromEntries(alphabetBuckets([odd]).map((b) => [b.key, b.count]));
    expect(Object.values(byKey).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("favourites storage", () => {
  it("round-trips a set", () => {
    const set = new Set(["t1", "t5"]);
    expect(parseFavourites(serialiseFavourites(set))).toEqual(set);
  });

  // A corrupt display preference must never blank a clinical screen.
  it("returns an empty set for corrupt, absent or wrongly-shaped storage rather than throwing", () => {
    expect(parseFavourites("not json")).toEqual(new Set());
    expect(parseFavourites(null)).toEqual(new Set());
    expect(parseFavourites("{}")).toEqual(new Set());
    expect(parseFavourites("[1,2,{}]")).toEqual(new Set());
    expect(parseFavourites('["t1",2]')).toEqual(new Set(["t1"]));
  });
});

describe("treatmentKey", () => {
  it("uses the code a dentist types when there is one", () => {
    expect(treatmentKey(ROWS[2])).toBe("121");
  });

  // The code is read defensively from three unverified field names and falls
  // back to "". With an empty code, `row.code === activeCode` matched EVERY row,
  // so selecting one treatment highlighted the whole list; and draftKey is
  // `${tooth}:${treatmentCode}`, so every codeless treatment on a tooth
  // collapsed into a single draft entry.
  it("falls back to the id, so two codeless treatments are never the same treatment", () => {
    const a: TreatmentRow = { id: "t9", code: "", name: "Examination", categoryId: null, price: 0 };
    const b: TreatmentRow = { id: "t10", code: "", name: "Radiograph", categoryId: null, price: 0 };
    expect(treatmentKey(a)).toBe("t9");
    expect(treatmentKey(b)).toBe("t10");
    expect(treatmentKey(a)).not.toBe(treatmentKey(b));
  });

  it("never returns an empty key, which is what matched everything", () => {
    for (const row of [...ROWS, { id: "x", code: "", name: "", categoryId: null, price: 0 }]) {
      expect(treatmentKey(row).length).toBeGreaterThan(0);
    }
  });
});
