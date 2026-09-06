// ===========================================================================
// JOURNEY 8 — HONEST NUMBERS, ON THE SCREEN THE OWNER LOOKS AT FIRST.
//
// Everything in this platform is default-off. So on the morning it is handed
// over, an owner opens the home page and sees a row of tiles, and almost all of
// them are for systems that are not running. The one thing that must not happen
// is a tile printing "0".
//
// "0 pre-visit questions sent" is a claim about the practice: we asked, and
// nobody answered. "Off" is a claim about the platform: we never asked. They
// look alike on a screen and they are opposite facts, and an owner who reads the
// first one switches nothing on because it appears not to work.
//
// THE THREE STATES THIS JOURNEY INSISTS ON, and they are three, not two:
//   OFF      the system is not running, so there is no number to print.
//   EMPTY    it IS running and nothing is in it yet — a setup step outstanding.
//   FIGURE   a number, and if the read hit its bound it says "at least".
//
// AND THE FOURTH, which is the one that gets lost: UNREADABLE. A failed read is
// not an empty table. Every tile here is driven into that state too.
//
// The last section drives a real bounded read PAST its cap and requires the
// screen to say so — the honest-numbers rule (charter section 0.5) at the exact
// point where it is cheapest to break.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CLIENT, SITE, createOsWorld, installFetchGuard, type FetchGuard } from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));

import { readOsBand, TILE_ROW_CAP, OS_TILES } from "@/lib/home/os-band";
import type { OsTile } from "@/lib/home/os-band";
import { countWriteIntents, listWriteIntents, ROW_CAP, COUNT_CAP } from "@/lib/dentally/sync-ledger";
import { syncFacts, syncHeadline } from "@/lib/dentally/sync-surface";
import { targetLabel } from "@/lib/dentally/write-vocabulary";
import { systemRowSentence } from "@/components/client/systems/systems-view";
import { SyncStatusPanel, type SyncStatusPayloadShape } from "@/components/client/systems/sync-status-view";
import { DEFAULT_OFF_SLUGS } from "@/lib/systems/catalog";
import { srcPath } from "@/lib/test-support/walk-src";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import { EQUIPMENT_SLUG } from "@/lib/equipment/types";

const ORIGINAL_ENV = { ...process.env };
let guard: FetchGuard;

beforeEach(() => {
  world.reset();
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.DENTALLY_WRITE_ENABLED;
  delete process.env.DENTALLY_BASE_URL;
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

function band() {
  // role null = sign-in not configured, which shows every tile. The role gate is
  // pinned elsewhere; this journey is about what the numbers SAY.
  return readOsBand({ clientId: CLIENT, siteIds: [SITE], role: null });
}

function tile(tiles: OsTile[], key: string): OsTile {
  const found = tiles.find((t) => t.key === key);
  if (!found) throw new Error(`no tile "${key}" on the band`);
  return found;
}

describe("JOURNEY 8 — an off module says Off, and never a zero", () => {
  it("day one: every DEFAULT-OFF tile reads OFF, and not one of them prints a figure", async () => {
    // Nothing seeded and no toggle rows: the state every practice is in on the
    // morning the platform is handed over.
    //
    // Only the default-OFF systems are asserted here, and that is the honest
    // scope rather than a convenience. A default-ON system with no rows is
    // RUNNING and genuinely has nothing in it, so "0 awaiting first contact" is
    // a true sentence about the practice — the failure this journey exists to
    // catch is the opposite one, a number printed for a system that was never
    // asked. The default-on tiles are checked in the next assertion.
    const { tiles, switchesUnreadable } = await band();
    expect(switchesUnreadable).toBe(false);

    let checked = 0;
    for (const def of OS_TILES) {
      if (def.systemSlug === null || def.countsWhileOff) continue;
      if (!DEFAULT_OFF_SLUGS.has(def.systemSlug)) continue;
      checked += 1;
      const t = tile(tiles, def.key);
      expect(t.enabled, `${def.key} is enabled with no row`).toBe(false);
      expect(t.state.kind, `${def.key} printed a ${t.state.kind} while off`).toBe("off");
      // The decisive assertion: there is no `value` on an off tile at all, so
      // nothing downstream can render one as a number.
      expect((t.state as { value?: number }).value).toBeUndefined();
    }
    expect(checked, "no default-off tile was checked — the loop matched nothing").toBeGreaterThan(0);
  });

  it("a DEFAULT-ON tile with nothing in it prints a real zero, because that zero is true", async () => {
    // The other side of the rule, and the reason it is a rule about provenance
    // rather than about zeros. Speed-to-lead is default-ON: an absent toggle row
    // means running, so "0 awaiting first contact" is a fact about the practice
    // and is allowed to be printed as one.
    const t = tile((await band()).tiles, "leads");
    expect(t.enabled).toBe(true);
    expect(t.state.kind).toBe("figure");
    expect((t.state as { value: number }).value).toBe(0);
    expect((t.state as { atLeast: boolean }).atLeast).toBe(false);
  });

  it("OFF and EMPTY are different facts, and the tile says which", async () => {
    // Equipment switched ON with nothing on the register. A practice that has
    // switched the desk on and not yet imported its assets is in a DIFFERENT
    // position from one that has not switched it on, and printing the same word
    // for both makes the owner switch on something that is already running.
    world.setToggle(EQUIPMENT_SLUG, true);
    const on = tile((await band()).tiles, "equipment");
    expect(on.enabled).toBe(true);
    expect(on.state.kind).toBe("empty");
    expect((on.state as { firstStep: string | null }).firstStep, "an empty tile offers no first step").toBeTruthy();

    // And switched OFF with the SAME empty register, it reads off — so the two
    // words are tracking the switch, not the row count.
    world.setToggle(EQUIPMENT_SLUG, false);
    const off = tile((await band()).tiles, "equipment");
    expect(off.state.kind).toBe("off");
  });

  it("a running system with real rows prints a real figure — so 'off' above was not vacuous", async () => {
    world.setToggle(EQUIPMENT_SLUG, true);
    world.fake.seed(
      "equipment_asset",
      { id: "a1", client_id: CLIENT, name: "Autoclave", category: "sterilisation", site_id: SITE, next_service_due: "2020-01-01" },
      { id: "a2", client_id: CLIENT, name: "X-ray", category: "imaging", site_id: SITE, next_service_due: "2099-01-01" },
    );

    const t = tile((await band()).tiles, "equipment");
    expect(t.state.kind).toBe("figure");
    const state = t.state as { value: number; noun: string; atLeast: boolean; tone: string };
    expect(state.value).toBe(1);
    expect(state.noun).toBe("overdue a service");
    expect(state.atLeast).toBe(false);
    // Overdue is the one thing this tile is allowed to shout about.
    expect(state.tone).toBe("attention");
  });

  it("a FAILED read is never an empty table and never a zero", async () => {
    world.setToggle(EQUIPMENT_SLUG, true);
    world.setToggle(TRIAGE_SYSTEM_SLUG, true);
    world.fake.failTable("equipment_asset", "register unavailable");
    world.fake.failTable("previsit_target", "targets unavailable");

    const { tiles } = await band();
    expect(tile(tiles, "equipment").state.kind).toBe("unreadable");
    expect(tile(tiles, "pre-visit").state.kind).toBe("unreadable");
    // Not "empty", not a figure of 0 — those are claims about the practice, and
    // this is a fact about the network.
    expect((tile(tiles, "equipment").state as { value?: number }).value).toBeUndefined();
  });

  it("switches that cannot be read at all make the WHOLE band say so, rather than reading as all-off", async () => {
    world.fake.failTable("system_toggle", "toggles unavailable");
    const { tiles, switchesUnreadable } = await band();

    expect(switchesUnreadable, "an unreadable switch table read as a confident all-off").toBe(true);
    for (const t of tiles) {
      expect(t.enabled, `${t.key} claimed a switch state nobody could read`).toBeNull();
      expect(t.state.kind, `${t.key}`).toBe("unreadable");
    }
  });

  it("the controls screen answers the question each state actually raises, and never with a number", () => {
    const halts = "The equipment desk stops answering questions.";
    const starts = "Switching this on lets staff ask about the practice's registered equipment.";

    const off = systemRowSentence({ enabled: false, halts, starts });
    const on = systemRowSentence({ enabled: true, halts, starts });

    // OFF asks "what would I get if I switched this on?"; ON asks "what do I
    // lose if I switch it off?". They are different questions and the row used
    // to answer both with the second one.
    expect(off).toBe(starts);
    expect(on).toBe(`Running. ${halts}`);
    expect(off).not.toBe(on);
    // Neither sentence is ever a count, which is the honest-numbers rule applied
    // to the one screen where an owner decides what to switch on.
    expect(off).not.toMatch(/^\d/);
    expect(on).not.toMatch(/^\d/);

    // And the row carries the literal word next to the name. The component is a
    // client fetcher with no exported presentational half, so this is asserted
    // against its source — the same technique dashboard-chrome.test.ts uses for
    // the parts a static render cannot reach.
    const viewSrc = readFileSync(srcPath("components/client/systems/systems-view.tsx"), "utf8");
    expect(viewSrc, "the controls row no longer prints the word Off").toMatch(/>\s*Off\s*</);
  });
});

describe("JOURNEY 8 — a read that hit its bound never wears a total's clothes", () => {
  /** Seed n intent rows, all blocked, as a long-running unarmed deployment would. */
  function seedIntents(n: number): void {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `intent-${i}`,
      client_id: CLIENT,
      site_id: SITE,
      kind: "appointment.create",
      source: "recall",
      module_slug: "recall",
      target: "api.dentally.co",
      payload_summary: {},
      status: "blocked",
      blocked_reason: "writes_disabled",
      actor: "user-abc",
    }));
    world.fake.seed("dentally_write_intent", ...rows);
  }

  it("under the cap: the count is a total, and says so", async () => {
    seedIntents(25);
    const counted = await countWriteIntents(CLIENT);
    expect(counted.total).toBe(25);
    expect(counted.counts.blocked).toBe(25);
    expect(counted.capped, "a small count claimed to be capped").toBe(false);
  });

  it("PAST the cap: the count becomes a floor, and the flag says which", async () => {
    // Driven past COUNT_CAP for real, through the same function the screen calls.
    seedIntents(COUNT_CAP + 5);
    const counted = await countWriteIntents(CLIENT);

    expect(counted.capped, "a read past its cap did not say so").toBe(true);
    expect(counted.total).toBe(COUNT_CAP);
    // The number is the CAP, not the true row count — which is exactly why it
    // may only ever be printed with "at least" in front of it.
    expect(counted.total).toBeLessThan(COUNT_CAP + 5);
  });

  it("PAST the row cap: the list reports there is more, proven rather than guessed", async () => {
    seedIntents(ROW_CAP + 1);
    const listed = await listWriteIntents(CLIENT);

    expect(listed.rows).toHaveLength(ROW_CAP);
    // `more` is proven by asking for one row beyond the page, not inferred from
    // a full page — a full page and a full page plus one look identical otherwise.
    expect(listed.more).toBe(true);

    // And a request for MORE than the cap is clamped rather than honoured.
    const greedy = await listWriteIntents(CLIENT, { limit: 5000 });
    expect(greedy.rows.length).toBe(ROW_CAP);
  });

  it("the Sync Status screen prints 'At least' for a capped count, and a plain total otherwise", () => {
    const base: SyncStatusPayloadShape = {
      mode: "dry_run",
      target: { host: "api.dentally.co", live: true },
      master: { slug: "dentally-write-back", off: false },
      headline: syncHeadline("dry_run"),
      facts: syncFacts("dry_run"),
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: COUNT_CAP },
      total: COUNT_CAP,
      countCapped: true,
      intents: [],
      more: true,
      pageSize: 50,
      ledgerError: null,
    };

    const capped = renderToStaticMarkup(createElement(SyncStatusPanel, { data: base }));
    expect(capped, "a capped total was printed as if it were exact").toContain("At least");

    const exact = renderToStaticMarkup(
      createElement(SyncStatusPanel, { data: { ...base, countCapped: false, total: 12, more: false } }),
    );
    expect(exact).not.toContain("At least");
    expect(exact).toContain("12");
  });

  it("the screen never prints a zero where a read FAILED", () => {
    const failed: SyncStatusPayloadShape = {
      mode: "dry_run",
      target: { host: "api.dentally.co", live: true },
      master: { slug: "dentally-write-back", off: false },
      headline: syncHeadline("dry_run"),
      facts: syncFacts("dry_run"),
      // null, never 0 — the whole point of the shape.
      counts: null,
      total: null,
      countCapped: false,
      intents: [],
      more: false,
      pageSize: 50,
      ledgerError: "The ledger could not be read just now.",
    };
    const html = renderToStaticMarkup(createElement(SyncStatusPanel, { data: failed }));
    expect(html).toContain("could not be read");
  });

  it("a row aimed at the local mock is labelled as such, and one aimed at the real book is not", () => {
    // The other half of an honest number on this screen: WHERE the write was
    // aimed. A dry-run row against localhost and a blocked row against the live
    // book are different facts about the practice's Dentally connection.
    expect(targetLabel("localhost:3000")).toBe("localhost:3000 (local mock)");
    expect(targetLabel("api.dentally.co")).toBe("api.dentally.co");
    // An unparseable host is treated as the real book, which is the safe default.
    expect(targetLabel("")).toBe("");
  });

  it("the write-back tile carries the same 'at least' honesty as the ledger it reads", async () => {
    // The tile is the one that COUNTS WHILE OFF — writes held back accrue
    // because write-back is off — so it is the one place on the band where an
    // off system still prints a figure, and it has to be as honest as the rest.
    seedIntents(COUNT_CAP + 5);
    const t = tile((await band()).tiles, "write-back");
    expect(t.state.kind).toBe("figure");
    const state = t.state as { value: number; atLeast: boolean; noun: string };
    expect(state.atLeast, "the tile printed a capped count as an exact one").toBe(true);
    expect(state.noun).toBe("held back");

    // CONTROL: a small ledger prints an exact figure.
    world.reset();
    seedIntents(3);
    const small = tile((await band()).tiles, "write-back");
    expect((small.state as { atLeast: boolean; value: number }).atLeast).toBe(false);
    expect((small.state as { value: number }).value).toBe(3);
  });

  it("a tile whose row read hits ITS bound says 'at least' too", async () => {
    world.setToggle("speed-to-lead", true);
    world.fake.seed(
      "speed_to_lead_lead",
      ...Array.from({ length: TILE_ROW_CAP + 3 }, (_, i) => ({
        id: `lead-${i}`,
        site_id: SITE,
        name: `Lead ${i}`,
        phone: `+4477009${String(i).padStart(5, "0")}`,
        channel: "sms",
        stage: "new",
        consent: { sms: true },
      })),
    );

    const t = tile((await band()).tiles, "leads");
    expect(t.state.kind).toBe("figure");
    const state = t.state as { value: number; atLeast: boolean };
    expect(state.atLeast, "a tile read at its bound printed an exact number").toBe(true);
    expect(state.value).toBe(TILE_ROW_CAP);
  });

  it("the pre-visit tile's bound is proved against the real repository too", async () => {
    /*
     * THE SAME FLOOR, THROUGH A DIFFERENT READ, AND THAT IS THE POINT. The leads
     * probe above drives `listLeads`; this one drives `listTargets` — a separately
     * written query, through the real repository, against a fake that enforces
     * PostgREST's own ceilings. The unit-level pin for this tile mocks the
     * repository and so proves the BAND's arithmetic over whatever the mock chose
     * to return; nothing there is evidence about the query underneath it.
     *
     * WHAT IT CATCHES, STATED HONESTLY. `figure()` calls a read capped at
     * rowCount > TILE_ROW_CAP and the tile asks for TILE_ROW_CAP + 1, so the whole
     * floor rests on that one spare row: ask for TILE_ROW_CAP exactly and a
     * practice with thousands of live links reads as an exact "200 sent". That
     * off-by-one is what goes red here. It is NOT a proof that `listTargets` still
     * passes a `.limit()` at all — an unbounded read of 203 rows produces the same
     * honest "at least 200", because the cap that makes the tile honest is the
     * tile's own. The bound on the query is a cost property, pinned where the
     * query lives.
     */
    world.setToggle(TRIAGE_SYSTEM_SLUG, true);
    world.fake.seed(
      "previsit_target",
      ...Array.from({ length: TILE_ROW_CAP + 3 }, (_, i) => ({
        id: `${SITE}:appt-${i}`,
        site_id: SITE,
        dentally_patient_id: `p-${i}`,
        appointment_id: `appt-${i}`,
        patient_name: `Patient ${i}`,
        fork: "full",
        // Ascending, because listTargets orders by it and the bound takes the
        // OLDEST page — the ordering this tile's comment says not to re-filter.
        appointment_at: new Date(Date.now() + i * 60_000).toISOString(),
        due_at: new Date(Date.now() - 3_600_000).toISOString(),
        status: "sent",
        stop_reason: null,
        consent_sms: true,
        link_token: `tok-${i}`,
      })),
    );

    const t = tile((await band()).tiles, "pre-visit");
    expect(t.state.kind).toBe("figure");
    const state = t.state as { value: number; atLeast: boolean; noun: string };
    expect(state.atLeast, "a real bounded pre-visit read printed an exact number").toBe(true);
    expect(state.value).toBe(TILE_ROW_CAP);
    expect(state.noun).toBe("sent, awaiting an answer");

    // CONTROL: under the bound it is an exact figure, so "at least" above is the
    // read hitting its ceiling and not this tile saying "at least" about
    // everything.
    world.reset();
    world.setToggle(TRIAGE_SYSTEM_SLUG, true);
    world.fake.seed("previsit_target", {
      id: `${SITE}:appt-solo`,
      site_id: SITE,
      dentally_patient_id: "p-solo",
      appointment_id: "appt-solo",
      patient_name: "Solo",
      fork: "full",
      appointment_at: new Date(Date.now() + 3_600_000).toISOString(),
      due_at: new Date(Date.now() - 3_600_000).toISOString(),
      status: "sent",
      stop_reason: null,
      consent_sms: true,
      link_token: "tok-solo",
    });
    const small = tile((await band()).tiles, "pre-visit");
    expect((small.state as { atLeast: boolean; value: number })).toMatchObject({ atLeast: false, value: 1 });
  });

  it("nothing in this journey reached the network", () => {
    expect(guard.calls).toEqual([]);
  });
});
