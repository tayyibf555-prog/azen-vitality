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
// when somebody adds agent number nineteen.
// ===========================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { AGENTS, AGENT_BY_KEY, DRAIN_AGENTS, PATIENT_FACING_AGENTS } from "./roster";
import { SYSTEM_BY_SLUG, DRAIN_SOURCE_TO_SLUG, DEFAULT_OFF_SLUGS } from "@/lib/systems/catalog";
import { CORRESPONDENCE_SOURCE_NAMES } from "@/lib/inbox/repository";
import { SEND_SITES } from "@/lib/inbox/send-sites";
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

/** Every non-test file under src/, as repo-relative posix paths. */
function everySourceFile(): string[] {
  return walkSrc({ includeDotDirs: true }).map((p) => `src/${p}`);
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
// 7. The shared first-contact primitive, and its four gates.
// ---------------------------------------------------------------------------

describe("contactLead is gated by every one of its callers", () => {
  /**
   * contactLead is the most-reused send primitive in the platform and it reads no
   * toggle itself. That is a deliberate choice — the smile-assessment path needs
   * BOTH its own switch and speed-to-lead's, which an internal single-slug guard
   * could not express — but it means the guarantee lives in the callers, and a
   * guarantee that lives in four places is one edit from living in three.
   */
  it("every file that calls it reads a system toggle", () => {
    const callers = everySourceFile().filter(
      (rel) => rel !== "src/lib/speed-to-lead/contact.ts" && /\bcontactLead\s*\(/.test(code(readRepo(rel))),
    );
    expect(callers.length, "the crawl found no callers at all; it has gone stale").toBeGreaterThan(2);
    const ungated = callers.filter((rel) => !readsAToggle(readRepo(rel)));
    expect(
      ungated,
      `these first-contact a lead without consulting the kill switch: ${ungated.join(", ")}`,
    ).toEqual([]);
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
// 9. Sanity: the roster is not silently empty.
// ---------------------------------------------------------------------------

describe("the roster is real", () => {
  it("covers the sixteen agents the programme charter lists, at least", () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(16);
    for (const key of [
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
    ]) {
      expect(AGENT_BY_KEY.has(key), `the charter names ${key} and the roster does not`).toBe(true);
    }
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
