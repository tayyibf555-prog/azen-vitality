import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ===========================================================================
// AN OPS FILE'S HEADER IS A CLAIM ABOUT PRODUCTION, SO IT IS CHECKED LIKE ONE.
//
// `supabase/ops/register-*.sql` is how a cron job gets into pg_cron: somebody
// opens the file, reads the header to decide whether it still needs running, and
// runs it. That makes the header a live instruction, not colour — and for months
// five of these files carried a header that was simply false. `app-sweep-outreach`
// said "NOT YET APPLIED" through 6,949 successful runs. `app-sweep-anomaly` said
// the same through 336. `app-prewarm-dentally` said "currently DISABLED in
// production" long after it was re-enabled.
//
// Two different people get hurt by that, in opposite directions:
//
//   * The owner at go-live reads "NOT YET APPLIED" (the roster used to print it
//     under a switched-off row as "Needs first") and believes a SQL step stands
//     between the switch and the first patient message. It does not. The switch
//     IS the last gate — the opposite fail direction, and the one that matters.
//
//   * The engineer who acts on the header RUNS the file. `cron.schedule()` on an
//     existing job name UPDATES it, so running `register-anomaly-cron.sql` as it
//     stood would have moved a job that had been working for months from :45 onto
//     :40 — the hourly Dentally prewarm's own minute. That is the failure this
//     file's schedule assertion exists for.
//
// Ruling W3/22 settles the direction: cron.job is authoritative, the FILE is
// corrected, and a working job is never moved in a review round. This test holds
// the ops directory to that ruling in both directions — a file for a live job must
// say APPLIED and must schedule the minute the live job actually runs; a file for
// a job the scheduler has never heard of must still say it has not been applied,
// so nobody skips a step that really is outstanding.
//
// WHERE THE TRUTH COMES FROM, AND WHY IT IS NOT WRITTEN OUT HERE ANY MORE.
// The read-only `select jobname, schedule, active from cron.job` Fable ran against
// production on 4 September 2026 — CRON.JOB TRUTH under ruling W3/7 — used to be
// copied into this file as a `SCHEDULER` constant of its own, a third copy beside
// the one in `runbook.test.ts` and the table in §2 of the runbook. Ruling W3/31
// ended that: the read lives in `src/lib/agent-wiring/scheduler.ts`, an ordinary
// module, and all three readers import it.
//
// THE THIRD COPY FAILED THE WAY THIRD COPIES DO, hours after it was written. Two
// pre-visit ops files landed under ruling W3/30; the runbook's table and
// runbook.test.ts knew about them and this file did not, so its own "the sweep is
// not vacuous" check went red naming a mismatch that was really a stale copy. With
// the import there is nothing to keep in step: an ops file for a job the module
// already holds needs no edit here at all, and an ops file for a job it does NOT
// hold goes red with a sentence telling the author to record the job.
//
// So the chain is: cron.job → scheduler.ts → { runbook §2, this directory, the
// control panel's list }. Change the scheduler, and whichever of those has not
// been updated goes red — never neither.
// ===========================================================================

import { OPS_FILE, SCHEDULER as CRON_JOB, UNROSTERED_OPS_JOBS } from "./scheduler";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const OPS_DIR = join(REPO_ROOT, "supabase/ops");

/**
 * Every pg_cron job that `supabase/ops` carries registration SQL for, against the
 * live scheduler. The value is the schedule cron.job actually holds, or `null`
 * when the scheduler has never heard of the job.
 *
 * DERIVED FROM THE ONE READ, never restated. A job in `scheduler.ts`'s SCHEDULER
 * contributes its real schedule when it is registered and `null` when it is not;
 * the two marketing-side jobs in `UNROSTERED_OPS_JOBS` are `null` because the same
 * read did not hold them either.
 *
 * A job here is NOT the whole scheduler — twenty-four rows are recorded and only
 * ten of them have an ops file; the other fourteen were registered from
 * `enable-24-7-cron.sql`, the 24/7 runbook, whose own statements are commented
 * out, so this directory holds nothing for them to be checked against.
 * runbook.test.ts holds all twenty-four against §2 of the runbook.
 *
 * This map still has twelve entries, and the two extra are not a contradiction:
 * they are the marketing jobs of `UNROSTERED_OPS_JOBS`, which have ops files and
 * which the scheduler has never held, so they are not among the twenty-four.
 *
 * Every numeral in those two paragraphs is derived and pinned in §4 below. This
 * sentence is exactly what drifted the last time the constant changed shape.
 */
const SCHEDULER: Record<string, string | null> = {
  ...Object.fromEntries(
    Object.entries(OPS_FILE).map(([job]) => [
      job,
      CRON_JOB[job].status === "not registered" ? null : CRON_JOB[job].schedule,
    ]),
  ),
  ...Object.fromEntries(Object.keys(UNROSTERED_OPS_JOBS).map((job) => [job, null])),
};

/** A five-field cron expression, and nothing else. */
const CRON_EXPRESSION = /^[\d*\/,\-]+(\s+[\d*\/,\-]+){4}$/;

/** SQL with every `--` line comment removed, so a commented-out schedule, a
 *  worked example (`enable-24-7-cron.sql` has one) or the inline note between
 *  `app-prewarm-dentally` and its minute can never be read as an instruction. */
function code(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** The file's own STATUS header: the first `-- STATUS:` line, unwrapped. */
function statusLine(sql: string): string | null {
  const m = /^-- STATUS:(.*)$/m.exec(sql);
  return m ? m[1].trim() : null;
}

interface Registration {
  file: string;
  job: string;
  schedule: string;
}

/** Every executable `cron.schedule('app-…', '<cron>', …)` in supabase/ops. */
function registrations(): Registration[] {
  const found: Registration[] = [];
  for (const file of readdirSync(OPS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const body = code(readFileSync(join(OPS_DIR, file), "utf8"));
    for (const [, call] of body.matchAll(/cron\.schedule\(([\s\S]*?)\);/g)) {
      const quoted = [...call.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const job = quoted.find((q) => q.startsWith("app-"));
      const schedule = quoted.find((q) => q !== job && CRON_EXPRESSION.test(q.trim()));
      if (job && schedule) found.push({ file, job, schedule: schedule.trim() });
    }
  }
  return found;
}

const REGISTRATIONS = registrations();

/** Files by job, for the header assertions. */
const FILE_FOR: Record<string, string> = Object.fromEntries(
  REGISTRATIONS.map((r) => [r.job, r.file]),
);

// ---------------------------------------------------------------------------
// 0. The sweep finds what it claims to sweep.
// ---------------------------------------------------------------------------
//
// Every assertion below is a for-loop over parsed SQL, so a parser that silently
// found nothing would turn this whole file green while the directory rotted.

describe("the ops sweep is not vacuous", () => {
  it("parses a registration out of every ops file that has one", () => {
    expect(REGISTRATIONS.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(FILE_FOR).sort()).toEqual(Object.keys(SCHEDULER).sort());
  });

  it("registers no job the one registration-truth module has never heard of", () => {
    // THE FAIL DIRECTION FOR A NEW OPS FILE (ruling W3/31). Every assertion in
    // this file compares a header against what cron.job holds, so a file for a
    // job that is in neither map of scheduler.ts is a file nothing checks — it
    // could open "APPLIED" for a job that does not exist and no test would care.
    // This is the sentence that stops that: record the job in scheduler.ts (and,
    // if an agent owns it, in §2 of the runbook) and every other pin here starts
    // covering the new file for free.
    const unknown = REGISTRATIONS.filter(
      (r) => !(r.job in CRON_JOB) && !(r.job in UNROSTERED_OPS_JOBS),
    ).map((r) => `${r.file} registers ${r.job}, which is not in src/lib/agent-wiring/scheduler.ts`);
    expect(unknown).toEqual([]);
  });

  it("agrees with OPS_FILE about which file holds which job", () => {
    // Both directions. OPS_FILE is what runbook.test.ts uses to decide whether a
    // job's SQL has to be printed in the runbook at all, so a wrong path there
    // silently excuses the document from carrying SQL a practice cannot get
    // anywhere else — and the directory is the only thing that can disprove it.
    for (const [job, file] of Object.entries(OPS_FILE)) {
      expect(FILE_FOR[job], `${OPS_FILE[job]} is named for ${job} but holds no registration`).toBe(
        file.replace("supabase/ops/", ""),
      );
    }
    for (const [job, file] of Object.entries(UNROSTERED_OPS_JOBS)) {
      expect(FILE_FOR[job], `${file} is named for ${job} but holds no registration`).toBe(
        file.replace("supabase/ops/", ""),
      );
    }
  });

  it("reads the executable statement, never a commented-out example", () => {
    // enable-24-7-cron.sql documents the shape in a `--` comment and registers
    // nothing itself. If the stripper ever stopped working, '<name>' would appear
    // as a job and the previous test's key comparison would fail — but this names
    // the reason, so a future reader does not have to infer it from a diff.
    expect(REGISTRATIONS.some((r) => r.file === "enable-24-7-cron.sql")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. A file for a job that IS live says so (rulings W3/7, W3/22).
// ---------------------------------------------------------------------------

describe("an ops file for a registered job states registration truth (W3/22)", () => {
  const live = Object.entries(SCHEDULER).filter(([, s]) => s !== null);

  it("covers the five jobs the scheduler was read to be running", () => {
    expect(live.map(([job]) => job).sort()).toEqual([
      "app-prewarm-dentally",
      "app-purge-assessment-step-events",
      "app-sweep-anomaly",
      "app-sweep-landing-promote",
      "app-sweep-outreach",
    ]);
  });

  it("opens with APPLIED, never with a NOT-applied claim about a job that is running", () => {
    for (const [job] of live) {
      const file = FILE_FOR[job];
      const status = statusLine(readFileSync(join(OPS_DIR, file), "utf8"));
      expect(status, `${file} has no "-- STATUS:" header`).toBeTruthy();
      expect(
        status!.startsWith("APPLIED"),
        `${file}: ${job} is registered and firing, but its header opens "${status}"`,
      ).toBe(true);
      expect(
        /\bNOT\s+(YET\s+)?(APPLIED|REGISTERED)\b/i.test(status!) ||
          /RE-REGISTRATION REQUIRED/i.test(status!),
        `${file}: the STATUS line still claims the job is not registered`,
      ).toBe(false);
    }
  });

  it("schedules the minute the live job actually runs, so running it cannot move it", () => {
    // The defect in the direction it actually failed: register-anomaly-cron.sql
    // said '40 * * * *' while cron.job held '45 * * * *'. cron.schedule() on an
    // existing name UPDATES the job, so an engineer acting on that file would have
    // moved a working hourly pass onto the Dentally prewarm's own minute.
    for (const [job, schedule] of live) {
      const reg = REGISTRATIONS.find((r) => r.job === job)!;
      expect(
        reg.schedule,
        `${reg.file}: ${job} runs on '${schedule}' in production; running this file would move it`,
      ).toBe(schedule);
    }
  });

  it("tells the reader how to check for themselves rather than trusting the header", () => {
    for (const [job] of live) {
      const file = FILE_FOR[job];
      const sql = readFileSync(join(OPS_DIR, file), "utf8");
      expect(sql, `${file} does not carry the cron.job query that would disprove it`).toContain(
        `select jobname, schedule, active from cron.job where jobname = '${job}'`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. And a file for a job that is NOT live still says a step is outstanding.
// ---------------------------------------------------------------------------
//
// The correction above is only safe in one direction. If "say APPLIED" leaked
// onto the closer, the collection run or post-op — three files that are unrun ON
// PURPOSE, because each drafts money or clinical follow-up to a patient — an
// owner would flip a switch believing the scheduler was already holding a job
// that does not exist, and nothing would ever happen. Fail direction is CLOSED:
// an unregistered job must keep saying so.

describe("an ops file for an unregistered job never claims to be applied", () => {
  const unregistered = Object.entries(SCHEDULER).filter(([, s]) => s === null);

  it("covers every ops file whose job the scheduler has never heard of", () => {
    // Seven since ruling W3/30 added the two pre-visit files. Five of the seven
    // are unrun ON PURPOSE (closer, collection, post-op, and the two marketing
    // jobs); the two pre-visit ones are an outstanding go-live step, which is a
    // different thing to a reader and the same thing to this assertion — neither
    // may say APPLIED.
    expect(unregistered.map(([job]) => job).sort()).toEqual([
      "app-sweep-closer",
      "app-sweep-collection",
      "app-sweep-meta-insights",
      "app-sweep-postop",
      "app-sweep-previsit",
      "app-sweep-previsit-mining",
      "app-sweep-winning-ads-ingest",
    ]);
  });

  it("states plainly that it has not been applied", () => {
    for (const [job] of unregistered) {
      const file = FILE_FOR[job];
      const status = statusLine(readFileSync(join(OPS_DIR, file), "utf8"));
      expect(status, `${file} has no "-- STATUS:" header`).toBeTruthy();
      expect(
        /\bNOT\s+(YET\s+)?(APPLIED|REGISTERED)\b/i.test(status!),
        `${file}: ${job} is not in cron.job, but its header opens "${status}"`,
      ).toBe(true);
      expect(status!.startsWith("APPLIED")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The whole directory answers to the one read, and nothing is left over.
// ---------------------------------------------------------------------------
//
// This used to be a re-parse of §2 of the runbook, asserting that the markdown
// table and this file's own copy of cron.job agreed. That was a patch for having
// two copies, not a check worth having: ruling W3/31 deleted the copy, and
// runbook.test.ts § "gives each job the schedule, route and status the scheduler
// actually has" already holds §2 row-for-row against the same module this file
// imports. Re-reading the table here would test the markdown parser twice and the
// scheduler nowhere.
//
// WHAT IS WORTH HAVING INSTEAD is the direction nothing else covers: every file in
// the directory is accounted for. A `register-*.sql` whose job appears in neither
// map of scheduler.ts is unchecked by every assertion above (§0 catches it), and a
// map entry naming a file that carries no such registration is a signpost into
// thin air (§0 catches that too). What is left is the count, so that deleting an
// ops file cannot quietly shrink this suite to a handful of green loops.

describe("every registration file in the directory is accounted for", () => {
  it("holds a registration for each of the twelve jobs the module records", () => {
    expect(Object.keys(OPS_FILE)).toHaveLength(10);
    expect(Object.keys(UNROSTERED_OPS_JOBS)).toHaveLength(2);
    expect(REGISTRATIONS.map((r) => r.job).sort()).toEqual(
      [...Object.keys(OPS_FILE), ...Object.keys(UNROSTERED_OPS_JOBS)].sort(),
    );
  });

  it("checks a header for every one of them", () => {
    // Non-vacuity for the two describes above, which are for-loops over subsets:
    // five live plus seven unregistered is every job, so no file can fall between
    // the two loops and go unchecked.
    const live = Object.values(SCHEDULER).filter((s) => s !== null).length;
    const dead = Object.values(SCHEDULER).filter((s) => s === null).length;
    expect(live).toBe(5);
    expect(dead).toBe(7);
    expect(live + dead).toBe(REGISTRATIONS.length);
  });
});

// ---------------------------------------------------------------------------
// 4. And the header's own arithmetic answers to the module as well.
// ---------------------------------------------------------------------------
//
// The sentence at the top of `SCHEDULER` counts the scheduler for a reader who is
// deciding whether a file is missing, and it was the one thing left in this file
// that was typed rather than derived. It drifted the moment the constant became an
// import: the left-hand number grew correctly (the five "not registered" rows
// joined the map) and the right-hand one grew wrongly, by folding in the two
// `UNROSTERED_OPS_JOBS` marketing jobs — which are, by construction, NOT among the
// rows the scheduler holds; that separation is the whole reason the second map
// exists. Nothing went red: §3 asserts the two sizes without ever comparing them to
// the prose, and the tree's only crawl over test prose (`claimsATotal` in
// roster.test.ts) is scoped to the roster.
//
// A reader who subtracts one number from the other — which is exactly the audit
// ruling W3/7 asks for, reconciling this directory against cron.job — then starts
// from a denominator two files wrong, and cannot tell whether a file is missing.
// So the numerals are computed from the module here and the header is held to
// them, word for word. Adding a job to `scheduler.ts` reddens this until the
// sentence is rewritten, which is the direction that failed.

describe("the header's count of the scheduler is derived, not remembered", () => {
  /** This file's own comments, unwrapped, so a reflow cannot break a pin that a
   *  changed numeral should. The assertions below build their sentences from the
   *  module, so the template literals that state them never match themselves. */
  const HEADER = readFileSync(join(__dirname, "ops-cron-registration.test.ts"), "utf8")
    .replace(/\n\s*(?:\*|\/\/)\s?/g, " ");

  /** English for a small count, so the assertion reads as the header writes. */
  const NUMERAL = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two",
    "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven",
    "twenty-eight", "twenty-nine", "thirty", "thirty-one", "thirty-two",
    "thirty-three", "thirty-four", "thirty-five", "thirty-six", "thirty-seven",
    "thirty-eight", "thirty-nine", "forty",
  ];
  function word(n: number): string {
    expect(NUMERAL[n], `no English word for ${n} — extend NUMERAL`).toBeTruthy();
    return NUMERAL[n];
  }

  /** Scheduler rows, and how many of them this directory carries a file for. */
  const ROWS = Object.keys(CRON_JOB).length;
  const WITH_FILE = Object.keys(OPS_FILE).filter((job) => job in CRON_JOB).length;

  it("counts the ops files against the scheduler's rows, not against this map", () => {
    // The two are different numbers and the header said they were one: OPS_FILE is
    // a subset of the scheduler, UNROSTERED_OPS_JOBS is disjoint from it, and only
    // the first kind can be "N of the scheduler's rows".
    expect(Object.keys(OPS_FILE).filter((job) => !(job in CRON_JOB))).toEqual([]);
    expect(Object.keys(UNROSTERED_OPS_JOBS).filter((job) => job in CRON_JOB)).toEqual([]);
    expect(WITH_FILE).toBe(Object.keys(OPS_FILE).length);

    expect(
      HEADER,
      `the header no longer says "${word(ROWS)} rows … only ${word(WITH_FILE)} of them have an ops file"`,
    ).toContain(`${word(ROWS)} rows are recorded and only ${word(WITH_FILE)} of them have an ops file`);
  });

  it("says how many rows this directory therefore cannot check, and is right", () => {
    expect(HEADER).toContain(`the other ${word(ROWS - WITH_FILE)} were registered from`);
    expect(HEADER).toContain(`runbook.test.ts holds all ${word(ROWS)} against §2 of the runbook`);
  });

  it("states this map's own size as the sum it is, so it is never read as the scheduler's", () => {
    expect(Object.keys(SCHEDULER)).toHaveLength(
      Object.keys(OPS_FILE).length + Object.keys(UNROSTERED_OPS_JOBS).length,
    );
    expect(HEADER).toContain(`This map still has ${word(Object.keys(SCHEDULER).length)} entries`);
    expect(HEADER).toContain(`they are not among the ${word(ROWS)}`);
  });
});
