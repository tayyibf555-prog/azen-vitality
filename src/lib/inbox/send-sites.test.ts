import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";
import { SEND_SITES, PATIENT_SEND_SITES } from "./send-sites";
import { CORRESPONDENCE_SOURCE_NAMES } from "./repository";

/**
 * THE STRUCTURAL TEST. It reads the source tree, not a list somebody maintained.
 *
 * The Correspondence tab claims to hold every message this platform has sent to a
 * patient. That claim was false for a year in four places, and the reason it stayed
 * false is that nothing in the codebase could tell you where the platform sends
 * from. `delivery.test.ts` pins the record's READ registry against the drain, which
 * covers the ten drain modules and is blind to the four senders that bypass it.
 *
 * So this file goes the other way round: it crawls src/ for `sendMessage(` call
 * sites and requires each one to be declared in SEND_SITES with an audience and,
 * for a patient-facing one, the correspondence source that carries it. A new agent
 * that texts patients cannot be merged without either wiring it into the record or
 * saying, in writing and in the registry, that it is staff-only.
 *
 * It fails in BOTH directions on purpose: an undeclared call site fails, and a
 * declared site that no longer exists fails too, so the registry cannot rot into a
 * list of places the platform used to send from.
 */

/** Where `sendMessage` is DEFINED. Its own declaration is not a call site. */
const SEND_MODULE = "src/lib/messaging/send.ts";

/** This file, for the assertions below that read their own source. */
const SELF = "lib/inbox/send-sites.test.ts";

/**
 * EVERY SOURCE FILE, as a path relative to src/, through the SHARED walk.
 *
 * This used to hand-roll its own directory listing, skipping only `node_modules`
 * and `.next` — which left it the one whole-src sweep that still DESCENDED
 * dot-directories, and it reads the bytes of every file it lists. `walk-src.test.ts`
 * materialises a real dot-directory mid-run (`mkdtemp ".walk-fixture-*"` under
 * lib/test-support, with a `route.ts` and a nested `.git/route.ts` inside) and
 * removes it again in a `finally`, so in a parallel run this crawl listed the
 * fixture's files and then reached `readFileSync` after they were gone: ENOENT,
 * failing the send registry for a reason that has nothing to do with sending.
 * `source-hygiene.test.ts` had already had to name that fixture in its own skip
 * list for exactly this. `walkSrc` skips dot-directories by default, so the race
 * is closed by construction rather than by a second name-based skip; it also roots
 * the walk at THIS FILE's src/ instead of at a `resolve(__dirname, ...)` climb.
 *
 * THE SECOND PASS IS NOT DECORATION. The third assertion in this file claims that
 * nothing in the platform reaches Twilio or Resend around `sendMessage`, and Next
 * serves `app/.well-known/<x>/route.ts` as a real route handler
 * (node_modules/next/dist/docs/01-app/02-guides/backend-for-frontend.md), so a
 * sweep making that claim may not skip the dot-directories the router serves. That
 * is the same posture the destructive-route and loading.tsx sweeps take, and it is
 * narrowed to app/ for the same reason theirs are — the transient fixture lives
 * under lib/test-support, where an app-narrowed walk cannot see it. Dropping this
 * pass would silently narrow a security claim; it is pinned below.
 *
 * Tests are excluded (walkSrc's default): they mock and assert on sendMessage
 * constantly and never put a message on the wire, so counting them would drown the
 * signal in noise.
 */
function sourceFiles(): string[] {
  const wholeTree = walkSrc();
  const dotDirsTheRouterServes = walkSrc({ subdir: "app", includeDotDirs: true });
  return [...new Set([...wholeTree, ...dotDirsTheRouterServes])].sort();
}

/**
 * Strip the comment forms this codebase actually uses, so prose ABOUT sendMessage
 * is not mistaken for a call to it. Several of these files discuss their own send
 * path at length (the voice webhook's "a second `sendMessage(...)` call site is
 * exactly how the double-text bug returns" is the reason this matters).
 *
 * Block comments go wholesale. Line comments are stripped only when `//` opens the
 * line, which is the form every commented mention in this tree takes, and which
 * cannot swallow a `https://` inside a string on a line of real code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * THE LOCAL NAME an export is bound to IN THIS FILE, resolved from its import.
 *
 * The crawl used to count the literal string `sendMessage(`, which made it
 * ALIAS-BLIND: a new patient-facing file could write
 *
 *     import { sendMessage as dispatch } from "@/lib/messaging/send";
 *     await dispatch({ channel: "sms", to, body });
 *
 * and every test here stayed green. The registry would not list the file, the
 * file-list assertion would not miss it (the crawl found nothing to miss), and the
 * count assertion would agree with a registry that never mentioned it. A sender
 * texting real patients with nothing on their record is exactly the defect this
 * lane exists to close, so the crawl has to follow the binding, not the spelling.
 *
 * Handles the three forms that can reach the module: a plain named import, an
 * aliased one, and a namespace import (counted as `ns.name`). The module is matched
 * on the SPECIFIER's tail so both `@/lib/messaging/send` and a relative `./send`
 * resolve, which is what `src/lib/messaging/send.test.ts` uses.
 */
function localBindings(code: string, moduleTail: RegExp, exported: string): string[] {
  const names: string[] = [];
  const IMPORT = /import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = IMPORT.exec(code)) !== null) {
    const [, clause, specifier] = m;
    if (!moduleTail.test(specifier)) continue;
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) {
      names.push(`${namespace[1]}.${exported}`);
      continue;
    }
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (!braced) continue;
    for (const raw of braced[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliased = part.match(
        new RegExp(`^${exported}\\s+as\\s+([A-Za-z_$][\\w$]*)$`),
      );
      if (aliased) {
        names.push(aliased[1]);
        continue;
      }
      if (part === exported) names.push(exported);
    }
  }
  return names;
}

/** Calls to a given local name, ignoring `foo.name(` and `myName(`. */
function countByName(code: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (code.match(new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, "g")) ?? []).length;
}

const SEND_MODULE_TAIL = /(^|\/)messaging\/send$/;
const PROVIDER_MODULE_TAIL = /(^|\/)messaging\/providers\/(twilio|resend)$/;

/** `sendMessage(` call sites in one file, excluding its own declaration. */
function countCalls(source: string): number {
  const code = stripComments(source)
    // `function sendMessage(` is the definition, not a call.
    .replace(/function\s+sendMessage\s*\(/g, "function SEND_MESSAGE_DECLARATION(");
  const bound = localBindings(code, SEND_MODULE_TAIL, "sendMessage");
  // No import of the one door found: fall back to the literal name, so a call
  // reached some other way (a dynamic import, a re-export, a helper of the same
  // name) is still counted rather than silently dropped by the smarter crawl.
  const names = new Set(bound.length > 0 ? bound : ["sendMessage"]);
  let calls = 0;
  for (const name of names) calls += countByName(code, name);
  return calls;
}

/** file (repo-relative, forward slashes) -> number of call sites. */
function crawl(): Map<string, number> {
  const found = new Map<string, number>();
  for (const rel of sourceFiles()) {
    const file = `src/${rel}`;
    if (file === SEND_MODULE) continue;
    const n = countCalls(readFileSync(srcPath(rel), "utf8"));
    if (n > 0) found.set(file, n);
  }
  return found;
}

describe("every send site is declared", () => {
  it("finds a send site in the tree for every file in the registry, and vice versa", () => {
    const actual = crawl();
    const declared = new Set(SEND_SITES.map((s) => s.file));

    const undeclared = [...actual.keys()].filter((f) => !declared.has(f)).sort();
    expect(
      undeclared,
      `these files call sendMessage but are not in SEND_SITES. Add each one, say who it goes ` +
        `to, and (if it is a patient) make sure it lands somewhere the record reads: ` +
        `${undeclared.join(", ")}`,
    ).toEqual([]);

    const stale = SEND_SITES.map((s) => s.file).filter((f) => !actual.has(f)).sort();
    expect(
      stale,
      `SEND_SITES lists files that no longer call sendMessage: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("pins the NUMBER of sends per file, so a new one in an existing file is caught too", () => {
    const actual = crawl();
    const drift = SEND_SITES.filter((s) => actual.get(s.file) !== s.calls).map(
      (s) => `${s.file}: registry says ${s.calls}, tree has ${actual.get(s.file)}`,
    );
    expect(drift, drift.join("; ")).toEqual([]);
  });

  it("proves sendMessage is the only door to a provider", () => {
    // The crawl above only enumerates the platform's outbound if nothing reaches
    // Twilio or Resend around it. If this ever fails, the registry has become a
    // list of SOME of the places the platform sends from.
    const callers: string[] = [];
    for (const rel of sourceFiles()) {
      const file = `src/${rel}`;
      if (file === SEND_MODULE || file.startsWith("src/lib/messaging/providers/")) continue;
      const code = stripComments(readFileSync(srcPath(rel), "utf8"));
      // Alias-resolved for the same reason as countCalls: `import { sendViaTwilio as
      // wire }` would otherwise walk straight past the door this test guards.
      for (const exported of ["sendViaTwilio", "sendViaResend"]) {
        const bound = localBindings(code, PROVIDER_MODULE_TAIL, exported);
        const names = new Set(bound.length > 0 ? bound : [exported]);
        for (const name of names) {
          if (countByName(code, name) > 0) callers.push(file);
        }
      }
    }
    expect(
      callers,
      `these call a provider directly, bypassing sendMessage and every gate around it: ${callers.join(", ")}`,
    ).toEqual([]);
  });
});

describe("the crawl's file list comes from the shared walk", () => {
  /**
   * These three pin the walk itself, because the walk is the half of this file that
   * decides WHAT is audited. A crawl that quietly stops opening a directory keeps
   * printing the same completeness claim about a smaller tree, and nothing else in
   * the suite can tell — src/ holds no dot-directory of its own to find one with.
   */
  const selfSource = (): string => stripComments(readFileSync(srcPath(SELF), "utf8"));

  /**
   * The BODY of `sourceFiles`, not the whole file.
   *
   * A pin that searched the whole file for "includeDotDirs: true" would match the
   * assertion below quoting it and stay green after the pass it guards was deleted —
   * the always-true guard this programme keeps finding. So the needle is looked for
   * only inside the function that must contain it.
   */
  const walkSetup = (): string => {
    const code = selfSource();
    const start = code.indexOf("function sourceFiles(");
    expect(start, "sourceFiles() has been renamed or removed; this pin is stale").toBeGreaterThan(
      -1,
    );
    const end = code.indexOf("\n}", start);
    expect(end, "sourceFiles() has no closing brace at column 0; this pin is stale").toBeGreaterThan(
      start,
    );
    return code.slice(start, end);
  };

  // MUTATION: hand-roll the readdir back ("it was only ten lines"). That is the walk
  // that descended lib/test-support/.walk-fixture-*/ and ENOENT'd on it mid-run.
  it("never hand-rolls a directory listing again", () => {
    const code = selfSource();
    expect(code, "the file list must come from walk-src, not a private copy").toContain(
      "walkSrc(",
    );
    const clause = code.match(/import\s*\{([^}]*)\}\s*from\s*"node:fs"/);
    expect(clause, "this file still has to READ the sources it walks").not.toBeNull();
    expect(
      clause?.[1]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      "a listing has been hand-rolled here again: reading is this file's job, " +
        "listing is walk-src's, and the private walk is what raced walk-src.test.ts's " +
        "transient dot-directory fixture into an ENOENT",
    ).toEqual(["readFileSync"]);
  });

  // MUTATION: delete the second walkSrc pass "because src/app holds no dot-folders".
  // Everything stays green and the provider assertion goes on claiming that NOTHING
  // reaches Twilio or Resend around sendMessage, about a directory it never opened.
  it("still opens the dot-directories the router serves", () => {
    const setup = walkSetup();
    expect(
      setup,
      'this file claims "sendMessage is the only door to a provider", which it ' +
        "cannot claim about app/.well-known/<x>/route.ts if it never looks there",
    ).toContain("includeDotDirs: true");
    expect(
      setup,
      "and that pass stays narrowed to app/, away from the transient fixture under " +
        "lib/test-support that the default walk is skipping",
    ).toContain('subdir: "app", includeDotDirs: true');
    expect(setup, "the whole-src pass is still there too").toMatch(/walkSrc\(\s*\)/);
  });

  // MUTATION: concatenate the two passes without the Set. Every file under src/app is
  // returned by BOTH, so each one would be crawled and counted twice and the per-file
  // call counts would double — an all-green way to make the registry unmaintainable.
  it("lists every file once, in a stable order, across both passes", () => {
    const files = sourceFiles();
    expect(new Set(files).size, "the two passes overlap on all of app/").toBe(files.length);
    expect(files, "a failure list in readdir order is a different list per machine").toEqual([
      ...files,
    ].sort());
    expect(files).toContain("lib/inbox/send-sites.ts");
    expect(files, "the app pass has to actually return app files").toContain(
      "app/api/messaging/drain/route.ts",
    );
    expect(files, "tests are excluded; they mock sendMessage, they never send").not.toContain(
      SELF,
    );
  });
});

describe("the crawl follows the BINDING, not the spelling", () => {
  /**
   * These run countCalls over synthetic sources rather than the tree, because the
   * property being pinned is about a file that does not exist yet: the next
   * patient-facing sender somebody writes. Proven once against the real tree by
   * dropping such a file in and watching the registry assertion name it.
   */
  it("counts a send imported under an alias", () => {
    const file = [
      `import { sendMessage as dispatch } from "@/lib/messaging/send";`,
      `export async function chase(to: string) {`,
      `  await dispatch({ channel: "sms", to, body: "hello" });`,
      `}`,
    ].join("\n");
    expect(countCalls(file)).toBe(1);
  });

  it("counts a send reached through a namespace import", () => {
    const file = [
      `import * as messaging from "@/lib/messaging/send";`,
      `export const go = () => messaging.sendMessage({ channel: "sms", to: "x", body: "y" });`,
    ].join("\n");
    expect(countCalls(file)).toBe(1);
  });

  it("does NOT credit the old literal when the import was aliased away", () => {
    // The exact hole: the file contains no `sendMessage(` at all, so the old crawl
    // returned 0 and the registry agreed with it.
    const file = [
      `import { sendMessage as dispatch } from "@/lib/messaging/send";`,
      `await dispatch({ channel: "sms", to: "x", body: "y" });`,
      `await dispatch({ channel: "email", to: "x", body: "y" });`,
    ].join("\n");
    expect(file).not.toMatch(/\bsendMessage\s*\(/);
    expect(countCalls(file)).toBe(2);
  });

  it("still counts the plain import, and does not double-count it", () => {
    const file = [
      `import { sendMessage } from "@/lib/messaging/send";`,
      `await sendMessage({ channel: "sms", to: "x", body: "y" });`,
    ].join("\n");
    expect(countCalls(file)).toBe(1);
  });

  it("does not count a same-named method on something else", () => {
    // `queue.sendMessage(...)` is not this platform's door. Counting it would put a
    // phantom call site in a file and fail the count assertion for no reason.
    const file = [
      `import { sendMessage } from "@/lib/messaging/send";`,
      `await queue.sendMessage({});`,
      `await sendMessage({ channel: "sms", to: "x", body: "y" });`,
    ].join("\n");
    expect(countCalls(file)).toBe(1);
  });

  it("falls back to the literal name when no import of the door is present", () => {
    // A dynamic import or a re-export still counts, rather than being dropped by
    // the smarter crawl: an unrecognised shape must over-report, never under-report.
    const file = [
      `const { sendMessage } = await import("@/lib/messaging/send");`,
      `await sendMessage({ channel: "sms", to: "x", body: "y" });`,
    ].join("\n");
    expect(countCalls(file)).toBe(1);
  });
});

describe("every patient-facing send lands somewhere the record reads", () => {
  it("names at least one correspondence source for each one", () => {
    const unrecorded = PATIENT_SEND_SITES.filter(
      (s) => !s.recordedIn || s.recordedIn.length === 0,
    ).map((s) => s.file);
    expect(
      unrecorded,
      `patient-facing sends with nowhere on the record: ${unrecorded.join(", ")}. ` +
        `Either record them (see src/lib/inbox/record-outbound.ts) or the tab's ` +
        `"every message" copy and the runbook's gap table have to say so.`,
    ).toEqual([]);
  });

  it("names sources the record actually reads, not invented ones", () => {
    // A registry naming a source the read does not have would be the same defect in
    // a new costume: a written claim of completeness that nothing checks.
    const known = new Set(CORRESPONDENCE_SOURCE_NAMES);
    const bogus: string[] = [];
    for (const site of PATIENT_SEND_SITES) {
      for (const source of site.recordedIn ?? []) {
        if (!known.has(source)) bogus.push(`${site.file} -> ${source}`);
      }
    }
    expect(bogus, `sources the correspondence read does not have: ${bogus.join(", ")}`).toEqual([]);
  });

  it("records the four paths that used to be missing", () => {
    // Named individually rather than by count: these are the exact four the record
    // silently lost, and a regression on any one of them should say which.
    const byFile = new Map(SEND_SITES.map((s) => [s.file, s]));
    for (const file of [
      "src/app/api/webhooks/twilio/voice/route.ts",
      "src/app/api/webhooks/twilio/inbound/route.ts",
      "src/lib/copilot/tools.ts",
    ]) {
      const site = byFile.get(file);
      expect(site?.audience, file).toBe("patient");
      expect(site?.recordedIn, file).toContain("agent");
    }
  });

  it("keeps staff sends OFF the record rather than filing them under a patient", () => {
    for (const site of SEND_SITES.filter((s) => s.audience === "staff")) {
      expect(site.recordedIn, site.file).toBeNull();
    }
  });

  it("gives every site a note, because 'who does this text' is the whole question", () => {
    for (const site of SEND_SITES) {
      expect(site.note.length, site.file).toBeGreaterThan(20);
    }
  });
});
