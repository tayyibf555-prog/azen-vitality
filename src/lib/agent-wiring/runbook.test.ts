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
import { DEFAULT_REVIEW_SCHEDULE } from "@/lib/reviews/schedule";
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

  // -------------------------------------------------------------------------
  // "NOTHING AT ALL" IS A CLAIM ABOUT MESSAGES, NOT ABOUT THE SWITCH.
  // -------------------------------------------------------------------------
  // §0 item 3 told the go-live reader that switching on any of the five jobless
  // sweeps "does nothing at all, with no error anywhere". For the closer, the
  // collection run and post-op that is true. For `pre-visit-triage` it stopped
  // being true when ruling W3/8 gave the mining scan its caller: the owner-only
  // "Build / refresh candidates" button is fail-closed under that very switch
  // (W3/21), so flipping it is what turns a scan over real patient history from
  // greyed-out into pressable — with no cron anywhere in the story. The same
  // switch arms the public questionnaire form (W2-C/4, STRICT). §3 of the same
  // document has said both for 650 lines, and the roster's own switch-on
  // sentence — the one the control panel prints — says "Switching it on also
  // opens the implant-candidate list on the Implants tab". §0 was the one place
  // left claiming otherwise, and §0 is the page a person reads first.
  //
  // The pin is not the sentence. The DOOR is read off the tree (owner-only,
  // switch-gated, pressed from the workspace), and then every "nothing at all"
  // in item 3 has to be qualified as a claim about drafting and sending. A
  // blanket no-effect claim goes red however it is phrased.
  it("never says a jobless sweep's switch does nothing at all while it still opens a door (W3/8, W3/21)", () => {
    const item = slice("3. **The cron job that triggers it.**", "**What a switch actually stops.**");
    const flatItem = item.replace(/\s+/g, " ");

    const slug = AGENTS.find((a) => a.key === "pre-visit-triage")?.slug;
    expect(slug, "pre-visit-triage has left the roster; this test needs rewriting").toBeTruthy();
    expect(
      slugsWithNoScheduledJob(),
      `${slug} has a scheduled job now — §0 item 3 and this test move together`,
    ).toContain(slug);

    // The door itself, from the tree rather than from prose.
    const route = readFileSync(srcPath("app/api/previsit/mining-run/route.ts"), "utf8");
    expect(route, "the mining route is no longer gated on the module's switch").toContain(
      "TRIAGE_SYSTEM_SLUG",
    );
    expect(route, "the mining route is no longer owner-only").toContain("requireOwnerRole");
    expect(
      readFileSync(srcPath("components/client/previsit/previsit-workspace.tsx"), "utf8"),
      "nothing on screen presses the mining route any more, so §0 may stop carving it out",
    ).toContain("api/previsit/mining-run");

    // So no sentence here may claim a switch has no effect at all: the claim is
    // about what reaches a patient, and it says so.
    for (const sentence of flatItem.split(/(?<=\.)\s+/)) {
      if (!sentence.includes("nothing at all")) continue;
      expect(
        /draft|send|messag|invite|text/i.test(sentence),
        `§0 item 3 makes a blanket no-effect claim — "${sentence.trim()}" — but ${slug}'s ` +
          "switch still enables the owner-only Build / refresh candidates scan over real " +
          "patient history (W3/8, W3/21)",
      ).toBe(true);
    }

    // And the exception is named where the reader is, by the slug they will flip
    // and by the control it turns on.
    expect(flatItem, `§0 item 3 never names \`${slug}\` as the exception`).toContain(`\`${slug}\``);
    expect(
      flatItem,
      "§0 item 3 does not say which door the switch still opens",
    ).toContain("Build / refresh candidates");
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
// This is that join. `SCHEDULER`, imported from ./scheduler.ts, is the tree's one
// record of what cron.job holds (ruling W3/31); these three tests make the roster
// answer to it. One derived copy survives — `SWEEPS_WITH_NO_CRON_JOB` in the
// "use client" control panel, which cannot import a server module's neighbours
// freely — and src/components/client/systems/cron-registration.test.ts holds it
// equal to `slugsWithNoScheduledJob()` in both directions, so it is a projection
// under test rather than a second opinion.
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

  // -------------------------------------------------------------------------
  // THE PASS THAT MAKES THE WORKLIST FALL (handoff B89).
  // -------------------------------------------------------------------------
  // The sweep gained a THIRD pass and the runbook described two. A go-live reader
  // planning the switch-on has to know that a delivered invite is retired once
  // its appointment starts — otherwise the module's own counters climb for ever
  // and the first person to look at them reports a leak. It is also the one pass
  // that sends nothing and reads no Dentally endpoint, which is worth saying
  // where somebody is deciding what a tick costs.
  it("describes the third pass, which retires an overtaken link", () => {
    const section = sectionFor("pre-visit-triage");
    const flatSection = section.replace(/\s+/g, " ");
    expect(flatSection, "the runbook still describes a two-pass sweep").toContain(
      "retired once its appointment has started",
    );
    expect(flatSection).toContain("`expired`");
    // The honest-number half: the response says "at least this many" rather than
    // printing a bare figure off a bounded read (charter §0/5).
    expect(flatSection).toContain("expiredMore");
    // And it cannot run before the cron does, like the rest of the sweep (W3/7).
    expect(flatSection).toContain("cannot run until the cron in §2 is registered");
  });

  it("and the pass it describes is really there, in the route the section names", () => {
    // Both directions, the SCHEDULER pin's shape: deleting pass 3 and leaving the
    // runbook describing it is as red as the reverse.
    const route = readFileSync(srcPath("app/api/previsit/sweep/route.ts"), "utf8");
    expect(route).toContain("PASS 3: retire");
    expect(route).toContain('stopTarget(target.id, "expired")');
    expect(route).toContain("expiredMore");
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

  // -------------------------------------------------------------------------
  // BOTH OF THE MODULE'S JOBS ARE NAMED WHERE THE OWNER READS (handoff H39).
  // -------------------------------------------------------------------------
  // "Needs first" is the ONLY place an owner is told a job does not exist — the
  // panel prints it off `needs` by identity, and the co-pilot returns the same
  // array as `needsFirst`. The module owns TWO unregistered sweeps and the list
  // named one, so an owner who arranged everything it asked for still had a
  // nightly scan that never ran. The consequence differs, and the sentence says
  // which: the questionnaire sweep is a hard stop, the mining sweep has a manual
  // door beside it.
  it("tells the owner about the SECOND jobless pre-visit sweep as well (H39)", () => {
    const agent = AGENTS.find((a) => a.key === "pre-visit-triage");
    expect(agent, "pre-visit-triage is missing from the roster").toBeTruthy();
    expect(SCHEDULER["app-sweep-previsit-mining"].status).toBe("not registered");

    const sentence = agent!.needs.find((s) =>
      s.includes(SCHEDULER["app-sweep-previsit-mining"].route),
    );
    expect(
      sentence,
      "the roster never mentions the mining sweep's missing cron, so the only warning an " +
        "owner gets is for the other job",
    ).toBeTruthy();
    // NOT a second hard stop: the owner-only button is the door that exists
    // (W3/8, W3/27), and a sentence that read like the questionnaire's would send
    // somebody looking for a fix they do not need.
    expect(sentence).toContain("Build / refresh candidates");
    expect(sentence).toContain("docs/runbooks/agent-switch-on.md");
    // Registering it deletes this clause AND flips the SCHEDULER row, together.
    expect(agent!.needs.filter((s) => /cron registration/i.test(s))).toHaveLength(2);
  });

  it("says on the switch-on sentence that the list is part of what turning it on opens", () => {
    // `firstTick` is what the control panel prints as "what switching it on
    // starts" (vocabulary.ts reads it by identity), and it described the invite
    // alone — so the implant list, which is fail-closed under the same switch
    // (W3/21), appeared nowhere in the answer to "what will happen if I flip
    // this". The three clauses os-copy-sweep.test.ts §5 pins are untouched: a
    // clause was added, never traded.
    const agent = AGENTS.find((a) => a.key === "pre-visit-triage");
    expect(agent!.firstTick).toContain("implant-candidate list");
    expect(agent!.firstTick, "the switch-on sentence promises the list sends something").toContain(
      "messages nobody",
    );
    expect(agent!.firstTick).toContain("its own text");
    expect(agent!.firstTick).toContain("one extra message per appointment");
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
// 9. What §2 says about the ops directory is a claim about the tree, so the
//    tree is checked.
// ---------------------------------------------------------------------------
//
// Ruling W3/7 put the two pre-visit cron statements in the runbook BECAUSE no
// `supabase/ops/register-*.sql` carried them, and §2 said so in those words —
// pinned here, so that adding the files without correcting the sentence went red.
//
// RULING W3/30 (5 September 2026) ADDED THE FILES, so this section flipped with
// them, in one edit and in the same direction: the claim is still checked against
// the directory, only the true claim has changed. §2 now names both files, both
// files exist, and both still open "NOT YET APPLIED" — which is the half that
// actually protects somebody, because these two jobs really are unregistered and
// a header saying otherwise is how an owner comes to believe a switch is the last
// gate when a cron registration still stands behind it.
//
// The runbook keeps the SQL as well as pointing at the files. That is not
// duplication for its own sake: §2 is what the person doing go-live reads, and
// `carries the registration SQL for every job that has no ops file (W3/7)` above
// takes the file-exists branch for these two now, so nothing else would hold the
// document to the statement it prints.

describe("the runbook's claim about the ops directory (W3/7, W3/30)", () => {
  const OPS_DIR = join(REPO_ROOT, "supabase/ops");
  const PREVISIT_OPS: Record<string, string> = {
    "app-sweep-previsit": "supabase/ops/register-previsit-cron.sql",
    "app-sweep-previsit-mining": "supabase/ops/register-previsit-mining-cron.sql",
  };

  it("names the two pre-visit ops files, and both are really there", () => {
    const onDisk = readdirSync(OPS_DIR).filter((f) => f.includes("previsit")).sort();
    expect(onDisk, "supabase/ops no longer carries the pre-visit registration SQL").toEqual([
      "register-previsit-cron.sql",
      "register-previsit-mining-cron.sql",
    ]);
    for (const [job, file] of Object.entries(PREVISIT_OPS)) {
      expect(OPS_FILE[job], `${job} lost its OPS_FILE entry`).toBe(file);
      expect(flat, `§2 no longer sends the reader to ${file}`).toContain(file);
    }
    // The sentence this section was written to catch. It was true until the files
    // landed; it is false now, and a lane restoring it would be sending the
    // reader to the wrong place for SQL that is on disk.
    expect(flat).not.toContain("The two pre-visit jobs have no ops file at all");
  });

  it("both files still say a step is outstanding, because both jobs are", () => {
    // FAIL DIRECTION. The whole risk of adding these files is a header copied
    // from one of the five that were corrected to APPLIED under W3/22. Neither
    // job is in cron.job, so "APPLIED" here would tell the owner the last gate is
    // the switch — and nothing would ever be sent.
    for (const [job, file] of Object.entries(PREVISIT_OPS)) {
      expect(SCHEDULER[job].status, `${job} is registered now; this pin is stale`).toBe(
        "not registered",
      );
      const sql = readFileSync(join(REPO_ROOT, file), "utf8");
      const status = /^-- STATUS:(.*)$/m.exec(sql)?.[1]?.trim() ?? null;
      expect(status, `${file} has no "-- STATUS:" header`).toBeTruthy();
      expect(
        /\bNOT\s+YET\s+APPLIED\b/i.test(status!),
        `${file}: ${job} is not in cron.job, but its header opens "${status}"`,
      ).toBe(true);
      expect(
        sql,
        `${file} schedules a minute the runbook's table does not hold`,
      ).toContain(`'${SCHEDULER[job].schedule}'`);
    }
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

// ---------------------------------------------------------------------------
// 11. §4's answer to "switched on, nothing happens, ever" is a claim about two
//     screens, so both screens are read.
// ---------------------------------------------------------------------------
//
// That row of the troubleshooting table ended "— and nothing on screen says so"
// for as long as it was true, which was the honest thing to write and the worst
// possible thing to leave standing once it stopped being true. A runbook that
// under-claims teaches the person doing go-live to distrust the product: they
// read that the platform will not tell them, so they do not look, and the
// sentence the platform now prints on the row they are staring at goes unread.
//
// BOTH SENTENCES ARE DERIVED FROM `slugsWithNoScheduledJob()` (ruling W3/31), so
// registering a job retires them together and this section keeps the document
// moving with them. The strings are compared as SOURCE rather than by importing
// the screens: one of them is a "use client" module, and this file is the
// runbook's test, not the control panel's.

describe("§4 tells the truth about what the screens now say (W3/31)", () => {
  const PANEL = "src/components/client/systems/systems-view.tsx";
  const BAND = "src/lib/home/os-band.ts";

  it("quotes the control panel's sentence, and the panel really prints it", () => {
    const panel = readFileSync(join(REPO_ROOT, PANEL), "utf8");
    expect(panel, `${PANEL} no longer warns about an unregistered sweep`).toContain(
      "Switched on, but it has not started",
    );
    expect(flat).toContain('System controls now says so on the row itself ("Switched on, but it has not started")');
  });

  /**
   * Every `systemSlug` OS_TILES carries, and the label beside it, read out of
   * the band's source. A tile is the only thing `qualifyUnscheduled` can rewrite,
   * so this set is exactly the set of systems Home is able to say the sentence
   * about — which is the fact §4 got wrong (see the test below).
   *
   * Source rather than an import on purpose: os-band.ts is `server-only` and
   * pulls six repositories at module load (os-band-note.test.ts stubs all of
   * them to touch it at all), and this file is the runbook's test, not the
   * band's. The header of §4's describe block explains the same choice.
   */
  function tileLabelsBySlug(band: string): Map<string, string> {
    const start = band.indexOf("export const OS_TILES");
    expect(start, `${BAND} no longer declares OS_TILES`).toBeGreaterThan(-1);
    const tiles = band.slice(start, band.indexOf("] as const;", start));
    const found = new Map<string, string>();
    for (const m of tiles.matchAll(/label:\s*"([^"]+)"[\s\S]*?systemSlug:\s*"([^"]+)"/g)) {
      found.set(m[2], m[1]);
    }
    expect(found.size, `${BAND}'s tiles no longer parse — the partition below would be empty`)
      .toBeGreaterThan(0);
    return found;
  }

  it("quotes Home's tile sentence, and the band really prints it", () => {
    const band = readFileSync(join(REPO_ROOT, BAND), "utf8");
    expect(band, `${BAND} no longer qualifies the tile for an unscheduled sweep`).toContain(
      '"On, but nothing runs it yet"',
    );
    expect(flat).toContain('it reads "On, but nothing runs it yet" rather than a zero');
  });

  it("does not promise a tile to the three stalled modules that have none (round-2 §4 over-claim)", () => {
    // THE DEFECT. The row used to read "Home's tile for such a module reads 'On,
    // but nothing runs it yet' rather than a zero", where "such a module" was
    // every switch in `slugsWithNoScheduledJob()`. Only ONE of the four has a
    // tile. An owner who switched the closer on, saw nothing, and followed this
    // row to Home went looking for a tile that does not exist and concluded the
    // runbook was wrong rather than that the cron was unregistered. os-band.ts's
    // own comment already said so ("treatment-closer, balance-reminders and
    // postop-checkin have no tile of their own, so this figure is the ONLY thing
    // Home says about them"); §4 was the half that had not been corrected.
    //
    // W3/31 blesses the CODE, not the generalisation: the fix is the sentence,
    // never three new tiles. So the partition is DERIVED here — add a tile, or
    // register a cron, and the counts below move and this test reddens rather
    // than letting the document drift back.
    const band = readFileSync(join(REPO_ROOT, BAND), "utf8");
    const tiles = tileLabelsBySlug(band);
    const stalled = slugsWithNoScheduledJob();
    const withTile = stalled.filter((slug) => tiles.has(slug));
    const withoutTile = stalled.filter((slug) => !tiles.has(slug));

    // Floors: the sentence only makes sense while the partition has both halves.
    expect(withTile, "no stalled system has a tile — §4's sentence describes nothing").not.toEqual([]);
    expect(withoutTile, "every stalled system has a tile now — §4 should say so plainly").not.toEqual([]);

    expect(
      flat,
      `§4 counts the stalled switches differently from slugsWithNoScheduledJob() (${stalled.join(", ")})`,
    ).toContain(`of those ${NUMBER_WORD[stalled.length]} switches only`);

    for (const slug of withTile) {
      expect(
        flat,
        `§4 does not name Home's tile for ${slug} ("${tiles.get(slug)}") as the one that carries the sentence`,
      ).toContain(`**${tiles.get(slug)}** has a tile of its own`);
    }

    expect(
      flat,
      `§4 does not say that ${withoutTile.length} stalled modules (${withoutTile.join(", ")}) have no tile`,
    ).toContain(`The other ${NUMBER_WORD[withoutTile.length]} —`);
    expect(flat, "§4 no longer says the other stalled modules have no tile at all").toContain(
      "have no tile at all",
    );

    // And the thing Home does say about them instead is the Automations cell's
    // own clause, which the band builds from the same list.
    expect(band, `${BAND} no longer subtracts the stalled switches into "not started"`).toContain(
      "not started",
    );
    expect(flat).toContain('Automations cell subtracting them into its "not started" clause');
  });

  it("both screens take the list from the scheduler, not from prose of their own", () => {
    // The half that makes the row's last clause true. A screen that hard-coded
    // the slugs would still print the sentence and would still be wrong the day
    // a job is registered — which is the failure §2's own table was written
    // about, one layer down.
    const band = readFileSync(join(REPO_ROOT, BAND), "utf8");
    expect(band).toContain("slugsWithNoScheduledJob");
    const panelTest = readFileSync(
      join(REPO_ROOT, "src/components/client/systems/cron-registration.test.ts"),
      "utf8",
    );
    expect(panelTest, "nothing holds the panel's list to the scheduler any more").toContain(
      "slugsWithNoScheduledJob",
    );
    expect(slugsWithNoScheduledJob(), "the scheduler reports every sweep as registered").toContain(
      "pre-visit-triage",
    );
  });
});

// ---------------------------------------------------------------------------
// 11. THE SENTENCES §2, §3 AND §5 SHARE WITH SOMETHING ELSE IN THE TREE.
//
// Everything above pins a runbook claim against the code it describes. This
// section pins the claims the runbook makes TWICE — once here and once in the
// roster, the charter or a test — because that is where wave 3 kept finding the
// drift: half of a sentence was corrected and the other half, in the document
// the person doing go-live actually reads with his hand on the switch, was not.
//
//  - Reviews' "Day one" described a send WINDOW the sweep does not have. The
//    roster's own comment (roster.ts, `reviews`) records this as one of TWO
//    corrections made in the wave-3 review and rewrote `firstTick` accordingly,
//    so the CONTROL PANEL printed the true sentence while this document printed
//    the falsified one.
//  - Speed-to-lead's Gaps said "all four callers" after roster.test.ts had begun
//    recomputing that word from a crawl that finds six.
//  - §5 stated the funding-jargon rule in its pre-W3/36 absolute form ("any
//    agent, any form, any message"), naming the very category — a form — the
//    ruling carved out, and sending a reader to remove labels the Dentally
//    booking payload needs.
//
// So each test below reads the OTHER half and requires this document to agree
// with it. None of them is a spelling check: break the code or the roster and
// the assertion moves with it.
// ---------------------------------------------------------------------------

/** "3pm", "10am" — the way the runbook writes an hour for an owner. */
function hour12(h: number): string {
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

describe("the runbook agrees with the other half of its own sentence", () => {
  it("gives Reviews the schedule the roster gives the control panel, not a send window (W3/9)", () => {
    const section = slice("### Reviews — `reviews`", "### Segment outreach");
    const flatSection = section.replace(/\s+/g, " ");

    // The identical sentence, taken from the field the panel prints by identity
    // (vocabulary.ts reads `firstTick` as `starts`), so the owner cannot be told
    // one thing on the screen and another in the document he is holding.
    const firstTick = AGENTS.find((a) => a.key === "reviews")?.firstTick ?? "";
    expect(firstTick, "the roster no longer has a reviews agent").not.toBe("");
    expect(
      flatSection,
      "the Reviews section no longer states the schedule the control panel states",
    ).toContain(firstTick);

    // And the hours in that sentence are the ones the code ships, so moving a
    // default reddens the document rather than silently falsifying it.
    const { delayHours, cutoffHour, morningHour } = DEFAULT_REVIEW_SCHEDULE;
    expect(flatSection).toContain(`seen before ${hour12(cutoffHour)}`);
    expect(flatSection).toContain(`${NUMBER_WORD[delayHours]} hours later the same day`);
    expect(flatSection).toContain(`at ${hour12(morningHour)} the next morning`);
  });

  it("does not promise a window the reviews sweep has no gate for", () => {
    const section = slice("### Reviews — `reviews`", "### Segment outreach");
    const ROUTE = "src/app/api/reviews/sweep/route.ts";
    const route = readFileSync(join(REPO_ROOT, ROUTE), "utf8");

    // The claim, held to the route: `reviewSendAt` decides when a request becomes
    // DUE; nothing in the sweep decides when it may SEND. If an hour gate is ever
    // added, this goes red and §3 has to be rewritten with it.
    expect(
      route,
      `${ROUTE} now gates on an hour — the runbook says it has no window`,
    ).not.toMatch(/morningHour|cutoffHour|reviewScheduleFromEnv/);
    expect(section.replace(/\s+/g, " ")).toContain("There is **no send window**");
  });

  it("counts speed-to-lead's callers the way the roster counts them, not from memory", () => {
    // roster.test.ts recomputes "all six callers gate it" from the crawl itself;
    // this holds the runbook to whatever that computation produced, so the two
    // deliverables of W1-B cannot disagree about how many doors guard the
    // platform's most-reused send primitive.
    const gap = AGENTS.find((a) => a.key === "speed-to-lead")?.gaps.join(" ") ?? "";
    const phrase = /all (\w+) callers gate it/.exec(gap);
    expect(phrase, "the roster's speed-to-lead gap no longer counts the callers").not.toBeNull();
    const section = slice("### Speed-to-lead — `speed-to-lead`", "### Missed-call text-back");
    expect(
      section.replace(/\s+/g, " "),
      `the roster says "${phrase![0]}" and the runbook says something else`,
    ).toContain(phrase![0]);
  });

  it("states the funding rule in the form ruling W3/36 left it, and names the carve-out", () => {
    // §5 is the last section of the document, so it runs to the end of the file.
    const start = md.indexOf("## 5. The cross-module rules");
    expect(start, "the runbook no longer has a cross-module rules section").toBeGreaterThan(-1);
    const flatSection = md.slice(start).replace(/\s+/g, " ");

    // The reworded rule (charter §0 item 7): it governs what the platform WRITES
    // TO a patient, not a patient choosing a service.
    expect(flatSection).toContain("Copy the platform writes to a patient never says NHS or private");
    expect(flatSection, "§5 still states the rule in the pre-ruling absolute").not.toContain(
      "in any agent, any form, any message",
    );
    expect(flatSection).toContain("W3/36");

    // The carve-out is named, and it is really there — one file, still offering
    // the two labels, still excused by a named exemption that deletes itself when
    // they go. A reader who follows this paragraph cannot end up removing them.
    const BOOKING = "src/components/book/booking-calendar.tsx";
    const SWEEP = "src/lib/systems/os-copy-sweep.test.ts";
    expect(flatSection).toContain(BOOKING);
    expect(flatSection).toContain(SWEEP);
    const booking = readFileSync(join(REPO_ROOT, BOOKING), "utf8");
    expect(booking, `${BOOKING} no longer offers the two labels the runbook excuses`).toContain(
      '["NHS", "Private"]',
    );
    expect(
      readFileSync(join(REPO_ROOT, SWEEP), "utf8"),
      `${SWEEP} no longer holds the named W3/36 exemption the runbook points at`,
    ).toContain("RULED_FUNDING_EXEMPTION");
  });

  it("cites the module that really holds the cron list, not a test that imports it (W3/31)", () => {
    // Registration truth moved to scheduler.ts and runbook.test.ts kept only the
    // import. §2 went on telling the person registering a job to "change the data
    // there" in a file that holds none — so the citation is checked by opening
    // whatever file it names and requiring every job to be in it.
    const para = slice("**Where this list comes from.**", "**An ops file's header is a claim");
    const cited = /held as data in `([^`]+)`/.exec(para.replace(/\s+/g, " "));
    expect(cited, "§2 no longer says where the cron list is held").not.toBeNull();
    const body = readFileSync(join(REPO_ROOT, cited![1]), "utf8");
    const missing = Object.keys(SCHEDULER).filter((job) => !body.includes(job));
    expect(
      missing,
      `§2 cites ${cited![1]}, which does not hold ${missing.length} of the jobs it says it holds`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. §3 KEEPS THE PROMISE §3 MAKES ABOUT ITSELF.
//
// Charter §2 W1-B is a per-agent definition of done: "slug, what switching it on
// starts, what it needs first, how to verify it's working on day one, how to
// stop it". §3's own preamble restates that shape for the reader. Nothing held
// the document to it, and one section had quietly lost a field: Treatment
// Coordinator carried Switch, Day one, Volume bound, Verify, Stop and Gaps, and
// no "Needs first" at all — while the roster declared one
// (`needs: ["COORDINATOR_AUTO_SEND_THRESHOLD"]`) and systems-view.tsx printed it
// under the switched-off row. The screen told the owner to arrange something the
// document he was reading never mentioned, which is the fail direction the
// charter forbids: the document is the half a person actually works down.
//
// roster.test.ts §8 pins the runbook's SHAPE across agents — a section each, the
// slug named, every gap carried — but nothing inside a section. This is that:
// the six fields, in every section, derived from the section list rather than a
// remembered index, so deleting a heading or adding a twenty-second agent
// without one goes red instead of shipping.
// ---------------------------------------------------------------------------

describe("§3 gives every agent the fields §3 says it gives them (charter §2 W1-B)", () => {
  /** The bold lead-in that opens each field, and the preamble's name for it.
   *  Prefixes, because several sections extend the heading itself ("**Day one —
   *  read this twice.**", "**Needs first — and this one is a hard stop.**"). */
  const FIELDS: readonly (readonly [string, string])[] = [
    ["**Switch:**", "slug"],
    ["**Day one", "what switching it on starts"],
    ["**Needs first", "what it needs first"],
    ["**Verify in the first hour", "how to verify in the first hour"],
    ["**Stop.**", "how to stop it"],
    ["**Gaps.**", "residual gaps"],
  ];

  /** §3, split at its own `###` headings. */
  function sections(): { title: string; body: string }[] {
    const from = md.indexOf("## 3. The agents");
    const to = md.indexOf("## 4. Where to look");
    expect(from, "the runbook no longer has an agents section").toBeGreaterThan(-1);
    expect(to, "the runbook no longer has a troubleshooting section").toBeGreaterThan(from);
    const lines = md.slice(from, to).split("\n");
    const out: { title: string; body: string }[] = [];
    for (const line of lines) {
      if (line.startsWith("### ")) out.push({ title: line.slice(4).trim(), body: "" });
      else if (out.length) out[out.length - 1].body += `${line}\n`;
    }
    return out;
  }

  it("still promises the six fields in its preamble", () => {
    // The contract half. If the preamble is reworded, this test is the thing
    // that says the list below has to be reworded with it — rather than the
    // list silently outliving the promise it was derived from.
    const preamble = slice("## 3. The agents", "### Smile Assessment");
    for (const [, name] of FIELDS) {
      expect(preamble.replace(/\s+/g, " "), `§3's preamble no longer promises "${name}"`).toContain(name);
    }
  });

  it("has one section per rostered agent", () => {
    // Floor for the crawl below: if the split stopped finding sections, the
    // missing-field assertion would pass by looking at nothing.
    expect(sections().length, "§3's sections no longer match the roster one for one").toBe(AGENTS.length);
  });

  it("leaves no section short of a field, on any agent", () => {
    const missing = sections().flatMap((s) =>
      FIELDS.filter(([lead]) => !s.body.includes(lead)).map(
        ([lead, name]) => `${s.title}: no "${lead}" line — the owner is never told ${name}`,
      ),
    );
    expect(missing, `sections missing a field:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("tells the Treatment Coordinator's owner about the threshold the panel asks him for", () => {
    // The named regression. `needs` is what systems-view.tsx prints under a
    // switched-OFF row and what the co-pilot's agent_status returns, so a
    // prerequisite the roster declares and the runbook omits is the two halves
    // of W1-B disagreeing in front of the person doing go-live.
    const agent = AGENTS.find((a) => a.key === "treatment-coordinator");
    expect(agent, "treatment-coordinator is missing from the roster").toBeTruthy();
    expect(agent!.needs, "the coordinator no longer declares a prerequisite").not.toEqual([]);

    const section = sections().find((s) => s.title.includes("treatment-coordinator"));
    expect(section, "the runbook no longer has a Treatment Coordinator section").toBeTruthy();
    const flatSection = section!.body.replace(/\s+/g, " ");
    for (const need of agent!.needs) {
      expect(
        flatSection,
        `the panel asks the owner for ${need} and the runbook never names it`,
      ).toContain(need);
    }
  });

  it("states the auto-send threshold the way the sweep applies it, not inverted", () => {
    // The other half of the same edit. The section read "opportunities scoring
    // above COORDINATOR_AUTO_SEND_THRESHOLD are drafted and queued; the rest
    // wait for approval" — exactly backwards, and backwards in the expensive
    // direction: it describes a platform that texts the biggest debtors
    // unattended and holds the small ones for a human.
    const ROUTE = "src/app/api/coordinator/sweep/route.ts";
    const route = readFileSync(join(REPO_ROOT, ROUTE), "utf8");
    expect(
      route,
      `${ROUTE} no longer auto-sends the ones BELOW the threshold — §3 says it does`,
    ).toContain("o.amountOutstanding < autoSendThreshold()");

    const section = sections().find((s) => s.title.includes("treatment-coordinator"));
    const flatSection = section!.body.replace(/\s+/g, " ");
    expect(flatSection, "§3 no longer says which side of the threshold sends itself").toContain(
      "**below** `COORDINATOR_AUTO_SEND_THRESHOLD`",
    );
    expect(flatSection, "§3 has gone back to the inverted sentence").not.toMatch(
      /scoring above `COORDINATOR_AUTO_SEND_THRESHOLD`/,
    );
  });
});

// ---------------------------------------------------------------------------
// 13. THE PANIC STOP IS THE ONE PARAGRAPH READ UNDER PRESSURE.
//
// It used to open "**Panic stop, no deploy needed.**" and then offer, first,
// the option that needs a deploy: set MESSAGING_DRY_RUN=true in Vercel *and
// redeploy*. Only the second option — pausing the sweeps with cron.alter_job —
// earns the promise in the heading. Four bolded words pointed at the slower of
// the two while the drain went on firing every five minutes.
//
// And the SQL is narrower than it looks. `jobname like 'app-sweep-%'` does not
// match `app-drain`, which is the job that actually sends: pausing the sweeps
// stops new drafting and leaves everything already queued to go out on the next
// tick. Neither option is an instant total stop, so the paragraph now says which
// half each one buys — and both halves are derived from the scheduler here, so
// renaming the drain job or changing its schedule reddens this rather than
// leaving an incident instruction quietly wrong.
// ---------------------------------------------------------------------------

describe("§0's panic stop is true in an incident", () => {
  const para = () => slice("**Panic stop.**", "## 1. Suggested order").replace(/\s+/g, " ");

  /** The one job in the scheduler that delivers queued rows. */
  function drainJob(): [string, SchedulerJob] {
    const found = Object.entries(SCHEDULER).find(([, def]) => def.route === "/api/messaging/drain");
    expect(found, "the scheduler no longer holds a job for /api/messaging/drain").toBeTruthy();
    return found as [string, SchedulerJob];
  }

  it("promises 'no deploy needed' only for the option that needs no deploy", () => {
    expect(para(), "the SQL is no longer the option offered as the fast one").toContain(
      "**No deploy needed — pause every sweep at once:**",
    );
    expect(flat, "the heading again promises no deploy and then names the deploy").not.toContain(
      "Panic stop, no deploy needed",
    );
    // The env option is still there, still correct, and still says what it costs.
    expect(para()).toContain("`MESSAGING_DRY_RUN=true` in Vercel, and it needs a deploy");
  });

  it("says that pausing the sweeps does not pause the job that sends", () => {
    const [job, def] = drainJob();
    const pattern = /jobname like '([^']+)'/.exec(para());
    expect(pattern, "§0's panic-stop SQL no longer filters on a jobname pattern").not.toBeNull();

    // The LIKE pattern, applied to the scheduler's own job names. If the pattern
    // is ever widened to cover the drain, the paragraph's warning becomes false
    // and this goes red — which is the direction that matters.
    const like = new RegExp(`^${pattern![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
    expect(
      like.test(job),
      `${pattern![1]} now matches ${job}, so §0's "stops the drafting, not the delivery" is wrong`,
    ).toBe(false);

    expect(def.status, `${job} is not registered — §0 says it keeps running`).toBe("registered");
    expect(def.schedule, `${job}'s schedule moved; §0 says "every five minutes"`).toBe("*/5 * * * *");
    expect(para(), `§0 no longer names ${job} as the job the SQL misses`).toContain(`\`${job}\``);
    expect(para()).toContain("every five minutes");
    expect(para(), `§0 no longer offers the second call that does pause ${job}`).toContain(
      `j.jobname = '${job}'`,
    );
  });

  it("is right that switching the systems off stops delivery too", () => {
    // The other escape §0 offers. It is only true because the drain re-reads the
    // switches every tick and skips a source whose system is off.
    const DRAIN = "src/app/api/messaging/drain/route.ts";
    const drain = readFileSync(join(REPO_ROOT, DRAIN), "utf8");
    expect(drain, `${DRAIN} no longer maps an outbox source to a system slug`).toContain(
      "DRAIN_SOURCE_TO_SLUG",
    );
    expect(drain, `${DRAIN} no longer skips a source whose system is off`).toContain(
      'skipped: "system off"',
    );
    expect(para()).toContain("refuses a source whose system is off");
  });
});
