// ===========================================================================
// WHAT THE SCHEDULER ACTUALLY HOLDS, AS A MODULE THE PLATFORM CAN READ.
//
// Ruling W3/7: "the runbook and the systems view state REGISTRATION TRUTH: what
// cron.job actually holds." The runbook half was straightforward — a table in
// docs/runbooks/agent-switch-on.md §2, pinned row-for-row by runbook.test.ts.
// The SCREEN half was not, and the reason is this file's whole purpose.
//
// THE DEFECT THIS EXISTS TO END. Registration truth used to live only as a
// constant inside runbook.test.ts. A test file is not importable by the
// application, so when the control panel needed to warn that a switched-ON
// system has no job to run it, the four slugs had to be typed out a second time
// inside a "use client" component (`SWEEPS_WITH_NO_CRON_JOB` in
// src/components/client/systems/systems-view.tsx), and a third test was written
// to keep the copy honest by parsing the markdown table. Three places, two of
// them derived by string matching, for one fact. That is the same shape as the
// three partial registries the roster itself was written to join.
//
// So the data moves here, to an ordinary module with no React and no filesystem
// access, which means:
//
//   - runbook.test.ts pins the document against it, in both directions;
//   - ops-cron-registration.test.ts checks every `supabase/ops/register-*.sql`
//     header against it, so a file cannot claim to be applied for a job the
//     scheduler has never heard of (ruling W3/22);
//   - src/components/client/systems/cron-registration.test.ts holds the control
//     panel's own list to `slugsWithNoScheduledJob()`;
//   - home's OS band qualifies a tile that would otherwise read "0 sent,
//     awaiting an answer" for a sweep that cannot run at all.
//
// ONE COPY IS LEFT, and it is named rather than hidden: `SWEEPS_WITH_NO_CRON_JOB`
// in the "use client" component src/components/client/systems/systems-view.tsx.
// It is held equal to `slugsWithNoScheduledJob()` by the test above, so it cannot
// drift silently; deleting it outright means /api/systems projecting a per-row
// `cannotRunYet` from this module, which is a route change and a handoff.
//
// IT IS A RECORD OF A READ, NOT AN AUTHORITY. Vitest makes no network calls and
// neither does a rendered page: nothing here is queried from Postgres at
// runtime. The values are what `cron.job` held on 4 September 2026, read with
//
//     select jobname, schedule, active from cron.job order by jobname;
//
// against the production project and cross-checked against `cron.job_run_details`
// so that "registered" means "has run", not "has a row". If a row here disagrees
// with the scheduler, the scheduler is right: re-read it, update this file AND
// §2 of the runbook in the same edit (runbook.test.ts fails until both agree),
// and date the note.
//
// MCP is read-only on cron.job, so registering a job is something Tayyib or the
// client runs by hand — which is exactly why the fact has to be visible on the
// screen that offers the switch.
// ===========================================================================

import { AGENTS } from "./roster";

export type JobStatus = "registered" | "registered, INACTIVE" | "not registered";

export interface SchedulerJob {
  /** The cron expression, in the scheduler's own UTC. */
  schedule: string;
  /** The route the job POSTs, or a plain description where there is none. */
  route: string;
  status: JobStatus;
}

/**
 * cron.job, production, 4 September 2026. Nineteen rows exist; five more are
 * routes the platform has a sweep for and the scheduler has never heard of.
 *
 * `app-sync-dentally` is the row in between: the job exists and is switched off
 * at the scheduler (last successful run 5 July 2026), which is a different
 * repair from an absent job — cron.alter_job, not cron.schedule.
 */
export const SCHEDULER: Record<string, SchedulerJob> = {
  "app-drain": { schedule: "*/5 * * * *", route: "/api/messaging/drain", status: "registered" },
  "app-sweep-speed-to-lead": { schedule: "* * * * *", route: "/api/speed-to-lead/sweep", status: "registered" },
  "app-sweep-recall": { schedule: "*/10 * * * *", route: "/api/recall/sweep", status: "registered" },
  "app-sweep-reactivation": { schedule: "*/10 * * * *", route: "/api/reactivation/sweep", status: "registered" },
  "app-sweep-noshow": { schedule: "*/10 * * * *", route: "/api/noshow/sweep", status: "registered" },
  "app-sweep-coordinator": { schedule: "*/10 * * * *", route: "/api/coordinator/sweep", status: "registered" },
  "app-sweep-outreach": { schedule: "*/10 * * * *", route: "/api/outreach/sweep", status: "registered" },
  "app-sweep-reviews": { schedule: "*/15 * * * *", route: "/api/reviews/sweep", status: "registered" },
  "app-sweep-anomaly": { schedule: "45 * * * *", route: "/api/anomaly/sweep", status: "registered" },
  "app-sweep-rota": { schedule: "0 6 * * *", route: "/api/rota/sweep", status: "registered" },
  "app-sweep-landing-promote": {
    schedule: "17 3 * * *",
    route: "/api/landing-pages/promote-sweep",
    status: "registered",
  },
  "app-prewarm-dentally": { schedule: "40 * * * *", route: "/api/dentally/prewarm", status: "registered" },
  "app-purge-assessment-step-events": {
    schedule: "43 4 * * *",
    route: "(in-database delete, no route)",
    status: "registered",
  },
  "app-sync-reactivation": { schedule: "5 * * * *", route: "/api/sync/reactivation", status: "registered" },
  "app-sync-recall": { schedule: "10 * * * *", route: "/api/sync/recall", status: "registered" },
  "app-sync-noshow": { schedule: "15 * * * *", route: "/api/sync/noshow", status: "registered" },
  "app-sync-coordinator": { schedule: "20 * * * *", route: "/api/sync/coordinator", status: "registered" },
  "app-sync-patient-count": { schedule: "15 3 * * *", route: "/api/sync/patient-count", status: "registered" },
  "app-sync-dentally": { schedule: "0 * * * *", route: "/api/sync/dentally", status: "registered, INACTIVE" },
  "app-sweep-closer": { schedule: "17 * * * *", route: "/api/closer/sweep", status: "not registered" },
  "app-sweep-collection": { schedule: "40 6 * * *", route: "/api/collection/sweep", status: "not registered" },
  "app-sweep-postop": { schedule: "25 * * * *", route: "/api/postop/sweep", status: "not registered" },
  "app-sweep-previsit": { schedule: "*/10 * * * *", route: "/api/previsit/sweep", status: "not registered" },
  "app-sweep-previsit-mining": {
    schedule: "20 2 * * *",
    route: "/api/previsit/mining-sweep",
    status: "not registered",
  },
};

/**
 * The registration SQL that exists as a file, for every job in SCHEDULER. A job
 * with no entry here has no ops file, so ruling W3/7 puts its SQL in the runbook
 * itself — which is the whole reason the pre-visit questionnaire could never
 * have sent in production.
 *
 * IT IS COMPLETE OVER `supabase/ops`, not a shortlist of the interesting ones,
 * and `ops-cron-registration.test.ts` holds it to the directory in both
 * directions. It was a shortlist until 5 September 2026: three files for jobs
 * that are live and therefore never take the runbook-SQL branch were simply
 * missing, so the sentence above ("a job with no entry here has no ops file")
 * was false for three of the nineteen and nothing said so.
 *
 * THE TWO PRE-VISIT JOBS NOW HAVE FILES (ruling W3/30, 5 September 2026). Their
 * SQL stayed in §2 of the runbook as well, deliberately: the runbook is what the
 * person doing go-live reads, and runbook.test.ts holds the file, the table and
 * this map to each other, so a correction cannot land in one of the three only.
 * `runbook.test.ts` § "carries the registration SQL for every job that has no
 * ops file (W3/7)" is what changes shape when an entry is added here: the job
 * moves from the runbook-SQL branch to the file-exists branch.
 */
export const OPS_FILE: Record<string, string> = {
  "app-sweep-closer": "supabase/ops/register-closer-cron.sql",
  "app-sweep-collection": "supabase/ops/register-collection-cron.sql",
  "app-sweep-postop": "supabase/ops/register-postop-cron.sql",
  "app-sweep-outreach": "supabase/ops/register-outreach-cron.sql",
  "app-sweep-anomaly": "supabase/ops/register-anomaly-cron.sql",
  "app-sweep-previsit": "supabase/ops/register-previsit-cron.sql",
  "app-sweep-previsit-mining": "supabase/ops/register-previsit-mining-cron.sql",
  "app-prewarm-dentally": "supabase/ops/register-dentally-prewarm-cron.sql",
  "app-sweep-landing-promote": "supabase/ops/register-landing-promote-cron.sql",
  "app-purge-assessment-step-events": "supabase/ops/purge-assessment-step-events.sql",
};

/**
 * The two cron jobs `supabase/ops` carries SQL for that no rostered agent owns:
 * the Meta insights refresh and the winning-ads ingest, both marketing-side.
 *
 * They are recorded APART FROM `SCHEDULER` rather than inside it because §2 of
 * the runbook is the AGENTS' cron table and `runbook.test.ts` pins that table
 * key-for-key against SCHEDULER — adding a job the agents' runbook has no
 * business describing would put two rows in an owner-facing document to satisfy
 * a test. They belong here all the same: the point of this module is that ONE
 * read of `cron.job` answers for the whole tree, and an ops file whose job is in
 * neither map is an ops file nobody has checked. Neither was in the 4 September
 * read, so neither is registered.
 */
export const UNROSTERED_OPS_JOBS: Record<string, string> = {
  "app-sweep-meta-insights": "supabase/ops/register-meta-insights-cron.sql",
  "app-sweep-winning-ads-ingest": "supabase/ops/register-winning-ads-ingest-cron.sql",
};

/** Every route the platform exposes a sweep for that the scheduler never calls. */
export function unregisteredRoutes(): string[] {
  return Object.values(SCHEDULER)
    .filter((j) => j.status === "not registered")
    .map((j) => j.route)
    .sort();
}

/**
 * The owner switches whose sweep has no scheduled job at all — the slugs for
 * which "switched on" and "running" are different things.
 *
 * Derived, never listed: the roster names a FILE for each agent's trigger
 * ("src/app/api/closer/sweep/route.ts") and the scheduler names the ROUTE it
 * calls ("/api/closer/sweep"). One is the other, so registering a job later
 * shortens this set without anybody remembering to edit a list.
 *
 * A route with no rostered agent contributes nothing, which is correct rather
 * than lossy: /api/previsit/mining-sweep shares `pre-visit-triage` with the
 * questionnaire sweep, and that slug is already in the set.
 */
export function slugsWithNoScheduledJob(): string[] {
  const routes = new Set(unregisteredRoutes());
  const slugs = new Set<string>();
  for (const agent of AGENTS) {
    if (!agent.slug) continue;
    const route = agent.trigger.replace(/^src\/app/, "").replace(/\/route\.ts$/, "");
    if (routes.has(route)) slugs.add(agent.slug);
  }
  return [...slugs].sort();
}
