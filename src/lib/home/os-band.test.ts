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
// subset by construction and a clinician gets no band at all.
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

vi.mock("@/lib/systems/repository", () => ({
  getSystemStates: async () => maybe(systemStates, "getSystemStates"),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listLeads: async () => maybe(leads, "listLeads"),
}));
vi.mock("@/lib/triage/repository", () => ({
  listTargets: async () => maybe(targets, "listTargets"),
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
vi.mock("@/lib/dentally/sync-ledger", () => ({
  countWriteIntents: async () => maybe(intents, "countWriteIntents"),
}));

const { readOsBand, OS_TILES, TILE_ROW_CAP } = await import("./os-band");
const { canRoleAccessModule } = await import("@/lib/nav");
const { OperatingSystemBandView } = await import("@/components/client/dashboard/os-band");

const ALL_ON = OS_TILES.filter((t) => t.systemSlug !== null).map((t) => ({
  slug: t.systemSlug as string,
  enabled: true,
}));
const ALL_OFF = ALL_ON.map((s) => ({ ...s, enabled: false }));

beforeEach(() => {
  called.length = 0;
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
    // One failure does not take the others down.
    expect(tile(band, "pre-visit").state.kind).toBe("figure");
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

  it("the band gates on the module guard itself, not on a second list", () => {
    // The property that made the widening above free: every tile's visibility is
    // `canRoleAccessModule(role, tile.moduleSlug)`, so a nav ruling reaches the
    // front door with no second edit — and, more importantly, a module NARROWED
    // later cannot leave a tile behind pointing at a 403.
    for (const role of ["client_clinician", "client_staff", "client_coordinator"] as const) {
      const expected = OS_TILES.filter((t) => canRoleAccessModule(role, t.moduleSlug)).map((t) => t.key);
      return readOsBand({ ...OWNER, role }).then((band) => {
        expect(band.tiles.map((t) => t.key)).toEqual(expected);
      });
    }
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
