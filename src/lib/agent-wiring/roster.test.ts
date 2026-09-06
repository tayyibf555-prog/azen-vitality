// ===========================================================================
// THE JOIN. Four registries, one set of agents, and the seams between them.
//
// Each of the platform's existing registries is complete about its own question
// and blind to the others:
//
//   src/lib/systems/catalog.ts      what an owner can switch off
//   the drain's SOURCES array       what the outbox drain delivers
//   src/lib/inbox/send-sites.ts     what can put a message on the wire
//   src/lib/inbox/repository.ts     what a patient's record reads
//
// An agent can be present in all four and still be broken BETWEEN them. The two
// defects this lane actually found are both of that shape: a function that queues
// a real patient SMS with no toggle read anywhere above it, and six dead
// "stub-send" helpers that would mark a message sent without sending it.
//
// So this file does not assert one registry against another. It asserts the
// SOURCE TREE against the roster: every file that queues a message, every file
// that calls sendMessage, every default-off switch, every path the runbook
// promises. It fails in both directions, and it is the test that goes red first
// when somebody adds the next agent. (Not "agent number nineteen", which is what
// this line used to say: the roster passed nineteen without the sentence
// noticing, and a count written into prose is the thing that goes stale — see
// "states no fixed agent count in its header or its test names" below.)
// ===========================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { AGENTS, AGENT_BY_KEY, DRAIN_AGENTS, PATIENT_FACING_AGENTS } from "./roster";
import type { AgentDef } from "./roster";
import { SYSTEM_BY_SLUG, DRAIN_SOURCE_TO_SLUG, DEFAULT_OFF_SLUGS } from "@/lib/systems/catalog";
import { CORRESPONDENCE_SOURCE_NAMES } from "@/lib/inbox/repository";
import { SEND_SITES } from "@/lib/inbox/send-sites";
// Section 9 checks the roster's owner-facing sentences against the code they
// describe, so it imports the composer and the panel's own heading rather than
// retyping either. Both are pure (no I/O, no clock, no server-only).
import { previsitBody } from "@/lib/triage/copy";
import { SUMMARY_COPY } from "@/lib/triage/summary";
import { walkSrc, srcPath, SRC_ROOT } from "@/lib/test-support/walk-src";

const REPO_ROOT = join(SRC_ROOT, "..");

function readRepo(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/** Comment-stripped source, so prose ABOUT a guard is never read as a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * Every non-test file under src/, as repo-relative posix paths.
 *
 * NO `includeDotDirs`, AND THAT IS A CORRECTNESS FIX, NOT TIDINESS (wave-3
 * review, 4 Sep 2026). This was the tree's only whole-src walk that descended
 * into dot-directories, which is precisely the combination walk-src.ts's own
 * header rules out: "the whole-src sweeps leave it off deliberately", and the
 * two sweeps that turn it on are narrowed to app/ because Next SERVES
 * `app/.well-known/<name>/route.ts`. Nothing below makes a routing claim, so
 * nothing below needs them.
 *
 * What it cost while it was on: src/ holds no permanent dot-directory, so the
 * only thing such a walk can ever find is another test's transient fixture —
 * walk-src.test.ts mkdtemps `src/lib/test-support/.walk-fixture-XXXX/route.ts`
 * and removes it in a `finally`. Vitest runs files in parallel, so this crawl
 * would list that path and `readRepo` (a bare readFileSync) would reach it after
 * the teardown: `ENOENT … .walk-fixture-F14TNe/route.ts` thrown from whichever of
 * the six tests below happened to be running. Roughly one full-suite run in five.
 *
 * That is worse than a flake here. Charter §0 item 11 makes "break the rule →
 * the NAMED test goes red" the way every fix in this programme is verified, and
 * a red that no mutation caused is indistinguishable from a mutation caught.
 */
function everySourceFile(): string[] {
  return walkSrc().map((p) => `src/${p}`);
}

// ---------------------------------------------------------------------------
// 1. The roster is well formed and agrees with the owner's control panel.
// ---------------------------------------------------------------------------

describe("the roster names every agent exactly once", () => {
  it("has unique keys", () => {
    const keys = AGENTS.map((a) => a.key);
    expect(new Set(keys).size, `duplicate keys in the roster: ${keys.join(", ")}`).toBe(keys.length);
  });

  it("names a switch that the owner's control panel actually has", () => {
    const unknown = AGENTS.filter((a) => a.slug !== null && !SYSTEM_BY_SLUG.has(a.slug)).map(
      (a) => `${a.key} -> ${a.slug}`,
    );
    expect(unknown, `roster slugs missing from the catalog: ${unknown.join(", ")}`).toEqual([]);
  });

  it("explains itself whenever an agent has NO switch of its own", () => {
    for (const agent of AGENTS.filter((a) => a.slug === null)) {
      expect(agent.slugNote, `${agent.key} has no slug and no slugNote`).toBeTruthy();
      expect((agent.slugNote ?? "").length, agent.key).toBeGreaterThan(40);
    }
  });

  it("points at files that exist, for the trigger, the guard and the drafter", () => {
    const missing: string[] = [];
    for (const agent of AGENTS) {
      for (const [field, path] of [
        ["trigger", agent.trigger],
        ["guard", agent.guard],
        ["drafter", agent.drafter],
      ] as const) {
        if (!path) continue;
        if (!existsSync(join(REPO_ROOT, path))) missing.push(`${agent.key}.${field}: ${path}`);
      }
    }
    expect(missing, `roster paths that are not in the tree: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every agent the four things a runbook needs", () => {
    for (const agent of AGENTS) {
      expect(agent.firstTick.length, `${agent.key}.firstTick`).toBeGreaterThan(30);
      expect(agent.bound.length, `${agent.key}.bound`).toBeGreaterThan(20);
      expect(agent.verify.length, `${agent.key}.verify`).toBeGreaterThan(20);
      expect(agent.stop.length, `${agent.key}.stop`).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every drain module is rostered, and every rostered drain module is killable.
// ---------------------------------------------------------------------------

/** The source names the drain iterates, read out of the drain's own source. */
function drainSourceNames(): string[] {
  const src = readRepo("src/app/api/messaging/drain/route.ts");
  const block = src.slice(src.indexOf("const SOURCES: OutboxSource[] = ["));
  return [...block.slice(0, block.indexOf("\n];")).matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("the drain and the roster describe the same set of modules", () => {
  it("every source the drain iterates has an agent in the roster", () => {
    const rostered = new Set(DRAIN_AGENTS.map((a) => a.drainSource));
    const orphaned = drainSourceNames().filter((n) => !rostered.has(n));
    expect(
      orphaned,
      `the drain sends for these and the roster does not know they exist: ${orphaned.join(", ")}. ` +
        `An unrostered module has no switch-on runbook and no scenario trace.`,
    ).toEqual([]);
  });

  it("every rostered drain source is one the drain really iterates", () => {
    const actual = new Set(drainSourceNames());
    const stale = DRAIN_AGENTS.filter((a) => !actual.has(a.drainSource!)).map(
      (a) => `${a.key} -> ${a.drainSource}`,
    );
    expect(stale, `roster names drain sources the drain does not have: ${stale.join(", ")}`).toEqual([]);
  });

  it("maps each one to the agent's OWN switch, so the kill switch reaches its outbox", () => {
    // An unmapped source is an unkillable one; a source mapped to the WRONG slug is
    // worse, because the owner's switch then silently stops somebody else's module.
    const wrong = DRAIN_AGENTS.filter((a) => DRAIN_SOURCE_TO_SLUG[a.drainSource!] !== a.slug).map(
      (a) => `${a.drainSource} maps to ${DRAIN_SOURCE_TO_SLUG[a.drainSource!]}, roster says ${a.slug}`,
    );
    expect(wrong, wrong.join("; ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Every patient-facing agent lands on the patient's record.
// ---------------------------------------------------------------------------

describe("every agent that speaks to a patient leaves a trace on their record", () => {
  it("names correspondence sources the record actually reads", () => {
    const known = new Set(CORRESPONDENCE_SOURCE_NAMES);
    const bogus: string[] = [];
    for (const agent of AGENTS) {
      for (const source of agent.correspondence) {
        if (!known.has(source)) bogus.push(`${agent.key} -> ${source}`);
      }
    }
    expect(bogus, `sources the correspondence read does not have: ${bogus.join(", ")}`).toEqual([]);
  });

  it("gives every patient-facing agent at least one", () => {
    const unrecorded = PATIENT_FACING_AGENTS.filter((a) => a.correspondence.length === 0).map((a) => a.key);
    expect(
      unrecorded,
      `these can text a patient and appear nowhere on their record: ${unrecorded.join(", ")}`,
    ).toEqual([]);
  });

  it("makes an agent that records NOTHING say why, in writing", () => {
    for (const agent of AGENTS.filter((a) => a.correspondence.length === 0)) {
      // The only two honest reasons to hold nothing: it speaks to nobody, or it
      // speaks to STAFF — and a nurse's shift text filed under a patient of the
      // same name would be its own defect, so that one is a decision, not a gap.
      expect(agent.audience, `${agent.key} texts patients but records nothing`).not.toBe("patient");
      expect(agent.recordNote, `${agent.key} has no recordNote`).toBeTruthy();
      expect((agent.recordNote ?? "").length, agent.key).toBeGreaterThan(40);
    }
  });

  it("agrees with the send-site registry about who is a staff sender", () => {
    // send-sites.ts already decided this for the rota routes and the handover ping.
    // Two registries disagreeing about the audience of the same file is how a staff
    // text ends up on a patient's record, so they are checked against each other.
    const staffFiles = new Set(SEND_SITES.filter((s) => s.audience === "staff").map((s) => s.file));
    for (const agent of AGENTS.filter((a) => a.audience === "staff")) {
      expect(
        staffFiles.has(agent.trigger),
        `${agent.key} is staff-facing in the roster; send-sites does not say so for ${agent.trigger}`,
      ).toBe(true);
    }
  });

  it("accounts for every patient-facing file the send-site registry knows about", () => {
    // send-sites.ts crawls the tree for sendMessage; this asserts the roster covers
    // the same ground, so a sender can never be "declared" and yet unrostered.
    const rosterFiles = new Set<string>();
    for (const agent of AGENTS) {
      rosterFiles.add(agent.trigger);
      if (agent.drafter) rosterFiles.add(agent.drafter);
      if (agent.guard) rosterFiles.add(agent.guard);
    }
    // The drain and the human-in-the-loop surfaces are not agents; they are named
    // here so the exemption is a decision rather than an omission.
    const NOT_AN_AGENT = new Set([
      "src/app/api/messaging/drain/route.ts", // delivers every module's rows; not a module
      "src/app/api/inbox/reply/route.ts", // a person typing in the Conversations inbox
      "src/lib/copilot/tools.ts", // a person asking the co-pilot to text somebody
      "src/lib/agent/alerts.ts", // the staff handover ping
      "src/app/api/rota/sweep/route.ts", // the rota agent's second trigger
      "src/lib/speed-to-lead/nurture.ts", // the speed-to-lead agent's own cadence
      "src/lib/speed-to-lead/contact.ts", // the shared first-contact primitive
    ]);
    const unaccounted = SEND_SITES.map((s) => s.file).filter(
      (f) => !rosterFiles.has(f) && !NOT_AN_AGENT.has(f),
    );
    expect(
      unaccounted,
      `these put messages on the wire and belong to no rostered agent: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. THE GUARD-COVERAGE CRAWL. This is the one that found the real defect.
// ---------------------------------------------------------------------------

const TOGGLE_READS = ["isSystemEnabled(", "isSystemEnabledForSend(", "isSystemEnabledStrict(", "getDisabledSlugs"];

function readsAToggle(source: string): boolean {
  const c = code(source);
  return TOGGLE_READS.some((needle) => c.includes(needle));
}

/**
 * Files allowed to queue an outbox row without reading a toggle themselves,
 * each with the reason it is safe. Anything NOT here has to read the switch.
 */
const QUEUE_WITHOUT_TOGGLE: Record<string, string> = {
  // The repositories DEFINE enqueueOutbox / approveDraft. They are the mechanism,
  // not a decision to send: every caller is crawled below.
  "src/lib/calendar/repository.ts": "defines enqueueOutbox",
  "src/lib/coordinator/repository.ts": "defines enqueueOutbox",
  "src/lib/noshow/repository.ts": "defines enqueueOutbox",
  "src/lib/outreach/repository.ts": "defines enqueueOutbox",
  "src/lib/reactivation/repository.ts": "defines enqueueOutbox",
  "src/lib/recall/repository.ts": "defines enqueueOutbox",
  "src/lib/reviews/repository.ts": "defines enqueueOutbox",
  "src/lib/closer/repository.ts": "defines approveDraft",
  "src/lib/collection/repository.ts": "defines approveDraft",
  "src/lib/postop/repository.ts": "defines approveDraft",
};

// ---------------------------------------------------------------------------
// 2b. THE CRAWL ITSELF. Six tests below read the whole tree through
//     everySourceFile(), so how it walks is a property of all six.
// ---------------------------------------------------------------------------

describe("the shared source crawl cannot read a file that is being deleted", () => {
  it("skips dot-directories, so no other test's fixture is ever in its list", () => {
    // The behavioural half. src/ holds no permanent dot-directory, so this list
    // is identical either way TODAY — which is exactly why the hazard was
    // invisible: the only dot-directory that ever appears is a fixture another
    // file creates and removes while this one is running (walk-src.test.ts).
    expect(everySourceFile()).toEqual(walkSrc().map((p) => `src/${p}`));
    const dotted = everySourceFile().filter((rel) => rel.split("/").some((seg) => seg.startsWith(".")));
    expect(dotted, `the crawl descended into: ${dotted.join(", ")}`).toEqual([]);
  });

  it("asks walkSrc for the default walk and never widens it", () => {
    /*
     * The deterministic half, and the one the mutation check uses: the option is
     * a configuration, and re-adding it goes red here whether or not a fixture
     * happens to exist at that instant. Writing the obvious behavioural test
     * instead — create a dot-directory, assert it is skipped — would mean THIS
     * file creating a transient file under src/ and so spreading the very race it
     * closes to the tree's other hand-rolled crawls. walk-src.test.ts already owns
     * that fixture and is the right place for it.
     *
     * The needle is the argument list rather than the option's name because the
     * name would have to appear in this file to be searched for.
     */
    const self = code(readRepo("src/lib/agent-wiring/roster.test.ts"));
    const args = [...self.matchAll(/walkSrc\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(args.length, "no call to walkSrc found; the pin has gone stale").toBeGreaterThan(0);
    expect(
      args.filter((a) => a !== ""),
      `a whole-src walk in this file takes options: ${args.join(" | ")}. ` +
        `walk-src.ts's header says whole-src sweeps leave includeDotDirs off; only the ` +
        `routing sweeps narrowed to app/ turn it on.`,
    ).toEqual([]);
  });
});

describe("nothing can queue a patient message without reading the owner's switch", () => {
  /**
   * WHY THIS CRAWL EXISTS, AND WHAT IT CAUGHT.
   *
   * src/lib/noshow/fill.ts is the only thing in the platform that queues a
   * waitlist slot offer. It had four call sites and the guard was written into
   * three of them; the fourth — the Dentally reconciliation pass in
   * src/app/api/sync/noshow/route.ts — reads no toggle anywhere in the file. So
   * with no-show defence switched OFF, a desk cancellation still drafted an offer
   * and left a real patient SMS in noshow_outbox. The drain would not send it
   * while the switch stayed off, but outbox rows live for 48 hours, so switching
   * the system back on inside two days released a burst of offers for slots the
   * practice had already dealt with by hand.
   *
   * A fourth copy of the guard would have closed that hole and left the shape
   * intact for the fifth caller. The guard now lives inside fill.ts, and this
   * crawl is what keeps it there: delete it and this test names the file.
   */
  it("every file that queues one reads a system toggle, or is named here with a reason", () => {
    const offenders: string[] = [];
    for (const rel of everySourceFile()) {
      const source = readRepo(rel);
      const c = code(source);
      const queues = /\benqueueOutbox\s*\(/.test(c) || /\bapproveDraft\s*\(/.test(c);
      if (!queues) continue;
      if (QUEUE_WITHOUT_TOGGLE[rel]) continue;
      if (!readsAToggle(source)) offenders.push(rel);
    }
    expect(
      offenders,
      `these queue a message to a patient and never consult the kill switch: ${offenders.join(", ")}. ` +
        `Add the guard to the file, or name it in QUEUE_WITHOUT_TOGGLE with the reason it is safe.`,
    ).toEqual([]);
  });

  it("the fill path in particular reads it, because three callers used to and one did not", () => {
    const fill = readRepo("src/lib/noshow/fill.ts");
    expect(fill).toContain("isSystemEnabledForSend");
    expect(fill).toContain('"no-show-defence"');
    // FAIL DIRECTION: the send-path variant, i.e. fail-open only under dry-run.
    expect(code(fill)).not.toContain("isSystemEnabled(");
  });

  it("the exemption list has not rotted into a list of files that no longer queue", () => {
    const stale = Object.keys(QUEUE_WITHOUT_TOGGLE).filter((rel) => {
      const c = code(readRepo(rel));
      return !/\benqueueOutbox\s*\(/.test(c) && !/\bapproveDraft\s*\(/.test(c);
    });
    expect(stale, `named as exempt but no longer queue anything: ${stale.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. NO STUB SENDERS. The historic double-send class, closed structurally.
// ---------------------------------------------------------------------------

describe("no module can mark a message sent without sending it", () => {
  /**
   * SIX DEAD FUNCTIONS, ALL THE SAME SHAPE. calendar, coordinator, noshow,
   * reactivation, recall and reviews each carried a `markTouchSent` left over
   * from the pre-drain "stub adapter": it set the touch to 'sent', set the outbox
   * to 'sent' with provider 'stub', and wrote no to_address.
   *
   * Nothing called them any more — the sweeps had already been fixed, and two of
   * them say so in a comment. But a dead function that does the wrong thing is a
   * loaded gun in a drawer, and this one has been picked up before: a row marked
   * 'sent' is invisible to the drain (which lists only 'queued'), so the message
   * is never dispatched; the patient's record then SHOWS it as sent; and reply
   * correlation, which matches on to_address, can never match it again.
   * Coordinator's copy was additionally pointed at the wrong table.
   *
   * They are gone. This keeps them gone, and catches any new one by its shape
   * rather than its name.
   */
  it("no source file writes a 'stub' provider", () => {
    const offenders = everySourceFile().filter((rel) => /provider:\s*["']stub["']/.test(code(readRepo(rel))));
    expect(
      offenders,
      `these mark a message delivered by a provider that does not exist: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("markTouchSent is gone from every repository", () => {
    const offenders = everySourceFile().filter((rel) => /\bmarkTouchSent\b/.test(code(readRepo(rel))));
    expect(
      offenders,
      `the stub-sender is back in: ${offenders.join(", ")}. The drain records a send; nothing else may.`,
    ).toEqual([]);
  });

  it("the drain's recordSent is still the only thing that stamps an address", () => {
    // to_address is what inbound reply correlation matches on, so a path that
    // stamps 'sent' without one silently orphans every reply to that message.
    const drain = readRepo("src/app/api/messaging/drain/route.ts");
    expect(drain).toContain("toAddress: to");
  });
});

// ---------------------------------------------------------------------------
// 6. Default-OFF is TWO mechanisms, and the second one is easy to forget.
// ---------------------------------------------------------------------------

describe("a default-off system is off twice", () => {
  const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

  function seededDisabledSlugs(): Set<string> {
    const found = new Set<string>();
    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      for (const m of sql.matchAll(
        /insert\s+into\s+system_toggle[\s\S]{0,200}?values\s*\(\s*'[^']*'\s*,\s*'([a-z-]+)'\s*,\s*false/gi,
      )) {
        found.add(m[1]);
      }
    }
    return found;
  }

  it("declares defaultEnabled:false in the catalog AND seeds a disabled row", () => {
    // The catalog inversion covers every client and every database, including one
    // where the migration never ran. The seeded row covers the live pilot even if
    // somebody later deletes the catalog flag. Neither alone is enough, which is
    // exactly why the second is the one that gets forgotten.
    const seeded = seededDisabledSlugs();
    const unseeded = [...DEFAULT_OFF_SLUGS].filter((slug) => !seeded.has(slug));
    expect(
      unseeded,
      `default-off in the catalog but with no disabled row in any migration: ${unseeded.join(", ")}`,
    ).toEqual([]);
  });

  it("every agent whose runbook says its switch ships OFF really is default-off", () => {
    for (const agent of AGENTS) {
      if (!agent.slug) continue;
      const claimsOff = /NOTHING IS SENT|ships OFF/i.test(agent.firstTick);
      if (!claimsOff) continue;
      expect(DEFAULT_OFF_SLUGS.has(agent.slug), `${agent.key} claims it ships off`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The shared first-contact primitive, and the gates on every door into it.
// ---------------------------------------------------------------------------

/** Files that call `contactLead`, excluding the module that defines it. */
function contactLeadCallers(): string[] {
  return everySourceFile().filter(
    (rel) => rel !== "src/lib/speed-to-lead/contact.ts" && /\bcontactLead\s*\(/.test(code(readRepo(rel))),
  );
}

/** How the roster's prose counts, so a derived count can be compared to it. */
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

describe("contactLead is gated by every one of its callers", () => {
  /**
   * contactLead is the most-reused send primitive in the platform and it reads no
   * toggle itself. That is a deliberate choice — the smile-assessment path needs
   * BOTH its own switch and speed-to-lead's, which an internal single-slug guard
   * could not express — but it means the guarantee lives in the callers, and a
   * guarantee that lives in six places is one edit from living in five.
   */
  it("every file that calls it reads a system toggle", () => {
    const callers = contactLeadCallers();
    expect(callers.length, "the crawl found no callers at all; it has gone stale").toBeGreaterThan(2);
    const ungated = callers.filter((rel) => !readsAToggle(readRepo(rel)));
    expect(
      ungated,
      `these first-contact a lead without consulting the kill switch: ${ungated.join(", ")}`,
    ).toEqual([]);
  });

  /*
   * THE CRAWL ABOVE CANNOT SEE A FAIL DIRECTION, WHICH IS HALF THE RULE.
   * `readsAToggle` accepts the literal `isSystemEnabled(` as readily as
   * `isSystemEnabledForSend(`, so it proves a switch was consulted and says
   * nothing about what happens when the switch cannot be READ. The lenient form
   * resolves a toggle-table error to the slug's CATALOG DEFAULT, and
   * `speed-to-lead` is default-ON — so a blip on system_toggle answered
   * "enabled" for a system the owner had switched off, at a door whose next line
   * texts a real patient with no outbox and no drain to re-gate it.
   *
   * The fail-direction law (W1-B/1-5, and the reason the sweeps moved) makes
   * uncertainty count as OFF. The staff worklist's Resend was the last human
   * door still on the lenient read; this crawl is what stops a seventh door
   * being written the old way and looking green.
   */
  it("every caller of contactLead reads the FOR-SEND form of the switch", () => {
    const callers = contactLeadCallers();
    const lenient = callers.filter((rel) => !code(readRepo(rel)).includes("isSystemEnabledForSend("));
    expect(
      lenient,
      `these reach contactLead behind a switch read that fails OPEN: ${lenient.join(", ")}`,
    ).toEqual([]);
    // Floor: the assertion above is empty for the right reason, not because the
    // crawl found nothing to look at.
    expect(callers.length, "the caller crawl went stale").toBeGreaterThan(2);
  });

  it("the roster's speed-to-lead gap sentence names as many callers as the crawl finds", () => {
    // WHY THE PROSE IS DERIVED. This sentence said "all four callers" while six
    // files called it — the co-pilot's nudge_lead, the missed-call bridge and the
    // smile-assessment submit path had all arrived since. It is printed on the
    // owner's control panel and returned by the co-pilot's agent_status, so it is
    // a claim the practice reads, and nothing checked it. Now the number in the
    // sentence is recomputed from the same crawl the sentence is about.
    const count = contactLeadCallers().length;
    const word = COUNT_WORDS[count] ?? String(count);
    const gap = AGENTS.find((a) => a.key === "speed-to-lead")?.gaps.join(" ") ?? "";
    expect(
      gap,
      `the roster says something other than "all ${word} callers", but the crawl finds ${count}`,
    ).toContain(`all ${word} callers gate it`);
  });

  it("the smile-assessment path needs BOTH switches, not either", () => {
    const submit = code(readRepo("src/app/api/smile-assessment/submit/route.ts"));
    expect(submit).toContain('"smile-assessment"');
    expect(submit).toContain('"speed-to-lead"');
  });
});

// ---------------------------------------------------------------------------
// 8. The runbook is part of the deliverable, so it is part of the test.
// ---------------------------------------------------------------------------

describe("the switch-on runbook covers every agent", () => {
  const RUNBOOK = "docs/runbooks/agent-switch-on.md";

  it("exists", () => {
    expect(existsSync(join(REPO_ROOT, RUNBOOK)), `${RUNBOOK} is missing`).toBe(true);
  });

  it("has a section for every agent in the roster", () => {
    const md = readRepo(RUNBOOK);
    const missing = AGENTS.filter((a) => !md.includes(`\`${a.key}\``)).map((a) => a.key);
    expect(missing, `agents with no section in the runbook: ${missing.join(", ")}`).toEqual([]);
  });

  it("says how to stop each one, using the slug the owner will actually see", () => {
    const md = readRepo(RUNBOOK);
    const missing = AGENTS.filter((a) => a.slug !== null && !md.includes(a.slug)).map((a) => a.key);
    expect(missing, `agents whose switch is never named in the runbook: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries every agent's known gaps forward rather than quietly dropping them", () => {
    const md = readRepo(RUNBOOK);
    const undocumented = AGENTS.filter((a) => a.gaps.length > 0 && !md.includes(a.label)).map((a) => a.key);
    expect(undocumented, `agents with gaps but no mention in the runbook: ${undocumented.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. THE OWNER-FACING HALF OF THE ROSTER.
//
// Everything above this line checks the roster against the SOURCE TREE. This
// section checks it against the SCREEN, which is a different claim and was the
// one nothing held.
//
// `firstTick` stopped being documentation on 3 Sep 2026, when W2-B wired the
// control panel to it: src/lib/systems/vocabulary.ts reads `starts` off this
// field BY IDENTITY for every rostered slug, /api/systems serialises it, and
// systems-view.tsx prints it verbatim under every switched-OFF row — which is
// every row an owner is looking at while deciding to switch something on. It is
// also `whatSwitchingItOnStarts` in the co-pilot's agent_status tool, and
// `verify` is that tool's `howToSeeItWorking`, so a wrong sentence here is one
// the assistant repeats on request.
//
// The wave-3 review found three ways that goes wrong, and each has a test below:
// a sentence written in the deployment's environment-variable names (a value the
// owner cannot see and has not been given a name for), a sentence that promises
// a message the composer does not compose, and a sentence that sends a person to
// a screen that does not render the thing.
// ---------------------------------------------------------------------------

/**
 * SCREAMING_SNAKE_CASE — an identifier, not a word. Global on purpose so a
 * failure can list every hit; only ever used with String.match, which resets
 * lastIndex, so it is safe to share.
 */
const ENV_NAME = /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g;

describe("the switch-on sentence an owner reads is written for an owner", () => {
  /**
   * The three fields an owner is given as ANSWERS. Extended from `firstTick`
   * alone on 5 September 2026 — see the note inside the test below.
   */
  const ANSWER_FIELDS: ReadonlyArray<readonly [string, (a: AgentDef) => string]> = [
    ["firstTick", (a) => a.firstTick],
    ["bound", (a) => a.bound],
    ["stop", (a) => a.stop],
  ];

  it("never names an environment variable", () => {
    // WHY THESE THREE FIELDS AND NOT EVERY FIELD. `needs` is the field where env
    // names belong, and vocabulary.ts:50-55 says so in as many words: it becomes
    // "Needs first" a paragraph below, and "the person reading this row is the
    // person who arranges them". `firstTick`, `bound` and `stop` each answer a
    // different question — what will happen if I flip this, how much of it will
    // there be, how do I make it stop — and an answer given in the names of
    // values the owner cannot read is not an answer.
    //
    // `firstTick` alone was scanned when this was written on 4 Sep, because
    // `firstTick` is the field the CONTROL PANEL prints (vocabulary.ts reads it
    // by identity as `starts`). That was too narrow by one door: the co-pilot's
    // agent_status hands `bound` back as `whatBoundsIt` and `stop` as
    // `howToStopIt` (both in src/lib/copilot/tools.ts, agent_status's describe
    // block), to an owner-and-agency tool whose description invites exactly the
    // question "what limits the no-show agent?". Four `bound` sentences and one
    // `stop` were still written
    // in deployment identifiers on 5 Sep, and three of the four carried no
    // figure at all — so the owner was handed an identifier INSTEAD of an
    // answer, three lines below a comment stating the rule as "the number, not
    // its variable name".
    //
    // `gaps` is deliberately NOT here. Its env names are prerequisites of the
    // same class as `needs` — "booking into real Dentally still needs
    // DENTALLY_DEFAULT_PAYMENT_PLAN_ID" is addressed to whoever arranges it, and
    // blanket-sweeping it would delete a true warning rather than rewrite a bad
    // answer. That field's own problem (it also carries internal code constants)
    // is a separate one and is not solved by this regex.
    //
    // The panel-side sweep in src/lib/systems/os-copy-sweep.test.ts cannot cover
    // any of this: it is fed SYSTEM_VOCABULARY.starts + catalog.halts +
    // FIRST_STEPS, and neither `bound` nor `stop` reaches a screen at all. This
    // test is their only guard.
    const offenders = AGENTS.flatMap((a) =>
      ANSWER_FIELDS.map(([field, read]) => ({ key: a.key, field, hits: read(a).match(ENV_NAME) ?? [] })),
    )
      .filter((r) => r.hits.length > 0)
      .map((r) => `${r.key}.${r.field}: ${[...new Set(r.hits)].join(", ")}`);
    expect(
      offenders,
      `these print an environment-variable name to the practice owner — on the control panel, or ` +
        `read back by the co-pilot's agent_status: ${offenders.join("; ")}. Put the NUMBER in the ` +
        `sentence and leave the name in needs (or in a comment, when it is not a prerequisite).`,
    ).toEqual([]);
  });

  it("and the crawl reaches all three answer fields, not just the one it started on", () => {
    // Floor for the "nothing matched" assertion above (ruling W3/17), aimed at
    // the specific way it rotted once: scanning one field and reporting clean.
    expect(ANSWER_FIELDS.map(([field]) => field)).toEqual(["firstTick", "bound", "stop"]);
    for (const [field, read] of ANSWER_FIELDS) {
      const planted = AGENTS.map((a) => ({ ...a, [field]: `${read(a)} Set NOSHOW_MAX_SENDS_PER_RUN.` }));
      const caught = planted.flatMap((a) =>
        ANSWER_FIELDS.flatMap(([, r]) => r(a as unknown as AgentDef).match(ENV_NAME) ?? []),
      );
      expect(caught, `an env name planted in ${field} is invisible to the crawl`).toContain(
        "NOSHOW_MAX_SENDS_PER_RUN",
      );
    }
  });

  it("and the crawl can still see one where an env name is allowed", () => {
    // The guard above is a "nothing matched" assertion, which is exactly the
    // shape that rots into always-true (ruling W3/17). This is its floor: the
    // same regex, run over the field that deliberately DOES carry env names.
    const recall = AGENT_BY_KEY.get("recall");
    expect(recall, "the roster lost its recall entry").toBeTruthy();
    expect(recall!.needs.join(" ").match(ENV_NAME) ?? []).toContain("RECALL_DAILY_CONTACT_LIMIT");
  });

  it("still says something an owner can act on, rather than going quiet", () => {
    // Deleting the offending clause would also pass the test above. Every
    // sentence has to keep answering the question, and the three the review
    // rewrote have to keep naming the volume they used to name as a variable.
    for (const key of ["recall", "no-show-defence", "reviews"]) {
      const agent = AGENT_BY_KEY.get(key);
      expect(agent, `${key} is missing from the roster`).toBeTruthy();
      expect(agent!.firstTick.length, `${key}.firstTick`).toBeGreaterThan(60);
      expect(/\d/.test(agent!.firstTick), `${key}.firstTick states no figure at all`).toBe(true);
    }
  });

  it("and `bound` answers the volume question with a figure, not a shrug", () => {
    // The same floor for the second field, and the reason it needed rewriting
    // rather than trimming: three of the four offenders — booking-agent,
    // treatment-closer, balance-reminders — named an identifier and NO number,
    // so an owner asking the co-pilot "what limits this?" was given a word he
    // cannot look up in place of the answer. Deleting the identifier would have
    // left an empty sentence and a green test.
    const figures: Record<string, readonly string[]> = {
      "speed-to-lead": ["three"],
      "booking-agent": ["20"],
      "whatsapp-agent": ["20"],
      "no-show-defence": ["25", "ten minutes"],
      "treatment-closer": ["500", "25", "24 hours"],
      "balance-reminders": ["300", "40", "10", "24 hours"],
    };
    for (const [key, expected] of Object.entries(figures)) {
      const agent = AGENT_BY_KEY.get(key);
      expect(agent, `${key} is missing from the roster`).toBeTruthy();
      for (const fragment of expected) {
        expect(agent!.bound, `${key}.bound no longer states ${fragment}`).toContain(fragment);
      }
    }
  });

  it("and `stop` still names the switch it told the owner to reach for", () => {
    // reviews.stop offered two ways to stop the agent and wrote the second one
    // as REVIEW_LINK_URL. The clause is true and stays; only the identifier
    // went. This pins both halves so the rewrite cannot quietly become "switch
    // off 'reviews'" and lose a real answer.
    const reviews = AGENT_BY_KEY.get("reviews");
    expect(reviews, "reviews is missing from the roster").toBeTruthy();
    expect(reviews!.stop).toContain("'reviews'");
    expect(reviews!.stop.toLowerCase()).toContain("review link");
  });
});

describe("the pre-visit sentence describes the message the module composes", () => {
  /**
   * RULING W3/9 (4 Sep 2026): "copy matches code, never the reverse". The
   * sentence used to say the questionnaire link went out "alongside the
   * medical-history link the practice already sends". src/lib/triage/copy.ts
   * decided the opposite and wrote down why — two links do not fit in one SMS
   * credit — so the invite is its own text and the medical-history hand-off
   * moved onto the completion screen. An owner reading the old sentence budgeted
   * one text per patient and would have been sent two.
   *
   * This is the behavioural half the string pin was missing: the claim is
   * checked against the message the composer actually returns.
   */
  it("the composed invite carries exactly one link, and the sentence says so", () => {
    const agent = AGENT_BY_KEY.get("pre-visit-triage");
    expect(agent, "pre-visit-triage is missing from the roster").toBeTruthy();

    const body = previsitBody({
      firstName: "Amara",
      practiceName: "Vitality Dental",
      link: "https://vitality.example/pv/aaaaaaaaaaaaaaaaaaaaaa",
    });
    const links = body.match(/https?:\/\/\S+/g) ?? [];
    expect(links, `the invite the module composes: ${body}`).toHaveLength(1);

    // And the composer has no way to acquire a second one: the medical-history
    // link builder is not reachable from the message at all.
    expect(code(readRepo("src/lib/triage/copy.ts"))).not.toContain("buildMedicalHistoryLink");

    // Given ONE link in the body, the sentence may not describe a message that
    // travels with another.
    const ridesAlong = /\b(alongside|along with|together with)\b/i.test(agent!.firstTick);
    expect(
      ridesAlong,
      `the control panel says the pre-visit link travels with another link; the message carries ` +
        `one: ${agent!.firstTick}`,
    ).toBe(false);
    expect(
      /separate from the medical-history/i.test(agent!.firstTick),
      `ruling W3/9 requires the sentence to say the link is separate from the medical-history ` +
        `link: ${agent!.firstTick}`,
    ).toBe(true);
  });
});

describe("a verify step names a surface that renders the thing", () => {
  it("the pre-visit summary is verified on the record, which is where it is drawn", () => {
    // The sentence said a completed form "appears as a pre-visit summary on the
    // appointment". No appointment-level surface reads it: the diary's
    // appointment panel has no triage import, and `previsitSummaryFor` has two
    // non-test callers — the patient record's Appointments tab and the co-pilot
    // tool. A clinician sent to the appointment would have found nothing and
    // treated the patient without reading what they wrote, which is the failure
    // the summary exists to prevent (charter §2 W1-C).
    const agent = AGENT_BY_KEY.get("pre-visit-triage");
    expect(agent, "pre-visit-triage is missing from the roster").toBeTruthy();

    // Named by the heading the panel actually prints, so a renamed panel is a
    // red test rather than a stale instruction.
    expect(agent!.verify).toContain(SUMMARY_COPY.heading);

    const readers = everySourceFile().filter((rel) =>
      /previsitSummaryFor\s*\(/.test(code(readRepo(rel))),
    );
    expect(readers.length, "nothing reads the pre-visit summary; this crawl has gone stale").toBeGreaterThan(1);
    expect(readers).toContain("src/components/client/patients/record/record-tab-content.tsx");

    const appointmentSurfaces = readers.filter((rel) => /\/(calendar|diary)\//.test(rel));
    expect(
      appointmentSurfaces,
      `a diary surface now reads the summary; the verify step may name it: ${appointmentSurfaces.join(", ")}`,
    ).toEqual([]);
    expect(
      /\bon the appointment\b/i.test(agent!.verify),
      `verify sends a clinician to the appointment, where nothing renders it: ${agent!.verify}`,
    ).toBe(false);
  });
});

describe("no sentence an owner reads is addressed to the team that built it", () => {
  /**
   * WAVE-3B HANDOFFS H36/H44 (5 Sep 2026). The pre-visit entry carried, in
   * `gaps`, "Owned by lane W1-C; this roster entry and its runbook section are a
   * snapshot of the code and should be confirmed by that lane before go-live."
   *
   * That is a note from one build lane to another, and eight of this Record's
   * fields are not notes: src/lib/systems/vocabulary.ts reads `firstTick` and
   * `needs` by identity onto the control panel, and the co-pilot's agent_status
   * hands `label`, `slugNote`, `firstTick`, `bound`, `needs`, `verify`, `stop`
   * and `gaps` straight back to whoever asked (src/lib/copilot/tools.ts:3280-97,
   * `knownGaps`). So a practice owner asking "is anything wrong with the
   * pre-visit questions?" was told his platform had an internal lane code as a
   * known gap — an answer he can neither act on nor understand, about work that
   * was in fact finished (W1-C is FINAL in the decisions log). The runbook half
   * of the same hedge was deleted by the runbook lane and its absence pinned
   * (runbook.test.ts, "the pre-visit section is finished work"); this is the
   * other half, and this is what stops a third one being written.
   *
   * TWO CLASSES ARE FORBIDDEN, and the second was added on 5 September 2026.
   *
   * PROVISIONAL OWNERSHIP: a sentence that names a build lane as the thing
   * responsible, or says the entry is a draft somebody else has still to confirm.
   * True only inside the programme, and false to the person reading it.
   *
   * INTERNAL RULING CODES: "Ruling W1-B/4, 3 Sep 2026". Three sentences on the
   * abandoned-booking rescue carried one, and they were argued for at the time as
   * traceability rather than a hedge — a reader can look the decision up. The
   * owner cannot: the decisions log is a programme document he has never seen, so
   * in an agent_status answer about his own platform the code is an unresolvable
   * reference that makes a settled fact read like an unfinished note. The
   * citations were not deleted, they MOVED — src/lib/agent-wiring/roster.ts
   * carries them in a comment above that entry, which is where a build decision
   * belongs. Owner copy states the decision itself.
   */
  /**
   * A programme ruling code as this repository writes them: W1-B/4, W3/9, W2-C/2.
   * Matched anywhere in a sentence, because the offence is the owner meeting the
   * code at all, not where in the line it sits.
   */
  const RULING_CODE = /\bW\d(?:-[A-E])?\/\d+\b/;

  const HANDOVER_NOTE: readonly RegExp[] = [
    /\bowned by\b/i,
    /\blanes?\s+W\d/i,
    /\bthis lane\b/i,
    /\bconfirmed by that lane\b/i,
    /\bsnapshot of the code\b/i,
  ];

  /** Every field of an agent that reaches a person outside this repository. */
  function ownerFacingSentences(): Array<{ key: string; field: string; text: string }> {
    return AGENTS.flatMap((a) => [
      { key: a.key, field: "label", text: a.label },
      { key: a.key, field: "slugNote", text: a.slugNote ?? "" },
      { key: a.key, field: "firstTick", text: a.firstTick },
      { key: a.key, field: "bound", text: a.bound },
      { key: a.key, field: "verify", text: a.verify },
      { key: a.key, field: "stop", text: a.stop },
      { key: a.key, field: "recordNote", text: a.recordNote ?? "" },
      ...a.needs.map((text) => ({ key: a.key, field: "needs", text })),
      ...a.gaps.map((text) => ({ key: a.key, field: "gaps", text })),
    ]);
  }

  it("names no build lane as the owner of anything, on the panel or in the co-pilot", () => {
    const offenders = ownerFacingSentences()
      .filter(({ text }) => HANDOVER_NOTE.some((re) => re.test(text)))
      .map(({ key, field, text }) => `${key}.${field}: "${text}"`);
    expect(
      offenders,
      `these are printed on the owner's control panel or returned by agent_status as ` +
        `knownGaps/needsFirst, and they are addressed to a build lane: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("and the crawl would still catch the sentence it was written for (W3/17)", () => {
    // Floor for the "nothing matched" assertion above, which is otherwise the
    // exact shape that rots into always-true. The control is the deleted string,
    // byte for byte, plus proof the crawl reaches every field rather than one.
    const deleted =
      "Owned by lane W1-C; this roster entry and its runbook section are a snapshot of the " +
      "code and should be confirmed by that lane before go-live.";
    expect(HANDOVER_NOTE.some((re) => re.test(deleted))).toBe(true);

    const sentences = ownerFacingSentences().filter((s) => s.text.length > 0);
    expect(sentences.length, "the owner-facing crawl found almost nothing").toBeGreaterThan(120);
    expect(new Set(sentences.map((s) => s.field)).size, "the crawl reads only some fields").toBe(9);

  });

  it("cites no internal ruling code in anything the owner is shown", () => {
    // The second forbidden class. Every code the programme uses, in the shapes
    // this file has actually written them: "W1-B/4", "ruling W3/9", "W2-C/2".
    const offenders = ownerFacingSentences()
      .filter(({ text }) => RULING_CODE.test(text))
      .map(({ key, field, text }) => `${key}.${field}: "${text}"`);
    expect(
      offenders,
      `an owner reading these on the control panel, or hearing them back from the co-pilot, ` +
        `cannot resolve a programme ruling code: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("and that crawl would still catch the three sentences it was written for", () => {
    // Floor for the assertion above, in the same shape as the one for handover
    // notes: the deleted fragments, byte for byte, so "nothing matched" cannot
    // quietly become "the pattern stopped matching".
    for (const deleted of [
      "'online-booking' (the flow it invites the patient back into). Ruling W1-B/4, 3 Sep 2026 — an owner…",
      "because the host sweep now uses the shared ten-row gate (ruling W1-B/5) — drafting stops",
      "Its basis is narrow ON PURPOSE (ruling W1-B/4): one transactional follow-up",
    ]) {
      expect(RULING_CODE.test(deleted), deleted).toBe(true);
    }
    // And it does not fire on ordinary copy, which is what makes the empty
    // result above meaningful rather than an accident of a lenient pattern.
    expect(RULING_CODE.test("At most 25 holds converted per tick.")).toBe(false);
    expect(RULING_CODE.test("Switch off 'speed-to-lead'.")).toBe(false);
  });

  /**
   * THE THIRD FORBIDDEN CLASS, added 5 September 2026 alongside the env-name
   * widening in section 9.
   *
   * `gaps` is not scanned by the env-name rule, and deliberately: the identifiers
   * an owner meets there are mostly things somebody has to GO AND ARRANGE — "still
   * needs DENTALLY_DEFAULT_PAYMENT_PLAN_ID" is the same class of sentence as
   * `needs`, and blanket-sweeping the field would delete a true warning rather
   * than rewrite a bad answer.
   *
   * What does not belong is the OTHER kind of identifier the field had collected:
   * a constant in our own source, named to a practice owner with no way to look it
   * up. Two of them were there — `POSTOP_NEVER_PRIMES` (a boolean in
   * src/lib/agent/reply-context.ts) and `MISSING_FROM_MIGRATIONS` (a table in the
   * test fake, cited as "see … in the fake") — and both are now stated in words,
   * with the constant's name moved into a comment beside the entry.
   *
   * So the rule is an allow-list, not a pattern: every SCREAMING_SNAKE identifier
   * that survives in `gaps` must be a named, cited configuration value the
   * practice or its deployer actually sets. A new one goes red until it is
   * justified here or rewritten, which is the fail-closed direction.
   */
  const CONFIGURATION_NAMES_ALLOWED_IN_GAPS: Record<string, string> = {
    // src/lib/dentally/patient-payload.ts — real Dentally rejects a patient
    // create without a payment plan id; the owner supplies it (charter §3).
    DENTALLY_DEFAULT_PAYMENT_PLAN_ID: "booking-agent",
    // src/lib/collection/draft.ts — must stay unset until pounds-vs-pence is
    // reconciled against a real invoice (charter §3, money semantics).
    COLLECTION_QUOTE_AMOUNT: "balance-reminders",
    // src/lib/triage/copy.ts completion screen — off by default, and switching
    // pre-visit questions on does not switch it on.
    MEDICAL_HISTORY_ENABLED: "pre-visit-triage",
  };

  it("names no internal code constant in the gaps the co-pilot reads back", () => {
    const offenders = AGENTS.flatMap((a) =>
      a.gaps.flatMap((text) =>
        [...new Set(text.match(ENV_NAME) ?? [])]
          .filter((name) => CONFIGURATION_NAMES_ALLOWED_IN_GAPS[name] !== a.key)
          .map((name) => `${a.key}.gaps: ${name}`),
      ),
    );
    expect(
      offenders,
      `agent_status returns these to a practice owner as knownGaps, and they are identifiers from ` +
        `our own source rather than something he sets: ${offenders.join("; ")}. State the fact in ` +
        `words and put the constant's name in a comment, or add it to ` +
        `CONFIGURATION_NAMES_ALLOWED_IN_GAPS with a citation.`,
    ).toEqual([]);
  });

  /**
   * THE FOURTH FORBIDDEN CLASS, added 6 September 2026.
   *
   * The three rules above all key on an IDENTIFIER — a lane code, a ruling code,
   * a SCREAMING_SNAKE constant — and a sentence carrying none of them walks
   * straight through all three. `rota-notify`'s only gap did: "The only toggle
   * read in the tree that happens INSIDE a loop (per client), which is the
   * pattern every other sweep should eventually follow." No identifier, so it was
   * clean by every crawl in this file, and it was still a note to a build lane —
   * the register gives it away, not any name in it. A practice owner asking the
   * co-pilot what he should know before switching staff rota texts on was told
   * something about the shape of our loops, in a phrase ("the only ... in the
   * tree") that reads as a defect report about the safest of the three patterns.
   *
   * So this rule is about the REGISTER rather than the vocabulary: our source
   * described as "the tree", work somebody means to do later ("should
   * eventually", "for now", "to be done"), and a claim about a code pattern being
   * followed. All three are true only to a reader who has the repository open,
   * and `gaps`/`needs`/`firstTick` reach a reader who does not.
   *
   * The fix is always the same one this file has used twice before: the
   * observation moves into a comment beside the entry, and the fact underneath it
   * — if there is one the owner can use — is restated in his terms.
   */
  const BUILD_REGISTER: readonly RegExp[] = [
    /\bin the tree\b/i,
    /\bthe (?:code)?base\b/i,
    /\bcodebase\b/i,
    /\bshould eventually\b/i,
    /\bfor now\b/i,
    /\bthe pattern (?:every|that|which|all|the)\b/i,
    /\brefactor/i,
    /\bTODO\b/,
  ];

  it("describes no agent to the owner in the register of the people who built it", () => {
    const offenders = ownerFacingSentences()
      .filter(({ text }) => BUILD_REGISTER.some((re) => re.test(text)))
      .map(({ key, field, text }) => `${key}.${field}: "${text}"`);
    expect(
      offenders,
      `the co-pilot reads these back to a practice as knownGaps/needsFirst and the control panel ` +
        `prints them, and they are written about our repository rather than about his platform: ` +
        `${offenders.join("; ")}. Put the observation in a comment beside the entry and state the ` +
        `fact underneath it in the owner's terms.`,
    ).toEqual([]);
  });

  it("and that crawl would still catch the sentence it was written for (W3/17)", () => {
    // Floor for the assertion above, in the shape the other two floors take: the
    // deleted sentence, byte for byte, so "nothing matched" cannot quietly become
    // "the pattern stopped matching". Two clauses of it offend independently,
    // which is the point — one narrow pattern would not have been enough.
    const deleted =
      "The only toggle read in the tree that happens INSIDE a loop (per client), which is the pattern " +
      "every other sweep should eventually follow.";
    expect(BUILD_REGISTER.filter((re) => re.test(deleted)).length, deleted).toBeGreaterThanOrEqual(2);
    // And it leaves ordinary owner copy alone, including the true sentence that
    // replaced it — otherwise the empty result above is a lenient pattern rather
    // than a clean roster.
    const replacement = AGENT_BY_KEY.get("rota-notify")!.gaps.join(" ");
    expect(replacement, "rota-notify's gap no longer says what a mid-run switch-off costs").toContain(
      "does not stop that run",
    );
    for (const ordinary of [
      replacement,
      "Switch off 'speed-to-lead'. Intake is rejected and nothing is auto-contacted.",
      "At most 25 holds converted per tick.",
    ]) {
      expect(
        BUILD_REGISTER.filter((re) => re.test(ordinary)).map(String),
        `this is ordinary owner copy: ${ordinary}`,
      ).toEqual([]);
    }
  });

  it("and that allow-list is exact, not a wildcard (W3/17)", () => {
    // Floor for the assertion above. The two deleted fragments, byte for byte,
    // so "nothing matched" cannot quietly become "the pattern stopped matching";
    // and the allow-list is keyed to ONE agent each, so the same name appearing
    // on a different agent is still caught.
    for (const deleted of [
      "Post-op check-ins deliberately never prime the agent (POSTOP_NEVER_PRIMES).",
      "invisible from the repo (see MISSING_FROM_MIGRATIONS in the fake).",
    ]) {
      expect(deleted.match(ENV_NAME) ?? [], deleted).not.toEqual([]);
    }
    for (const [name, key] of Object.entries(CONFIGURATION_NAMES_ALLOWED_IN_GAPS)) {
      const agent = AGENT_BY_KEY.get(key);
      expect(agent, `${name} is allowed for ${key}, which is not in the roster`).toBeTruthy();
      expect(
        agent!.gaps.some((g) => g.includes(name)),
        `${name} is allowed for ${key} and ${key} no longer says it — delete the exemption`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Sanity: the roster is not silently empty.
// ---------------------------------------------------------------------------

/**
 * THE CHARTER'S OWN LIST, by key, in the charter's own order (§2 W1-B, "for
 * EVERY agent in the roster (smile-assessment, speed-to-lead, ...)").
 *
 * It is a named constant rather than an inline literal because the floor below
 * is derived from it: "the roster holds at least everything the charter names"
 * is a claim that stays true as the charter's list is read again, where a hand-
 * typed number is only ever true on the day it is typed. The roster is longer
 * than this — `pre-visit-triage`, `outreach` and `diary-notify` were rostered
 * after the charter was written — so the floor is a floor and not an equality.
 */
const CHARTER_AGENT_KEYS: readonly string[] = [
  "smile-assessment",
  "speed-to-lead",
  "missed-call-bridge",
  "abandoned-booking-rescue",
  "booking-agent",
  "whatsapp-agent",
  "online-booking",
  "recall",
  "reactivation",
  "no-show-defence",
  "treatment-coordinator",
  "treatment-closer",
  "balance-reminders",
  "postop-checkin",
  "booking-reply-context",
  "anomaly-alerts",
  "reviews",
  "rota-notify",
];

describe("the roster is real", () => {
  it("covers every agent the programme charter lists", () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(CHARTER_AGENT_KEYS.length);
    for (const key of CHARTER_AGENT_KEYS) {
      expect(AGENT_BY_KEY.has(key), `the charter names ${key} and the roster does not`).toBe(true);
    }
  });

  it("states no fixed agent count in its header or its test names", () => {
    /*
     * A COUNT IN PROSE IS THE THING THAT GOES STALE. roster.ts's header said the
     * list held sixteen while it held twenty-one, and the title of the test above
     * said the same, so a reader auditing charter §2 W1-B against the roster read
     * "sixteen" in the roster's own voice, saw the charter's eighteen, and could
     * only conclude that agents were MISSING when three extra ones were present —
     * with a green test appearing to confirm the figure. Nothing else could catch
     * it: the floor above is `>=`, so growth never reddens it, and the number
     * lived in a comment and a test title, which no assertion reads.
     *
     * THE RUNBOOK ALREADY HAS THIS RULE for the same reason and in the same words
     * (runbook.test.ts, "does not restate a total number of agents in the opening
     * line"); this is the roster half of it, over the two places the stale figure
     * actually sat. `AGENTS.length` and the membership check above are the honest
     * answers, and neither can rot.
     *
     * THE SHAPE, NOT EVERY NUMERAL. A number attached to a claim about the size
     * of this list is banned; numbers doing other work in prose are not, because
     * a rule that bans digits from a comment is a rule authors route around.
     */
    const claimsATotal =
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-\w+)?|\d+)\b[ \t]*(?:of them|of these|agents?|entries|rows|in one list|in this list|in the list)\b/i;

    const rosterSource = readRepo("src/lib/agent-wiring/roster.ts");
    const header = rosterSource.slice(0, rosterSource.indexOf("/** How the message"));
    expect(header.length, "roster.ts's header block was not found").toBeGreaterThan(500);
    expect(
      header.match(claimsATotal)?.[0] ?? null,
      "roster.ts's header states a fixed number of agents; the list outgrows it",
    ).toBeNull();

    const self = readRepo("src/lib/agent-wiring/roster.test.ts");
    const titles = [...self.matchAll(/^\s*(?:it|describe)\(\s*"([^"\n]+)"/gm)].map((m) => m[1]);
    expect(titles.length, "no test titles were read; the pin has gone stale").toBeGreaterThan(40);
    const stale = titles.filter((title) => claimsATotal.test(title));
    expect(stale, `test names stating a fixed agent count: ${stale.join(" | ")}`).toEqual([]);
  });

  it("keeps the in-memory database OUT of the application", () => {
    // src/lib/test-support/fake-supabase.ts reads supabase/migrations/ off the
    // filesystem. That is fine in a test run and would be a defect in a rendered
    // page: a server component importing it would read the disk on every request,
    // and a client one would not build at all. It lives under src/, so nothing but
    // this stops it drifting into the app the way any other helper could.
    const importers = everySourceFile().filter(
      (rel) =>
        rel !== "src/lib/test-support/fake-supabase.ts" &&
        /from\s+["'][^"']*test-support\/fake-supabase["']/.test(code(readRepo(rel))),
    );
    expect(
      importers,
      `these import the test-only in-memory database: ${importers.join(", ")}`,
    ).toEqual([]);
  });

  it("walks a src/ that is really there", () => {
    const files = everySourceFile();
    expect(files.length, "the source crawl found nothing").toBeGreaterThan(400);
    expect(existsSync(srcPath("lib/agent-wiring/roster.ts"))).toBe(true);
  });
});
