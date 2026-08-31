import { describe, it, expect } from "vitest";
import { RECENTS_LIMIT, selectRecents, type RecentPatientRow } from "./cap";

// ===========================================================================
// THE RECENTS RULE, PROVEN WITHOUT A DATABASE.
//
// Every clause below could have lived in the PostgREST chain in repository.ts
// (`.in(...)`, `.order(...)`, `.limit(...)`, plus the unique constraint in
// migration 0095 standing in for the dedupe) and the feature would have looked
// finished. None of it would have been answerable to a test. That matters here
// more than for most display code, because two of these clauses are not cosmetic:
// the SITE SCOPE decides whether one site's patient names are shown to somebody
// who has scoped that site away, and the DEDUPE ORDER decides whether the strip
// quietly shows six names when it promised eight.
//
// So the rule is a pure function and these are the awkward inputs it has to
// survive: duplicates, a wrong-order arrival, an out-of-scope site, an empty
// scope, and a timestamp that will not parse.
// ===========================================================================

const SITE = "site-cc";
const OTHER_SITE = "site-ng";

/** A row, with only the field under test varied at each call site. */
function row(patientId: string, viewedAt: string, over: Partial<RecentPatientRow> = {}): RecentPatientRow {
  return { patientId, name: `Patient ${patientId}`, siteId: SITE, viewedAt, ...over };
}

/** `n` distinct patients, opened one minute apart, oldest first. */
function opened(n: number): RecentPatientRow[] {
  return Array.from({ length: n }, (_, i) =>
    row(`p-${i}`, new Date(Date.UTC(2026, 7, 31, 9, i)).toISOString()),
  );
}

describe("the strip is capped", () => {
  it("caps the strip at RECENTS_LIMIT however many patients were opened", () => {
    expect(RECENTS_LIMIT).toBe(8);
    const out = selectRecents(opened(30), [SITE]);
    expect(out).toHaveLength(RECENTS_LIMIT);
    // And it is the NEWEST eight, not the first eight the database happened to
    // hand back: p-29 was opened last.
    expect(out[0].patientId).toBe("p-29");
    expect(out[7].patientId).toBe("p-22");
  });
});

describe("the strip is deduped", () => {
  it("dedupes a repeated patient, keeping the NEWEST opening", () => {
    const out = selectRecents(
      [
        row("p-1", "2026-08-31T09:00:00.000Z", { name: "Older reading" }),
        row("p-2", "2026-08-31T09:30:00.000Z"),
        row("p-1", "2026-08-31T10:00:00.000Z", { name: "Newest reading" }),
      ],
      [SITE],
    );
    // One entry for p-1, not two...
    expect(out.filter((p) => p.patientId === "p-1")).toHaveLength(1);
    // ...and it is the newest one, which is also the one carrying the name as it
    // read most recently.
    expect(out[0]).toMatchObject({ patientId: "p-1", name: "Newest reading" });
    expect(out.map((p) => p.patientId)).toEqual(["p-1", "p-2"]);
  });

  it("dedupes BEFORE capping, so a repeated patient never costs a slot", () => {
    // The failure this pins: cap-then-dedupe takes the newest eight rows and only
    // then collapses them, so a coordinator who tabbed back to one patient three
    // times gets a SIX-name strip and no explanation. Here the ten newest rows are
    // all the same patient; a correct implementation still fills every slot.
    const repeats = Array.from({ length: 10 }, (_, i) =>
      row("p-hot", new Date(Date.UTC(2026, 7, 31, 12, i)).toISOString()),
    );
    const out = selectRecents([...opened(20), ...repeats], [SITE]);
    expect(out).toHaveLength(RECENTS_LIMIT);
    expect(out.filter((p) => p.patientId === "p-hot")).toHaveLength(1);
    expect(new Set(out.map((p) => p.patientId)).size).toBe(RECENTS_LIMIT);
  });
});

describe("the strip is newest first", () => {
  it("returns newest first whatever order the rows arrived in", () => {
    const out = selectRecents(
      [
        row("middle", "2026-08-31T10:00:00.000Z"),
        row("oldest", "2026-08-30T08:00:00.000Z"),
        row("newest", "2026-08-31T18:00:00.000Z"),
      ],
      [SITE],
    );
    expect(out.map((p) => p.patientId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("an unreadable viewed_at sorts oldest and never wins the dedupe", () => {
    // Date.parse returns NaN here, and NaN inside a comparator means "leave it
    // where it is" — which would have parked a corrupt row at the front of the
    // strip AND let it beat a perfectly good newer reading of the same patient,
    // because the dedupe keeps whichever copy sorts first.
    const out = selectRecents(
      [
        row("p-1", "not a timestamp", { name: "Corrupt reading" }),
        row("p-1", "2026-08-31T09:00:00.000Z", { name: "Good reading" }),
        row("p-2", "2026-08-31T08:00:00.000Z"),
      ],
      [SITE],
    );
    expect(out.map((p) => p.patientId)).toEqual(["p-1", "p-2"]);
    expect(out[0].name).toBe("Good reading");
  });
});

describe("the strip is scoped to the sites in view", () => {
  it("drops a patient opened at a site outside the current selection", () => {
    // Not a tidiness rule. The record shell notFound()s a patient outside scope,
    // so the link would be dead — but the NAME is the leak, and it has already
    // been published by the time anyone clicks it.
    const out = selectRecents(
      [
        row("in-scope", "2026-08-31T09:00:00.000Z"),
        row("elsewhere", "2026-08-31T10:00:00.000Z", { siteId: OTHER_SITE, name: "Other Site Patient" }),
      ],
      [SITE],
    );
    expect(out.map((p) => p.patientId)).toEqual(["in-scope"]);
    expect(JSON.stringify(out)).not.toContain("Other Site Patient");
  });

  it("returns nothing when no site is in scope, rather than everything", () => {
    // Fail closed. "No filter means show everything" is the direction this class
    // of bug always fails in, and it would publish every name the user has ever
    // opened to a view that has resolved to no sites at all.
    expect(selectRecents(opened(5), [])).toEqual([]);
  });

  it("keeps patients from every site when the switcher is on All sites", () => {
    const out = selectRecents(
      [row("a", "2026-08-31T09:00:00.000Z"), row("b", "2026-08-31T10:00:00.000Z", { siteId: OTHER_SITE })],
      [SITE, OTHER_SITE],
    );
    expect(out.map((p) => p.patientId)).toEqual(["b", "a"]);
  });
});

describe("the rule is pure", () => {
  it("does not mutate the caller's array", () => {
    // The sort is the hazard: Array#sort is in place, and the rows handed in come
    // straight off a database read that a caller may go on to use.
    const rows = [row("a", "2026-08-30T09:00:00.000Z"), row("b", "2026-08-31T09:00:00.000Z")];
    const before = rows.map((r) => r.patientId);
    selectRecents(rows, [SITE]);
    expect(rows.map((r) => r.patientId)).toEqual(before);
  });
});
