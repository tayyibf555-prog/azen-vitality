import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

const SRC = resolve(__dirname, "..", "..");
const REPO = resolve(SRC, "..");

/** Where `sendMessage` is DEFINED. Its own declaration is not a call site. */
const SEND_MODULE = "src/lib/messaging/send.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Tests mock and assert on sendMessage constantly; they never put a message on
    // the wire, so counting them would drown the signal in noise.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
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
  for (const file of walk(SRC)) {
    const rel = relative(REPO, file).split(sep).join("/");
    if (rel === SEND_MODULE) continue;
    const n = countCalls(readFileSync(file, "utf8"));
    if (n > 0) found.set(rel, n);
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
    for (const file of walk(SRC)) {
      const rel = relative(REPO, file).split(sep).join("/");
      if (rel === SEND_MODULE || rel.startsWith("src/lib/messaging/providers/")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      // Alias-resolved for the same reason as countCalls: `import { sendViaTwilio as
      // wire }` would otherwise walk straight past the door this test guards.
      for (const exported of ["sendViaTwilio", "sendViaResend"]) {
        const bound = localBindings(code, PROVIDER_MODULE_TAIL, exported);
        const names = new Set(bound.length > 0 ? bound : [exported]);
        for (const name of names) {
          if (countByName(code, name) > 0) callers.push(rel);
        }
      }
    }
    expect(
      callers,
      `these call a provider directly, bypassing sendMessage and every gate around it: ${callers.join(", ")}`,
    ).toEqual([]);
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
