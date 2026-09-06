import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SYSTEMS } from "@/lib/systems/catalog";
import { SYSTEM_VOCABULARY } from "@/lib/systems/vocabulary";
import { GROUP_ORDER, systemRowSentence } from "./systems-view";

// ===========================================================================
// THE OWNER'S CONTROL PANEL: the two things about it that are rules rather than
// layout.
//
// 1. EVERY GROUP IN THE CATALOG IS DRAWN. The panel renders GROUP_ORDER and
//    filters the rows into it, so a catalog group the order does not name is a
//    group of systems that SILENTLY DISAPPEARS from the only screen that can
//    switch them. That is how the Dentally master lever could have been added
//    to its own group and never appeared.
//
// 2. EACH ROW ANSWERS THE QUESTION ITS OWN STATE RAISES. An off row says what
//    switching it on starts; an on row says what switching it off stops. It was
//    the other way round, which meant the panel told an owner what a stopped
//    system would stop.
// ===========================================================================

describe("no system can hide from the control panel", () => {
  it("every group the catalog uses is in the panel's order", () => {
    const groups = [...new Set(SYSTEMS.map((s) => s.group))].sort();
    const ordered = [...GROUP_ORDER].sort();
    expect(
      groups.filter((g) => !GROUP_ORDER.includes(g)),
      `catalog groups the panel never draws: they would be invisible and unswitchable`,
    ).toEqual([]);
    // And nothing in the order is dead: a group with no systems draws nothing,
    // but a name in this list that the catalog never uses is a stale entry.
    expect(ordered).toEqual(groups);
  });

  it("the Dentally group is last and holds exactly the master lever", () => {
    expect(GROUP_ORDER[GROUP_ORDER.length - 1]).toBe("Dentally");
    const inGroup = SYSTEMS.filter((s) => s.group === "Dentally").map((s) => s.slug);
    expect(inGroup).toEqual(["dentally-write-back"]);
  });

  it("the master lever is not filed among the modules it governs", () => {
    // It was in "Operations", between Compliance and the IT desk, which read as
    // a tenth module rather than as the lever above nine of them.
    const writeBack = SYSTEMS.find((s) => s.slug === "dentally-write-back");
    expect(writeBack?.group).not.toBe("Operations");
  });
});

describe("a row says what its own state makes worth saying", () => {
  const row = { halts: "Recall invites stop.", starts: "Due patients are invited back." };

  it("an OFF row says what switching it on starts", () => {
    expect(systemRowSentence({ ...row, enabled: false })).toBe("Due patients are invited back.");
  });

  it("an ON row says what switching it off stops", () => {
    expect(systemRowSentence({ ...row, enabled: true })).toBe("Running. Recall invites stop.");
  });

  it("falls back to the halts line rather than printing nothing", () => {
    expect(systemRowSentence({ ...row, starts: null, enabled: false })).toBe("Recall invites stop.");
  });

  it("every real system has a distinct sentence for each state", () => {
    for (const system of SYSTEMS) {
      const starts = SYSTEM_VOCABULARY[system.slug].starts;
      const off = systemRowSentence({ enabled: false, halts: system.halts, starts });
      const on = systemRowSentence({ enabled: true, halts: system.halts, starts });
      expect(off, `${system.slug} fell back to halts, so it has no switch-on sentence`).toBe(starts);
      expect(on).toContain(system.halts);
      expect(off).not.toBe(on);
    }
  });
});

describe("the panel and its route agree about what a row carries", () => {
  // A SOURCE PIN, and it is honest about being one: the route needs a session, a
  // client and a database to run, so this is not a behaviour proof. What it
  // catches is the failure that actually happens — the panel declares a field,
  // nobody adds it to the route's projection, and every row renders `undefined`
  // with no type error anywhere, because the response is cast on arrival.
  const ROUTE = "src/app/api/systems/route.ts";
  const source = readFileSync(join(process.cwd(), ROUTE), "utf8");
  const VIEW = "src/components/client/systems/systems-view.tsx";
  const view = readFileSync(join(process.cwd(), VIEW), "utf8");

  it("every field the panel's row type declares is projected by the route", () => {
    const block = view.slice(view.indexOf("export interface SystemRow {"));
    const fields = [...block.slice(0, block.indexOf("\n}")).matchAll(/^\s{2}([a-zA-Z]+)[?]?:/gm)].map(
      (m) => m[1],
    );
    expect(fields.length, "the SystemRow scan found nothing; it has gone stale").toBeGreaterThan(6);
    const missing = fields.filter((f) => !new RegExp(`\\b${f}:`).test(source));
    expect(missing, `fields the panel reads but /api/systems never sends: ${missing.join(", ")}`).toEqual([]);
  });

  it("the route takes them from the shared vocabulary, not from a literal", () => {
    expect(source).toContain("vocabularyFor");
  });

  // =========================================================================
  // A FLIPPED SWITCH HAS TO REACH THE SERVER-RENDERED SCREENS THAT READ IT
  // (wave-3d review, 6 September 2026; Next 16 client router cache).
  //
  // `toggle` POSTs to /api/systems and flips its own React state. That updates
  // this panel and nothing else — and `system_toggle` is read on the SERVER by
  // the sidebar (`getDisabledSlugs`, src/app/c/[client]/layout.tsx), by Home's
  // Operating system band (`readOsBand`/`getSystemStates`) and by the module
  // banners. next.config.ts sets `experimental.staleTimes = { dynamic: 30,
  // static: 120 }`, so a route the owner has already visited comes back from the
  // client router cache on a <Link> navigation with no server render at all, and
  // a plain `fetch` to a Route Handler invalidates none of it (only
  // `router.refresh()` and a Server Action do). The owner switches a system off
  // during an incident, clicks Home to check it stopped, and reads the state
  // from before he touched it — indistinguishable on screen from a save that
  // never landed.
  //
  // A SOURCE PIN, AND HONEST ABOUT BEING ONE. `toggle` is a closure inside a
  // client component; this suite is node-environment `src/**/*.test.ts` and
  // renders to static markup, so there is no click to drive and no router to
  // observe. What it catches is the regression that actually happens — the
  // refresh being dropped in a refactor of the handler — in the same shape
  // src/components/client/previsit/mining-run-button.test.ts uses for the same
  // decision next door ("if (outcome.refresh) router.refresh()").
  // =========================================================================
  it("a flipped switch invalidates the server-rendered screens that read it", () => {
    expect(view, "the panel no longer imports the router").toMatch(
      /import \{ useRouter \} from "next\/navigation";/,
    );
    const toggle = view.slice(
      view.indexOf("async function toggle(slug: string, next: boolean)"),
    );
    expect(toggle, "the toggle handler scan went stale").toContain("/api/systems");
    const body = toggle.slice(0, toggle.indexOf("\n  }\n"));
    expect(
      body,
      "the toggle writes the switch and never tells the sidebar, Home's band or the module banners",
    ).toContain("router.refresh()");
    // AND ONLY ON A WRITE THAT LANDED, outside the try: a throw from the refresh
    // caught by the handler's own catch would revert the optimistic flip and
    // tell the owner the switch failed, for a switch that was written.
    expect(body).toContain("if (wrote) router.refresh()");
  });
});
