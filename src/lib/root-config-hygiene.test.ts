// THE ROOT CONFIG GUARD — the repo root carries the project's tooling, never a
// lane's throwaway.
//
// WHY THIS EXISTS. A wave-3c finder needed a shifted-clock run of the suite, so
// it wrote a second vitest config at the repo root (`vitest.f3cclock.mts`) whose
// own first line said "THROWAWAY ... deleted after the sweep" and whose
// `setupFiles` was a hard-coded absolute path into that session's scratchpad.
// The sweep finished; the file did not leave. It sat untracked and unignored in
// a tree of ~197 dirty entries whose integration step has to `add` the untracked
// work (migrations, new tests, ops SQL), so the next wave commit would have
// shipped it. Nothing in the suite noticed:
//
//   source-hygiene.test.ts  walks the whole repo, but only for raw control
//                           bytes — a perfectly clean UTF-8 config passes.
//   tsc                     type-checks it happily (tsconfig includes
//                           `**/*.mts`), so the gates stayed green.
//   vitest                  auto-discovers only the exact basename
//                           `vitest.config.*`, so the stray file changed no
//                           test run and produced no warning.
//
// A committed second vitest config is worse than clutter: it is broken for
// everybody (the setup file lives in a scratchpad that is wiped between
// sessions), and it reads as sanctioned tooling that a later lane will copy.
//
// THE RULE. The repo root holds exactly ONE vitest config, `vitest.config.ts`,
// and no root config names an absolute machine path. Fail direction is CLOSED: a
// genuinely new config is a red test until someone names it here on purpose,
// which is the whole point — that naming is the review this class of file never
// got. Do NOT satisfy this guard with a .gitignore pattern; hiding the file from
// git would hide a legitimate future config too.
//
// SCOPING. Through import.meta.url, never process.cwd(), so it reads THIS repo
// root and not a .claude/worktrees copy (the boundary.test.ts precedent).
//
// KNOWN GAP, stated rather than hidden: only `vitest.*` is pinned. The same
// class exists for scratch tsconfigs — the root still carries five orphaned
// `tsconfig.<something>.tsbuildinfo` droppings from earlier scoped type-check
// runs — but `*.tsbuildinfo` is gitignored, so those can never reach a commit
// and pinning them would only make this file red about build output. Widen to
// `tsconfig.*.json` if a scratch tsconfig ever survives a round.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The vitest configs the repo is allowed to carry. One entry, and it is the one
 * vitest itself auto-discovers. A lane that needs a variant run passes
 * `--config` a file under its OWN scratchpad and deletes nothing here.
 */
const ALLOWED_VITEST_CONFIGS = ["vitest.config.ts"];

/** Root-level files whose contents must stay portable (no machine-specific paths). */
const PORTABLE_ROOT_CONFIG_PATTERN = /^(vitest|tsconfig|next\.config|eslint\.config|postcss\.config)\./;

/** Files sitting directly at the repo root, sorted, directories excluded. */
function rootFiles(): string[] {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe("repo root config hygiene", () => {
  it("the repo root holds exactly one vitest config", () => {
    const configs = rootFiles().filter((name) => name.startsWith("vitest."));

    // Named, not just counted: the message has to say WHICH file to delete,
    // because whoever trips this is a lane finishing a sweep in a hurry.
    expect(configs).toEqual(ALLOWED_VITEST_CONFIGS);
  });

  it("no root config hard-codes an absolute machine path", () => {
    // The throwaway's setupFiles was /private/tmp/claude-501/<session>/... — a
    // path that exists on exactly one machine for exactly one session. Any
    // committed config carrying one is broken for everybody else.
    const offenders: string[] = [];

    for (const name of rootFiles()) {
      if (!PORTABLE_ROOT_CONFIG_PATTERN.test(name)) continue;
      if (name.endsWith(".tsbuildinfo")) continue; // gitignored build output
      const body = readFileSync(join(REPO_ROOT, name), "utf8");
      if (/["'`](\/Users\/|\/private\/tmp\/|\/tmp\/|\/home\/|[A-Za-z]:\\\\)/.test(body)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
