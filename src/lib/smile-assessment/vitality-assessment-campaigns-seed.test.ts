import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidSlug, GOAL_KEYS } from "./campaign";

// Requirement: the three campaigns seeded by migration 0060 must have valid
// slugs/goals and clean, compliant patient-facing copy. Rather than duplicate
// the values, this test reads the ACTUAL migration file and parses its insert
// tuples, so the seed can never drift out of spec. Mirrors the 0056/0057/0058
// landing-page seed tests (src/lib/landing/hygiene-seed-content.test.ts etc.).

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/0060_vitality_assessment_campaigns.sql",
);

// Mirrors the FORBIDDEN set in area16-18-patient-copy-jargon.test.ts (NHS/
// private/privately), plus the two extra house-style rules the landing-page
// lint enforces (src/lib/landing/compliance.ts): no em/en-dash, no
// "guarantee(d/s)" wording.
const FORBIDDEN = [/\bNHS\b/i, /\bprivate\b/i, /\bprivately\b/i, /[—–]/, /\bguarantee(?:d|s)?\b/i];

function assertClean(label: string, text: string): void {
  for (const re of FORBIDDEN) {
    expect(re.test(text), `"${label}" -> "${text}" fails the jargon/compliance rule ${re}`).toBe(false);
  }
}

interface SeededCampaign {
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  goal: string;
  targetBudget: string;
  headline: string;
  intro: string;
  status: string;
  createdBy: string;
}

/** Parse every `insert into smile_assessment_campaign (...) values (...)`
 *  tuple from the migration. Deliberately simple/regex-based (no SQL parser
 *  dependency) — the column list is fixed to the order this migration writes
 *  it in: (client_id, site_id, slug, name, goal, target_budget, headline,
 *  intro, status, created_by). */
function seededCampaigns(): SeededCampaign[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const pattern =
    /\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\s*\)\s*\non conflict/g;
  const out: SeededCampaign[] = [];
  for (const m of sql.matchAll(pattern)) {
    out.push({
      clientId: m[1]!,
      siteId: m[2]!,
      slug: m[3]!,
      name: m[4]!,
      goal: m[5]!,
      targetBudget: m[6]!,
      headline: m[7]!,
      intro: m[8]!,
      status: m[9]!,
      createdBy: m[10]!,
    });
  }
  return out;
}

describe("0060 vitality assessment campaigns seed", () => {
  const campaigns = seededCampaigns();

  it("seeds exactly three campaigns", () => {
    expect(campaigns).toHaveLength(3);
  });

  it("seeds the expected slugs, each with a valid, catalogued goal", () => {
    expect(campaigns.map((c) => c.slug).sort()).toEqual(["bonding", "hygiene", "invisalign"]);
    for (const c of campaigns) {
      expect(isValidSlug(c.slug)).toBe(true);
      expect(GOAL_KEYS).toContain(c.goal);
      // The slug IS the goal for these three (one campaign per treatment).
      expect(c.goal).toBe(c.slug);
    }
  });

  it("targets vitality / site-cc, active, created by system", () => {
    for (const c of campaigns) {
      expect(c.clientId).toBe("vitality");
      expect(c.siteId).toBe("site-cc");
      expect(c.status).toBe("active");
      expect(c.createdBy).toBe("system");
    }
  });

  it("name/headline/intro pass the patient-copy jargon + compliance rules", () => {
    for (const c of campaigns) {
      assertClean(`${c.slug}.name`, c.name);
      assertClean(`${c.slug}.headline`, c.headline);
      assertClean(`${c.slug}.intro`, c.intro);
      // Non-empty patient-facing copy (no placeholder blanks slipped in).
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.intro.length).toBeGreaterThan(0);
    }
  });

  it("the hygiene campaign is framed around a fresh, healthy visit, not clinical jargon", () => {
    const hygiene = campaigns.find((c) => c.slug === "hygiene")!;
    expect(hygiene.goal).toBe("hygiene");
    expect(`${hygiene.headline} ${hygiene.intro}`.toLowerCase()).toMatch(/fresh|healthy/);
    expect(`${hygiene.headline} ${hygiene.intro}`.toLowerCase()).toMatch(/book a hygiene visit/);
  });

  it("is idempotent: every insert has an ON CONFLICT (client_id, slug) DO NOTHING guard", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const inserts = sql.match(/insert into smile_assessment_campaign/g) ?? [];
    const guards = sql.match(/on conflict \(client_id, slug\) do nothing/g) ?? [];
    expect(inserts).toHaveLength(3);
    expect(guards).toHaveLength(inserts.length);
  });
});
