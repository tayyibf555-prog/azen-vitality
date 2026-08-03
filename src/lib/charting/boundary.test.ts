import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * THE RSC BOUNDARY GUARD.
 *
 * This repo has already paid for this once: a shared primitive taking function
 * props became a client component, the build passed, and the server page threw
 * at render. A node test reading source is the only way to hold the line,
 * because vitest collects no .tsx at all.
 *
 * Scoped through import.meta.url so it never walks .claude/worktrees, which are
 * full repo copies and would find duplicate files.
 */
const CHART_UI_DIR = fileURLToPath(
  new URL("../../components/client/patients/record/chart/", import.meta.url),
);
const TAB_CHART = fileURLToPath(
  new URL("../../components/client/patients/record/tab-chart.tsx", import.meta.url),
);
const CHARTING_LIB = fileURLToPath(new URL("./", import.meta.url));

function chartUiFiles(): { name: string; source: string }[] {
  if (!existsSync(CHART_UI_DIR)) return [];
  return readdirSync(CHART_UI_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(`${CHART_UI_DIR}${name}`, "utf8") }));
}

describe("the chart's client boundary", () => {
  it("puts the only 'use client' directive on the workspace", () => {
    for (const { name, source } of chartUiFiles()) {
      const declaresClient = /^\s*["']use client["']/m.test(source);
      expect(declaresClient, `${name} declares 'use client'`).toBe(name === "chart-workspace.tsx");
    }
  });

  // THE ASSERTION THAT MATTERS. tab-chart.tsx is a SERVER component. Every leaf
  // in chart/ other than the workspace and its own subtree is an undirected
  // universal module that attaches DOM handlers and takes function props;
  // rendering one from a server component builds green and throws at render.
  //
  // CHANGED DELIBERATELY WHEN THE PLAN PANEL LANDED, and widened rather than
  // loosened. The old list named two files, which meant a server-safe leaf could
  // only be reached by editing this list — but it also meant a file already on
  // the list could grow an import of something that was NOT, and nothing here
  // would notice. The panel has a real subtree (appointment-card, plan-footer,
  // plan-cards, disabled-control), so the check now walks the graph: whatever
  // tab-chart reaches, transitively, inside chart/ must be server-safe.
  const ROOTS = ["chart-workspace", "plan-panel"];

  it("lets the server tab import only the workspace and the plan panel from chart/", () => {
    if (!existsSync(TAB_CHART)) return;
    const source = readFileSync(TAB_CHART, "utf8");
    const imported = [...source.matchAll(/from\s+["'][^"']*\/chart\/([a-z0-9-]+)["']/g)].map(
      (m) => m[1],
    );
    for (const mod of imported) {
      expect(ROOTS, `tab-chart imports ${mod}`).toContain(mod);
    }
  });

  /** Everything reachable from a chart/ module through relative imports inside
   *  chart/, the module itself included. */
  function reachable(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const path = `${CHART_UI_DIR}${name}.tsx`;
      if (!existsSync(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const m of source.matchAll(/from\s+["'](?:\.\/|[^"']*\/chart\/)([a-z0-9-]+)["']/g)) {
        queue.push(m[1]);
      }
    }
    return seen;
  }

  // THE ONE THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. tab-chart may import
  // plan-panel, but plan-panel pulls in four more files, and any one of them
  // gaining "use client" or a function prop puts the throw back. chart-workspace
  // is excluded because it IS the client boundary: everything below it is
  // allowed to be a client module.
  it("keeps the whole plan panel subtree server-safe, not just its entry point", () => {
    const subtree = [...reachable("plan-panel")];
    // A panel that reached nothing would pass this test vacuously.
    expect(subtree.length).toBeGreaterThan(1);
    // chart-workspace IS the client boundary. The panel reaching it would mean the
    // server tab renders the client tree twice over, through two entry points.
    expect(subtree, "the plan panel reaches the client workspace").not.toContain(
      "chart-workspace",
    );
    for (const name of subtree) {
      const path = `${CHART_UI_DIR}${name}.tsx`;
      if (!existsSync(path)) continue;
      const source = readFileSync(path, "utf8");
      expect(source, `${name}.tsx is reachable from the server tab and declares 'use client'`)
        .not.toMatch(/^\s*["']use client["']/m);
      // A function prop is the other half of the same failure: it does not throw
      // on its own, but it cannot cross the server boundary, so a server parent
      // passing one is a runtime error rather than a build one.
      expect(source, `${name}.tsx takes an on* handler prop`).not.toMatch(
        /^\s*on[A-Z]\w*:\s*\(/m,
      );
    }
  });
});

describe("the charting library stays pure", () => {
  const files = readdirSync(CHARTING_LIB).filter((f) => f.endsWith(".ts"));

  it("has no barrel, which is what would let the client workspace reach the server-only repository", () => {
    expect(files).not.toContain("index.ts");
  });

  it("never reaches the server-only draft repository, and never declares a client directive", () => {
    for (const name of files) {
      const source = readFileSync(`${CHARTING_LIB}${name}`, "utf8");
      if (name.endsWith(".test.ts")) continue;
      expect(source, `${name} must not import the draft repository`).not.toContain(
        "@/lib/patient-chart",
      );
      expect(source, `${name} must not import server-only`).not.toContain('"server-only"');
      expect(source, `${name} must not be a client module`).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("never imports React, so every module here is collectable by vitest and reusable on both sides", () => {
    for (const name of files) {
      if (name.endsWith(".test.ts")) continue;
      const source = readFileSync(`${CHARTING_LIB}${name}`, "utf8");
      expect(source, `${name} must not import React`).not.toMatch(/from\s+["']react["']/);
    }
  });
});
