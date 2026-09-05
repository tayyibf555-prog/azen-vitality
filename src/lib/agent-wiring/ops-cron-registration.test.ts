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
// WHERE THE TRUTH COMES FROM. `SCHEDULER` below is the read-only
// `select jobname, schedule, active from cron.job` Fable ran against production on
// 4 September 2026, recorded as CRON.JOB TRUTH under ruling W3/7 — the same read
// that `src/lib/agent-wiring/runbook.test.ts` holds as its own `SCHEDULER` and
// that §2 of `docs/runbooks/agent-switch-on.md` prints as a table. Three copies of
// one read is one copy too many (handoff H109 proposes promoting it to
// `src/lib/agent-wiring/scheduler.ts` and projecting it), so until that happens the
// last describe below reads the runbook's table and asserts the two agree. Change
// the scheduler, and either this file or that one goes red — never neither.
// ===========================================================================

const REPO_ROOT = join(__dirname, "..", "..", "..");
const OPS_DIR = join(REPO_ROOT, "supabase/ops");
const RUNBOOK = join(REPO_ROOT, "docs/runbooks/agent-switch-on.md");

/**
 * Every pg_cron job that `supabase/ops` carries registration SQL for, against the
 * live scheduler. The value is the schedule cron.job actually holds, or `null`
 * when the scheduler has never heard of the job.
 *
 * A job here is NOT the whole scheduler — nineteen rows exist and only ten of them
 * have an ops file (the rest were registered from `enable-24-7-cron.sql`, which
 * contains no executable statement of its own). runbook.test.ts holds all nineteen.
 */
const SCHEDULER: Record<string, string | null> = {
  // Registered, active, firing (cron.job + cron.job_run_details, 4 Sep 2026).
  "app-purge-assessment-step-events": "43 4 * * *",
  "app-prewarm-dentally": "40 * * * *",
  "app-sweep-anomaly": "45 * * * *",
  "app-sweep-landing-promote": "17 3 * * *",
  "app-sweep-outreach": "*/10 * * * *",
  // Written, deliberately never run. The schedule in each file is a PROPOSAL, so
  // there is nothing to compare it against and none is recorded here.
  "app-sweep-closer": null,
  "app-sweep-collection": null,
  "app-sweep-postop": null,
  "app-sweep-meta-insights": null,
  "app-sweep-winning-ads-ingest": null,
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
    expect(REGISTRATIONS.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(FILE_FOR).sort()).toEqual(Object.keys(SCHEDULER).sort());
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

  it("covers the five that were written and deliberately not run", () => {
    expect(unregistered).toHaveLength(5);
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
// 3. This file and the runbook hold the same read.
// ---------------------------------------------------------------------------
//
// §2 of the runbook prints the scheduler as a table, and runbook.test.ts pins that
// table to its own copy of the same read. So the chain is: cron.job → runbook §2 →
// runbook.test.ts, and this joins the fourth link. Until handoff H109 promotes the
// read to one module, this is what stops a correction landing in one place only.

describe("the runbook's §2 table and this file's SCHEDULER agree", () => {
  const md = readFileSync(RUNBOOK, "utf8");

  // One §2 row: a job name, its schedule, its route and its status, each in
  // backticks or bold between pipes.
  function tableRows(): Record<string, { schedule: string; status: string }> {
    const start = md.indexOf("## 2. Cron registration");
    const end = md.indexOf("## 3. The agents", start + 1);
    const rows: Record<string, { schedule: string; status: string }> = {};
    if (start === -1 || end === -1) return rows;
    for (const line of md.slice(start, end).split("\n")) {
      const m = /^\|\s*`(app-[a-z0-9-]+)`\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$/.exec(line);
      if (!m) continue;
      const cell = (s: string) => s.trim().replace(/^`|`$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
      rows[m[1]] = { schedule: cell(m[2]), status: cell(m[4]) };
    }
    return rows;
  }

  const rows = tableRows();

  it("finds the runbook table where §2 says it is", () => {
    // Non-vacuity: without this, a renamed heading would make every comparison
    // below iterate an empty object and pass.
    expect(Object.keys(rows).length).toBeGreaterThanOrEqual(15);
  });

  it("agrees with §2 on every job that has an ops file", () => {
    for (const [job, schedule] of Object.entries(SCHEDULER)) {
      const row = rows[job];
      if (!row) continue; // meta-insights and winning-ads are not agents; §2 omits them
      const registered = row.status !== "not registered";
      expect(registered, `§2 and this file disagree about whether ${job} exists`).toBe(
        schedule !== null,
      );
      if (schedule !== null) {
        expect(row.schedule, `§2 and this file disagree about ${job}'s schedule`).toBe(schedule);
      }
    }
  });

  it("cross-checks enough rows to be worth having", () => {
    const checked = Object.keys(SCHEDULER).filter((job) => rows[job]);
    expect(checked.length).toBeGreaterThanOrEqual(8);
  });
});
