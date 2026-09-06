import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { srcPath } from "@/lib/test-support/walk-src";

// ===========================================================================
// THE OWNER'S "BUILD CANDIDATES" DOOR (ruling W3/8).
//
// The implant-interest scan shipped with NO caller of any kind: not registered in
// cron.job, no button, no runbook row, and `cronUnauthorized` on its only door so
// a person could not run it from a browser either. The owner opened the list he
// had asked for by name and read "This list has not been built yet" — for ever.
//
// This route is the caller. What has to be true of it: only the owner may start a
// scan, the kill switch still governs it, it shares the scheduler's lease so a
// click cannot double the practice's Dentally reads, and it takes the practice's
// quota as BACKGROUND work even though somebody is waiting — a button that
// outranked the diary somebody else is booking into would be the wrong trade.
//
// The scan itself is faked here; it has its own tests next door (_mining.test.ts).
// ===========================================================================

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  systemOn: true,
  lockAvailable: true,
  priorities: [] as string[],
  locks: [] as string[],
  released: [] as string[],
  ran: 0,
  report: {
    patientReads: 4,
    budgetRefused: false,
    sites: [{ siteId: "site-cc", daysCovered: 3, candidates: 2 }],
  } as Record<string, unknown>,
}));

// PARTIAL mock: the REAL requireOwnerRole and requireClientAccess run — they are
// the lock this file is about — and only the session read is faked.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => store.user };
});
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemOn }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "key" }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@/lib/dentally/budget", () => ({
  runWithDentallyPriority: async (p: string, fn: () => Promise<Response>) => {
    store.priorities.push(p);
    return fn();
  },
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async (name: string) => {
    store.locks.push(name);
    return store.lockAvailable;
  },
  releaseCronLock: async (name: string) => {
    store.released.push(name);
  },
}));
vi.mock("../_mining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_mining")>();
  return {
    MINING_LOCK: actual.MINING_LOCK,
    runMiningSweep: async () => {
      store.ran += 1;
      return store.report;
    },
  };
});

import { POST } from "./route";
import { MINING_LOCK } from "../_mining";

function owner() {
  return { id: "u1", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
}

async function post(slug = "vitality"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request(`http://localhost/api/previsit/mining-run?client=${slug}`, { method: "POST" }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  store.user = owner();
  store.systemOn = true;
  store.lockAvailable = true;
  store.priorities = [];
  store.locks = [];
  store.released = [];
  store.ran = 0;
  store.report = {
    patientReads: 4,
    budgetRefused: false,
    sites: [{ siteId: "site-cc", daysCovered: 3, candidates: 2 }],
  };
});

describe("only the owner may start a scan", () => {
  it("the practice manager is refused, and no scan starts", async () => {
    // She runs the interest lists and the page is hers; STARTING a scan spends the
    // practice's shared Dentally quota on historical book, so it sits with the same
    // role that edits the question banks.
    store.user = { ...owner(), role: "client_coordinator" };
    const { status } = await post();
    expect(status).toBe(403);
    expect(store.ran).toBe(0);
    expect(store.locks).toEqual([]);
  });

  it("a clinician and a staff login are refused too", async () => {
    for (const role of ["client_clinician", "client_staff"]) {
      store.user = { ...owner(), role };
      expect((await post()).status, `${role} could start a scan`).toBe(403);
    }
    expect(store.ran).toBe(0);
  });

  it("an owner of ANOTHER practice is refused before the role is even asked", async () => {
    store.user = { ...owner(), clientId: "someone-else" };
    expect((await post()).status).toBe(403);
    expect(store.ran).toBe(0);
  });

  it("an unknown practice is a 404, not a scan", async () => {
    expect((await post("nope")).status).toBe(404);
    expect(store.ran).toBe(0);
  });
});

describe("the kill switch still governs it", () => {
  it("an owner is told the module is off rather than finding the list grew anyway", async () => {
    // Ruling W2-C/4 named the surfaces the switch does NOT halt — the bank editor,
    // /api/previsit/bank, the module page — as a closed list. This is not one of
    // them: it reads real patient history and grows a list, so it is gated.
    store.systemOn = false;
    const { body } = await post();
    expect(body).toMatchObject({ ok: false, skipped: "system off" });
    expect(String(body.message)).toContain("switched off");
    expect(store.ran).toBe(0);
    expect(store.locks, "an off system still took the lease").toEqual([]);
  });
});

describe("what an owner's click actually does", () => {
  it("runs the scan and says what it read", async () => {
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(store.ran).toBe(1);
    expect(body.message).toBe("Read 3 more days of the diary and added 2 people.");
    expect(body).toMatchObject({ ok: true, patientReads: 4 });
  });

  it("says so plainly when the practice's quota stopped it, and does not pretend otherwise", async () => {
    store.report = {
      patientReads: 120,
      budgetRefused: true,
      sites: [{ siteId: "site-cc", daysCovered: 1, candidates: 0 }],
    };
    const { body } = await post();
    expect(String(body.message)).toContain("daily limit");
    expect(String(body.message)).toContain("Read 1 more day");
    expect(String(body.message)).toContain("nothing is lost");
  });

  it("tells the owner what a bare total hides (W3/25)", async () => {
    // A site that stopped on its own even share of the run, and patients whose
    // records could not be read at all. Both are in the report and neither was on
    // any screen: the composed sentence is what the button prints verbatim.
    store.report = {
      patientReads: 120,
      budgetRefused: false,
      sites: [
        { siteId: "site-cc", daysCovered: 2, candidates: 1, unreadable: 3, stoppedBy: "patient-budget" },
        { siteId: "site-n17", daysCovered: 4, candidates: 0, unreadable: 0, stoppedBy: "complete" },
      ],
    } as typeof store.report;
    const { body } = await post();
    // PER SITE, NOT SUMMED, AND BOUNDED WHEN THE SITES ARE OUT OF STEP. This
    // expectation used to read "Read 6 more days of the diary", which was the
    // clause adding one site's 2 days to another's 4 — the false-completeness
    // defect miningRunSentence was rewritten to remove (charter §0/5, ruling
    // W3/11; pinned at source by "counts days PER SITE, because three sites do
    // not make ninety days of one diary" in src/lib/triage/mining.test.ts). The
    // route prints the library's sentence verbatim, so this asserts the sentence
    // the library actually composes rather than the one it used to.
    expect(String(body.message)).toContain(
      "Read up to 4 more days of the diary at each of 2 sites and added 1 person.",
    );
    expect(String(body.message), "the two sites' days were added up again").not.toContain("6 more days");
    expect(String(body.message)).toContain("One site reached its share");
    expect(String(body.message)).toContain("3 patients could not be looked up at all");
  });

  it("takes the SAME lease as the scheduled sweep, and releases it", async () => {
    await post();
    expect(store.locks).toEqual([MINING_LOCK]);
    expect(store.released).toEqual([MINING_LOCK]);
  });

  it("answers a click during a running scan instead of doubling the reads", async () => {
    store.lockAvailable = false;
    const { body } = await post();
    expect(store.ran).toBe(0);
    expect(body).toMatchObject({ ok: true, skipped: "another run in progress" });
  });

  it("spends the practice's Dentally quota as BACKGROUND work", async () => {
    // Even with a person waiting. The scan is resumable, so a refusal costs a
    // click; outranking the diary would cost somebody their booking screen.
    await post();
    expect(store.priorities).toEqual(["background"]);
  });
});

describe("the route is locked at the API layer and swept by both coverage tests", () => {
  it("carries a RETURNED owner guard, which is the shape both sweeps recognise", () => {
    const src = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(src).toMatch(/const roleDenied = requireOwnerRole\(result\);\s*\n\s*if \(roleDenied\) return roleDenied;/);
    expect(src).toContain("requireClientAccess(result, client.id)");
  });

  it("needs no exemption in either sweep, and has none", () => {
    for (const sweep of [
      "app/api/client-api-module-guard-coverage.test.ts",
      "app/api/destructive-route-capability-coverage.test.ts",
    ]) {
      expect(readFileSync(srcPath(sweep), "utf8")).not.toContain("previsit/mining-run");
    }
  });

  it("has no GET: a scan is something you start, never something a page load does", () => {
    const src = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(src).not.toMatch(/export\s+(async\s+function|const)\s+GET\b/);
  });
});
