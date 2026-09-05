import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  SYSTEM_SLUGS,
  DRAIN_SOURCE_TO_SLUG,
  defaultEnabledFor,
  isControllableSystem,
} from "@/lib/systems/catalog";

// ===========================================================================
// THE APPROVED-AUTHORITIES POSTURE, PROVEN RATHER THAN ASSERTED IN A COMMENT.
//
// 0100_approved_authorities.sql ships this table with NO system_toggle row and
// argues, at length, that it needs none. That conclusion is right — the table is
// an owner-typed list, not a send surface — and programme ruling W3/18 upheld it.
// But the migration's ORIGINAL argument leant on a control that does not exist:
// it said the co-pilot "has its own kill switch", quoting a system slug for it,
// and that switching that off already stopped every read of this table.
//
// It did not, twice over: `co-pilot` is a NAV module slug and is absent from
// SYSTEMS, so no such switch can be created by any surface; and a row inserted by
// hand would have been default-ARMED anyway, because `defaultEnabledFor` treats an
// uncatalogued slug as ON. The claim survived every gate in the tree because
// NOTHING here read migration prose. This file does.
//
// A false comment about a safety control is not cosmetic. It is the thing an owner
// hunts for in System controls, the thing an auditor records as present, and the
// premise the next engineer reasons from. So there are two kinds of test below:
//
//   1. THIS TABLE: the no-switch decision is coherent (no seed row, no catalog
//      slug), the file no longer claims the switch, and each control it DOES now
//      name is really there in the code.
//   2. EVERY MIGRATION: a sweep for the same mistake anywhere else — a slug
//      quoted as a kill switch that is not a controllable system.
// ===========================================================================

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MIGRATION = "supabase/migrations/0100_approved_authorities.sql";
const MIGRATIONS_DIR = "supabase/migrations";
const AUTHORITIES_ROUTE = "src/app/api/authorities/[action]/route.ts";
const COPILOT_ROUTE = "src/app/api/copilot/route.ts";
const REPOSITORY = "src/lib/knowledge/repository.ts";

/**
 * Comment text only, as ONE normalised stream. Two things matter here:
 *
 *   * only `--` lines are read. SQL bodies quote plenty of legitimate literals
 *     ('active', 'regulator') and none of them is a claim about a switch;
 *   * line breaks are collapsed to single spaces BEFORE anything is matched.
 *     Migration prose wraps at ~80 columns, so "kill switch" straddles a line
 *     break as often as not; a sweep that matched line by line would miss the
 *     wrapped half of every claim it exists to catch.
 */
function commentProse(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => line.trimStart().startsWith("--"))
    .map((line) => line.trimStart().replace(/^--\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * Sentences that make a claim about a kill switch. Split on sentence enders so a
 * quoted slug three paragraphs away is never attributed to this sentence.
 */
function killSwitchSentences(prose: string): string[] {
  return prose.split(/(?<=[.:;])\s/).filter((s) => /kill switch/i.test(s));
}

/**
 * Single-quoted, slug-shaped tokens: lowercase letters, digits and hyphens, no
 * spaces. This file's own convention — and the tree's — is that single quotes hold
 * a VALUE the system uses (a slug, a status, a kind) while backticks hold a code
 * identifier being discussed in prose. So `'co-pilot'` inside a kill-switch
 * sentence is a claim that a togglable system by that name exists; a backticked
 * `co-pilot` is not, and the correction in 0100 uses backticks for exactly that
 * reason.
 */
function quotedSlugs(sentence: string): string[] {
  return [...sentence.matchAll(/'([a-z0-9][a-z0-9-]{2,40})'/g)].map((m) => m[1]);
}

/**
 * Slugs a migration may quote as a kill switch despite not being in SYSTEMS.
 *
 * EMPTY, AND THAT IS THE POINT. If a real case ever arises, add the slug here with
 * the file that quotes it and the ruling that permits it — never by loosening the
 * assertion below. A slug quoted as a switch that has no switch is the defect this
 * sweep exists to catch.
 */
const KILL_SWITCH_SLUG_EXEMPTIONS = new Map<string, string>();

describe("approved authorities: no kill switch, and the reason given is true", () => {
  it("`co-pilot` is not a controllable system, so the switch 0100 used to cite cannot exist", () => {
    expect(isControllableSystem("co-pilot")).toBe(false);
    expect(SYSTEM_SLUGS).not.toContain("co-pilot");
  });

  it("and a hand-inserted row would have been ARMED, not off: an uncatalogued slug defaults ON", () => {
    // The second half of why the old sentence was wrong. Even someone who inserted
    // the row by hand would not have got the safe behaviour the comment promised.
    expect(defaultEnabledFor("co-pilot")).toBe(true);
  });

  it("the migration seeds no system_toggle row, matching the catalog", () => {
    expect(read(MIGRATION)).not.toContain("insert into system_toggle");
  });

  it("the migration no longer claims a co-pilot kill switch", () => {
    const prose = commentProse(read(MIGRATION));
    expect(prose).not.toMatch(/has its own kill switch \('co-pilot'\)/);
    expect(prose).not.toMatch(/which already stops every\s+read of this table/);
  });

  it("it records that the correction is documentation-only on an APPLIED migration (W3/18)", () => {
    const prose = commentProse(read(MIGRATION));
    expect(prose).toContain("W3/18");
    expect(prose).toMatch(/Editing a comment does not alter applied state/);
  });

  it("and it names the controls that DO exist instead", () => {
    const prose = commentProse(read(MIGRATION));
    expect(prose).toContain("requireOwnerRole");
    expect(prose).toContain("system.copilot.ask");
    expect(prose).toMatch(/Archiving a row excludes it from every prompt/);
  });
});

describe("approved authorities: each control the migration names is really there", () => {
  it("the door is owner-only on the READ as well as the writes", () => {
    const route = read(AUTHORITIES_ROUTE);
    expect(route).toMatch(/requireOwnerRole\(auth\)/);
    expect(route).toMatch(/requireModuleApiAccess\(auth, "co-pilot"\)/);
    // The owner gate is applied to the listing action too, not only to mutations.
    expect(route).toMatch(/requireClientAccess\(auth/);
  });

  it("the single reader is /api/copilot, behind the module guard and the per-person capability", () => {
    const route = read(COPILOT_ROUTE);
    expect(route).toMatch(/listActiveAuthorities\(client\.id\)/);
    expect(route).toMatch(/requireModuleApiAccess\(auth, "co-pilot"\)/);
    expect(route).toMatch(/requireCapability\(auth, "system\.copilot\.ask"\)/);
  });

  it("no production file outside that route reads the active list", () => {
    const readers = sourceFilesUnder("src")
      .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx"))
      .filter((rel) => read(rel).includes("listActiveAuthorities"));
    expect(readers.sort()).toEqual([COPILOT_ROUTE, REPOSITORY].sort());
  });

  it("archiving really does remove a row from every prompt: the active read filters on status", () => {
    expect(read(REPOSITORY)).toMatch(/listActiveAuthorities[\s\S]{0,400}\.eq\("status", "active"\)/);
  });
});

describe("approved authorities: it is not a send surface, structurally", () => {
  it("nothing in src/lib/knowledge can reach the messaging layer", () => {
    const offenders = sourceFilesUnder("src/lib/knowledge")
      .filter((rel) => !rel.endsWith(".test.ts"))
      .filter((rel) => /@\/lib\/messaging|enqueueSend|_outbox|_touch/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it("it registers no source with the shared drain", () => {
    const sources = Object.keys(DRAIN_SOURCE_TO_SLUG);
    expect(sources.length).toBeGreaterThan(5); // the map is populated, so [] means absent
    expect(sources.filter((s) => /authorit|knowledge/i.test(s))).toEqual([]);
  });

  it("and it schedules no work: no cron file mentions the table", () => {
    const opsDir = join(ROOT, "supabase", "ops");
    const cronFiles = readdirSync(opsDir).filter((f) => f.endsWith(".sql"));
    expect(cronFiles.length).toBeGreaterThan(0); // there ARE cron files to have missed
    const offenders = cronFiles.filter((f) =>
      readFileSync(join(opsDir, f), "utf8").includes("approved_authorit"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("every migration: a slug quoted as a kill switch must have one", () => {
  it("no migration cites a kill switch for a system that is not in the catalog", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"))) {
      const prose = commentProse(read(join(MIGRATIONS_DIR, file)));
      for (const sentence of killSwitchSentences(prose)) {
        for (const slug of quotedSlugs(sentence)) {
          if (isControllableSystem(slug)) continue;
          if (KILL_SWITCH_SLUG_EXEMPTIONS.has(slug)) continue;
          offenders.push(`${file}: '${slug}' is quoted as a kill switch but is not in SYSTEMS`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the sweep actually looks at the migrations (it is not vacuously green)", () => {
    // A guard against the sweep silently reading nothing: 0100's corrected header
    // still discusses kill switches, so there is prose for it to parse, and the
    // directory it walks is the real one.
    const files = readdirSync(join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("0100_approved_authorities.sql");
    expect(killSwitchSentences(commentProse(read(MIGRATION))).length).toBeGreaterThan(0);
  });
});

/** Every .ts/.tsx file under `rel`, as repo-relative paths. */
function sourceFilesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(child);
    }
  };
  walk(rel);
  return out;
}
