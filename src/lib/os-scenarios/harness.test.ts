// ===========================================================================
// THE HARNESS'S OWN CONTROLS.
//
// Every journey in this directory ends by asserting that a list of violations is
// empty. That is a strong shape when the list can actually be non-empty, and a
// completely worthless one when it cannot — a helper that returns `[]` no matter
// what would make all eight journeys pass forever, and nothing else in the suite
// would notice.
//
// So this file does the one thing the journeys cannot do for themselves: it
// hands each invariant a world that BREAKS it and requires the violation to be
// reported, in words, naming the thing that broke. It is the mutation check for
// this lane, done at the fixture level — which is the only place it can be done
// honestly, because the modules these journeys drive belong to other lanes and
// are not this lane's to edit.
//
// Read it as: "here is what a failure looks like". If a journey ever goes green
// while something in it is wrong, the bug is in one of these five functions, and
// these are the tests that would have caught it.
// ===========================================================================

import { describe, it, expect, beforeEach } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";
import {
  CLIENT,
  SITE,
  MOCK_DENTALLY_HOST,
  createOsWorld,
  installFetchGuard,
  isLiveDentallyUrl,
  liveDentallyViolations,
  correspondenceViolations,
  dailyCapViolations,
  patientCopyViolations,
  type FetchGuard,
  type OsWorld,
} from "./harness";

let world: OsWorld;
const cleanGuard: FetchGuard = { calls: [], liveDentallyCalls: [], restore: () => {} };

beforeEach(() => {
  world = createOsWorld(createFakeSupabase());
});

function intent(overrides: Record<string, unknown>) {
  world.fake.seed("dentally_write_intent", {
    id: `intent-${Math.random().toString(36).slice(2)}`,
    client_id: CLIENT,
    site_id: SITE,
    kind: "appointment.create",
    source: "recall",
    module_slug: "recall",
    target: "api.dentally.co",
    payload_summary: {},
    status: "blocked",
    blocked_reason: "writes_disabled",
    ...overrides,
  });
}

describe("the harness's live-Dentally invariant reports what it should", () => {
  it("is silent on the world the journeys actually produce", () => {
    intent({ status: "blocked", target: "api.dentally.co" });
    intent({ status: "dry_run", target: MOCK_DENTALLY_HOST });
    expect(liveDentallyViolations(world, cleanGuard)).toEqual([]);
  });

  it("names a request that reached a live Dentally host", () => {
    const guard: FetchGuard = {
      calls: ["https://api.dentally.co/v1/appointments"],
      liveDentallyCalls: ["https://api.dentally.co/v1/appointments"],
      restore: () => {},
    };
    const problems = liveDentallyViolations(world, guard);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a request was made to a live Dentally host");
  });

  it("names a row in status `sent`, which is the one status that means the real book", () => {
    intent({ status: "sent", target: MOCK_DENTALLY_HOST });
    const problems = liveDentallyViolations(world, cleanGuard);
    expect(problems.some((p) => p.includes('is status "sent"'))).toBe(true);
  });

  it("names a row that RAN against the live host rather than being refused", () => {
    // The subtle one, and the reason the sweep is not simply "no sent rows": a
    // dry_run row aimed at api.dentally.co means the gate performed against the
    // live book and merely labelled the result differently.
    intent({ status: "dry_run", target: "api.dentally.co" });
    const problems = liveDentallyViolations(world, cleanGuard);
    expect(problems.some((p) => p.includes('targets the live host api.dentally.co with status "dry_run"'))).toBe(true);
  });

  it("names a failed write against the mock, which should have been dry_run or blocked", () => {
    intent({ status: "failed", target: MOCK_DENTALLY_HOST });
    expect(liveDentallyViolations(world, cleanGuard)).toHaveLength(1);
  });

  it("treats an unparseable host as the live book, which is the safe direction", () => {
    expect(isLiveDentallyUrl("api.dentally.co")).toBe(true); // no scheme: unparseable
    expect(isLiveDentallyUrl("https://api.dentally.co/v1/patients")).toBe(true);
    expect(isLiveDentallyUrl("https://sandbox.dentally.co/v1")).toBe(true);
    expect(isLiveDentallyUrl("http://localhost:3000/api/mock-dentally")).toBe(false);
    // The near-misses that must NOT read as live.
    expect(isLiveDentallyUrl("https://dentally.co.evil.test/v1")).toBe(false);
    expect(isLiveDentallyUrl("https://notdentally.co/v1")).toBe(false);
  });

  it("the fetch guard records and rejects, rather than quietly allowing", async () => {
    const guard = installFetchGuard();
    try {
      await expect(fetch("https://api.dentally.co/v1/patients")).rejects.toThrow(/tried to reach the network/);
      await expect(fetch("https://example.test/anything")).rejects.toThrow(/tried to reach the network/);
      expect(guard.calls).toHaveLength(2);
      expect(guard.liveDentallyCalls).toEqual(["https://api.dentally.co/v1/patients"]);
    } finally {
      guard.restore();
    }
    // And it puts the real fetch back, so one journey cannot poison the next.
    expect(typeof globalThis.fetch).toBe("function");
  });
});

describe("the harness's correspondence invariant reports what it should", () => {
  const message = (source: string) => ({ source, body: "Hello from the practice.", direction: "outbound" });

  it("is silent when every expected source is on the record", () => {
    const read = { thread: { messages: [message("agent"), message("speed-to-lead")] }, failedSourceNames: [] };
    expect(correspondenceViolations(read, ["agent", "speed-to-lead"])).toEqual([]);
  });

  it("names a source that is missing, and lists what WAS there", () => {
    const read = { thread: { messages: [message("agent")] }, failedSourceNames: [] };
    const problems = correspondenceViolations(read, ["agent", "speed-to-lead"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('correspondence source "speed-to-lead" is missing');
    expect(problems[0]).toContain("present: agent");
  });

  it("names a source that FAILED to read, even when the message being looked for is there", () => {
    // The failure mode this catches is a record that is silently incomplete: the
    // one message the test was watching for arrived, and the balance-reminder
    // history could not be read at all.
    const read = { thread: { messages: [message("agent")] }, failedSourceNames: ["collection"] };
    const problems = correspondenceViolations(read, ["agent"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('could not read correspondence source "collection"');
  });

  it("names an empty record when messages were expected", () => {
    const problems = correspondenceViolations({ thread: null, failedSourceNames: [] }, ["previsit"]);
    expect(problems[0]).toContain("no thread at all");
  });

  it("is silent about an empty record when nothing was expected", () => {
    expect(correspondenceViolations({ thread: null, failedSourceNames: [] }, [])).toEqual([]);
  });
});

describe("the harness's daily-cap invariant reports what it should", () => {
  it("is silent on one stamp per address per day", () => {
    world.fake.seed(
      "message_daily_log",
      { site_id: SITE, address: "+447700900001", sent_on: "2026-09-03", source: "recall" },
      { site_id: SITE, address: "+447700900002", sent_on: "2026-09-03", source: "recall" },
      { site_id: SITE, address: "+447700900001", sent_on: "2026-09-04", source: "recall" },
    );
    expect(dailyCapViolations(world)).toEqual([]);
  });

  it("names an address stamped twice on the same day", () => {
    world.fake.seed(
      "message_daily_log",
      { site_id: SITE, address: "+447700900001", sent_on: "2026-09-03", source: "recall" },
      { site_id: SITE, address: "+447700900001", sent_on: "2026-09-03", source: "reviews" },
    );
    const problems = dailyCapViolations(world);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2 rows");
    expect(problems[0]).toContain("+447700900001");
  });
});

describe("the harness's funding-jargon invariant reports what it should", () => {
  it("is silent on the copy the platform actually sends", () => {
    expect(
      patientCopyViolations("control", [
        "Hi Amara, Vitality Dental here. A few quick questions before your visit: https://x.test/pv/abc",
        "If you're in severe pain right now, please call the practice on 020 8808 8484. Outside opening hours, call 111 for urgent dental advice.",
      ]),
    ).toEqual([]);
  });

  it("names the forbidden word, and the message it was in", () => {
    const problems = patientCopyViolations("first contact", ["We can see you on the NHS next week."]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("first contact");
    expect(problems[0]).toContain('contains "NHS"');
  });

  it("catches the other two shapes as well", () => {
    expect(patientCopyViolations("x", ["This would be a private appointment."])).toHaveLength(1);
    expect(patientCopyViolations("x", ["That is a Band 2 treatment."])).toHaveLength(1);
    // "call 111" is allowed and must stay allowed — it is the phrase the triage
    // help-now line uses precisely BECAUSE it does not say the forbidden word.
    expect(patientCopyViolations("x", ["Outside opening hours, call 111."])).toEqual([]);
  });
});

describe("the world itself behaves as the journeys assume", () => {
  it("an absent toggle row is not the same as a row saying false", () => {
    world.setToggle("equipment", true);
    expect(world.rows("system_toggle")).toHaveLength(1);
    world.clearToggle("equipment");
    expect(world.rows("system_toggle"), "clearToggle left the row behind").toEqual([]);
  });

  it("setToggle updates in place rather than stacking rows", () => {
    world.setToggle("equipment", true);
    world.setToggle("equipment", false);
    const rows = world.rows("system_toggle");
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
  });

  it("reset really empties the world, so one journey cannot leak into the next", () => {
    intent({});
    world.setToggle("equipment", true);
    world.reset();
    expect(world.rows("dentally_write_intent")).toEqual([]);
    expect(world.rows("system_toggle")).toEqual([]);
  });
});
