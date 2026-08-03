import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * THE TWO APP SHELLS ARE ONE SHELL.
 *
 * /c/[client] (staff) and /owner/[client] (owner + agency) render the same
 * chrome around different guards. They stopped doing so, and the practice owner
 * noticed before we did: /c was rebuilt around the permanent rail and the
 * Dentally-style section bar (b68e78a, 8899fd6, 261fdbb) while /owner kept a
 * sidebar component of its own from a generation earlier and grew no section bar
 * at all. Signing in as the owner showed a visibly older product than signing in
 * as the practice manager, and the owner page still opened on the retired
 * dashboard while the staff page opened on the current one.
 *
 * THE PROPERTY THIS FILE PINS is not "both files mention a sidebar". It is:
 *
 *     neither shell may gain or lose a chrome component without the other.
 *
 * So the assertion is on the SYMMETRIC DIFFERENCE of the two files' component
 * sets, held at a named allow-list of deliberate exceptions. Adding a widget to
 * one layout and forgetting the other fails here, by name, with no test edit
 * needed to catch it. Deleting the whole shell from one side fails too, because
 * the required set is checked as well.
 *
 * WHY A SOURCE-READING NODE TEST. vitest here collects only src/-star-star/*.test.ts
 * in the node environment and no .tsx at all, so there is no renderer to mount a
 * layout in. Reading source is the strongest instrument available. Paths are
 * resolved from import.meta.url so this never walks .claude/worktrees, which are
 * full repo copies and would match duplicate files.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHELLS = {
  client: resolve(SRC, "app/c/[client]/layout.tsx"),
  owner: resolve(SRC, "app/owner/[client]/layout.tsx"),
} as const;

const OWNER_PAGE = resolve(SRC, "app/owner/[client]/page.tsx");
const CLIENT_PAGE = resolve(SRC, "app/c/[client]/page.tsx");

const read = (path: string) => readFileSync(path, "utf8");

/**
 * The COMPONENTS a layout actually renders from the app's own component tree.
 *
 * BOTH conditions, and the second is the one that matters: imported from
 * @/components AND present in the JSX as a tag. An import alone is not a shell -
 * deleting `<ClientSectionBar />` from the owner layout while leaving its import
 * line behind is exactly the shape a hurried edit takes, and an import-only check
 * would call that parity. Lower-case identifiers (hooks, helpers) and anything
 * outside @/components are ignored: this is about chrome, not about plumbing.
 */
function chromeComponents(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(@\/components\/[^"]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!name || !/^[A-Z]/.test(name)) continue;
      if (new RegExp(`<${name}(?=[\\s/>])`).test(source)) names.add(name);
    }
  }
  return names;
}

/**
 * The chrome BOTH shells must carry, named so that deleting it from both at once
 * is still a failure. Without this, a symmetric-difference test would happily
 * pass on two empty layouts.
 */
const REQUIRED_IN_BOTH = [
  // The permanent icon rail. The owner tree had OwnerSidebar here instead.
  "ClientSidebar",
  // The second level of the navigation. The owner tree had nothing here.
  "ClientSectionBar",
  "ClientTopbar",
  "PatientQuickViewProvider",
  "PlatformShortcuts",
  "FeedbackWidget",
] as const;

/**
 * The ONLY components allowed to appear in one shell and not the other, each
 * with the reason it is deliberate. Anything else in the difference is drift.
 *
 * UsageBeacon: surfaceFromPath (src/lib/telemetry-surface.ts) instruments paths
 * beginning /c and returns null for everything else, which telemetry-surface.test.ts
 * pins. Mounting the beacon in the owner shell would be a component that provably
 * does nothing. If owner usage is ever wanted, the surface reducer and the
 * server-side allow-list are the things to change, and this entry goes with them.
 */
const ALLOWED_DIFFERENCES = new Set<string>(["UsageBeacon"]);

describe("the staff shell and the owner shell are the same shell", () => {
  const client = chromeComponents(read(SHELLS.client));
  const owner = chromeComponents(read(SHELLS.owner));

  it.each(REQUIRED_IN_BOTH)("both layouts render %s", (name) => {
    expect(client.has(name), `/c/[client]/layout.tsx does not import ${name}`).toBe(true);
    expect(owner.has(name), `/owner/[client]/layout.tsx does not import ${name}`).toBe(true);
  });

  it("has no chrome component in one shell that is not in the other", () => {
    // THE CENTRAL ASSERTION. Every future widget added to one layout lands here.
    const onlyClient = [...client].filter((n) => !owner.has(n) && !ALLOWED_DIFFERENCES.has(n));
    const onlyOwner = [...owner].filter((n) => !client.has(n) && !ALLOWED_DIFFERENCES.has(n));
    expect(
      { onlyClient, onlyOwner },
      "a chrome component was added to one shell and not the other; add it to both, or add it to ALLOWED_DIFFERENCES with the reason",
    ).toEqual({ onlyClient: [], onlyOwner: [] });
  });

  it("keeps a second owner-only sidebar from coming back", () => {
    // OwnerSidebar was deleted, not disabled. A layout that imports any sidebar
    // other than the shared one has forked the shell again, which is the exact
    // failure this file exists to prevent.
    const ownerSidebars = [...owner].filter((n) => /Sidebar$/.test(n) && n !== "ClientSidebar");
    expect(ownerSidebars, "the owner shell has a sidebar of its own again").toEqual([]);
    expect(read(SHELLS.owner)).not.toContain("@/components/owner/owner-sidebar");
  });

  it("passes the switched-off systems to BOTH levels of the navigation, in both shells", () => {
    // The kill switch is the one behaviour the owner sidebar had that the shared
    // one had to learn. A shell that renders the rail or the bar without
    // disabledSlugs shows the owner a module they have switched off.
    for (const [name, path] of Object.entries(SHELLS)) {
      const source = read(path);
      for (const component of ["ClientSidebar", "ClientSectionBar"]) {
        const tag = new RegExp(`<${component}[\\s\\S]*?/>`).exec(source);
        expect(tag, `${name}: ${component} is not rendered`).not.toBeNull();
        expect(
          (tag as RegExpExecArray)[0],
          `${name}: ${component} is rendered without disabledSlugs, so a switched-off system still shows`,
        ).toContain("disabledSlugs");
      }
    }
  });

  it("keeps the site switcher wired in both shells", () => {
    // ClientTopbar owns which practice you are looking at. Rendering it without
    // the server-resolved selection resets the switcher on every owner page load.
    for (const [name, path] of Object.entries(SHELLS)) {
      const tag = /<ClientTopbar[\s\S]*?\/>/.exec(read(path));
      expect(tag, `${name}: ClientTopbar is not rendered`).not.toBeNull();
      expect(
        (tag as RegExpExecArray)[0],
        `${name}: ClientTopbar has lost its site selection`,
      ).toContain("selected=");
    }
  });

  it("has no loading.tsx in either shell, which once killed every button on the page", () => {
    // A streamed loading.tsx left authed pages unhydrated and every button on
    // them dead (commit feb8677). Named here because this is a file a shell edit
    // is tempted to add.
    for (const [name, path] of Object.entries(SHELLS)) {
      const dir = dirname(path);
      expect(
        readFileSync(path, "utf8").length > 0 && !existsLoading(dir),
        `${name} has a loading.tsx beside its layout`,
      ).toBe(true);
    }
  });
});

function existsLoading(dir: string): boolean {
  try {
    readFileSync(resolve(dir, "loading.tsx"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * THE OWNER LANDS ON THE CURRENT DASHBOARD.
 *
 * Same philosophy as owner-module-coverage.test.ts, which catches a MODULE wired
 * into the client tree and not the owner one. This catches the same failure for
 * the tree's index page, which that test cannot see: /owner/[client]/page.tsx is
 * not part of the [module] if-chain.
 */
describe("the owner home page renders the same dashboard the practice does", () => {
  const owner = read(OWNER_PAGE);
  const client = read(CLIENT_PAGE);

  it("renders PracticeDashboard, the dashboard /c/[client] renders", () => {
    // The defect: /owner opened on OverviewDashboard, which /c retired. The
    // practice manager comparing us against Dentally was being shown the current
    // screen and the owner was not.
    expect(client, "the staff home no longer renders PracticeDashboard - this test is checking the wrong component").toContain(
      "<PracticeDashboard",
    );
    expect(owner, "the owner home does not render PracticeDashboard").toContain("<PracticeDashboard");
  });

  it("reads the dashboard the same way, from the same reader and the same scoping", () => {
    // Same data or the two screens disagree about the day. readPracticeDashboard
    // takes the whole client (the strip's all-sites toggle is the point) and the
    // top bar's selection decides only what it opens on.
    for (const [name, source] of [["/c", client], ["/owner", owner]] as const) {
      expect(source, `${name} does not call readPracticeDashboard`).toContain("readPracticeDashboard");
      expect(source, `${name} does not seed the dashboard from the site switcher`).toContain(
        "getViewSiteSelection",
      );
      expect(source, `${name} does not map the all-sites selection to null`).toMatch(
        /initialSiteId=\{selection === ALL_SITES \? null : selection\}/,
      );
    }
  });

  it("keeps the owner-only sections, BELOW the dashboard", () => {
    // Parity must not cost the owner anything. These are the three things the
    // owner home had before, and they now follow the dashboard rather than
    // replacing it.
    for (const component of ["OwnerViewSwitch", "SystemsCatalog", "OverviewDashboard"]) {
      expect(owner, `the owner home lost ${component}`).toContain(component);
    }
    const dashboardAt = owner.indexOf("<PracticeDashboard");
    for (const component of ["<OwnerViewSwitch", "<SystemsCatalog"]) {
      expect(
        owner.indexOf(component),
        `${component} is rendered above the dashboard; the owner reads the day first`,
      ).toBeGreaterThan(dashboardAt);
    }
  });

  it("does not render the owner-only sections in the staff shell", () => {
    // The other direction of the same rule: parity is not "make /c the owner page".
    for (const component of ["OwnerViewSwitch", "SystemsCatalog"]) {
      expect(client, `the staff home renders the owner-only ${component}`).not.toContain(component);
    }
  });
});
