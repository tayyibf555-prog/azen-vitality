// THE SOURCE HYGIENE GUARD — no invisible control characters in the tree.
//
// WHY THIS EXISTS. flow-validate.ts used a NUL character as the sentinel for the
// "default route" edge, and it was written as a RAW byte inside the string
// literal rather than as the escape sequence. The runtime was correct and every
// test passed, so nothing in the suite noticed. What broke was everything
// AROUND the code:
//
//   git   treated the file as binary. `git diff` reported "Bin 21009 bytes"
//         instead of a patch, so the file could never be reviewed in a diff.
//   grep  refused to print matches from it. `grep -n validateFlow <file>`
//         exited 1 — the file simply looked empty to every text tool, and any
//         audit sweep that greps the tree would silently skip it.
//
// A one-file fix would leave the whole class open. This walks the tree instead,
// so the next raw control character fails here before it can be committed.
//
// SCOPING. Through import.meta.url, never process.cwd(), so it walks THIS src/
// and not a .claude/worktrees copy (the boundary.test.ts precedent). Binary
// assets are excluded by extension: a NEW binary type therefore fails loudly
// until it is named here on purpose, which is the safe direction — a new TEXT
// extension (.json, .svg, .yaml) is covered automatically.
//
// KNOWN GAP, stated rather than hidden: the walk stops at src/. A repo-wide
// sweep finds one more instance of exactly this defect outside it —
// scripts/ingest-knowledge.ts:300 writes its strip-NUL regex as a raw byte
// inside the pattern (committed in ab79706) where the two-character escape would
// do. Widen SRC_DIR to the repo root once that line is fixed; doing it before
// would only make this file red about something it cannot fix.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The WHOLE REPO, not just src/. The first raw-NUL defect this guard caught was
// in src/, but the second was in scripts/ingest-knowledge.ts - committed a month
// earlier and binary to git the entire time. Code lives outside src/ here
// (scripts/, supabase/), so the sweep starts at the repo root.
const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Directories that are build output, vendored code or tooling state - never our source. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", ".superpowers"]);

/** Genuinely binary payloads. Control bytes are their content, not a defect. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".mp4",
  ".webm",
  ".zip",
]);

/** OS droppings. Untracked, so git never sees them and neither should this. */
const SKIP_NAMES = new Set([".DS_Store"]);

/** Tab, LF and CR are the only control characters a source file may contain. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Every text file under src/, as a path relative to src/. */
function textFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Transient test fixtures: walk-src.test.ts materialises a real
        // dot-prefixed directory (mkdtemp ".walk-fixture-*") mid-run and removes
        // it again. This walker captures its file list at describe-collection
        // time but reads the bytes later inside the its, so racing that fixture
        // yields ENOENT here for a reason unrelated to source hygiene.
        if (entry.name.startsWith(".walk-fixture-")) continue;
        walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_NAMES.has(entry.name)) continue;
      if (BINARY_EXTENSIONS.has(extensionOf(entry.name))) continue;
      found.push(`${prefix}${entry.name}`);
    }
  };
  walk(SRC_DIR, "");
  return found.sort();
}

interface Offence {
  file: string;
  offset: number;
  line: number;
  column: number;
  byte: number;
}

/** Every disallowed control byte in one file, located for a human. */
function offencesIn(relativePath: string): Offence[] {
  const bytes = readFileSync(`${SRC_DIR}${relativePath}`);
  const offences: Offence[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      line++;
      lineStart = i + 1;
      continue;
    }
    if (byte >= 0x20 || ALLOWED_CONTROL_BYTES.has(byte)) continue;
    offences.push({ file: relativePath, offset: i, line, column: i - lineStart + 1, byte });
  }
  return offences;
}

function describeOffence(o: Offence): string {
  const code = `0x${o.byte.toString(16).padStart(2, "0")}`;
  const name = o.byte === 0 ? "NUL" : `control byte ${code}`;
  return `src/${o.file}:${o.line}:${o.column} contains a raw ${name} (byte offset ${o.offset}). Write it as an escape sequence in the string literal instead.`;
}

describe("the source tree is readable by every text tool", () => {
  const files = textFiles();

  // A walk that found nothing would pass every assertion below vacuously, and
  // that is exactly how a guard like this rots: someone moves a directory, the
  // walk finds zero files, the suite stays green and the check is gone.
  it("actually walks the tree it claims to walk", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files, "the walk missed the file the original defect lived in").toContain(
      "src/lib/smile-assessment/flow-validate.ts",
    );
    // The file the SECOND defect lived in - outside src/, which is why the walk
    // now starts at the repo root.
    expect(files, "the walk missed the scripts tree").toContain("scripts/ingest-knowledge.ts");
    expect(files, "the walk missed the app router").toContain("src/app/assess/[client]/[slug]/page.tsx");
    // .tsx is covered too — vitest cannot collect .tsx as a test, but this walk
    // reads bytes, so components are in scope exactly like libraries are.
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".ts"))).toBe(true);
  });

  // THE ASSERTION THAT MATTERS. Reported ALL AT ONCE rather than one at a time:
  // whoever runs into this needs the full list to fix it in a single pass, the
  // same reason validateFlow returns every failure (content.ts:311-318).
  it("has no raw NUL byte in any source file", () => {
    const nuls = files.flatMap((f) => offencesIn(f)).filter((o) => o.byte === 0);
    expect(nuls.map(describeOffence)).toEqual([]);
  });

  // The wider class. NUL is the one that turns a file binary, but a stray
  // vertical tab, form feed or ESC is just as invisible in review and just as
  // capable of hiding a character from a reader who greps for it.
  it("has no other C0 control character either, tab and the newline pair aside", () => {
    const offences = files.flatMap((f) => offencesIn(f));
    expect(offences.map(describeOffence)).toEqual([]);
  });

  // The exclusion list is a hole by construction, so it is pinned: growing it
  // has to be a deliberate edit here, never a quiet one somewhere else.
  it("excludes only binary payloads and untracked OS droppings", () => {
    expect([...SKIP_NAMES]).toEqual([".DS_Store"]);
    // Widened with the walk root: .git and the two agent-tooling state dirs are
    // not our source; everything else in the repo is now in scope.
    expect([...SKIP_DIRS].sort()).toEqual([".claude", ".git", ".next", ".superpowers", "node_modules"]);
    for (const ext of BINARY_EXTENSIONS) {
      expect(ext, "every excluded extension is a leading-dot lowercase suffix").toMatch(
        /^\.[a-z0-9]+$/,
      );
    }
    // No source extension may be waved through as "binary".
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".sql", ".svg"]) {
      expect(BINARY_EXTENSIONS.has(ext), `${ext} must not be excluded from the sweep`).toBe(false);
    }
  });
});
