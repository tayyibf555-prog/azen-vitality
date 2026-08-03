import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  //
  // Declaring globalIgnores here REPLACES the config's own defaults, so the
  // four lines eslint-config-next would have ignored are restated verbatim
  // before anything of ours is added. Drop one and .next/ starts getting
  // linted again.
  //
  // Everything below the defaults exists because `npx eslint .` was reporting
  // ~48,800 problems, of which only 326 were actually ours. A gate nobody can
  // read is a gate nobody runs, so the two sources of that noise are excluded
  // by path rather than by silencing any rule. No rule is disabled here — the
  // severity of every finding in src is exactly what it was before.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Agent worktrees: each subdirectory is a full scratch copy of this repo
    // checked out for a background task. Linting them re-reports every finding
    // in src once per live worktree (46,344 problems across 1,836 files at the
    // time of writing), and the copies are transient — fixing anything in them
    // is fixing a file that will be deleted. The real file is linted at its
    // real path; this only removes the duplicates.
    ".claude/worktrees/**",

    // Vendored third-party bundles shipped as static assets (currently Google's
    // <model-viewer>). This is minified upstream code we neither wrote nor can
    // edit: patching it would be overwritten by the next vendor drop, so its
    // 2,111 problems are permanently unactionable.
    "public/vendor/**",
  ]),
]);

export default eslintConfig;
