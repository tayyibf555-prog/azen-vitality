// Build-tick cursor + counter invariants (findings #1 budget-exhaustion cursor skip,
// #2 double-counted counters). The bounded build reads at most
// MAX_APPOINTMENT_READS_PER_RUN (60) appointment histories per tick. When that budget
// trips PART-WAY through a 100-row patient page, the tick must:
//   1. leave `page` unchanged and persist an intra-page `pageOffset`, so the next tick
//      resumes at the UNSCANNED TAIL (never re-reading the head, which would re-spend
//      the whole budget on rows it already scanned and never reach the tail), and
//   2. count each distinct row exactly once across the stop-then-resume (no inflation).
// A 429 mid-page read is exercised the same way, plus the eager-count roll-back for the
// row that gets retried.
//
// Dentally + repository are doubled so the cursor/counter logic is pinned deterministically.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DentallyError } from "@/lib/dentally/client";

const h = vi.hoisted(() => ({
  pages: new Map<number, unknown[]>(),
  apptCalls: [] as string[], // patientIds passed to getPatientAppointments this run
  fail429At: null as string | null, // when set, that patientId's read throws a 429 once
  enrolled: new Set<string>(), // idempotent target store, keyed by patientId
  inserts: [] as string[][], // patientIds per insertTargets call
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/dentally/read", () => ({
  dentallyFromEnv: () => ({
    listPatients: async ({ page }: { page: number }) => ({ patients: h.pages.get(page) ?? [] }),
    getPatientAppointments: async (id: string) => {
      h.apptCalls.push(id);
      if (h.fail429At && id === h.fail429At) throw new DentallyError(429, "rate limited");
      return { appointments: [{ start_time: "2025-01-01T09:00:00Z", reason: "hygiene", state: "closed" }] };
    },
  }),
  dentallyReadKey: () => "test-key",
}));
vi.mock("@/lib/mock/clients", () => ({ dentallySiteId: (id: string) => id }));
// Every scanned row is a candidate and every candidate matches, so the ONLY thing that
// bounds a tick is the appointment-read budget - exactly the path under test.
vi.mock("@/lib/outreach/filters", () => ({
  prefilterOutcome: () => ({ pass: true, excludedForMissingData: false }),
  matchAppointmentHistory: () => ({ matched: true, matchedReason: "Hygiene 2025" }),
}));
vi.mock("@/lib/outreach/repository", () => ({
  getCampaign: async () => null,
  updateCampaign: async (_id: string, fields: Record<string, unknown>) => {
    h.updates.push(fields);
  },
  insertTargets: async (targets: { patientId: string }[]) => {
    const fresh = targets.filter((t) => !h.enrolled.has(t.patientId));
    for (const t of fresh) h.enrolled.add(t.patientId);
    h.inserts.push(targets.map((t) => t.patientId));
    return fresh.length; // idempotent: a re-inserted target counts as 0 new
  },
}));

import { runOutreachBuildTick, initBuildCursor } from "./build";
import type { OutreachCampaign } from "./types";

function makePage(from: number, to: number): unknown[] {
  const rows: unknown[] = [];
  for (let i = from; i <= to; i++) {
    rows.push({ id: String(i), first_name: "P", last_name: String(i), mobile_phone: "07700900000", use_sms: true });
  }
  return rows;
}

function campaign(over: Partial<OutreachCampaign> = {}): OutreachCampaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    siteId: "site-cc",
    name: "seg",
    status: "building",
    filters: {},
    practitionerId: null,
    practitionerName: null,
    messageAngle: "a hygiene visit",
    dailyCap: 25,
    buildCursor: initBuildCursor(),
    counts: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

beforeEach(() => {
  h.pages = new Map();
  h.apptCalls = [];
  h.fail429At = null;
  h.enrolled = new Set();
  h.inserts = [];
  h.updates = [];
});

describe("runOutreachBuildTick: budget-exhaustion cursor (finding #1)", () => {
  it("a page with more candidates than the read budget stops WITHOUT advancing the page", async () => {
    h.pages.set(1, makePage(1, 100)); // 100 candidates, budget is 60
    h.pages.set(2, []);

    const r1 = await runOutreachBuildTick(campaign());

    // A budget stop is normal pacing, NOT a rate-limit stop, and the build is not done.
    expect(r1.stopped).toBeNull();
    expect(r1.done).toBe(false);
    // The page is LEFT AS-IS (the bug advanced it and skipped the tail); the offset
    // marks where to resume.
    expect(r1.cursor?.page).toBe(1);
    expect(r1.cursor?.pageOffset).toBe(60);
    expect(r1.appointmentReads).toBe(60);
    expect(h.apptCalls).toHaveLength(60); // read patients 1..60 only
    expect(r1.counts.matched).toBe(60);
  });

  it("the next tick resumes at the tail, reads + enrols it, and never re-reads the head", async () => {
    h.pages.set(1, makePage(1, 100));
    h.pages.set(2, []);

    const r1 = await runOutreachBuildTick(campaign());
    h.apptCalls = []; // isolate the SECOND tick's reads
    const r2 = await runOutreachBuildTick(campaign({ buildCursor: r1.cursor, counts: r1.counts }));

    expect(r2.done).toBe(true);
    expect(r2.cursor?.pageOffset).toBe(0);
    // Only the unscanned tail (61..100) is read this tick; the head (1..60) is skipped.
    expect(h.apptCalls).toHaveLength(40);
    expect(h.apptCalls).toContain("61");
    expect(h.apptCalls).toContain("100");
    expect(h.apptCalls).not.toContain("60");
    // The whole page is enrolled across the two ticks: the tail was NOT skipped.
    expect(h.enrolled.size).toBe(100);
    for (let i = 1; i <= 100; i++) expect(h.enrolled.has(String(i))).toBe(true);
  });
});

describe("runOutreachBuildTick: no double-count across a re-scan (finding #2)", () => {
  it("stop-then-resume on the same page counts each row exactly once", async () => {
    h.pages.set(1, makePage(1, 100));
    h.pages.set(2, []);

    const r1 = await runOutreachBuildTick(campaign());
    const r2 = await runOutreachBuildTick(campaign({ buildCursor: r1.cursor, counts: r1.counts }));

    // 100 distinct rows, counted once each - NOT 60 + 100 = 160.
    expect(r2.counts.scanned).toBe(100);
    expect(r2.counts.candidates).toBe(100);
    expect(r2.counts.matched).toBe(100);
    expect(r2.counts.enrolled).toBe(100);
  });

  it("counts only SMS-consented matches as contactable (finding #2)", async () => {
    // 10 patients, all matching (filters mocked to pass); 6 have SMS consent, 4 do not.
    // Matched counts everyone; contactable counts only the reachable (SMS-consented) ones.
    const rows: unknown[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push({ id: String(i), first_name: "P", last_name: String(i), mobile_phone: "07700900000", use_sms: i <= 6 });
    }
    h.pages.set(1, rows);
    h.pages.set(2, []);

    const r = await runOutreachBuildTick(campaign());

    expect(r.done).toBe(true);
    expect(r.counts.matched).toBe(10);
    expect(r.counts.contactable).toBe(6); // only the 6 with use_sms:true
    expect(r.cursor?.contactable).toBe(6); // persisted on the cursor so it survives ticks
  });

  it("a 429 mid-page rolls back the failed row's eager count and retries only it", async () => {
    // Small page so the resume completes in one further tick (no second budget stop).
    h.pages.set(1, makePage(1, 40));
    h.pages.set(2, []);
    h.fail429At = "30"; // the 30th read (index 29) rate-limits on the first tick

    const r1 = await runOutreachBuildTick(campaign());
    expect(r1.stopped).toBe("429");
    expect(r1.cursor?.page).toBe(1);
    // Rows 1..29 committed; the 429'd row (index 29) is the resume point and its eager
    // scanned/candidate increments were rolled back, so the counts show 29 not 30.
    expect(r1.cursor?.pageOffset).toBe(29);
    expect(r1.counts.scanned).toBe(29);
    expect(r1.counts.candidates).toBe(29);
    expect(r1.counts.matched).toBe(29);

    h.apptCalls = [];
    h.fail429At = null; // the retry succeeds
    const r2 = await runOutreachBuildTick(campaign({ buildCursor: r1.cursor, counts: r1.counts }));

    expect(r2.done).toBe(true);
    // The retried row ("30") plus the rest of the tail are read; the head is not.
    expect(h.apptCalls).toContain("30");
    expect(h.apptCalls).not.toContain("29");
    expect(h.apptCalls).toHaveLength(11); // patients 30..40
    // 40 distinct rows counted once each (no double-count of the 1..29 head).
    expect(r2.counts.scanned).toBe(40);
    expect(r2.counts.matched).toBe(40);
    expect(h.enrolled.size).toBe(40);
  });
});
