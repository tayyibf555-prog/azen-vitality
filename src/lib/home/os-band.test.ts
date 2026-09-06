import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ===========================================================================
// THE OPERATING SYSTEM BAND: what it reads, what it refuses to read, and what
// it prints when it cannot.
//
// The band is the front door's answer to "is the machine running", so the whole
// suite is about HONESTY rather than about layout. Four properties, each of
// which is a way the band could lie:
//
//   1. A switched-off system prints "Off", never "0". A zero under a system
//      nobody switched on reads as "nothing needs doing" when the truth is
//      "nothing is watching" — the most expensive dishonesty a dashboard has.
//   2. A switched-off system is not even QUERIED. That is the same rule proved
//      from the other end: if the read never runs, no zero can be produced by
//      accident, and a practice on day one pays for two queries and not six.
//   3. A failed read prints "Not readable just now" and never an empty state.
//      "You have no equipment" and "we could not read your equipment" are
//      different sentences and only one of them is ever true here.
//   4. A capped read is a FLOOR. A query that stopped counting at its bound
//      prints "at least N" and never wears N's clothes.
//
// Plus the role rule, which is the OS-cohesion half: a tile is drawn only if the
// role may open the module it links to, so the practice manager's band is her
// subset by construction and a clinician and a member of staff get exactly the
// two desks that ruling W2-A/1 (3 Sep 2026) widened to all five clearances —
// Equipment and the IT desk. (Until that ruling this paragraph said a clinician
// saw nothing here at all, which is what the module's own header said too; that
// one is pinned by "the header's account of who sees a tile is the one the code
// gives", and this one is scanned by the same test now, so the two accounts
// cannot drift apart again.)
// ===========================================================================

vi.mock("server-only", () => ({}));

let systemStates: Array<{ slug: string; enabled: boolean }> | "throw" = [];
let leads: unknown[] | "throw" = [];
let targets: unknown[] | "throw" = [];
let assets: Array<{ nextServiceDue: string | null }> | null | "throw" = [];
let contact: { name: string | null; company: string | null } | null | "throw" = null;
let intents: { counts: Record<string, number>; total: number; capped: boolean } | "throw" = {
  counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 0 },
  total: 0,
  capped: false,
};

/** Which reads actually ran on the last call. Property 2 is proved from this. */
const called: string[] = [];

function maybe<T>(value: T | "throw", name: string): T {
  called.push(name);
  if (value === "throw") throw new Error(`${name} exploded`);
  return value;
}

/** What each list read was ASKED for, on the last call. */
const limits: Record<string, number | undefined> = {};

/**
 * A LIST STUB THAT HONOURS `limit`, BECAUSE THE REAL ONE DOES AND THE FLOOR
 * TESTS BELOW ARE ONLY EVIDENCE IF IT DOES.
 *
 * `listLeads` and `listTargets` both end in `.limit(args.limit ?? N)`
 * (src/lib/speed-to-lead/repository.ts, src/lib/triage/repository.ts), so the
 * database can NEVER hand the band more rows than the band asked for. A stub
 * that ignored the argument and returned the whole fixture broke that link: it
 * let a seeded 201-row fixture reach `figure()` however small a page the code
 * requested, so "a read at the cap is a FLOOR" proved only that the FORMATTER
 * handles an over-full array. Drop the `+ 1` from either read — the one thing
 * that makes `rowCount > TILE_ROW_CAP` reachable at all — and the whole suite
 * stayed green while the band began printing an exact "200 sent, awaiting an
 * answer" for a practice with hundreds more out. Charter §0/11: the mock must
 * be at least as strict as live.
 */
function bounded<T>(value: T[] | "throw", name: string, args?: { limit?: number }): T[] {
  limits[name] = args?.limit;
  const rows = maybe(value, name);
  return args?.limit === undefined ? rows : rows.slice(0, args.limit);
}

vi.mock("@/lib/systems/repository", () => ({
  getSystemStates: async () => maybe(systemStates, "getSystemStates"),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listLeads: async (args: { limit?: number }) => bounded(leads, "listLeads", args),
}));
vi.mock("@/lib/triage/repository", () => ({
  listTargets: async (args: { limit?: number }) => bounded(targets, "listTargets", args),
}));
// ASSET_ROW_CAP is re-exported by the mock rather than dropped: the band reads
// the register's OWN bound to decide whether its figure is a floor, and a mock
// that omitted it would make every equipment figure silently un-capped — which
// is the exact dishonesty the tests below are about.
vi.mock("@/lib/equipment/repository", () => ({
  ASSET_ROW_CAP: 400,
  listAssets: async () => maybe(assets, "listAssets"),
}));
vi.mock("@/lib/itdesk/repository", () => ({
  getItContact: async () => maybe(contact, "getItContact"),
}));
// COUNT_CAP is re-exported for the same reason ASSET_ROW_CAP is: the write-back
// tile names the ledger's OWN bound in the sentence it prints when a capped read
// found nothing blocked, and a mock that dropped it would print "the most recent
// undefined writes" while this suite passed. Pinned to the real value below.
vi.mock("@/lib/dentally/sync-ledger", () => ({
  COUNT_CAP: 900,
  countWriteIntents: async () => maybe(intents, "countWriteIntents"),
}));

const { readOsBand, OS_TILES, TILE_ROW_CAP } = await import("./os-band");
const { canRoleAccessModule } = await import("@/lib/nav");
const { londonDayKey } = await import("@/lib/time/london");
const { OperatingSystemBandView } = await import("@/components/client/dashboard/os-band");

const ALL_ON = OS_TILES.filter((t) => t.systemSlug !== null).map((t) => ({
  slug: t.systemSlug as string,
  enabled: true,
}));
const ALL_OFF = ALL_ON.map((s) => ({ ...s, enabled: false }));

beforeEach(() => {
  called.length = 0;
  for (const k of Object.keys(limits)) delete limits[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  systemStates = ALL_ON;
  leads = [];
  targets = [];
  assets = [];
  contact = null;
  intents = { counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 0 }, total: 0, capped: false };
});

const OWNER = { clientId: "c1", siteIds: ["s1"], role: "client_owner" as const };

function tile(band: Awaited<ReturnType<typeof readOsBand>>, key: string) {
  const found = band.tiles.find((t) => t.key === key);
  expect(found, `no tile ${key}`).toBeTruthy();
  return found!;
}

describe("a switched-off system says Off, and is not read at all", () => {
  it("prints the state and the first step, never a zero", async () => {
    systemStates = ALL_OFF;
    const band = await readOsBand(OWNER);
    for (const key of ["leads", "pre-visit", "equipment", "it-desk"]) {
      const t = tile(band, key);
      expect(t.enabled, `${key} switch state`).toBe(false);
      expect(t.state.kind, `${key} state`).toBe("off");
    }
    // The one that HAS a first step written for it carries it.
    const previsit = tile(band, "pre-visit");
    expect(previsit.state.kind === "off" && previsit.state.firstStep).toBeTruthy();
  });

  it("issues no query for an off tile — the zero cannot be produced by accident", async () => {
    systemStates = ALL_OFF;
    await readOsBand(OWNER);
    expect(called).not.toContain("listLeads");
    expect(called).not.toContain("listTargets");
    expect(called).not.toContain("listAssets");
    expect(called).not.toContain("getItContact");
  });

  it("STILL counts what write-back held back, because that number exists BECAUSE it is off", async () => {
    systemStates = ALL_OFF;
    intents = {
      counts: { dry_run: 4, queued: 0, sent: 0, failed: 0, blocked: 12 },
      total: 16,
      capped: false,
    };
    const band = await readOsBand(OWNER);
    expect(called).toContain("countWriteIntents");
    const t = tile(band, "write-back");
    expect(t.enabled).toBe(false);
    expect(t.state).toEqual({ kind: "figure", value: 12, noun: "held back", atLeast: false, tone: "attention" });
  });

  it("is the ONLY tile that counts while off", async () => {
    const exceptions = OS_TILES.filter((t) => t.countsWhileOff).map((t) => t.key);
    // The automations tile has no switch of its own; write-back is the one
    // switched surface whose figure survives being off.
    expect(exceptions.sort()).toEqual(["automations", "write-back"]);
  });
});

describe("a switched-on system prints an honest figure", () => {
  it("counts leads awaiting a first contact", async () => {
    leads = new Array(7).fill({});
    const band = await readOsBand(OWNER);
    expect(tile(band, "leads").state).toEqual({
      kind: "figure",
      value: 7,
      noun: "awaiting first contact",
      atLeast: false,
      tone: "attention",
    });
  });

  it("a read at the cap is a FLOOR, and says so", async () => {
    leads = new Array(TILE_ROW_CAP + 1).fill({});
    const band = await readOsBand(OWNER);
    const state = tile(band, "leads").state;
    expect(state).toEqual({
      kind: "figure",
      value: TILE_ROW_CAP,
      noun: "awaiting first contact",
      atLeast: true,
      tone: "attention",
    });
  });

  it("zero enquiries under a RUNNING system is a plain zero, not 'Off'", async () => {
    leads = [];
    const band = await readOsBand(OWNER);
    const state = tile(band, "leads").state;
    expect(state.kind).toBe("figure");
    expect(state.kind === "figure" && state.value).toBe(0);
    // And a zero never colours: nothing needs attention.
    expect(state.kind === "figure" && state.tone).toBe("neutral");
  });

  it("an ON system with an EMPTY register says 'Nothing yet', which is not 'Off'", async () => {
    assets = [];
    const band = await readOsBand(OWNER);
    const t = tile(band, "equipment");
    expect(t.enabled).toBe(true);
    expect(t.state.kind).toBe("empty");
    expect(t.state.kind === "empty" && t.state.firstStep).toContain("register");
  });

  it("counts equipment overdue a service, and colours only when there is some", async () => {
    assets = [
      { nextServiceDue: "1999-01-01" },
      { nextServiceDue: "1999-01-02" },
      { nextServiceDue: "2999-01-01" },
      { nextServiceDue: null },
    ];
    const overdue = await readOsBand(OWNER);
    expect(tile(overdue, "equipment").state).toEqual({
      kind: "figure",
      value: 2,
      noun: "overdue a service",
      atLeast: false,
      tone: "attention",
    });

    assets = [{ nextServiceDue: "2999-01-01" }];
    const clean = await readOsBand(OWNER);
    expect(tile(clean, "equipment").state).toEqual({
      kind: "fact",
      text: "1 registered, none overdue",
      tone: "neutral",
    });
  });

  it("decides 'overdue a service' on the PRACTICE's day, not the server's", async () => {
    // 00:30 on 16 July 2026 in London is 23:30 UTC on the 15th. For that hour
    // every BST night the UTC day key is still YESTERDAY, and an autoclave whose
    // pressure-vessel test was due on the 15th is overdue in the practice. The
    // equipment desk (/api/equipment/[action] passes londonDayKey(new Date()))
    // and the co-pilot's equipment_lookup both call it overdue at this instant
    // and append the take-out-of-use sentence (W1-D/2); the front door must not
    // be the one surface that calls it fine. Fixtures a millennium from any day
    // boundary — which is what the rest of this suite uses — cannot see this.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-15T23:30:00Z"));
      // The premise, asserted rather than assumed: if the two keys agreed at
      // this instant, the test below would be proving nothing at all.
      expect(
        new Date().toISOString().slice(0, 10),
        "the UTC/London shift is not biting at this instant",
      ).not.toBe(londonDayKey(new Date()));

      assets = [{ nextServiceDue: "2026-07-15" }];
      expect(tile(await readOsBand(OWNER), "equipment").state).toEqual({
        kind: "figure",
        value: 1,
        noun: "overdue a service",
        atLeast: false,
        tone: "attention",
      });

      // CONTROL: due TODAY in London is not overdue. The boundary moved by one
      // day; it did not turn every asset red.
      assets = [{ nextServiceDue: "2026-07-16" }];
      expect(tile(await readOsBand(OWNER), "equipment").state).toEqual({
        kind: "fact",
        text: "1 registered, none overdue",
        tone: "neutral",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a register read at ITS OWN bound makes both equipment figures a floor", async () => {
    const { ASSET_ROW_CAP } = await import("@/lib/equipment/repository");
    // The mock's bound is pinned to the REAL one, read out of the repository's
    // source rather than remembered here: a cap the module raised and the mock
    // did not would make this suite prove a floor the band never applies.
    const { readFileSync } = await import("node:fs");
    const real = readFileSync("src/lib/equipment/repository.ts", "utf8").match(
      /ASSET_ROW_CAP\s*=\s*(\d+)/,
    );
    expect(real, "the ASSET_ROW_CAP scan went stale").toBeTruthy();
    expect(ASSET_ROW_CAP, "the mock's bound drifted from the repository's").toBe(Number(real![1]));
    assets = new Array(ASSET_ROW_CAP).fill({ nextServiceDue: "2999-01-01" });
    const clean = await readOsBand(OWNER);
    expect(tile(clean, "equipment").state).toEqual({
      kind: "fact",
      text: `at least ${ASSET_ROW_CAP} registered, none overdue so far`,
      tone: "neutral",
    });

    assets = [
      ...new Array(ASSET_ROW_CAP - 1).fill({ nextServiceDue: "2999-01-01" }),
      { nextServiceDue: "1999-01-01" },
    ];
    const overdue = await readOsBand(OWNER);
    expect(tile(overdue, "equipment").state).toEqual({
      kind: "figure",
      value: 1,
      noun: "overdue a service",
      atLeast: true,
      tone: "attention",
    });
  });

  it("names the IT contact, and flags its absence", async () => {
    contact = { name: "Sam Patel", company: null };
    const named = await readOsBand(OWNER);
    expect(tile(named, "it-desk").state).toEqual({
      kind: "fact",
      text: "Escalates to Sam Patel",
      tone: "neutral",
    });

    contact = { name: null, company: null };
    const none = await readOsBand(OWNER);
    expect(tile(none, "it-desk").state).toEqual({
      kind: "fact",
      text: "No IT contact set",
      tone: "attention",
    });
  });

  it("counts the switches themselves for the automations tile", async () => {
    systemStates = [
      { slug: "recall", enabled: true },
      { slug: "reviews", enabled: false },
      { slug: "equipment", enabled: false },
    ];
    const band = await readOsBand(OWNER);
    expect(tile(band, "automations").state).toEqual({
      kind: "fact",
      text: "1 of 3 running",
      tone: "neutral",
    });
  });

  // THE HEADLINE COUNT AND THE TILE BESIDE IT MUST NOT DISAGREE (ruling W3/31).
  //
  // Four owner switches arm a sweep with no scheduled job. The pre-visit tile
  // already says "On, but nothing runs it yet" for one of them; counting the
  // same system in a headline "running" figure put two cells of one instrument
  // in contradiction, with the summary-shaped one wrong. And three of the four
  // — treatment-closer, balance-reminders, postop-checkin — have no tile of
  // their own at all, so this figure is the only thing Home says about them and
  // nothing on the front door could have corrected it.
  it("a switched-on system with no scheduled job is not counted as running, and is named", async () => {
    systemStates = [
      { slug: "recall", enabled: true }, // registered: genuinely running
      { slug: "pre-visit-triage", enabled: true }, // armed, no cron job
      { slug: "postop-checkin", enabled: true }, // armed, no cron job, and no tile of its own
      { slug: "reviews", enabled: false },
    ];
    expect(tile(await readOsBand(OWNER), "automations").state).toEqual({
      kind: "fact",
      // One of the four is running; two are switched on and inert; the
      // denominator is still every controllable system there is.
      text: "1 of 4 running, 2 not started",
      tone: "attention",
    });
  });

  it("takes the stalled slugs from the scheduler, not from a list of its own", async () => {
    // The derivation, the same one the pre-visit tile uses: registering the two
    // jobs (a status edit in src/lib/agent-wiring/scheduler.ts) restores them to
    // the running count with no edit to this module. `recall` above is the
    // control — a slug the scheduler DOES run, which must keep counting.
    const { slugsWithNoScheduledJob } = await import("@/lib/agent-wiring/scheduler");
    const stalled = slugsWithNoScheduledJob();
    expect(stalled).toEqual(expect.arrayContaining(["pre-visit-triage", "postop-checkin"]));
    expect(stalled).not.toContain("recall");
  });
});

describe("the write-back tile's ZERO is as honest as its figure", () => {
  // The tile counts while its system is off because writes held back accrue
  // BECAUSE it is off, and that number is the reason the owner goes and looks.
  // The count comes off a read bounded at COUNT_CAP, so on a capped read a zero
  // means "none of the most recent N", never "none ever" — and a held-back write
  // is permanent (W1-A/1: no replay, ever). "Nothing held back" printed off a
  // truncated read is the one sentence that stops the owner opening Sync Status.
  it("a CAPPED read with nothing blocked in it never claims nothing was held back", async () => {
    const { COUNT_CAP } = await import("@/lib/dentally/sync-ledger");
    // The mock's bound is pinned to the REAL one, read out of the ledger's
    // source rather than remembered here — same reason as ASSET_ROW_CAP above.
    const { readFileSync } = await import("node:fs");
    const real = readFileSync("src/lib/dentally/sync-ledger.ts", "utf8").match(/COUNT_CAP\s*=\s*(\d+)/);
    expect(real, "the COUNT_CAP scan went stale").toBeTruthy();
    expect(COUNT_CAP, "the mock's bound drifted from the ledger's").toBe(Number(real![1]));

    systemStates = ALL_OFF;
    intents = {
      counts: { dry_run: COUNT_CAP, queued: 0, sent: 0, failed: 0, blocked: 0 },
      total: COUNT_CAP,
      capped: true,
    };
    const state = tile(await readOsBand(OWNER), "write-back").state;
    expect(state.kind).toBe("fact");
    const text = state.kind === "fact" ? state.text : "";
    expect(text, "a truncated read made a claim about the whole ledger").not.toBe("Nothing held back");
    // It says what it counted, and names the bound it counted to.
    expect(text).toContain("most recent");
    expect(text).toContain(COUNT_CAP.toLocaleString("en-GB"));
    expect(state.kind === "fact" && state.tone).toBe("neutral");
  });

  it("an UNCAPPED read with nothing blocked says so plainly, with no hedge", async () => {
    // The control: the qualifier is tracking the CAP, not the zero. A practice
    // whose whole ledger was read and held nothing back is told exactly that.
    systemStates = ALL_OFF;
    intents = {
      counts: { dry_run: 9, queued: 0, sent: 0, failed: 0, blocked: 0 },
      total: 9,
      capped: false,
    };
    expect(tile(await readOsBand(OWNER), "write-back").state).toEqual({
      kind: "fact",
      text: "Nothing held back",
      tone: "neutral",
    });
  });

  it("a capped read WITH blocked rows still prints the floor it always did", async () => {
    // Unchanged behaviour, kept under the same heading so the two halves of the
    // rule are read together: capped + non-zero is "at least N held back".
    systemStates = ALL_OFF;
    intents = {
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 7 },
      total: 2000,
      capped: true,
    };
    expect(tile(await readOsBand(OWNER), "write-back").state).toEqual({
      kind: "figure",
      value: 7,
      noun: "held back",
      atLeast: true,
      tone: "attention",
    });
  });
});

describe("the pre-visit figure is one the practice can clear", () => {
  // A target leaves `sent` when the patient answers, or when the pre-visit
  // sweep's third pass retires a link its appointment overtook (ruling W3/5).
  // The tile has no retirement of its own and must not grow one — the module's
  // own note says why a date filter applied AFTER this bounded, oldest-first
  // read would turn an honest floor into a wrong number — so the noun
  // "awaiting an answer" is true only while that pass exists. The pass lives in
  // another module's route and is behaviour-tested there; what a lane removing
  // it would BREAK is the meaning of this tile, so the red belongs here too.
  it("the sweep still retires a sent link its appointment has overtaken", async () => {
    const { readFileSync } = await import("node:fs");
    const sweep = readFileSync("src/app/api/previsit/sweep/route.ts", "utf8");
    expect(sweep.length, "the pre-visit sweep scan went stale").toBeGreaterThan(1_000);
    // Deliberately loose about ORDER and about what else is in the list — the
    // one fact this tile depends on is that `sent` is among the statuses the
    // retiring pass examines. A lane widening or reordering that list should
    // not get a false red from the front door.
    expect(
      sweep,
      "the sweep no longer looks at SENT targets, so nothing retires this tile's number",
    ).toMatch(/statuses:\s*\[[^\]]*"sent"[^\]]*\]/);
    expect(
      sweep,
      "the sweep no longer retires an overtaken link, so this tile's figure only grows",
    ).toMatch(/stopTarget\(\s*[^)]*"expired"\s*\)/);
  });

  // THE ZERO THAT IS NOT A ZERO (wave-3b handoff B128, ruling W3/31). The
  // pre-visit sweep has no scheduled job, so a switched-on module sends nothing
  // and this tile's honest-looking "0 sent, awaiting an answer" was the same
  // fail-open the control panel's "Switched on, but it has not started" sentence
  // was written to close — printed one screen earlier and read by more people.
  it("an ON module whose sweep has no scheduled job says so instead of printing 0", async () => {
    targets = [];
    expect(tile(await readOsBand(OWNER), "pre-visit").state).toEqual({
      kind: "fact",
      text: "On, but nothing runs it yet",
      tone: "attention",
    });
  });

  it("takes that fact from the scheduler, not from a list of its own", async () => {
    // The derivation, not the sentence: this tile qualifies itself because
    // `pre-visit-triage` is in slugsWithNoScheduledJob(), so registering the job
    // (a two-line edit to src/lib/agent-wiring/scheduler.ts) restores the figure
    // without anybody remembering this file exists.
    const { slugsWithNoScheduledJob } = await import("@/lib/agent-wiring/scheduler");
    expect(slugsWithNoScheduledJob()).toContain("pre-visit-triage");
    expect(slugsWithNoScheduledJob().length, "the scheduler reports every sweep as registered")
      .toBeGreaterThan(0);
  });

  it("never hides a real number behind it", async () => {
    // The other direction, and the one that would be a worse defect: a count
    // that exists is proof the sweep ran, whatever this module records. Only the
    // EMPTY figure is replaced.
    targets = [{}, {}, {}];
    expect(tile(await readOsBand(OWNER), "pre-visit").state).toEqual({
      kind: "figure",
      value: 3,
      noun: "sent, awaiting an answer",
      atLeast: false,
      tone: "neutral",
    });
  });

  it("counts the questionnaires out, and prints a floor at the bound", async () => {
    // The noun the paragraph above is about, pinned as text: a rename that made
    // it a claim about something other than an outstanding answer would land
    // here first.
    targets = Array.from({ length: TILE_ROW_CAP + 1 }, () => ({}));
    expect(tile(await readOsBand(OWNER), "pre-visit").state).toEqual({
      kind: "figure",
      value: TILE_ROW_CAP,
      noun: "sent, awaiting an answer",
      atLeast: true,
      tone: "neutral",
    });
  });

  it("reads ONE ROW PAST the bound, or the floor above could never be true", async () => {
    // THE READ, NOT THE FORMATTER. `figure()` decides `atLeast` from
    // `rowCount > TILE_ROW_CAP`, and that comparison is reachable only because
    // the query asks for TILE_ROW_CAP + 1: a read bounded at exactly the cap
    // cannot come back with more than the cap, so `atLeast` would be
    // structurally false and this tile would print a flat "200 sent, awaiting
    // an answer" — a complete-looking total — to a practice with hundreds more
    // links out. That is rule 4 of the module header ("a number at its cap is a
    // floor, not a total") and programme ruling W3/11, and dropping the `+ 1`
    // used to leave the whole suite green, because the stub ignored `limit`.
    // The stub honours it now, so the assertion below is the real path and the
    // recorded argument is the diagnosis printed alongside it.
    targets = Array.from({ length: TILE_ROW_CAP * 4 }, () => ({}));
    const state = tile(await readOsBand(OWNER), "pre-visit").state;
    expect(limits.listTargets, "the questionnaire read must reach past its own bound").toBe(
      TILE_ROW_CAP + 1,
    );
    expect(state).toEqual({
      kind: "figure",
      value: TILE_ROW_CAP,
      noun: "sent, awaiting an answer",
      atLeast: true,
      tone: "neutral",
    });
  });

  it("the enquiries read reaches past ITS bound too — the sibling this one drifted from", async () => {
    // The symmetry is the point: both figures on the band are floors off
    // bounded reads, and the pre-visit one went un-probed for a whole wave
    // while the leads one was pinned in os-scenarios/j8-honest-numbers. Neither
    // is now pinned only by its neighbour.
    leads = Array.from({ length: TILE_ROW_CAP * 4 }, () => ({}));
    const state = tile(await readOsBand(OWNER), "leads").state;
    expect(limits.listLeads, "the enquiries read must reach past its own bound").toBe(
      TILE_ROW_CAP + 1,
    );
    expect(state).toEqual({
      kind: "figure",
      value: TILE_ROW_CAP,
      noun: "awaiting first contact",
      atLeast: true,
      tone: "attention",
    });
  });
});

describe("a read that failed never wears a number's clothes", () => {
  it("an unreadable list is 'unreadable', not empty", async () => {
    leads = "throw";
    assets = "throw";
    contact = "throw";
    const band = await readOsBand(OWNER);
    expect(tile(band, "leads").state.kind).toBe("unreadable");
    expect(tile(band, "equipment").state.kind).toBe("unreadable");
    expect(tile(band, "it-desk").state.kind).toBe("unreadable");
    // One failure does not take the others down. The pre-visit read SUCCEEDED
    // and returned nothing, which since B128 prints as the unscheduled-sweep
    // sentence rather than a bare zero — the point here is that it is not
    // "unreadable", and that the distinction survives three siblings throwing.
    expect(tile(band, "pre-visit").state.kind).not.toBe("unreadable");
    expect(tile(band, "pre-visit").state).toEqual({
      kind: "fact",
      text: "On, but nothing runs it yet",
      tone: "attention",
    });
  });

  it("unreadable SWITCHES stop every read and say the band's state is unknown", async () => {
    systemStates = "throw";
    const band = await readOsBand(OWNER);
    expect(band.switchesUnreadable).toBe(true);
    // Not "off" — we do not know that. Every tile says so, and nothing was read
    // except the tile whose figure is the switches themselves.
    for (const t of band.tiles) {
      expect(t.enabled, `${t.key} claims a switch state it cannot know`).toBeNull();
      expect(t.state.kind, `${t.key}`).toBe("unreadable");
    }
    expect(called).toEqual(["getSystemStates"]);
  });
});

describe("who sees which tiles is decided by the module guard, not a second list", () => {
  it("the owner and the agency see the whole band", async () => {
    for (const role of ["client_owner", "agency_admin"] as const) {
      const band = await readOsBand({ ...OWNER, role });
      expect(band.tiles.map((t) => t.key)).toEqual(OS_TILES.map((t) => t.key));
    }
  });

  it("the practice manager sees her operational subset and no System controls", async () => {
    const band = await readOsBand({ ...OWNER, role: "client_coordinator" });
    expect(band.tiles.map((t) => t.key)).toEqual(["leads", "pre-visit", "equipment", "it-desk"]);
    // The two she loses are the two that link into the owner's control panel.
    expect(band.tiles.map((t) => t.path)).not.toContain("/controls");
    expect(band.tiles.map((t) => t.path)).not.toContain("/controls/sync");
  });

  // WIDENED, and INVERTED rather than loosened. This test asserted that a
  // clinician and a receptionist got no band at all, which was true while the
  // two desks were owner+manager. The programme coordinator's ruling of
  // 3 Sep 2026 (W2-A/1) widened the equipment desk and the IT desk to every
  // clearance, and the band follows automatically because it gates on
  // `canRoleAccessModule` rather than on a list of its own — which is the
  // property worth having and is what the assertion now states.
  it("a clinician and a member of staff get EXACTLY the two desks, and nothing else", async () => {
    for (const role of ["client_clinician", "client_staff"] as const) {
      called.length = 0;
      const band = await readOsBand({ ...OWNER, role });
      expect(band.tiles.map((t) => t.key), `${role}`).toEqual(["equipment", "it-desk"]);
      // No enquiries, no questionnaires, no write ledger and no switch panel.
      expect(called).not.toContain("listLeads");
      expect(called).not.toContain("listTargets");
      expect(called).not.toContain("countWriteIntents");
      expect(band.tiles.map((t) => t.path)).not.toContain("/controls");
    }
  });

  it("the header's account of who sees a tile is the one the code gives", async () => {
    // Charter §0 item 1: in this tree the comments are the contract — a later
    // lane reads this file's header to decide whether a new tile needs a
    // clinician review or an empty state. The header said a clinician "gets no
    // band at all", which stopped being true in the very commit that widened the
    // two desks to all five clearances (W2-A/1), and prod has no clinician login
    // to catch it. So the paragraph is pinned to the behaviour it describes:
    // every tile a role actually gets must be named in it, and the stale claim
    // cannot come back.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/home/os-band.ts", "utf8");
    const header = src.slice(0, src.indexOf("import { canRoleAccessModule }"));
    expect(header, "the header-block scan went stale").toContain("WHO SEES A TILE");

    for (const role of ["client_clinician", "client_coordinator"] as const) {
      const band = await readOsBand({ ...OWNER, role });
      expect(band.tiles.length, `${role} sees no tiles at all`).toBeGreaterThan(0);
      for (const t of band.tiles) {
        expect(
          header.toLowerCase(),
          `the header never names the ${t.label} tile that ${role} actually gets`,
        ).toContain(t.label.toLowerCase());
      }
    }

    // And the specific stale sentence, which is the one a later lane would act
    // on: it must not return while the clinician's band is non-empty.
    expect(header, "the header claims a clinician gets no band").not.toMatch(/clinician[^.]*no band/i);

    // THE SUITE'S OWN HEADER IS THE SAME CONTRACT. It carried the identical
    // stale claim for as long as the module's did, and it is what a lane adding
    // a case reads first, so it is scanned the same way. Only the top block —
    // everything above the first mock — so a test's prose about the old wording
    // (this one's included) is not mistaken for the claim itself.
    const suite = readFileSync("src/lib/home/os-band.test.ts", "utf8");
    const suiteHeader = suite.slice(0, suite.indexOf('vi.mock("server-only"'));
    expect(suiteHeader, "the suite header-block scan went stale").toContain("Plus the role rule");
    expect(
      suiteHeader,
      "the suite's own header claims a clinician gets no band",
    ).not.toMatch(/clinician[^.]*no band/i);
  });

  it("the band gates on the module guard itself, not on a second list", async () => {
    // The property that made the widening above free: every tile's visibility is
    // `canRoleAccessModule(role, tile.moduleSlug)`, so a nav ruling reaches the
    // front door with no second edit — and, more importantly, a module NARROWED
    // later cannot leave a tile behind pointing at a 403.
    //
    // ALL THREE CLEARANCES ARE ACTUALLY EVALUATED, AND THAT IS STRUCTURAL.
    // This body used to `return` the first role's promise from INSIDE a `for`
    // loop, so `client_staff` and `client_coordinator` were named in the loop
    // header and never once run: a green test proving one third of what it
    // claimed, at exactly the moment a widening or narrowing lane edits the
    // guard (charter §0 item 11; W3/17). A counter would not have caught the
    // regression either — a `return` put back inside a loop skips the counter's
    // assertion along with the remaining roles. So there is no loop carrying
    // assertions at all: every role is READ first into `seen`, and the three
    // comparisons below are single assertions over the whole map. An early
    // `return` inside the `.map` callback returns one element, not the test.
    const roles = ["client_clinician", "client_staff", "client_coordinator"] as const;
    const seen = await Promise.all(
      roles.map(async (role) => ({
        role,
        expected: OS_TILES.filter((t) => canRoleAccessModule(role, t.moduleSlug)).map((t) => t.key),
        actual: (await readOsBand({ ...OWNER, role })).tiles.map((t) => t.key),
      })),
    );

    // 1. Every clearance the test names was actually evaluated.
    expect(seen.map((s) => s.role), "a clearance named above went unevaluated").toEqual([...roles]);
    // 2. None of the comparisons is `[] === []`: a role that may open no module
    //    at all would make the check below true while proving nothing.
    expect(
      seen.filter((s) => s.expected.length === 0).map((s) => s.role),
      "these clearances may open no module in the band, so their check proves nothing",
    ).toEqual([]);
    // 3. The band IS the guard, per role — keyed by role so a red names the
    //    clearance that moved rather than a bare array diff.
    expect(Object.fromEntries(seen.map((s) => [s.role, s.actual]))).toEqual(
      Object.fromEntries(seen.map((s) => [s.role, s.expected])),
    );
  });
});

describe("the band as it is rendered", () => {
  function render(band: Awaited<ReturnType<typeof readOsBand>>): string {
    return renderToStaticMarkup(
      createElement(OperatingSystemBandView, { band, basePath: "/c/vitality" }),
    );
  }

  it("an off tile prints Off and the first step, and no zero", async () => {
    systemStates = ALL_OFF;
    const html = render(await readOsBand(OWNER));
    expect(html).toContain("Operating system");
    expect(html).toContain("Off");
    expect(html).toContain("Review the two question lists");
    // The literal figure a lying band would print. Checked as a standalone
    // number so "0 of 30 running" and the like cannot mask it.
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it("every tile is a link into the module it describes", async () => {
    const html = render(await readOsBand(OWNER));
    expect(html).toContain('href="/c/vitality/speed-to-lead"');
    expect(html).toContain('href="/c/vitality/pre-visit-triage"');
    expect(html).toContain('href="/c/vitality/equipment"');
    expect(html).toContain('href="/c/vitality/it-desk"');
    // The Dentally sync tab is a route of its own in the staff tree.
    expect(html).toContain('href="/c/vitality/controls/sync"');
  });

  it("the OWNER shell gets the module path, because it has no nested route", () => {
    // /owner/[client] resolves ONE dynamic module segment. A tile pointing at
    // /owner/<client>/controls/sync is a 404 with an owner behind it, and the
    // sync tab is the second tab on the page /owner/<client>/controls opens.
    const staff = OS_TILES.map((t) => `/${t.moduleSlug}${t.subPath ?? ""}`);
    expect(staff).toContain("/controls/sync");
    return readOsBand({ ...OWNER, tree: "owner" }).then((band) => {
      const paths = band.tiles.map((t) => t.path);
      expect(paths).not.toContain("/controls/sync");
      expect(paths.filter((p) => p === "/controls")).toHaveLength(2);
      const html = render(band);
      expect(html).not.toContain("/controls/sync");
    });
  });

  it("a capped figure renders as a floor", async () => {
    leads = new Array(TILE_ROW_CAP + 1).fill({});
    const html = render(await readOsBand(OWNER));
    expect(html).toContain(`at least ${TILE_ROW_CAP}`);
  });

  it("an unreadable band says so instead of drawing figures", async () => {
    systemStates = "throw";
    const html = render(await readOsBand(OWNER));
    expect(html).toContain("could not be read");
    expect(html).toContain("Not readable just now");
  });

  it("draws nothing at all for a role with no tiles", () => {
    // No role has an empty band today (W2-A/1 gave the two desks to all five),
    // so the empty case is asserted on the VIEW directly rather than through a
    // role that happens to produce it. The rule being pinned is the view's: an
    // empty band under a heading reads as a broken feature, so it draws nothing.
    expect(render({ tiles: [], switchesUnreadable: false })).toBe("");
  });
});
