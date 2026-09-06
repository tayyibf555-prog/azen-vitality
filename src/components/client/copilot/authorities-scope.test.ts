// ===========================================================================
// THE APPROVED-SOURCES PANEL COUNTS WHAT THE CO-PILOT IS GIVEN, NOT WHAT THE
// PRACTICE STORED (wave-3d review, 6 September 2026; charter §0 item 5,
// ruling W3/9 "copy matches code, never the reverse").
//
// THE DEFECT. The collapsed subtitle printed
// `${active.length} sources the co-pilot may cite.` over every active row.
// `authoritiesBrief` is handed `active.slice(0, AUTHORITY_BRIEF_MAX)` — eight —
// and `listActiveAuthorities` orders `created_at` ASCENDING, so the eight that
// reach the prompt are the OLDEST and the ones dropped are the ones the owner
// added most recently. The brief says so ("Showing 8 of 12 approved
// authorities…") in the SYSTEM PROMPT, where nobody reads it. On screen the
// count wore a predicate the code does not honour, and the owner's only way to
// discover it was to ask about a source and be told nothing.
//
// WHY IT WAS NOT ALREADY CAUGHT. src/lib/knowledge/authorities.test.ts pins the
// brief's cap and its "Showing N of M" line, which proves the PROMPT is honest
// and says nothing about the screen. os-copy-sweep.test.ts renders the panel
// only in its empty, collapsed state (the fetch happens on the opening gesture,
// so a server render has `rows = []` and the subtitle under review never runs).
// This file is the missing half.
//
// IT TESTS THE PURE MODULE, NOT THE PANEL, and that is why the module exists:
// the sentence only renders after a fetch and a click, neither of which this
// node-environment suite has. The last test below is the join — the panel calls
// these functions rather than carrying a second copy of the rule.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUTHORITY_BRIEF_MAX } from "@/lib/knowledge/authorities";
import type { ApprovedAuthority } from "@/lib/knowledge/types";
import {
  NOT_IN_USE_LABEL,
  authoritiesBoundNote,
  authoritiesInScope,
  authoritiesSubtitle,
} from "./authorities-scope";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function authority(n: number, status: "active" | "archived" = "active"): ApprovedAuthority {
  return {
    id: `a${n}`,
    clientId: "c1",
    name: `Source ${n}`,
    kind: "guideline",
    publisher: "",
    reference: "",
    summary: "",
    principles: "",
    status,
    createdBy: null,
    createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`,
  };
}

/** n active sources, oldest first — the order both repository reads produce. */
const listOf = (n: number) => Array.from({ length: n }, (_, i) => authority(i + 1));

describe("the subtitle says what the co-pilot is handed, not what the table holds", () => {
  it("is the default posture while the list is empty", () => {
    expect(authoritiesSubtitle(0)).toBe(
      "None yet — the co-pilot answers from the practice's own records.",
    );
  });

  it("says the plain count while every source is in scope", () => {
    expect(authoritiesSubtitle(1)).toBe("1 source the co-pilot may cite.");
    expect(authoritiesSubtitle(AUTHORITY_BRIEF_MAX)).toBe(
      `${AUTHORITY_BRIEF_MAX} sources the co-pilot may cite.`,
    );
  });

  // MUTATION: put `${activeCount} sources the co-pilot may cite.` back for every
  // count. The first assertion goes red — the panel would be claiming the model
  // may cite four sources it is never shown.
  it("stops claiming the co-pilot may cite them all the moment the list passes the bound", () => {
    const over = AUTHORITY_BRIEF_MAX + 4;
    const copy = authoritiesSubtitle(over);
    expect(
      copy,
      "the panel promises the co-pilot may cite sources the brief never carries",
    ).not.toMatch(new RegExp(`${over}\\s+sources? the co-pilot may cite`));
    // BOTH figures, because either alone misleads: the owner's own count is what
    // he recognises, and the bound is the fact he is missing.
    expect(copy).toContain(String(over));
    expect(copy).toContain(String(AUTHORITY_BRIEF_MAX));
  });

  it("explains the bound only when there is a bound to explain, and says how to change it", () => {
    expect(authoritiesBoundNote(AUTHORITY_BRIEF_MAX)).toBeNull();
    const note = authoritiesBoundNote(AUTHORITY_BRIEF_MAX + 1);
    expect(note).not.toBeNull();
    expect(note as string).toContain(String(AUTHORITY_BRIEF_MAX));
    // Naming the shortfall without naming the lever swaps one puzzle for another;
    // archiving is the only control this panel has.
    expect(note as string).toMatch(/archive/i);
  });
});

describe("the rows marked in scope are the rows the brief will carry", () => {
  it("takes the first AUTHORITY_BRIEF_MAX active rows, in the order they arrive", () => {
    const rows = listOf(AUTHORITY_BRIEF_MAX + 3);
    const { active, inBrief, overBound, bound } = authoritiesInScope(rows);
    expect(bound).toBe(AUTHORITY_BRIEF_MAX);
    expect(active).toHaveLength(AUTHORITY_BRIEF_MAX + 3);
    expect(overBound).toBe(true);
    expect(inBrief.size).toBe(AUTHORITY_BRIEF_MAX);
    expect([...inBrief]).toEqual(rows.slice(0, AUTHORITY_BRIEF_MAX).map((r) => r.id));
    // And the three the owner added last are the three that are NOT.
    for (const row of rows.slice(AUTHORITY_BRIEF_MAX)) expect(inBrief.has(row.id)).toBe(false);
  });

  it("counts archived rows in neither half", () => {
    const rows = [authority(1), authority(2, "archived"), authority(3)];
    const { active, inBrief, overBound } = authoritiesInScope(rows);
    expect(active.map((r) => r.id)).toEqual(["a1", "a3"]);
    expect(inBrief.has("a2")).toBe(false);
    expect(overBound).toBe(false);
  });

  it("marks nothing while the whole list is in scope", () => {
    const { inBrief, overBound } = authoritiesInScope(listOf(AUTHORITY_BRIEF_MAX));
    expect(overBound).toBe(false);
    expect(inBrief.size).toBe(AUTHORITY_BRIEF_MAX);
  });
});

describe("the marker is only honest while these three orderings agree", () => {
  // THE COUPLING, READ FROM THE CODE IT DEPENDS ON. `authoritiesInScope` marks
  // the FIRST rows of the panel's list, and that is only the brief's own eight
  // while all three of these hold: the panel's read is oldest-first, the
  // co-pilot's read is oldest-first, and the brief keeps the FRONT of it. A
  // panel marking the wrong eight rows would be worse than one marking none, so
  // the day any of the three moves this goes red rather than the screen quietly
  // lying about which sources are in front of the model.
  const repository = src("src/lib/knowledge/repository.ts");
  const authorities = src("src/lib/knowledge/authorities.ts");

  function body(source: string, fn: string): string {
    const at = source.indexOf(`export function ${fn}`);
    const async = source.indexOf(`export async function ${fn}`);
    const start = at === -1 ? async : at;
    expect(start, `${fn} is no longer exported; this scan has gone stale`).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const next = rest.indexOf("\nexport ");
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("the co-pilot's own read is oldest-first", () => {
    expect(body(repository, "listActiveAuthorities")).toContain(
      'order("created_at", { ascending: true })',
    );
  });

  it("the panel's read is oldest-first too, so the two lists line up", () => {
    expect(body(repository, "listAllAuthorities")).toContain(
      'order("created_at", { ascending: true })',
    );
  });

  it("the brief keeps the FRONT of the active list", () => {
    expect(body(authorities, "authoritiesBrief")).toContain(
      "active.slice(0, AUTHORITY_BRIEF_MAX)",
    );
  });
});

describe("the panel prints these sentences rather than a second copy of the rule", () => {
  // A SOURCE PIN, and honest about being one: the subtitle renders only after a
  // fetch and a click, neither of which exists in a node-environment suite. What
  // it catches is the regression that actually happens — the derived sentence
  // being replaced by a literal in the JSX, which would keep every assertion
  // above green while the owner read the old over-claim (the same shape
  // kill-switch-copy.test.ts uses for the control panel's paragraph).
  const panel = src("src/components/client/copilot/authorities-panel.tsx");

  it("the collapsed subtitle and the bound note both come from the shared module", () => {
    expect(panel).toContain("authoritiesSubtitle(active.length)");
    expect(panel).toContain("authoritiesBoundNote(active.length)");
    expect(panel).toContain("authoritiesInScope(rows)");
  });

  it("the old unqualified sentence is not in the file any more", () => {
    expect(
      panel,
      "the panel counts every stored source as one the co-pilot may cite",
    ).not.toMatch(/source\$\{[^}]*\} the co-pilot may cite/);
  });

  it("the rows outside the brief are marked on the row itself", () => {
    // The LABEL is imported, never typed into the JSX, so the word on the row
    // and the word this suite names cannot drift apart.
    expect(NOT_IN_USE_LABEL).toBe("Not in use");
    expect(panel).toContain("{NOT_IN_USE_LABEL}");
    expect(panel).not.toContain(`>${NOT_IN_USE_LABEL}<`);
    expect(panel).toContain("!inBrief.has(row.id)");
  });
});
