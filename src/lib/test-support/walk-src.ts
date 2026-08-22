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
}

/**
 * Never descended into.
 *
 * `node_modules` and dot-directories do not exist under src/ today, so skipping
 * them changes nothing about what any current caller sees. They are here for the
 * day one does: `.claude/worktrees` is a full copy of this repo, and a sweep that
 * followed one would find every declaration a second time and report a divergence
 * that does not exist.
 */
function skipDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
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
  const { subdir = "", extensions = [".ts", ".tsx"], includeTests = false } = options;
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name)) continue;
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
