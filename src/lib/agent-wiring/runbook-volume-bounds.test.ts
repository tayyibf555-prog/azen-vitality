// THE RUNBOOK'S "VOLUME BOUND" IS THE VOLUME BOUND, NOT THE MODEL BUDGET.
//
// WHY THIS EXISTS. Two agents in docs/runbooks/agent-switch-on.md answered the
// question "how many patients can this reach on its first tick?" with the wrong
// pair of environment variables:
//
//     **Volume bound.** `CLOSER_DRAFT_BUDGET_LIMIT` drafts per
//     `CLOSER_DRAFT_BUDGET_WINDOW`; `CLOSER_COOLDOWN_HOURS` between chases…
//
// `CLOSER_DRAFT_BUDGET_LIMIT` is the MODEL-cost guard in src/lib/closer/draft.ts
// (200 drafts an hour, shared across sites, there so a stuck loop cannot burn
// Anthropic spend). The volume an owner is actually asking about is
// DEFAULT_CLOSER_CONFIG — 500 plans examined and 25 drafts written per run — and
// the old sentence named neither, with no figure at all. Balance reminders
// carried the identical error. src/lib/agent-wiring/roster.ts (what the SCREENS
// print) was corrected in an earlier round; the runbook (what the person doing
// go-live reads, with his hand on the switch) still said the old thing, and the
// two documents disagreeing is how a deployer concludes a run can reach 200
// patients when it can reach 25.
//
// WHY A TEST. Nothing else can see it. The runbook is prose: tsc does not read
// it, eslint does not read it, and `grep -rn 'Volume bound' src/` was empty, so
// the corrected paragraph could rot back to a stale figure the moment somebody
// tunes DEFAULT_CLOSER_CONFIG and it would go red nowhere. This guard reads the
// two paragraphs out of the markdown and holds them to the constants the sweeps
// actually run on, so changing a cap without changing the runbook fails HERE.
//
// AND IT IS ASSERTED OFF THE PARSED CONSTANTS, NEVER OFF A LITERAL. Writing
// `expect(text).toContain("500")` would pin the prose to a number this file
// invented and would survive the mutation that matters (moving the cap). The
// numbers below all come from the modules: the per-run caps by importing the
// config objects, the model-budget defaults by reading the `?? "200"` fallback
// out of draft.ts, which is where they are written.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { DEFAULT_CLOSER_CONFIG } from "@/lib/closer/types";
import { DEFAULT_COLLECTION_CONFIG } from "@/lib/collection/types";

// Through import.meta.url, never process.cwd(), so it reads THIS repo's runbook
// and not a worktree copy's (the source-hygiene precedent).
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNBOOK = join(REPO_ROOT, "docs", "runbooks", "agent-switch-on.md");

function runbook(): string {
  return readFileSync(RUNBOOK, "utf8");
}

/** The body of one `### …` agent section, up to the next heading of any level. */
function section(headingContains: string): string {
  const text = runbook();
  const start = text.indexOf(`### ${headingContains}`);
  expect(start, `no "### ${headingContains}" section in the runbook`).toBeGreaterThan(-1);
  const next = text.indexOf("\n### ", start + 1);
  const end = next === -1 ? text.length : next;
  return text.slice(start, end);
}

/** The `**Volume bound.**` paragraph of a section, with newlines flattened. */
function volumeBound(headingContains: string): string {
  const body = section(headingContains);
  const start = body.indexOf("**Volume bound.**");
  expect(start, `the "${headingContains}" section no longer states a volume bound`).toBeGreaterThan(-1);
  const end = body.indexOf("\n\n", start);
  return body
    .slice(start, end === -1 ? body.length : end)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The default written into a `process.env.NAME ?? "…"` fallback, read out of the
 * module that owns it. These two budgets are inline literals rather than exported
 * constants, so the only honest way to assert the runbook agrees with them is to
 * read them where they live.
 */
function envFallback(file: string, name: string): string {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  const match = source.match(new RegExp(`process\\.env\\.${name}\\s*\\?\\?\\s*"([^"]+)"`));
  expect(match, `${file} no longer defaults ${name} with a ?? "…" fallback`).not.toBeNull();
  return match![1];
}

describe("the treatment-plan closer's runbook bound is its per-run cap", () => {
  const CLOSER = "Treatment-plan closer";

  it("states the plans-examined and drafts-written caps the sweep actually runs on", () => {
    const bound = volumeBound(CLOSER);
    expect(bound, "the runbook does not state how many plans a run examines").toContain(
      String(DEFAULT_CLOSER_CONFIG.maxExaminedPerRun),
    );
    expect(bound, "the runbook does not state how many drafts a run writes").toContain(
      String(DEFAULT_CLOSER_CONFIG.maxDraftsPerRun),
    );
    expect(bound, "the runbook does not name the env vars that move those caps").toContain(
      "CLOSER_MAX_EXAMINED_PER_RUN",
    );
    expect(bound).toContain("CLOSER_MAX_DRAFTS_PER_RUN");
  });

  it("states the cooldown in hours, not just its variable name", () => {
    const bound = volumeBound(CLOSER);
    expect(bound).toContain("CLOSER_COOLDOWN_HOURS");
    expect(bound, "the cooldown is named but its value is not stated").toContain(
      String(DEFAULT_CLOSER_CONFIG.cooldownHours),
    );
  });

  it("never presents the model budget as the volume a run can reach", () => {
    const bound = volumeBound(CLOSER);
    // The budget MAY be mentioned — a deployer should know it exists — but only
    // where the sentence says what it is. This is the exact defect: the paragraph
    // used to offer CLOSER_DRAFT_BUDGET_LIMIT as the answer to "how many
    // patients?".
    if (bound.includes("CLOSER_DRAFT_BUDGET_LIMIT")) {
      expect(
        /model spend/i.test(bound),
        "CLOSER_DRAFT_BUDGET_LIMIT appears in the volume bound without being labelled as the model-cost guard it is",
      ).toBe(true);
      expect(bound, "the model budget's own default is quoted wrongly or not at all").toContain(
        envFallback("src/lib/closer/draft.ts", "CLOSER_DRAFT_BUDGET_LIMIT"),
      );
    }
  });
});

describe("balance reminders' runbook bound is its per-run cap", () => {
  const COLLECTION = "Balance reminders";

  it("states all three per-run caps, including the Dentally verification reads", () => {
    const bound = volumeBound(COLLECTION);
    // The verification reads are the half that costs the practice's shared
    // Dentally budget, so a deployer who does not see that number cannot reason
    // about a tick's cost at all.
    expect(bound, "the runbook does not state how many accounts a run examines").toContain(
      String(DEFAULT_COLLECTION_CONFIG.maxExaminedPerRun),
    );
    expect(bound, "the runbook does not state how many balances a run verifies").toContain(
      String(DEFAULT_COLLECTION_CONFIG.maxVerifyReadsPerRun),
    );
    expect(bound, "the runbook does not state how many drafts a run writes").toContain(
      String(DEFAULT_COLLECTION_CONFIG.maxDraftsPerRun),
    );
    for (const name of [
      "COLLECTION_MAX_EXAMINED_PER_RUN",
      "COLLECTION_MAX_VERIFY_READS_PER_RUN",
      "COLLECTION_MAX_DRAFTS_PER_RUN",
    ]) {
      expect(bound, `the runbook does not name ${name}`).toContain(name);
    }
  });

  it("states the cooldown in hours, not just its variable name", () => {
    const bound = volumeBound(COLLECTION);
    expect(bound).toContain("COLLECTION_COOLDOWN_HOURS");
    expect(bound).toContain(String(DEFAULT_COLLECTION_CONFIG.cooldownHours));
  });

  it("never presents the model budget as the volume a run can reach", () => {
    const bound = volumeBound(COLLECTION);
    if (bound.includes("COLLECTION_DRAFT_BUDGET_LIMIT")) {
      expect(
        /model spend/i.test(bound),
        "COLLECTION_DRAFT_BUDGET_LIMIT appears in the volume bound without being labelled as the model-cost guard it is",
      ).toBe(true);
      expect(bound).toContain(envFallback("src/lib/collection/draft.ts", "COLLECTION_DRAFT_BUDGET_LIMIT"));
    }
  });
});

describe("the runbook and the roster tell the deployer the same thing", () => {
  // The roster is what the systems view and the co-pilot's agent_status print;
  // the runbook is what a person reads at go-live. They were allowed to drift
  // once already — the roster was corrected in an earlier round and the runbook
  // was not — which is the whole reason this file exists.
  const roster = readFileSync(join(REPO_ROOT, "src", "lib", "agent-wiring", "roster.ts"), "utf8").replace(
    /\s+/g,
    " ",
  );

  it("the roster's own bound sentences carry the same per-run figures", () => {
    for (const value of [
      DEFAULT_CLOSER_CONFIG.maxExaminedPerRun,
      DEFAULT_CLOSER_CONFIG.maxDraftsPerRun,
      DEFAULT_COLLECTION_CONFIG.maxExaminedPerRun,
      DEFAULT_COLLECTION_CONFIG.maxVerifyReadsPerRun,
      DEFAULT_COLLECTION_CONFIG.maxDraftsPerRun,
    ]) {
      expect(
        roster.includes(`At most ${value} `) || roster.includes(` ${value} `),
        `the roster no longer states ${value}; the screen and the runbook now disagree about a per-run cap`,
      ).toBe(true);
    }
  });
});
