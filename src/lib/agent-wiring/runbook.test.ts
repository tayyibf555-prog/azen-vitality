// ===========================================================================
// THE SWITCH-ON RUNBOOK IS A DELIVERABLE, SO ITS FACTS ARE TESTED.
//
// roster.test.ts §8 already pins the runbook's SHAPE — a section per agent, the
// slug the owner will see, every known gap carried forward. What it cannot pin is
// whether a sentence is TRUE, and that is the class of defect this file exists
// for: the runbook told the go-live reader that `app-sweep-outreach` and
// `app-sweep-anomaly` were "NOT applied" while both had been firing in production
// for months (6,949 and 336 successful runs), and said nothing at all about the
// two pre-visit jobs, which really do not exist. The one gate the document
// presented as closed was open, and the one that was open was not mentioned.
//
// ---------------------------------------------------------------------------
// REGISTRATION TRUTH IS DATA, AND IT LIVES NEXT DOOR (ruling W3/7).
// ---------------------------------------------------------------------------
// `SCHEDULER`, imported below from src/lib/agent-wiring/scheduler.ts (it was
// declared in this file until handoff H109 moved it somewhere the application
// can read it too), is what `cron.job` actually held on 4 September 2026, read
// with a read-only
//
//     select jobname, schedule, active from cron.job order by jobname;
//
// against the production project, cross-checked against `cron.job_run_details`
// so that "registered" means "has run", not "has a row". Vitest cannot reach
// Postgres — no test in this tree makes a network call — so the check is: the
// runbook's §2 table and this constant say the same thing, row for row, in both
// directions. Registering a job later is then a two-line edit that cannot be done
// by halves, and the runbook can never again invert a go-live fact quietly.
//
// If you are here because a row disagrees: the SCHEDULER constant is not the
// authority, the scheduler is. Re-read cron.job, update BOTH, and date the note.
// ===========================================================================

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { AGENTS } from "./roster";
// REGISTRATION TRUTH IS A MODULE NOW, NOT A CONSTANT IN THIS FILE (wave-3b
// handoff H109, 5 Sep 2026). `SCHEDULER` and `OPS_FILE` were declared below the
// imports here, which made the one fact about what the scheduler holds readable
// only by a test: the control panel needs the same fact to warn that a
// switched-ON system has no job behind it, cannot import a test file, and so
// carried a second hand-typed list inside a client component. They moved to
// src/lib/agent-wiring/scheduler.ts — an ordinary module, no React, no disk.
// Nothing below changed with them: this file still pins §2 of the runbook
// against them row for row, in both directions, and the header note above still
// describes where the values came from.
import { OPS_FILE, SCHEDULER, slugsWithNoScheduledJob } from "./scheduler";
import type { JobStatus, SchedulerJob } from "./scheduler";
import { SITES } from "@/lib/mock/clients";
import { DEFAULT_OFF_SLUGS } from "@/lib/systems/catalog";
import {
  MINING_DAYS_PER_RUN,
  MINING_HORIZON_DAYS,
  MINING_MAX_PAGES_PER_WINDOW,
  MINING_MAX_PATIENT_READS_PER_RUN,
} from "@/lib/triage/mining";
import { SRC_ROOT, srcPath, walkSrc } from "@/lib/test-support/walk-src";

const REPO_ROOT = join(SRC_ROOT, "..");
const RUNBOOK = "docs/runbooks/agent-switch-on.md";

const md = readFileSync(join(REPO_ROOT, RUNBOOK), "utf8");
/** The document with every run of whitespace flattened, for phrase matching that
 *  must not care where the author wrapped a line. */
const flat = md.replace(/\s+/g, " ");

const NUMBER_WORD = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve",
];

/** The slice of §0 between two of its numbered items. */
function slice(from: string, to: string): string {
  const a = md.indexOf(from);
  const b = md.indexOf(to, a + 1);
  expect(a, `runbook no longer contains: ${from}`).toBeGreaterThan(-1);
  expect(b, `runbook no longer contains: ${to}`).toBeGreaterThan(a);
  return md.slice(a, b);
}

/** One agent's section, from its heading to the next one. */
function sectionFor(key: string): string {
  const heading = md.indexOf(`\`${key}\`\n`);
  expect(heading, `no runbook section for ${key}`).toBeGreaterThan(-1);
  const start = md.lastIndexOf("### ", heading);
  const next = md.indexOf("\n### ", heading);
  return md.slice(start, next === -1 ? md.length : next);
}

// ---------------------------------------------------------------------------
// 1. §2 states what the scheduler holds.
// ---------------------------------------------------------------------------

describe("the cron table is registration truth", () => {
  /** Every `| \`app-…\` | … |` row of §2, parsed. */
  function tableRows(): Record<string, SchedulerJob> {
    const section = slice("## 2. Cron registration", "## 3. The agents");
    const rows: Record<string, SchedulerJob> = {};
    for (const line of section.split("\n")) {
      const m = /^\|\s*`(app-[a-z0-9-]+)`\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$/.exec(line);
      if (!m) continue;
      const cell = (s: string) => s.trim().replace(/^`|`$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
      rows[m[1]] = {
        schedule: cell(m[2]),
        route: cell(m[3]),
        status: cell(m[4]) as JobStatus,
      };
    }
    return rows;
  }

  it("lists exactly the jobs the scheduler was read to hold, and no others", () => {
    const listed = Object.keys(tableRows()).sort();
    expect(listed).toEqual(Object.keys(SCHEDULER).sort());
  });

  it("gives each job the schedule, route and status the scheduler actually has", () => {
    // The defect this catches in the direction it actually failed: a job that is
    // live and firing described as "NOT applied", which reads to the person doing
    // go-live as a second gate that does not exist.
    expect(tableRows()).toEqual(SCHEDULER);
  });

  it("never tells the reader to register a job that is already registered", () => {
    for (const [job, file] of Object.entries(OPS_FILE)) {
      if (SCHEDULER[job].status === "not registered") continue;
      expect(
        flat.includes(`Register the cron (\`${file}\``),
        `${job} is registered and firing, but the runbook still asks for ${file} to be run`,
      ).toBe(false);
    }
  });

  it("carries the registration SQL for every job that has no ops file (W3/7)", () => {
    for (const [job, def] of Object.entries(SCHEDULER)) {
      if (def.status !== "not registered") continue;
      const file = OPS_FILE[job];
      if (file) {
        expect(existsSync(join(REPO_ROOT, file)), `${job}: ${file} is missing`).toBe(true);
        continue;
      }
      // No file anywhere in the tree, so the runbook is the only place the
      // practice can get this SQL. Without it the module is unreachable in
      // production and nothing on screen says why.
      expect(flat, `${job} has no ops file and no SQL in the runbook`).toContain(
        `cron.schedule( '${job}', '${def.schedule}', $$select public.trigger_app_cron('${def.route}')$$ );`,
      );
    }
  });

  it("says in §0 how many sweeps have no job at all, and names the two that surprise people", () => {
    const item = slice("3. **The cron job that triggers it.**", "**What a switch actually stops.**");
    const missing = Object.values(SCHEDULER).filter((j) => j.status === "not registered").length;
    expect(item.toLowerCase(), `§0 item 3 no longer says ${NUMBER_WORD[missing]} sweeps are unregistered`).toContain(
      `${NUMBER_WORD[missing]} sweeps have no job`,
    );
    expect(item).toContain("`outreach`");
    expect(item).toContain("`anomaly-alerts`");
  });
});

// ---------------------------------------------------------------------------
// 2. §0 names every system that ships off, in both directions.
// ---------------------------------------------------------------------------

describe("the default-off list in §0 is complete", () => {
  const item = slice("2. **The agent's own switch**", "3. **The cron job that triggers it.**");
  const twiceOver = item.slice(0, item.indexOf("Four more"));

  it("names every rostered agent that ships off twice over", () => {
    // roster.test.ts checks the other direction only (an agent the runbook CLAIMS
    // is default-off really is), which is why four systems could go unnamed.
    const offAgents = AGENTS.filter((a) => a.slug !== null && DEFAULT_OFF_SLUGS.has(a.slug));
    expect(offAgents.length, "no default-off agents found; the crawl has gone stale").toBeGreaterThan(3);
    const unnamed = offAgents.filter((a) => !twiceOver.includes(`\`${a.slug}\``)).map((a) => a.key);
    expect(unnamed, `default-off agents §0 does not warn about: ${unnamed.join(", ")}`).toEqual([]);
    expect(twiceOver.toLowerCase()).toContain(`**${NUMBER_WORD[offAgents.length]}** of the agents`);
  });

  it("names the default-off systems that have no agent section to remind you", () => {
    const unnamed = [...DEFAULT_OFF_SLUGS].filter((slug) => !item.includes(`\`${slug}\``));
    expect(unnamed, `default-off systems missing from §0 entirely: ${unnamed.join(", ")}`).toEqual([]);
  });

  it("sends the reader to the panel that exists", () => {
    // "Settings → Systems" is not a surface: the switches live behind the
    // top-level System controls item (src/lib/nav.ts slug "controls").
    expect(item).toContain("System controls");
    expect(flat).not.toContain("Settings → Systems");
  });

  it("does not restate a total number of agents in the opening line", () => {
    // A count in prose is the thing that goes stale — the intro said "twenty"
    // while the roster held twenty-one. §3 has a section per agent and
    // roster.test.ts pins that, so the number adds nothing but a way to be wrong.
    const intro = md.slice(0, md.indexOf("## 0."));
    expect(intro).not.toMatch(/\b(sixteen|seventeen|eighteen|nineteen|twenty|twenty-one|\d+)\b[^.]*automated agents/i);
  });
});

// ---------------------------------------------------------------------------
// 3. The pre-visit section says what the code does (W3/9), and says it finally.
// ---------------------------------------------------------------------------

describe("the pre-visit section is finished work", () => {
  const section = sectionFor("pre-visit-triage");

  it("carries no unresolved hand-off to another lane", () => {
    // A go-live document that tells its reader it may be wrong and that somebody
    // else should check it has no reader left to check it: the lane is closed.
    expect(section).not.toMatch(/owned by (a different|another) workstream/i);
    expect(section).not.toMatch(/should be confirmed by that lane/i);
    expect(md).not.toMatch(/owned by lane W1-/i);
  });

  it("describes the invite as its own message, not one riding on the medical-history link (W3/9)", () => {
    // src/lib/triage/copy.ts is the contract: two links cannot fit in one SMS
    // credit, so the medical-history handover moved to the completion screen.
    expect(section).not.toMatch(/alongside the medical-history link/i);
    expect(section).toContain("its own text");
  });

  it("points at the surface the summary actually renders on", () => {
    // It is on the patient's record (Appointments tab), not on the appointment:
    // src/components/client/patients/record/record-tab-content.tsx.
    expect(section).toContain("pre-visit summary on the patient's record");
    expect(section).not.toMatch(/summary on the appointment/i);
  });

  it("says plainly that the switch alone sends nothing while the sweep has no cron", () => {
    const flatSection = section.replace(/\s+/g, " ");
    expect(SCHEDULER["app-sweep-previsit"].status).toBe("not registered");
    expect(flatSection).toContain("`/api/previsit/sweep` **has no cron job**");
    expect(flatSection.toLowerCase()).toContain("sends nothing at all");
  });
});

// ---------------------------------------------------------------------------
// 4. No runbook tells the practice a migration is pending when it is applied.
// ---------------------------------------------------------------------------

describe("the runbooks do not hold back an applied migration", () => {
  /**
   * Applied in production, from the programme's own migration log and confirmed
   * for 0096 by a read-only `select to_regclass('public.dentally_write_intent')`
   * on 4 September 2026 (the table exists; 0 rows). The failure this pins is the
   * one docs/runbooks/booking-live-calibration.md actually had: "migration 0096
   * is written and NOT applied — until a human applies it the ledger records
   * nothing", which tells the person doing go-live that the write ledger is
   * inert when in fact it is recording.
   */
  const APPLIED = ["0094", "0095", "0096", "0097", "0098", "0099", "0100"];
  const RUNBOOKS = ["agent-switch-on.md", "booking-live-calibration.md", "correspondence-visibility.md"];

  it("never describes one of them as unapplied", () => {
    for (const file of RUNBOOKS) {
      const text = readFileSync(join(REPO_ROOT, "docs/runbooks", file), "utf8").replace(/\s+/g, " ");
      for (const number of APPLIED) {
        for (let at = text.indexOf(number); at !== -1; at = text.indexOf(number, at + 1)) {
          const around = text.slice(Math.max(0, at - 160), at + 160);
          expect(
            /not applied|unapplied|never applied|awaiting application/i.test(around),
            `${file} says migration ${number} is not applied: "${around.trim()}"`,
          ).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. THE ROSTER STATES REGISTRATION TRUTH TOO, BECAUSE IT IS WHAT THE SCREEN READS.
//
// Ruling W3/7 binds two surfaces: "the runbook AND the systems view". Everything
// above this line checks the runbook — a document a person opens deliberately.
// The systems view is the one an owner is looking at with his hand on the switch,
// and it does not read the markdown: src/lib/systems/vocabulary.ts takes
// `needsFirst` off `AgentDef.needs` BY IDENTITY, /api/systems serialises it, and
// systems-view.tsx prints "Needs first: …" under every switched-OFF row. The
// co-pilot's agent_status hands the same two arrays over as `needsFirst` and
// `knownGaps`.
//
// So the first fix round corrected §2's table and left the roster saying
// `app-sweep-outreach` and `app-sweep-anomaly` were "NOT applied" — on the two
// rows an owner is most likely to be flipping, in the direction that reads as a
// second gate that does not exist. Nothing joined the two files: roster.test.ts
// treats `needs` as the field where infrastructure names are ALLOWED and never
// looks at what they claim, and vocabulary.test.ts pins that the copy propagates
// faithfully, which is a different claim from its being true.
//
// This is that join. SCHEDULER above is the only registration truth in the tree;
// these three tests make the roster answer to it.
// ---------------------------------------------------------------------------

describe("the roster's owner-facing prerequisites agree with the scheduler", () => {
  /** Talk about whether a job exists at the scheduler, in any of the shapes the
   *  roster has used: "NOT applied", "unregistered", "a cron registration for …",
   *  "the app-sweep-x cron REGISTERED (…)". Deliberately loose: the assertion it
   *  guards is about the jobs a sentence NAMES, so a false positive costs nothing
   *  and a missed shape costs the whole test. */
  const REGISTRATION_TALK = /registered|registration|not applied|no cron|cron\b/i;

  /** Every job a sentence points at, by job name, ops file or route. */
  function jobsNamedIn(sentence: string): string[] {
    return Object.entries(SCHEDULER)
      .filter(([job, def]) => {
        if (sentence.includes(job)) return true;
        const file = OPS_FILE[job];
        if (file && sentence.includes(file)) return true;
        return def.route.startsWith("/api/") && sentence.includes(def.route);
      })
      .map(([job]) => job);
  }

  /** `needs` and `gaps` together: both reach the owner (the panel prints the
   *  first, the co-pilot's agent_status returns both), so both have to be true. */
  const ownerFacing = AGENTS.flatMap((a) =>
    [...a.needs, ...a.gaps].map((sentence) => ({ key: a.key, sentence })),
  );

  it("never tells the owner a job is missing when the scheduler is firing it", () => {
    // The defect in the direction it actually failed: outreach and anomaly-alerts
    // carried "the app-sweep-… cron REGISTERED (… — NOT applied)" in `needs` while
    // both jobs had been running for months. An owner reading that flips the
    // switch to look at the screen, believing a SQL file stands between him and
    // the first message. For outreach it does not: the next tick is ten minutes
    // away and it drafts to every target of every built campaign.
    const lying = ownerFacing
      .filter(({ sentence }) => REGISTRATION_TALK.test(sentence))
      .flatMap(({ key, sentence }) =>
        jobsNamedIn(sentence)
          .filter((job) => SCHEDULER[job].status !== "not registered")
          .map((job) => `${key}: ${job} is ${SCHEDULER[job].status} — "${sentence}"`),
      );
    expect(
      lying,
      `these print a missing-cron prerequisite for a job that exists, on the owner's ` +
        `control panel and in the co-pilot's answer: ${lying.join("; ")}`,
    ).toEqual([]);
  });

  it("and the join still sees the three sweeps that really have no job (W3/17)", () => {
    // Floor for the "nothing matched" assertion above. If jobsNamedIn stopped
    // resolving anything — a renamed field, a reworded sentence, a regex that no
    // longer matches — the test above would pass by seeing nothing at all. These
    // three are the genuine article and must keep saying so.
    for (const [key, job] of [
      ["treatment-closer", "app-sweep-closer"],
      ["balance-reminders", "app-sweep-collection"],
      ["postop-checkin", "app-sweep-postop"],
    ] as const) {
      const agent = AGENTS.find((a) => a.key === key);
      expect(agent, `${key} is missing from the roster`).toBeTruthy();
      expect(SCHEDULER[job].status).toBe("not registered");
      const named = [...agent!.needs, ...agent!.gaps].filter(
        (s) => REGISTRATION_TALK.test(s) && jobsNamedIn(s).includes(job),
      );
      expect(named.length, `${key} no longer warns that ${job} is unregistered`).toBeGreaterThan(0);
    }
  });

  it("says nothing at all about a cron on the two rows that were wrong", () => {
    // Named regression, so the failure message points at the row rather than at a
    // crawl. Both jobs are live; neither agent needs anything arranged before its
    // first tick; an empty `needs` prints no "Needs first" line at all, which is
    // what the runbook's own "Needs first. Nothing." now says for both.
    for (const key of ["outreach", "anomaly-alerts"]) {
      const agent = AGENTS.find((a) => a.key === key);
      expect(agent, `${key} is missing from the roster`).toBeTruthy();
      expect(agent!.needs, `${key} needs nothing arranged: both its jobs are live`).toEqual([]);
      const cronTalk = agent!.gaps.filter((s) => /cron|registered|not applied/i.test(s));
      expect(cronTalk, `${key} still describes its cron in a gap: ${cronTalk.join("; ")}`).toEqual([]);
    }
  });

  it("tells the owner what the ONE unregistered switch actually costs him (H45)", () => {
    // THE OTHER FAIL DIRECTION, and the one still live. Three of the five jobless
    // sweeps only ever draft for a person to approve, and one of those three is
    // switched off anyway; `pre-visit-triage` is the flagship of wave 1 and its
    // switch is on the panel today. Its prerequisite read "a cron registration
    // for /api/previsit/sweep" — an item on a setup list, indistinguishable in
    // tone from "PUBLIC_BASE_URL" directly beneath it. What it means is that
    // flipping the switch does nothing at all: no invite, no queue row, no
    // error, and nothing anywhere on the screen afterwards to say so (the panel
    // stops printing "Needs first" the moment a row goes ON — which is why
    // src/components/client/systems/systems-view.tsx has a second sentence for
    // exactly these slugs). §2 of the runbook already says it in those words:
    // "Needs first — and this one is a hard stop."
    //
    // The join runs both ways. Register the job and this test goes red until the
    // clause is deleted, because the SCHEDULER row changes with it.
    const agent = AGENTS.find((a) => a.key === "pre-visit-triage");
    expect(agent, "pre-visit-triage is missing from the roster").toBeTruthy();
    expect(SCHEDULER["app-sweep-previsit"].status).toBe("not registered");

    const sentence = agent!.needs.find((s) => s.includes(SCHEDULER["app-sweep-previsit"].route));
    expect(sentence, "the pre-visit prerequisite no longer names its sweep at all").toBeTruthy();
    expect(
      /sends nothing|nothing (?:is )?(?:sent|happens)/i.test(sentence!),
      `it names the task and not the consequence, which is the only warning an owner gets ` +
        `that the flagship module is unreachable: "${sentence}"`,
    ).toBe(true);
    // Silently is the whole point: there is no error to look for.
    expect(/silent/i.test(sentence!), `"${sentence}"`).toBe(true);
    // And it says where the SQL is, because the fix is not the owner's to write.
    expect(sentence).toContain("docs/runbooks/agent-switch-on.md");
  });

  it("derives the panel's cannot-run-yet slugs from the same read, not from prose (H109)", () => {
    // `slugsWithNoScheduledJob()` is the projection the control panel and Home's
    // OS band need: the switches for which "switched on" and "running" are
    // different things. It is derived — the roster's `trigger` file mapped onto
    // the scheduler's route — so registering a job shortens it without anybody
    // remembering a list. This pins the derivation itself, because a mapping that
    // silently resolved nothing would return the empty set and every screen would
    // go quiet in the fail-open direction.
    const slugs = slugsWithNoScheduledJob();
    expect(slugs).toEqual(["balance-reminders", "postop-checkin", "pre-visit-triage", "treatment-closer"]);

    // Every one of them is a rostered agent's own switch...
    const rosterSlugs = new Set(AGENTS.map((a) => a.slug).filter((s): s is string => s !== null));
    for (const slug of slugs) expect(rosterSlugs.has(slug), `${slug} is not a rostered switch`).toBe(true);

    // ...and nothing the scheduler DOES hold sneaks in. Recall has been firing
    // every ten minutes for months; a panel that warned about it would be a panel
    // nobody reads.
    expect(slugs).not.toContain("recall");
    expect(slugs).not.toContain("outreach");
    expect(slugs).not.toContain("anomaly-alerts");

    // The mining pass shares `pre-visit-triage` and has no rostered entry of its
    // own, so it contributes nothing here — correct, not lossy, and stated so a
    // reader does not "fix" it by adding a fifth slug.
    expect(SCHEDULER["app-sweep-previsit-mining"].status).toBe("not registered");
  });
});

// ---------------------------------------------------------------------------
// 6. §0 says which sweeps really stop within ten rows (W1-B/5, W2-C/1, W3/4).
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS EXISTS FOR. §0 told the owner, of sweeps in general, that "A
// sweep checks its switch before it starts and then re-reads it every ten rows
// for the rest of the run". Ruling W1-B/5 was written about five sweeps, grew to
// six (W2-C/1, speed-to-lead) and then seven (W3/4, pre-visit) — each time
// because a sweep OUTSIDE the enumeration was caught reading its switch once and
// running the batch out. The runbook had generalised the ruling to sweeps the
// ruling had never covered, and `outreach` is the one that costs something: it
// is registered, fires every ten minutes, and drafts and queues to patients.
//
// So the paragraph is now specific, and the specificity is pinned in BOTH
// directions: the table below is checked against the source (a route that adopts
// the shared gate must move buckets here) and against the prose (every switch it
// names must appear in §0). Bringing outreach into the ten-row set is therefore a
// three-line edit — route, table, paragraph — that cannot be done by halves, and
// the assertion is never the thing that gets loosened. rulings.test.ts holds the
// behavioural half ("every long-running sweep uses the shared gate"); what is
// pinned here is that the DOCUMENT tells the owner the truth about the rest.

type SwitchRead =
  /** Holds `liveSwitch()` and calls `gate.stillOn()` inside its loop (W1-B/5). */
  | "ten-row"
  /** Reads its switch once, at the top, then runs the batch out. */
  | "once"
  /** Has no outbox and no drain source: the question does not arise. */
  | "messages-nobody";

/**
 * Every sweep route in the tree, and how it reads its switch. `slug` is the
 * switch the owner sees in System controls, or null where the route has none of
 * its own; every non-null slug must be named in §0's paragraph.
 */
const SWEEP_SWITCH_READ: Record<string, { slug: string | null; read: SwitchRead }> = {
  "app/api/recall/sweep/route.ts": { slug: "recall", read: "ten-row" },
  "app/api/reactivation/sweep/route.ts": { slug: "reactivation", read: "ten-row" },
  "app/api/noshow/sweep/route.ts": { slug: "no-show-defence", read: "ten-row" },
  "app/api/coordinator/sweep/route.ts": { slug: "treatment-coordinator", read: "ten-row" },
  "app/api/reviews/sweep/route.ts": { slug: "reviews", read: "ten-row" },
  "app/api/speed-to-lead/sweep/route.ts": { slug: "speed-to-lead", read: "ten-row" },
  "app/api/previsit/sweep/route.ts": { slug: "pre-visit-triage", read: "ten-row" },
  // Moved into the ten-row set on 4 Sep 2026 by the outreach fix lane, which is
  // exactly the drift this table exists to force: it was the one single-read
  // sweep that was registered, fired every ten minutes AND drafted marketing SMS
  // to patients, so a mid-tick flip cost model spend and outbox rows. The gate is
  // now taken before the row is touched and the break carries across campaigns.
  "app/api/outreach/sweep/route.ts": { slug: "outreach", read: "ten-row" },
  "app/api/closer/sweep/route.ts": { slug: "treatment-closer", read: "once" },
  "app/api/collection/sweep/route.ts": { slug: "balance-reminders", read: "once" },
  "app/api/postop/sweep/route.ts": { slug: "postop-checkin", read: "once" },
  // Once per CLIENT rather than once per tick, which for one client is the same
  // thing; it texts staff their shifts, never patients.
  "app/api/rota/sweep/route.ts": { slug: "rota", read: "once" },
  // Writes `anomaly_alert` rows the in-app feed reads. No outbox, no drain source.
  "app/api/anomaly/sweep/route.ts": { slug: "anomaly-alerts", read: "messages-nobody" },
  // Shares `pre-visit-triage`; it grows a candidate list and messages nobody, so
  // it is not counted again beside the questionnaire sweep above.
  "app/api/previsit/mining-sweep/route.ts": { slug: null, read: "messages-nobody" },
  "app/api/landing-pages/promote-sweep/route.ts": { slug: null, read: "messages-nobody" },
};

describe("§0 tells the truth about which sweeps stop within ten rows", () => {
  const paragraph = slice(
    "**Two things about switching off that surprise people.**",
    "**And one about things going wrong.**",
  );

  it("classifies every sweep route in the tree, and no route that is gone", () => {
    // A new sweep is a red test until somebody has decided which bucket it is in
    // and told the owner — which is the failure mode that produced this file.
    const found = walkSrc({ subdir: "app/api", includeDotDirs: true })
      .filter((f) => /(^|\/)[a-z-]*sweep\/route\.ts$/.test(f))
      .sort();
    expect(found).toEqual(Object.keys(SWEEP_SWITCH_READ).sort());
  });

  it("puts a sweep in the ten-row bucket exactly when it holds the shared gate", () => {
    for (const [route, def] of Object.entries(SWEEP_SWITCH_READ)) {
      const src = readFileSync(srcPath(route), "utf8");
      const gated = src.includes("liveSwitch(") && src.includes("gate.stillOn()");
      expect(
        gated,
        gated
          ? `${route} now re-reads its switch: move it to "ten-row" here and in §0 of the runbook`
          : `${route} is listed as "ten-row" but no longer holds the shared gate`,
      ).toBe(def.read === "ten-row");
    }
  });

  it("names every sweep's switch in the paragraph, in the right list", () => {
    // The sentence that divides the two lists. Found explicitly rather than with
    // a bare indexOf: -1 would silently make the whole paragraph the "ten-row
    // list" and every assertion below would pass on prose that says the opposite.
    const dividerAt = paragraph.indexOf("The remaining sweeps read their switch once");
    expect(dividerAt, "§0's two lists no longer have a divider this test can find").toBeGreaterThan(-1);
    const tenRow = paragraph.slice(0, dividerAt);
    for (const def of Object.values(SWEEP_SWITCH_READ)) {
      if (!def.slug) continue;
      expect(paragraph, `§0 does not name \`${def.slug}\` at all`).toContain(`\`${def.slug}\``);
      const inTenRowList = tenRow.includes(`\`${def.slug}\``);
      expect(
        inTenRowList,
        `§0 puts \`${def.slug}\` in the wrong list: it is "${def.read}"`,
      ).toBe(def.read === "ten-row");
    }
  });

  it("no longer states the ten-row rule of sweeps in general", () => {
    // The exact sentence that was false. `outreach` was registered and firing
    // every ten minutes while this told the owner a mid-run flip would stop it.
    expect(flat).not.toContain(
      "A sweep checks its switch before it starts and then re-reads it every ten rows",
    );
    const onceCount = Object.values(SWEEP_SWITCH_READ).filter((d) => d.read === "once").length;
    expect(paragraph, "§0 does not say that the other sweeps run their batch out").toMatch(
      /read their switch once,\s+at the top of the tick, and then run that batch out/,
    );
    expect(onceCount, "the once-reading list changed size; re-read §0's prose").toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 7. The 48-hour queue rule names its one exception (ruling W3/5).
// ---------------------------------------------------------------------------
//
// §0 promised, without qualification, that a queued row is retired unsent only
// once it is 48 hours old and that "Switch a system off and back on the same
// afternoon and the backlog goes out". Ruling W3/5 made the pre-visit invite the
// exception and the code implements it: listQueuedOutbox retires any queued link
// whose appointment has started, however young the row is, because "Before your
// visit, a few quick questions" may never arrive after the visit. An owner
// reading §0 would expect yesterday's queue to flush and would never chase the
// patients whose links were retired.
//
// The BEHAVIOUR is pinned behaviourally, against the real function and a fake
// database, by src/lib/triage/repository.test.ts — describe "listQueuedOutbox:
// never a pre-visit link after the visit (W3/5)". What is pinned here is the
// document, plus the cross-reference itself: if that guard is ever deleted the
// runbook's claim loses its evidence, so the link is asserted rather than
// assumed. (Checked against the real file, not written from memory.)

describe("the 48-hour queue rule names the pre-visit exception (W3/5)", () => {
  const paragraph = slice(
    "- **A queued row survives 48 hours",
    "**And one about things going wrong.**",
  );

  it("does not promise the owner that every backlog flushes on switch-on", () => {
    expect(paragraph).toContain("except a pre-visit invite");
    expect(paragraph, "§0 does not say when a pre-visit invite is retired").toMatch(
      /retired the\s+moment its own appointment starts/,
    );
    expect(paragraph).toContain("W3/5");
  });

  it("repeats the exception in the pre-visit section, where its reader is", () => {
    // §4's troubleshooting table sends a reader to §0; the module's own "Stop"
    // paragraph is where somebody switching pre-visit off actually looks.
    const section = sectionFor("pre-visit-triage");
    const stop = section.slice(section.indexOf("**Stop.**"), section.indexOf("**Gaps.**"));
    expect(stop, "the pre-visit Stop paragraph does not mention the retirement").toMatch(
      /retired the moment its own appointment starts/,
    );
    expect(stop).toContain("W3/5");
  });

  it("keeps its evidence: the behavioural guard it relies on still exists", () => {
    const guard = readFileSync(join(SRC_ROOT, "lib/triage/repository.test.ts"), "utf8");
    expect(
      guard,
      "the W3/5 behavioural guard is gone; the runbook now claims behaviour nothing proves",
    ).toContain("listQueuedOutbox: never a pre-visit link after the visit (W3/5)");
  });
});

// ---------------------------------------------------------------------------
// 8. The runbook describes the control the product actually has
//    (rulings W3/8, W3/21, W3/27).
// ---------------------------------------------------------------------------
//
// W3/8: "The implant-mining sweep gets a caller: an owner-only, guarded,
// budgeted 'Build/refresh candidates' action ON THE PRE-VISIT PAGE plus the cron
// SQL in the runbook. A feature with no caller is not shipped." For one round
// only the API half had landed, so this section asserted the opposite: that the
// runbook must TELL the go-live reader no button exists, because promising a
// control the product does not have is the failure that reading gets punished
// for. W3/27 closed it the other way — the button was built
// (`MiningRunButton` in components/client/previsit/previsit-workspace.tsx) — so
// the document flips with the tree, in this one edit, and this section flips
// with it.
//
// The pin keeps its shape, which is the SCHEDULER pin's shape for a UI control
// rather than a cron row: document and tree are asserted against each other in
// BOTH directions. Deleting the button and leaving the runbook boasting about it
// is now as red as building it and leaving the runbook denying it. What the
// button DOES is not pinned here — that is behavioural and belongs to
// components/client/previsit/mining-run-button.test.ts, which renders the panel
// ("is absent from the workspace for a practice manager", "is disabled and says
// so while the module is off"). This file only holds the document to it.

describe("the runbook describes the control the product has (W3/8, W3/27)", () => {
  const ENDPOINT = "api/previsit/mining-run";

  /** Every file outside the endpoint's own folder that mentions it. */
  function callers(): string[] {
    return walkSrc()
      .filter((f) => !f.startsWith("app/api/previsit/"))
      .filter((f) => readFileSync(srcPath(f), "utf8").includes(ENDPOINT));
  }

  it("says the mining scan has an owner-reachable caller, because it has one", () => {
    expect(
      callers(),
      "nothing in the tree calls /api/previsit/mining-run any more: §2's SQL comment and " +
        "the pre-visit Gaps paragraph both describe the button, and must be corrected in " +
        "the same edit that removes it",
    ).toContain("components/client/previsit/previsit-workspace.tsx");
    expect(flat, "the runbook still tells the reader the button does not exist").not.toContain(
      "NO BUTTON on the pre-visit page",
    );
    expect(flat).toContain("THAT DOOR NOW HAS ITS BUTTON");
  });

  it("tells the reader in the pre-visit section too, not only in the SQL comment", () => {
    const section = sectionFor("pre-visit-triage");
    const gaps = section.slice(section.indexOf("**Gaps.**")).replace(/\s+/g, " ");
    expect(gaps).toContain("POST /api/previsit/mining-run");
    expect(gaps).toContain("Build / refresh candidates");
    // The two properties an owner acts on, in the paragraph they will read:
    // it is not the practice manager's (W3/8) and it is fail-closed under the
    // module's own switch (W3/21), which is why it is not on the W2-C/4 list.
    expect(gaps, "the Gaps paragraph no longer says the button is the owner's").toContain(
      "A practice manager does not see it",
    );
    expect(gaps, "the Gaps paragraph no longer says the button is fail-closed").toContain(
      "the button is disabled and says so",
    );
    expect(gaps, "the runbook still denies the button").not.toContain(
      "Nor can anyone build it by hand today",
    );
  });

  it("points at an endpoint that exists, is owner-only and is switch-gated", () => {
    // If the route is ever removed the runbook must stop naming it; if its guard
    // is loosened the sentence "owner-only" is wrong; and if the system check
    // goes, "disabled ... while 'pre-visit-triage' is off" is wrong too (W3/21).
    const route = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(route).toContain("requireOwnerRole");
    expect(route).toContain("TRIAGE_SYSTEM_SLUG");
    expect(flat).toContain("owner-only door");
  });
});

// ---------------------------------------------------------------------------
// 9. "No ops file at all" is a claim about the tree, so the tree is checked.
// ---------------------------------------------------------------------------
//
// Ruling W3/7 put the two pre-visit cron statements in the runbook BECAUSE no
// `supabase/ops/register-*.sql` carries them, and §2 says so in those words. If
// somebody later adds those files — it is on the ledger as tidiness — the
// sentence becomes false in the one section whose entire purpose is being true,
// and the reader is sent to the wrong place for the SQL. So the claim is pinned
// to the directory it describes: add the files, and this goes red until §2 and
// OPS_FILE above are updated in the same edit.

describe("the runbook's claim about the ops directory (W3/7)", () => {
  const OPS_DIR = join(REPO_ROOT, "supabase/ops");

  it("says the two pre-visit jobs have no ops file only while they have none", () => {
    const previsitFiles = readdirSync(OPS_DIR).filter((f) => f.includes("previsit"));
    expect(
      previsitFiles,
      "supabase/ops now carries pre-visit registration SQL, so §2's \"no ops file at all\" " +
        "sentence is false and OPS_FILE in this file needs the new entries",
    ).toEqual([]);
    expect(flat).toContain("The two pre-visit jobs have no ops file at all");
  });
});

// ---------------------------------------------------------------------------
// 10. What a night of implant mining COSTS, arithmetic pinned to the constants.
// ---------------------------------------------------------------------------
//
// §2's SQL is a thing the practice is asked to run against production, so the
// paragraph above it that says what it will spend is part of the instruction,
// not colour. The scan reads the appointment book a DAY at a time per site —
// that is what lets the screen say which days it has actually covered — so its
// cost is `(MINING_DAYS_PER_RUN + 1) x mapped sites` appointment requests plus
// MINING_MAX_PATIENT_READS_PER_RUN patient reads, all against the 3,600/hour
// budget shared with the live product.
//
// Those are four constants and a site list, every one of which can be tuned by
// somebody who never opens this document. So the document is derived from them
// here rather than transcribed: turn MINING_DAYS_PER_RUN down to 14 and the
// runbook's "31 days x 3 mapped sites" is a lie the next reader budgets on,
// and this goes red instead.

describe("§2 states the mining job's real cost (handoff H38)", () => {
  const sites = SITES.filter((s) => s.clientId === "vitality").length;
  const days = MINING_DAYS_PER_RUN + 1; // the window is inclusive of both ends

  it("multiplies out the day-at-a-time reads the way the code performs them", () => {
    expect(flat, "the runbook's per-run appointment-read arithmetic is stale").toContain(
      `${days} days x ${sites} mapped sites = about ${days * sites} appointment requests`,
    );
    expect(flat, "the runbook no longer states the page cap for a very busy day").toContain(
      `adds a page, up to ${MINING_MAX_PAGES_PER_WINDOW}`,
    );
  });

  it("states the patient-read ceiling and the horizon the constants hold", () => {
    expect(flat, "the runbook's patient-read ceiling is stale").toContain(
      `at most ${MINING_MAX_PATIENT_READS_PER_RUN} patient reads (MINING_MAX_PATIENT_READS_PER_RUN)`,
    );
    expect(flat, "the runbook's window-per-night is stale").toContain(
      `walks ${MINING_DAYS_PER_RUN} more days`,
    );
    // The horizon was described as two years while the constant said three; a
    // reader planning "how many nights until the list is complete" was out by a
    // third. Named with its constant so the next change has to pass through here.
    expect(flat, "the runbook's mining horizon is stale").toContain(
      `three-year horizon (MINING_HORIZON_DAYS = ${MINING_HORIZON_DAYS})`,
    );
    expect(MINING_HORIZON_DAYS, "the horizon is no longer three years").toBe(1095);
  });

  it("names background priority, because that is why the button may refuse", () => {
    expect(flat).toContain("BACKGROUND priority against the shared 3,600/hour Dentally");
  });
});
