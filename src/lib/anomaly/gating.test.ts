import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ===========================================================================
// THE SAFE POSTURE, PROVEN FROM THE SOURCE RATHER THAN ASSERTED IN A COMMENT.
//
// House law here is that an absent system_toggle row means ENABLED, so every new
// surface needs BOTH a catalog `defaultEnabled: false` AND an explicit disabled
// seed row — two independent mechanisms, because the catalog covers every
// database and the seed covers every owner who has already opened the panel.
// This file checks both, and checks the third thing that matters just as much:
// that the ops file agrees with the job that is actually registered. It used to
// say the opposite here — "the cron file is written and deliberately NOT
// registered" — and that was false about production. See the W3/22 block above
// that describe for the full account; registration truth itself is `SCHEDULER`
// in src/lib/agent-wiring/runbook.test.ts, read from cron.job on 4 Sep 2026.
//
// It also pins what this module is NOT. The single largest risk in shipping an
// "alerting layer" is that it quietly grows a send path — an SMS to the owner at
// 3am, an email digest — without going through the shared drain, the consent
// gate and a toggle. The structural checks below make that impossible to do by
// accident: nothing in src/lib/anomaly may import the messaging layer, and the
// module registers no drain source.
// ===========================================================================

import { DEFAULT_OFF_SLUGS, DRAIN_SOURCE_TO_SLUG, SYSTEM_BY_SLUG, defaultEnabledFor } from "@/lib/systems/catalog";
import { ALERT_KINDS } from "./types";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MIGRATION = "supabase/migrations/0093_anomaly_alerts.sql";
const CRON = "supabase/ops/register-anomaly-cron.sql";
const ROUTE = "src/app/api/anomaly/sweep/route.ts";
const SLUG = "anomaly-alerts";

describe("the kill switch, both halves", () => {
  it("is in the catalog as a real, labelled, headless system", () => {
    const def = SYSTEM_BY_SLUG.get(SLUG);
    expect(def).toBeTruthy();
    expect(def?.label).toBe("Proactive alerts");
    expect(def?.halts.length).toBeGreaterThan(20);
  });

  it("MECHANISM 1: an absent toggle row means DISABLED, in every database", () => {
    expect(defaultEnabledFor(SLUG)).toBe(false);
    expect(DEFAULT_OFF_SLUGS.has(SLUG)).toBe(true);
  });

  it("MECHANISM 2: the migration seeds an explicit disabled row, without clobbering an ON", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("insert into system_toggle");
    expect(sql).toContain(`'${SLUG}', false`);
    expect(sql).toContain("on conflict (client_id, module_slug) do nothing");
  });

  it("the two mechanisms are independent, and the file says why", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("defaultEnabled:false");
    expect(sql).toContain("it covers one client, once");
  });

  it("the route checks the switch BEFORE it does any work at all", () => {
    // Measured inside the handler, not across the imports: an import of
    // acquireCronLock at the top of the file proves nothing about call order.
    const src = read(ROUTE);
    const body = src.slice(src.indexOf("async function handle"));
    const switchAt = body.indexOf(`isSystemEnabled(CLIENT_ID, "${SLUG}")`);
    const leaseAt = body.indexOf("acquireCronLock");
    const collectAt = body.indexOf("collectReadings");
    expect(switchAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(-1);
    expect(collectAt).toBeGreaterThan(-1);
    expect(switchAt).toBeLessThan(leaseAt);
    expect(switchAt).toBeLessThan(collectAt);
  });

  it("the route is CRON_SECRET gated and holds a lease that outlives its kill bound", () => {
    const src = read(ROUTE);
    expect(src).toContain("cronUnauthorized(request)");
    expect(src).toContain("releaseCronLock");
    const maxDuration = Number(src.match(/export const maxDuration = (\d+)/)![1]);
    const lease = Number(src.match(/acquireCronLock\("sweep-anomaly", (\d+)\)/)![1]);
    expect(lease).toBeGreaterThan(maxDuration);
  });

  it("spends the practice's Dentally quota at BACKGROUND priority, never ahead of staff", () => {
    expect(read(ROUTE)).toContain('runWithDentallyPriority("background"');
    expect(read("src/lib/anomaly/collect.ts")).toContain('runWithDentallyPriority("background"');
  });

  it("the notifications feed consults the SAME switch, so a flip leaves no residue", () => {
    const src = read("src/lib/notifications/build.ts");
    expect(src).toContain(`isSystemEnabled(ctx.clientId, "${SLUG}")`);
    // And it returns nothing rather than falling through to a read.
    expect(src).toMatch(/isSystemEnabled\(ctx\.clientId, "anomaly-alerts"\)\)\) return \[\];/);
  });
});

// THE CRON FILE, AFTER RULING W3/22.
//
// This block used to be called "the cron job is written and NOT registered" and
// asserted the file said "NOT YET APPLIED". Both were false about production:
// `app-sweep-anomaly` has been registered and active on `45 * * * *` for months
// (336 successful runs to 4 Sep 2026; the read is recorded as CRON.JOB TRUTH under
// W3/7 and held as `SCHEDULER` in src/lib/agent-wiring/runbook.test.ts). The file
// was written proposing minute 40 and somebody registered the job at 45 instead.
//
// W3/22 corrects the FILE, never the running job — and the minute matters here
// rather than being pedantry: `cron.schedule()` on an existing job name UPDATES
// it, so the old file would have moved a working hourly pass onto :40, which is
// the Dentally prewarm's own minute. The sweep in
// src/lib/agent-wiring/ops-cron-registration.test.ts holds every ops file to the
// same rule; this keeps the anomaly module's own suite honest about it.
describe("the cron file states registration truth (W3/22)", () => {
  it("exists, targets this route, and no longer claims the job was never applied", () => {
    const sql = read(CRON);
    expect(sql).toContain("/api/anomaly/sweep");
    expect(sql).toContain("app-sweep-anomaly");
    expect(sql).toMatch(/^-- STATUS: APPLIED/m);
    expect(sql).not.toContain("NOT YET APPLIED");
  });

  it("schedules the minute the live job runs, so running the file cannot move it", () => {
    expect(read(CRON)).toContain("'45 * * * *'");
    expect(read(CRON)).not.toContain("'40 * * * *'");
  });

  it("is not referenced by anything that would apply it automatically", () => {
    // The only mention of this job outside its own file is in prose, never in a
    // migration — migrations are applied, ops files are run by hand.
    const migration = read(MIGRATION);
    expect(migration).not.toContain("cron.schedule");
    expect(migration).not.toContain("app-sweep-anomaly");
  });
});

describe("this module cannot become a sending surface by accident", () => {
  const FILES = [
    "src/lib/anomaly/types.ts",
    "src/lib/anomaly/detect.ts",
    "src/lib/anomaly/dedupe.ts",
    "src/lib/anomaly/collect.ts",
    "src/lib/anomaly/repository.ts",
    ROUTE,
  ];

  it("imports nothing from the messaging layer", () => {
    for (const file of FILES) {
      const src = read(file);
      expect(src, file).not.toMatch(/from "@\/lib\/messaging\//);
      expect(src, file).not.toContain("sendMessage");
      expect(src, file).not.toContain("enqueueOutbox");
    }
  });

  it("registers no source with the shared messaging drain", () => {
    expect(Object.keys(DRAIN_SOURCE_TO_SLUG)).not.toContain(SLUG);
    expect(Object.values(DRAIN_SOURCE_TO_SLUG)).not.toContain(SLUG);
    expect(read("src/app/api/messaging/drain/route.ts")).not.toContain("anomaly");
  });

  it("creates no touch or outbox table, and writes only its own", () => {
    const sql = read(MIGRATION);
    const created = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["anomaly_alert"]);
    expect(sql).not.toContain("_outbox");
    expect(sql).not.toContain("_touch");
  });

  it("the sweep writes the alert table and nothing else", () => {
    const src = read(ROUTE);
    // Every write it performs comes from this module's own repository.
    for (const write of ["insertAlert", "refreshAlert", "reraiseAlert", "resolveAlerts"]) {
      expect(src).toContain(write);
    }
    expect(src).not.toContain("upsertTargets");
    expect(src).not.toContain("insertDraft");
    expect(src).not.toContain("DentallyClient");
  });
});

describe("the alert kinds are declared in exactly one place", () => {
  it("every kind the code can raise is allowed by the migration's CHECK", () => {
    const sql = read(MIGRATION);
    const check = sql.slice(sql.indexOf("kind text not null check"));
    for (const kind of ALERT_KINDS) {
      expect(check, kind).toContain(`'${kind}'`);
    }
  });

  it("the CHECK allows no kind the code cannot raise", () => {
    const sql = read(MIGRATION);
    const block = sql.slice(
      sql.indexOf("kind text not null check"),
      sql.indexOf("severity text not null check"),
    );
    const allowed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...ALERT_KINDS].sort());
  });
});
