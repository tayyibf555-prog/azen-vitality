// ===========================================================================
// ONE WALK OF src/, ROOTED WHERE IT CANNOT BE THE WRONG TREE.
//
// TEST SUPPORT ONLY. Nothing in the application imports this, and nothing in it
// may ever be reachable from a page: it reads the filesystem. It exists because
// a whole family of guards in this suite are STRUCTURAL — they assert a property
// of the SOURCE ("only one function is called pageAll", "only one module writes a
// keepalive fetch", "no loading.tsx exists") — and every one of them has to start
// by finding every file.
//
// WHY IT IS SHARED, WHICH IS NOT THE USUAL DEDUP ARGUMENT. Five of these walks
// had been hand-rolled, and they disagreed about the ONE thing a walk has to get
// right: WHERE IT STARTS.
//
//   beacon-transport.test.ts   src/, via import.meta.url          CORRECT
//   money-path-hardening       src/, via process.cwd()            WRONG
//   navigation-instant         src/app, via import.meta.url       CORRECT
//   destructive-route          src/app/api, via import.meta.url   CORRECT
//
// process.cwd() is the runner's directory, not the file's. Agent work in this
// repo happens in .claude/worktrees/<name>/ — a complete second checkout — and a
// suite run from the trunk against a worktree's copy (or the reverse) sweeps the
// tree the RUNNER happens to sit in and reports a clean result about source that
// was never read. The guard still passes; it has simply stopped being about the
// code under test. beacon-transport.test.ts wrote that hazard down as a comment
// and the very next sweep added to the tree used cwd anyway, which is the whole
// argument for a function over a convention: a comment is advice, and the import
// below cannot be rooted anywhere but this file.
//
// WHAT IS DELIBERATELY NOT HERE. No root option. A caller that could pass its own
// root would reintroduce the exact divergence this closes, so the root is fixed at
// src/ and a caller narrows with `subdir`. The one guard in the suite that must
// walk the WHOLE REPO (source-hygiene.test.ts, which reads scripts/ and supabase/
// too, and by bytes rather than by extension) therefore keeps its own walk on
// purpose — it is a different sweep, not a fifth copy of this one.
//
// AND WHAT A CALLER MUST STILL DECIDE: dot-directories. Skipping them by default
// was inherited from the hand-rolled walks and it is wrong for the two sweeps whose
// claim is about routing — Next SERVES app/.well-known/**/route.ts — so those pass
// `includeDotDirs: true` and the rest state why they do not. That option is the one
// place a walk can silently narrow without anything going red, so what it changes is
// pinned in walk-src.test.ts against a real dot-directory rather than assumed.
// ===========================================================================

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The absolute path of src/, resolved from THIS FILE.
 *
 * Never process.cwd(). See the header: cwd is where the runner was started, and
 * in a worktree that is a different checkout of this same repo.
 */
export const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** An absolute path to something under src/, given its path relative to src/. */
export function srcPath(relativeToSrc: string): string {
  return join(SRC_ROOT, relativeToSrc);
}

export interface WalkSrcOptions {
  /**
   * Narrow the walk to a directory under src/, as a posix path ("app",
   * "app/api"). Returned paths stay relative to src/ either way, so a path
   * means one thing whoever asked for it.
   */
  subdir?: string;
  /**
   * Extensions to keep, lowercase and dotted. `null` keeps EVERY file, which is
   * what a walk looking for a filename rather than a language wants.
   */
  extensions?: readonly string[] | null;
  /** Include `*.test.ts` / `*.test.tsx`. Off by default. */
  includeTests?: boolean;
  /**
   * Descend into dot-prefixed directories too. OFF by default, and the default is
   * NOT the safe answer everywhere.
   *
   * Next's app router genuinely serves them. `.well-known` is listed in the
   * framework's own docs as a custom endpoint you may define
   * (node_modules/next/dist/docs/01-app/02-guides/backend-for-frontend.md), so
   * `app/.well-known/<name>/route.ts` is a real, publicly reachable route handler.
   * A sweep that skips it is not merely incomplete: the destructive-route audit
   * states that NO write route in the platform is unguarded, and a walk that never
   * opened the file would be saying that about a route it never saw. Same for the
   * loading.tsx sweep, whose sentence is about the SHAPE of src/app.
   *
   * So the sweeps whose claim is about ROUTING turn this on, and they are narrowed
   * to app/ or app/api. The whole-src sweeps leave it off deliberately: the only
   * dot-directory a walk of ALL of src/ is likely to meet is a nested checkout
   * (.claude/worktrees/<name>/ is a complete copy of this repo), and descending one
   * finds every declaration a second time and reports a divergence that is not real.
   *
   * `node_modules` and `.git` are skipped either way; see NEVER_DESCENDED.
   */
  includeDotDirs?: boolean;
}

/**
 * Never descended into, whatever a caller asks for.
 *
 * `node_modules` is a second copy of half of npm and `.git` is object storage
 * rather than source; a sweep reaching either is reading files no reviewer will
 * ever edit, and would report every declaration in a vendored package as if it
 * were ours. Neither is a judgement call a caller gets to make, so neither is
 * reachable through an option. Every OTHER dot-directory is a judgement call, and
 * `includeDotDirs` is where it is made — see the option's own note.
 */
const NEVER_DESCENDED = new Set(["node_modules", ".git"]);

function skipDirectory(name: string, includeDotDirs: boolean): boolean {
  if (NEVER_DESCENDED.has(name)) return true;
  return !includeDotDirs && name.startsWith(".");
}

const TEST_FILE = /\.test\.tsx?$/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Every matching file under src/, as a posix path relative to src/, SORTED.
 *
 * Sorted because a structural guard's failure message is a list of offending
 * files, and a list in readdir order is a different list on a different machine.
 */
export function walkSrc(options: WalkSrcOptions = {}): string[] {
  const {
    subdir = "",
    extensions = [".ts", ".tsx"],
    includeTests = false,
    includeDotDirs = false,
  } = options;
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name, includeDotDirs)) continue;
        walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions !== null && !extensions.includes(extensionOf(entry.name))) continue;
      if (!includeTests && TEST_FILE.test(entry.name)) continue;
      found.push(rel);
    }
  };

  walk(subdir ? join(SRC_ROOT, subdir) : SRC_ROOT, subdir);
  return found.sort();
}
