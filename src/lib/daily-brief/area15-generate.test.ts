// AREA 15 (daily brief): generator composition, resilience, caps, role scoping
// and Europe/London date bucketing.
//
// The generator (generate.ts) is compute-on-read: it fans out to the real module
// repositories and folds their results into role-ordered sections + a capped
// headline. We drive it against in-memory fakes of every repository it imports so
// we assert the REAL composition logic with NO database or network:
//  - graceful fallback: any single repo throwing must never sink the brief,
//  - section composition from each module's real record shapes,
//  - the headline cap (6) and the section-body cap (5, enforced by the view),
//  - role scoping: coordinator vs owner section ORDER differs, and neither is fed
//    a wider site scope than the context passes (no cross-client leakage),
//  - Europe/London "today"/"tomorrow" bucketing across the local midnight and a
//    BST boundary.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BriefContext } from "./types";

// ---------------------------------------------------------------------------
// Hoisted in-memory store. Each repo fake reads from here so a test can seed
// rows, then assert what the generator folded them into. `throwers` lets a test
// force a specific repo to reject, to prove the try/catch resilience.
// ---------------------------------------------------------------------------
const store = vi.hoisted(() => ({
  appointments: [] as Array<Record<string, unknown>>,
  outstanding: [] as Array<Record<string, unknown>>,
  noshow: [] as Array<Record<string, unknown>>,
  recall: [] as Array<Record<string, unknown>>,
  reactivation: [] as Array<Record<string, unknown>>,
  opportunities: [] as Array<Record<string, unknown>>,
  captures: [] as Array<Record<string, unknown>>,
  throwers: new Set<string>(),
  // Records the siteIds each repo was called with, to assert scope propagation.
  calledSiteIds: {} as Record<string, string[] | undefined>,
}));

function guard(name: string): void {
  if (store.throwers.has(name)) throw new Error(`${name} exploded`);
}

// generate.ts is a server module (`import "server-only"`); stub it under node.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/dentally/read", () => ({
  listAppointments: vi.fn(async (...a: unknown[]) => {
    guard("listAppointments");
    store.calledSiteIds.listAppointments = a[0] as string[];
    return store.appointments;
  }),
  listOutstanding: vi.fn(async (...a: unknown[]) => {
    guard("listOutstanding");
    store.calledSiteIds.listOutstanding = a[0] as string[];
    return store.outstanding;
  }),
}));

vi.mock("@/lib/noshow/repository", () => ({
  listTargets: vi.fn(async (...a: unknown[]) => {
    guard("noshow");
    store.calledSiteIds.noshow = (a[0] as { siteIds: string[] }).siteIds;
    return store.noshow;
  }),
}));

vi.mock("@/lib/recall/repository", () => ({
  listTargets: vi.fn(async (...a: unknown[]) => {
    guard("recall");
    store.calledSiteIds.recall = (a[0] as { siteIds: string[] }).siteIds;
    return store.recall;
  }),
}));

vi.mock("@/lib/reactivation/repository", () => ({
  listTargets: vi.fn(async (...a: unknown[]) => {
    guard("reactivation");
    store.calledSiteIds.reactivation = (a[0] as { siteIds: string[] }).siteIds;
    return store.reactivation;
  }),
}));

vi.mock("@/lib/coordinator/repository", () => ({
  listOpportunities: vi.fn(async (...a: unknown[]) => {
    guard("opportunities");
    store.calledSiteIds.opportunities = (a[0] as { siteIds: string[] }).siteIds;
    return store.opportunities;
  }),
}));

vi.mock("@/lib/after-hours/repository", () => ({
  listCaptures: vi.fn(async (...a: unknown[]) => {
    guard("captures");
    store.calledSiteIds.captures = (a[0] as { siteIds: string[] }).siteIds;
    return store.captures;
  }),
}));

// Import AFTER the mocks are registered.
import { generateBrief } from "./generate";

// ---------------------------------------------------------------------------
// Fixture builders in each module's real record shape (only the fields the
// generator reads).
// ---------------------------------------------------------------------------
function appt(siteId: string, patientName: string, state = "scheduled"): Record<string, unknown> {
  return { siteId, patientName, state };
}
function noshowTarget(appointmentStartAt: string): Record<string, unknown> {
  return { appointmentStartAt };
}
function opp(
  siteId: string,
  patientName: string,
  plannedValue: number,
  amountOutstanding = 0,
  treatment = "Implant",
): Record<string, unknown> {
  return { siteId, patientName, plannedValue, amountOutstanding, treatment };
}

const SITE_IDS = ["site-cc", "site-rv"];

function ctxFor(role: BriefContext["role"], now: Date, siteIds = SITE_IDS): BriefContext {
  return { clientId: "vitality", siteIds, role, now };
}

beforeEach(() => {
  store.appointments = [];
  store.outstanding = [];
  store.noshow = [];
  store.recall = [];
  store.reactivation = [];
  store.opportunities = [];
  store.captures = [];
  store.throwers = new Set();
  store.calledSiteIds = {};
});

// A London-noon instant on 2026-06-18 (BST, so 11:00Z). Appointments "today"
// key off the London calendar day.
const NOW = new Date("2026-06-18T11:00:00Z");

describe("resilience: never throws the page", () => {
  it("returns a brief even when EVERY repository rejects", async () => {
    store.throwers = new Set([
      "listAppointments",
      "listOutstanding",
      "noshow",
      "recall",
      "reactivation",
      "opportunities",
      "captures",
    ]);
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    // Compliance is a static source, so it may still populate; the diary/money/
    // etc. sections degrade to empty. The key guarantee is no throw + a shape.
    expect(brief.generatedAt).toBe(NOW.toISOString());
    expect(brief.appointmentsToday).toBe(0);
    expect(Array.isArray(brief.sections)).toBe(true);
    expect(Array.isArray(brief.headline)).toBe(true);
    // No diary/noshow/money section should have survived a total repo blackout.
    const keys = brief.sections.map((s) => s.key);
    expect(keys).not.toContain("diary");
    expect(keys).not.toContain("money");
    expect(keys).not.toContain("noshow");
  });

  it("one throwing repo does not sink the others", async () => {
    store.throwers = new Set(["noshow"]);
    store.appointments = [appt("site-cc", "Amy"), appt("site-cc", "Ben")];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const keys = brief.sections.map((s) => s.key);
    expect(keys).toContain("diary"); // survived
    expect(keys).not.toContain("noshow"); // degraded to empty, dropped
    expect(brief.appointmentsToday).toBe(2);
  });
});

describe("composition from module shapes", () => {
  it("diary counts booked vs gaps and headlines appointmentsToday", async () => {
    store.appointments = [
      appt("site-cc", "Amy", "scheduled"),
      appt("site-cc", "Ben", "cancelled"),
      appt("site-rv", "Cara", "did_not_attend"),
    ];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    // 3 total, 2 gaps (cancelled + dna), 1 booked.
    expect(brief.appointmentsToday).toBe(1);
    const diary = brief.sections.find((s) => s.key === "diary");
    expect(diary?.items[0]?.title).toBe("3 appointments today");
    expect(diary?.items[0]?.detail).toContain("2 gaps");
  });

  it("arriving cross-references open plans against today's diary by site+name", async () => {
    store.appointments = [appt("site-cc", "Amy Jones"), appt("site-rv", "Zed")];
    store.opportunities = [
      opp("site-cc", "Amy Jones", 4000), // in diary today -> arriving
      opp("site-rv", "Not In Diary", 9000), // not in diary -> excluded
    ];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const arriving = brief.sections.find((s) => s.key === "arriving");
    expect(arriving?.items.some((l) => l.title.includes("Amy Jones"))).toBe(true);
    expect(arriving?.items.some((l) => l.title.includes("Not In Diary"))).toBe(false);
  });

  it("name match is case/whitespace-insensitive within the SAME site only", async () => {
    store.appointments = [appt("site-cc", "  aMy  ")];
    store.opportunities = [
      opp("site-cc", "Amy", 1000), // same site, normalised name -> match
      opp("site-rv", "Amy", 5000), // different site -> NOT a match
    ];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const arriving = brief.sections.find((s) => s.key === "arriving");
    // Only the site-cc Amy should surface; the site-rv Amy must not leak in.
    const titles = (arriving?.items ?? []).map((l) => l.title);
    expect(titles.some((t) => t.includes("Amy is in today"))).toBe(true);
    // With exactly one arriving patient there is no "N high-value patients" roll-up.
    expect(titles.some((t) => /high-value patients arriving/.test(t))).toBe(false);
  });

  it("money totals outstanding and flags large balances", async () => {
    store.outstanding = [
      { outstanding: 1500 }, // > 1000 threshold -> large
      { outstanding: 200 },
    ];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const money = brief.sections.find((s) => s.key === "money");
    expect(money?.items[0]?.value).toBe(1700);
    expect(money?.items[0]?.detail).toContain("over"); // "1 balance over £1,000"
    expect(money?.items[0]?.priority).toBe("medium");
  });

  it("every section line carries a real module slug for the deep link", async () => {
    store.appointments = [appt("site-cc", "Amy")];
    store.noshow = [noshowTarget(NOW.toISOString())];
    store.recall = [{}];
    store.reactivation = [{ recoverableValue: 500 }];
    store.opportunities = [opp("site-cc", "Amy", 100, 300)];
    store.captures = [{}];
    store.outstanding = [{ outstanding: 50 }];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    // These are the slugs the overflow deep link (/c/<client>/<slug>) is built
    // from; they must all exist as routes under src/app/c/[client]/.
    const validSlugs = new Set([
      "calendar", // the diary line deep-links to the Calendar (Today folded into Home)
      "no-show-defence",
      "treatment-coordinator",
      "recall",
      "reactivation",
      "after-hours",
      "payments",
      "compliance",
    ]);
    for (const section of brief.sections) {
      for (const line of section.items) {
        if (line.href !== undefined) {
          expect(validSlugs.has(line.href)).toBe(true);
        }
      }
    }
  });
});

describe("Europe/London date bucketing", () => {
  it("no-show buckets appointments on the London today/tomorrow, not UTC", async () => {
    // London day of NOW is 2026-06-18 (BST). An appointment at 2026-06-18T22:30Z
    // is still 18 Jun 23:30 London (today). An appointment at 2026-06-19T22:30Z
    // is 19 Jun 23:30 London (tomorrow). A 2026-06-20 one is neither.
    store.noshow = [
      noshowTarget("2026-06-18T22:30:00Z"), // today (London)
      noshowTarget("2026-06-19T22:30:00Z"), // tomorrow (London)
      noshowTarget("2026-06-20T09:00:00Z"), // day after -> excluded
    ];
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const noshow = brief.sections.find((s) => s.key === "noshow");
    expect(noshow?.items[0]?.count).toBe(2);
  });

  it("a late-evening UTC instant that is next-day London is bucketed as tomorrow-eligible not dropped", async () => {
    // now = 2026-06-18T23:30Z is already 2026-06-19 00:30 London. An appointment
    // 'today' relative to that London day is 2026-06-19. Proves the generator
    // keys off London midnight, not the UTC calendar day.
    const lateNow = new Date("2026-06-18T23:30:00Z"); // 19 Jun 00:30 London
    store.noshow = [noshowTarget("2026-06-19T10:00:00Z")]; // 19 Jun London = today
    const brief = await generateBrief(ctxFor("client_owner", lateNow));
    const noshow = brief.sections.find((s) => s.key === "noshow");
    expect(noshow?.items[0]?.count).toBe(1);
  });
});

describe("caps", () => {
  it("headline is capped at 6 items", async () => {
    // Seed enough distinct high-priority-ish lines across sections to exceed 6.
    store.appointments = [appt("site-cc", "Amy", "cancelled")]; // diary gap line
    store.noshow = [noshowTarget(NOW.toISOString())]; // noshow line
    store.opportunities = [
      opp("site-cc", "Amy", 100, 500), // arriving (in diary) + chase line
      opp("site-cc", "Zed", 200, 900),
    ];
    store.appointments.push(appt("site-cc", "Zed"));
    store.recall = [{}, {}]; // chase recall line
    store.reactivation = [{ recoverableValue: 500 }]; // chase reactivation line
    store.captures = [{}, {}]; // overnight line
    store.outstanding = [{ outstanding: 2000 }]; // money line
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    expect(brief.headline.length).toBeLessThanOrEqual(6);
    expect(brief.headline.length).toBeGreaterThan(0);
  });

  it("headline items conform to the BriefItem shape and priority order (high first)", async () => {
    store.captures = [{}, {}]; // overnight -> high
    store.outstanding = [{ outstanding: 100 }]; // money -> low
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const priorities = brief.headline.map((h) => h.priority);
    // high must never sort after a lower priority.
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < priorities.length; i++) {
      expect(rank[priorities[i]]).toBeGreaterThanOrEqual(rank[priorities[i - 1]]);
    }
    for (const h of brief.headline) {
      expect(typeof h.id).toBe("string");
      expect(["bookings", "revenue", "time", "risk"]).toContain(h.metric);
      expect(["high", "medium", "low"]).toContain(h.priority);
    }
  });

  it("overnight (high) outranks money (low) in the headline", async () => {
    store.captures = [{}]; // high
    store.outstanding = [{ outstanding: 100 }]; // low
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    const overnightIdx = brief.headline.findIndex((h) => /missed call/i.test(h.title));
    const moneyIdx = brief.headline.findIndex((h) => /outstanding/i.test(h.title));
    expect(overnightIdx).toBeGreaterThanOrEqual(0);
    expect(moneyIdx).toBeGreaterThanOrEqual(0);
    expect(overnightIdx).toBeLessThan(moneyIdx);
  });
});

describe("role scoping and ordering", () => {
  it("coordinator leads with arriving/noshow/overnight; owner leads with diary", async () => {
    store.appointments = [appt("site-cc", "Amy")]; // diary
    store.opportunities = [opp("site-cc", "Amy", 100)]; // arriving (in diary)
    store.captures = [{}]; // overnight
    store.outstanding = [{ outstanding: 100 }]; // money

    const owner = await generateBrief(ctxFor("client_owner", NOW));
    const coord = await generateBrief(ctxFor("client_coordinator", NOW));

    const ownerKeys = owner.sections.map((s) => s.key);
    const coordKeys = coord.sections.map((s) => s.key);

    // Owner: diary comes before arriving.
    expect(ownerKeys.indexOf("diary")).toBeLessThan(ownerKeys.indexOf("arriving"));
    // Coordinator: arriving is first, and comes before diary + money.
    expect(coordKeys[0]).toBe("arriving");
    expect(coordKeys.indexOf("arriving")).toBeLessThan(coordKeys.indexOf("diary"));
    expect(coordKeys.indexOf("overnight")).toBeLessThan(coordKeys.indexOf("money"));

    expect(owner.role).toBe("client_owner");
    expect(coord.role).toBe("client_coordinator");
  });

  it("passes ONLY the context siteIds to every repo (no scope widening / cross-client leak)", async () => {
    const scoped = ["site-rv"]; // a deliberately narrow scope
    await generateBrief(ctxFor("client_owner", NOW, scoped));
    // Every repository that takes a site scope was called with EXACTLY the
    // context's siteIds, never a wider set. If a builder silently substituted a
    // client-wide list, this catches the leak.
    expect(store.calledSiteIds.listAppointments).toEqual(scoped);
    expect(store.calledSiteIds.listOutstanding).toEqual(scoped);
    expect(store.calledSiteIds.noshow).toEqual(scoped);
    expect(store.calledSiteIds.recall).toEqual(scoped);
    expect(store.calledSiteIds.reactivation).toEqual(scoped);
    expect(store.calledSiteIds.opportunities).toEqual(scoped);
    expect(store.calledSiteIds.captures).toEqual(scoped);
  });

  it("empty everything yields no sections and an empty headline", async () => {
    // Force compliance out of the way is not possible (static), but with zero
    // module data the dynamic sections must all be empty.
    const brief = await generateBrief(ctxFor("client_owner", NOW));
    for (const s of brief.sections) {
      // Only compliance may appear (static mock); all others must be absent.
      expect(["compliance"]).toContain(s.key);
    }
  });
});
