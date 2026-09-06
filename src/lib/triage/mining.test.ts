import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { MINING_MIN_AGE, ageAt, matchExtraction, sanitiseFreeText } from "./extraction-match";
import {
  MINING_CAVEATS,
  MINING_DAYS_PER_RUN,
  MINING_HORIZON_DAYS,
  MINING_TITLE,
  coverageSentence,
  exclusionSentence,
  miningRunSentence,
  nextWindow,
  type MiningCoverage,
} from "./mining";
import { MiningPanel, PreVisitWorkspace, type MiningRow } from "@/components/client/previsit/previsit-workspace";
import { INTEREST_TREATMENTS } from "./bank";

// ===========================================================================
// THE MINING LIST. Its correctness is not "does it find every extraction" —
// nothing can, and the module says so — it is "does it state honestly what it
// covered". These tests hold that claim, on the SCREEN, not only in a constant.
// ===========================================================================

describe("matchExtraction", () => {
  it("matches the vocabulary a UK diary actually contains", () => {
    for (const text of [
      "Extraction UR6",
      "XLA LL8",
      "exo of 26",
      "Tooth out",
      "Surgical removal of wisdom tooth",
      "Third molar surgery",
      "extracted 46",
    ]) {
      expect(matchExtraction({ reason: text }), `"${text}" was not matched`).not.toBeNull();
    }
  });

  // THE DIVERGENCE FROM postop/flag.ts, STATED AS A TEST. That module vetoes
  // consult / assess / review / plan / follow-up, which is right for "should we
  // text this patient tomorrow" and wrong for "has this patient had a tooth out":
  // a record reading "Extraction review" is EVIDENCE the extraction happened.
  it("KEEPS a record whose text also mentions a review, plan or follow-up", () => {
    for (const text of [
      "Extraction review",
      "Post extraction follow up",
      "Extraction treatment plan discussion",
      "Assessment after XLA",
    ]) {
      expect(matchExtraction({ reason: text }), `"${text}" was wrongly discarded`).not.toBeNull();
    }
  });

  it("refuses text that says the extraction did NOT happen", () => {
    for (const text of [
      "Extraction cancelled",
      "XLA deferred",
      "Extraction not done, patient declined",
      "Discussed extraction, patient wants to save the tooth",
      "Root canal instead of an extraction",
    ]) {
      expect(matchExtraction({ reason: text }), `"${text}" was wrongly kept`).toBeNull();
    }
  });

  it("matches nothing in an empty or unrelated record", () => {
    expect(matchExtraction({ reason: "Routine check-up" })).toBeNull();
    expect(matchExtraction({ reason: null, treatment: null })).toBeNull();
    expect(matchExtraction({ reason: "" })).toBeNull();
  });

  it("reads the treatment field as well as the reason", () => {
    expect(matchExtraction({ reason: "Appointment", treatment: "Extraction" })).not.toBeNull();
  });
});

describe("sanitiseFreeText", () => {
  it("strips the characters that could turn stored text into structure elsewhere", () => {
    expect(sanitiseFreeText("<script>alert(1)</script> XLA")).not.toContain("<");
    expect(sanitiseFreeText("XLA {ignore} `cmd`")).not.toMatch(/[{}`]/);
  });

  it("collapses whitespace and control characters", () => {
    // The NUL is written as a SIX-CHARACTER ESCAPE, not as a literal byte: a raw
    // control character in the source tree fails src/lib/source-hygiene.test.ts,
    // and writing it as an escape also makes the assertion say out loud which
    // character is being collapsed.
    expect(sanitiseFreeText("XLA\n\n  UR6\u0000")).toBe("XLA UR6");
  });

  it("caps the length, because this is a field a human pastes into", () => {
    expect(sanitiseFreeText("x".repeat(1000)).length).toBe(160);
  });
});

describe("ageAt", () => {
  const NOW = new Date("2026-09-10T12:00:00.000Z");

  it("counts whole years, and a birthday later this year has not happened yet", () => {
    expect(ageAt("1990-09-09", NOW)).toBe(36);
    expect(ageAt("1990-09-10", NOW)).toBe(36);
    expect(ageAt("1990-09-11", NOW)).toBe(35);
  });

  // NULL IS NOT ZERO AND IT IS NOT "ADULT". The owner's rule is 18 and over, and a
  // patient whose age we do not know does not satisfy it.
  it("returns NULL for a date of birth we cannot read, never a guess", () => {
    for (const dob of [null, undefined, "", "not a date", "1990-13-40", "1990-02-31", "01/01/1990"]) {
      expect(ageAt(dob, NOW), `"${String(dob)}" produced an age`).toBeNull();
    }
  });

  it("refuses an impossible age rather than reporting it", () => {
    expect(ageAt("1700-01-01", NOW)).toBeNull(); // 326
    expect(ageAt("2030-01-01", NOW)).toBeNull(); // negative
  });

  it("the minimum age is the owner's rule, stated once", () => {
    expect(MINING_MIN_AGE).toBe(18);
  });
});

describe("nextWindow walks backwards and stops at the horizon", () => {
  const NOW = new Date("2026-09-10T12:00:00.000Z");

  it("starts with the most recent window", () => {
    expect(nextWindow(null, NOW)).toEqual({ from: "2026-08-11", to: "2026-09-10" });
  });

  it("steps back without overlapping or skipping a day, over a long walk", () => {
    // The two properties that matter are asserted over TEN consecutive windows
    // rather than spot-checked on one: an off-by-one that only bites on the third
    // step would pass a single-window assertion and silently skip a day of book
    // every month for ever.
    const DAY = 86_400_000;
    let cursor = nextWindow(null, NOW)!;
    for (let i = 0; i < 10; i += 1) {
      expect(new Date(cursor.from).getTime()).toBeLessThan(new Date(cursor.to).getTime());
      const next = nextWindow({ coveredFrom: cursor.from }, NOW);
      if (!next) break;
      // NO OVERLAP and NO GAP: the new window ends exactly one day before the old
      // one starts.
      expect(new Date(next.to).getTime()).toBe(new Date(cursor.from).getTime() - DAY);
      // ...and it really moves backwards, so the walk terminates.
      expect(new Date(next.from).getTime()).toBeLessThan(new Date(cursor.from).getTime());
      cursor = next;
    }
    // Ten windows of 30 days is most of a year behind us.
    expect(new Date(cursor.from).getTime()).toBeLessThan(NOW.getTime() - 250 * DAY);
  });

  it("STOPS at the horizon rather than walking the whole book for ever", () => {
    const atHorizon = new Date(NOW.getTime() - MINING_HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(nextWindow({ coveredFrom: atHorizon }, NOW)).toBeNull();
    expect(MINING_HORIZON_DAYS).toBe(1095);
    expect(MINING_DAYS_PER_RUN).toBe(30);
  });

  it("returns null for an unreadable coverage row rather than re-scanning everything", () => {
    expect(nextWindow({ coveredFrom: "nonsense" }, NOW)).toBeNull();
  });
});

describe("the coverage sentence: the list never wears a complete number's clothes", () => {
  function coverage(over: Partial<MiningCoverage> = {}): MiningCoverage {
    return {
      siteId: "site-cc",
      coveredFrom: "2025-09-10",
      coveredTo: "2026-09-10",
      examined: 4000,
      candidates: 212,
      excludedNoDob: 41,
      excludedUnderAge: 6,
      // The default is "the column is there and nobody was unreadable", so the
      // third clause is silent unless a test asks for it. Null — the shape of a
      // database without migration 0101 — has its own tests below.
      excludedUnreadable: 0,
      lastRunAt: "2026-09-10T02:00:00.000Z",
      moreToRead: true,
      ...over,
    };
  }

  it("ALWAYS names the window it was built from", () => {
    const sentence = coverageSentence(coverage());
    expect(sentence).toContain("10 September 2025");
    expect(sentence).toContain("10 September 2026");
  });

  it("says the list is still growing while there is book left to read", () => {
    expect(coverageSentence(coverage())).toMatch(/still reading further back/i);
    expect(coverageSentence(coverage({ moreToRead: false }))).toMatch(/as far back as this list goes/i);
  });

  it("an unbuilt list says so, and does NOT claim nobody has had an extraction", () => {
    const sentence = coverageSentence(null);
    expect(sentence).toMatch(/has not been built yet/i);
    expect(sentence).toMatch(/not a finding that no patient/i);
  });

  it("the EXCLUSIONS are printed rather than hidden", () => {
    // A list that silently dropped people is a list nobody can reconcile against
    // the practice's own numbers.
    const sentence = exclusionSentence(coverage());
    expect(sentence).toContain("41");
    expect(sentence).toContain("no date of birth");
    expect(sentence).toContain("6");
    expect(sentence).toContain("under 18");
  });

  it("says nothing about exclusions when there are none", () => {
    expect(exclusionSentence(coverage({ excludedNoDob: 0, excludedUnderAge: 0 }))).toBe("");
    // And says nothing about scope either: there is no figure to qualify.
    expect(exclusionSentence(coverage({ excludedNoDob: 0, excludedUnderAge: 0 }), { unscannedSites: 2 })).toBe("");
  });

  // THE SAME HOLE THE COVERAGE LINE WAS FIXED FOR. `mergeCoverage` sums the rows
  // the scan has TOUCHED, so on a scope where the sweep has only reached one of
  // three sites these figures are a floor over a third of the practice — printed
  // under a header naming all three. A bare figure there is the false-
  // completeness failure (charter §0/5, ruling W3/11).
  it("the exclusion COUNT never claims a scope the scan has not reached", () => {
    // (a) a stated gap is named, and counted rather than listed.
    const gap = exclusionSentence(coverage(), { unscannedSites: 2 });
    expect(gap).toContain("41");
    expect(gap).toMatch(/over the sites the scan has reached/i);
    expect(gap).toContain("2 other sites");
    expect(gap).toMatch(/have not been scanned/i);

    // (b) one missing site reads as a sentence, not as "1 other sites".
    const one = exclusionSentence(coverage(), { unscannedSites: 1 });
    expect(one).toContain("one other site");
    expect(one).toMatch(/has not been scanned/i);
    expect(one).not.toContain("1 other sites");

    // (c) a complete scope gets the plain sentence — the qualifier is a fact
    // about a gap, and printing it with no gap would be its own small lie.
    const whole = exclusionSentence(coverage(), { unscannedSites: 0 });
    expect(whole).toContain("41");
    expect(whole).not.toMatch(/over the sites the scan has reached/i);
    expect(whole).not.toMatch(/not been scanned/i);

    // (d) FAIL CLOSED. A caller that does not state the scope has not proved the
    // figures cover it, so they are qualified rather than printed bare. The
    // pre-visit view DOES state it now (it computes `unscanned` for the coverage
    // line one statement earlier, and hands the count over), so this is the
    // contract for the next caller rather than for the one that exists.
    const unstated = exclusionSentence(coverage());
    expect(unstated).toContain("41");
    expect(unstated).toMatch(/over the sites the scan has reached/i);
  });

  // -------------------------------------------------------------------------
  // THE THIRD WAY SOMEBODY IS LEFT OFF (handoff H40, migration 0101).
  // -------------------------------------------------------------------------
  // A patient the scan matched but could not look up AT ALL — Dentally answers
  // 404/410 for a merged or deleted record — is neither on the list nor under
  // "no date of birth". The sweep has counted them since wave 1; until 0101 there
  // was nowhere to persist the figure, so it was invisible on screen.
  it("names the patients it could not look up at all, once the figure exists", () => {
    const sentence = exclusionSentence(coverage({ excludedUnreadable: 3 }));
    expect(sentence).toContain("3 patients could not be looked up at all");
    expect(sentence, "the other two exclusions were dropped").toContain("41");
  });

  it("says patient, not patients, for one", () => {
    expect(exclusionSentence(coverage({ excludedUnreadable: 1 }))).toContain(
      "1 patient could not be looked up at all",
    );
  });

  it("is SILENT rather than printing a zero it cannot stand behind", () => {
    // NULL is the shape of a database where migration 0101 has not been applied:
    // the sweep counted those patients and had nowhere to put the number, so the
    // honest sentence leaves the clause out. Printing "0 patients could not be
    // looked up" over a scan that failed to read a dozen of them is a false
    // statement where silence is a true one (charter §0/5).
    const unknown = exclusionSentence(coverage({ excludedUnreadable: null }));
    expect(unknown).toContain("41");
    expect(unknown).not.toContain("looked up at all");

    const none = exclusionSentence(coverage({ excludedUnreadable: 0 }));
    expect(none).not.toContain("looked up at all");
  });

  it("does not turn an empty sentence into a full one on its own", () => {
    // The clause qualifies a list of exclusions; it never becomes the whole of it
    // by itself... except when it is the only exclusion there is, which is a real
    // state and reads correctly.
    expect(exclusionSentence(coverage({ excludedNoDob: 0, excludedUnderAge: 0, excludedUnreadable: 0 }))).toBe("");
    expect(
      exclusionSentence(coverage({ excludedNoDob: 0, excludedUnderAge: 0, excludedUnreadable: 2 })),
    ).toContain("Left off this list: up to 2 patients could not be looked up at all");
  });

  // -------------------------------------------------------------------------
  // THE UNIT. Three of these four figures are not headcounts.
  // -------------------------------------------------------------------------
  // `candidates` is distinct patients: `upsertCandidate` returns false for anybody
  // already on the register, so a second run cannot count them twice. The three
  // exclusion counters have no register — the sweep de-duplicates them only inside
  // ONE run, and every later run reads an older, disjoint window — so a patient
  // with extractions in two windows is resolved and counted in both. Printing all
  // four side by side as "N patients" is the false-completeness failure with the
  // direction reversed (charter §0/5, ruling W3/11), on the screen whose stated
  // purpose is that the list can be reconciled against the practice's own numbers.
  it("mining-exclusions-are-ceilings-not-headcounts", () => {
    const many = exclusionSentence(coverage({ excludedUnreadable: 3 }), { unscannedSites: 0 });
    expect(many).toContain("up to 41 patients have no date of birth");
    expect(many).toContain("up to 6 are under 18");
    expect(many).toContain("up to 3 patients could not be looked up at all");
    // And it says WHY, once, rather than leaving the reader to wonder what "up to"
    // is doing there.
    expect(many).toMatch(/Each run counts these again/i);
    expect(many).toMatch(/the number of people is this or fewer/i);
  });

  it("a figure of ONE is exact, and is not qualified into doubt", () => {
    // A ceiling of one over at least one occurrence is one person. "Up to 1
    // patient" would be its own small dishonesty, the same reason the scope clause
    // is dropped when there is no gap.
    const one = exclusionSentence(
      coverage({ excludedNoDob: 1, excludedUnderAge: 0, excludedUnreadable: 0 }),
      { unscannedSites: 0 },
    );
    expect(one).toContain("1 patient has no date of birth");
    expect(one).not.toContain("up to");
    expect(one, "an explanation with nothing to explain").not.toMatch(/Each run counts these again/i);
  });

  it("the ceiling clause and the SCOPE clause are different qualifications", () => {
    // One is about who was counted twice, the other about which sites were counted
    // at all. A sentence that carried only one of them would read as complete in
    // the other dimension.
    const both = exclusionSentence(coverage(), { unscannedSites: 2 });
    expect(both).toMatch(/Each run counts these again/i);
    expect(both).toMatch(/over the sites the scan has reached/i);
    expect(both).toContain("2 other sites");
  });
});

describe("the caveats are ON THE SCREEN, not in a constant nobody renders", () => {
  function render(rows: Parameters<typeof PreVisitWorkspace>[0]["mining"]): string {
    return renderToStaticMarkup(
      createElement(PreVisitWorkspace, {
        clientSlug: "vitality",
        isOwner: false,
        treatments: [...INTEREST_TREATMENTS],
        interest: [],
        interestCounts: {},
        // The switch: this suite is about the mining caveats, and it renders the
        // workspace as it looks with the system ON so the switched-off onboarding
        // line (Dental OS wave 2) never stands in for a caveat it is not.
        systemEnabled: true,
        mining: rows,
        miningTitle: MINING_TITLE,
        miningCoverage: coverageSentence({
          siteId: "site-cc",
          coveredFrom: "2025-09-10",
          coveredTo: "2026-09-10",
          examined: 0,
          candidates: 0,
          excludedNoDob: 0,
          excludedUnderAge: 0,
          excludedUnreadable: 0,
          lastRunAt: "2026-09-10T02:00:00.000Z",
          moreToRead: true,
        }),
        miningExclusions: "",
        miningCaveats: [...MINING_CAVEATS],
      }),
    );
  }

  const ROW = {
    id: "site-cc:p1",
    patientId: "p1",
    patientName: "Alex Berry",
    age: 44,
    lastExtractionAt: "2026-08-02T10:00:00.000Z",
    matchedText: "Extraction UR6",
  };

  /**
   * THE PANEL ITSELF, rendered directly.
   *
   * The Tabs primitive mounts only the ACTIVE panel, so rendering the workspace
   * reaches the interest list and never this one. An earlier version of this file
   * asserted the caveats against the CONSTANT while calling itself "on the
   * screen", and a mutation that emptied the rendered list left it green. This is
   * the fix: the assertions below run against markup.
   */
  function renderPanel(rows: MiningRow[] | null, caveats: string[] = [...MINING_CAVEATS]): string {
    return renderToStaticMarkup(
      createElement(MiningPanel, {
        title: MINING_TITLE,
        rows,
        coverage: "Built from appointments between 10 September 2025 to 10 September 2026.",
        exclusions: "Left off this list: 41 patients have no date of birth on record.",
        caveats,
      }),
    );
  }

  it("the workspace mounts only the active tab, which is why the panel is rendered directly", () => {
    expect(render([ROW])).toContain("Interest lists");
  });

  // THE ASSERTION THE BRIEF ASKED FOR: the caveats are stated ON SCREEN, beside
  // the names, not behind a tooltip and not in a help page.
  it("renders EVERY caveat above the list of names", () => {
    const markup = renderPanel([ROW]);
    for (const c of MINING_CAVEATS) {
      const rendered = c.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
      expect(markup, `a caveat is missing from the screen: ${c.slice(0, 50)}`).toContain(rendered);
    }
    // ABOVE the names, so they cannot be scrolled past.
    const lastCaveat = MINING_CAVEATS[MINING_CAVEATS.length - 1].slice(0, 40);
    expect(markup.indexOf(lastCaveat)).toBeLessThan(markup.indexOf("Alex Berry"));
  });

  it("renders the covered WINDOW and the exclusions beside the count", () => {
    const markup = renderPanel([ROW]);
    expect(markup).toContain("10 September 2025");
    expect(markup).toContain("no date of birth on record");
  });

  it("renders the caveats even when the list is EMPTY, and says nothing has been found", () => {
    // An empty list is the state a practice sees on day one, and it is exactly when
    // somebody might read the screen as "we have no implant candidates".
    const markup = renderPanel([]);
    expect(markup).toContain(MINING_CAVEATS[0].replace(/'/g, "&#x27;"));
    expect(markup).toContain("Nobody on this list yet");
  });

  it("a FAILED read says so rather than rendering an empty list", () => {
    const markup = renderPanel(null);
    expect(markup).toContain("failure to read it, not a finding that there is nobody on it");
  });

  it("every caveat is a real sentence, not a placeholder", () => {
    expect(MINING_CAVEATS.length).toBe(4);
    for (const c of MINING_CAVEATS) expect(c.length).toBeGreaterThan(60);
  });

  // THE ONE THAT MATTERS MOST. A reader who takes this for a clinical shortlist
  // will ring a patient and say something the practice cannot stand behind.
  it("the FIRST caveat refuses the clinical reading in plain words", () => {
    expect(MINING_CAVEATS[0]).toMatch(/not a clinical assessment/i);
    expect(MINING_CAVEATS[0]).toMatch(/worth a conversation/i);
  });

  it("a caveat admits the regex can miss and can over-match", () => {
    expect(MINING_CAVEATS[1]).toMatch(/will miss/i);
    expect(MINING_CAVEATS[1]).toMatch(/discussed rather than done/i);
  });

  it("a caveat says the window is a window", () => {
    expect(MINING_CAVEATS[2]).toMatch(/covers a window of time, not the whole history/i);
  });

  // BOTH EDGES, ON THE SCREEN. The caveat used to name only the older one — "it
  // does not know about anything before them" — and the older gap is the one the
  // scan CLOSES, a month of nights at a time, until it stops at the three-year
  // horizon. The gap in front of the window is the one that grows: `coveredTo`
  // is written once (src/app/api/previsit/_mining.ts passes the stored value
  // back, and recordScanRun only ever takes the maximum) and `nextWindow` only
  // ever walks backwards, so an extraction done since the first run can never
  // reach this list. A coordinator sizing a campaign off it six months later had
  // been told in writing that the only gap was history.
  it("the window caveat names the FORWARD gap too, not just the history behind it", () => {
    const caveat = MINING_CAVEATS[2];
    expect(caveat, "the caveat no longer names the older edge").toMatch(/nothing before the earlier one/i);
    expect(caveat, "the caveat does not name the edge that GROWS").toMatch(/nothing since the later one/i);
    expect(caveat).toMatch(/does not move/i);
    expect(caveat, "it does not say what a reader would act on").toMatch(
      /extraction done since then is not on this list/i,
    );
    // …and it is on the screen, above the names, not in a constant nobody reads.
    const markup = renderPanel([ROW]);
    expect(markup).toContain(caveat.replace(/'/g, "&#x27;"));
    expect(markup.indexOf(caveat.slice(0, 40))).toBeLessThan(markup.indexOf("Alex Berry"));
  });

  it("a caveat states the age exclusion rather than hiding it", () => {
    expect(MINING_CAVEATS[3]).toMatch(/left off and counted, not assumed to be an adult/i);
  });

  it("the title promises a conversation, not a shortlist", () => {
    expect(MINING_TITLE).toBe("People who might want to hear about implants");
    expect(MINING_TITLE).not.toMatch(/suitable|candidate|eligible|qualif/i);
  });
});

// ---------------------------------------------------------------------------
// WHAT ONE RUN TELLS THE OWNER (ruling W3/25, both halves).
// ---------------------------------------------------------------------------
describe("the run report says what a bare total would hide", () => {
  function report(over: Record<string, unknown> = {}) {
    return {
      budgetRefused: false,
      sites: [{ daysCovered: 3, candidates: 2, unreadable: 0, stoppedBy: "complete" }],
      ...over,
    } as Parameters<typeof miningRunSentence>[0];
  }

  it("says what was read and who was added", () => {
    expect(miningRunSentence(report())).toBe("Read 3 more days of the diary and added 2 people.");
  });

  it("says the practice's own quota stopped it, and does not pretend otherwise", () => {
    const out = miningRunSentence(report({ budgetRefused: true }));
    expect(out).toContain("daily limit");
    expect(out).toContain("nothing is lost");
    expect(out, "a refused run claimed to have added people").not.toContain("added 2 people");
  });

  it("names a site that stopped on its OWN share, which a total makes invisible", () => {
    // W3/25 splits the run's patient reads evenly so no site starves another. A
    // site that spends its share stops while its neighbours finish, and the
    // totals look exactly like a run that simply found less.
    const out = miningRunSentence(
      report({
        sites: [
          { daysCovered: 2, candidates: 1, unreadable: 0, stoppedBy: "patient-budget" },
          { daysCovered: 4, candidates: 1, unreadable: 0, stoppedBy: "complete" },
        ],
      }),
    );
    expect(out).toContain("Read up to 4 more days of the diary at each of 2 sites");
    expect(out).toContain("One site reached its share");
    expect(out).toContain("picks it up where it left off");
  });

  it("counts days PER SITE, because three sites do not make ninety days of one diary", () => {
    // THE DEFECT THIS PINS: the clause used to sum `daysCovered` across sites,
    // and `daysCovered` is one site's days — every site walks its OWN window of
    // at most MINING_DAYS_PER_RUN. Three sites moving in lockstep (the ordinary
    // case: they all start from the same empty coverage) advanced the calendar
    // thirty days and printed "Read 90 more days of the diary" on the same card
    // as `coverageSentence`, whose window had moved thirty. Two numbers, one
    // run, units differing by the number of sites — charter §0/5, ruling W3/11.
    const out = miningRunSentence(
      report({
        sites: [
          { daysCovered: 30, candidates: 5, unreadable: 0, stoppedBy: "complete" },
          { daysCovered: 30, candidates: 4, unreadable: 0, stoppedBy: "complete" },
          { daysCovered: 30, candidates: 5, unreadable: 0, stoppedBy: "complete" },
        ],
      }),
    );
    expect(out).toBe("Read 30 more days of the diary at each of 3 sites and added 14 people.");
    expect(out, "the days of three sites were added into one diary").not.toContain("90");
  });

  it("says 'up to' the moment the sites stop moving in step, and never an average", () => {
    // A site at the horizon, a site that spent its even share, a site that
    // finished its window: the largest is the only figure true of all three, so
    // it is bounded rather than summed, averaged or silently picked.
    const out = miningRunSentence(
      report({
        sites: [
          { daysCovered: 0, candidates: 0, unreadable: 0, stoppedBy: "horizon" },
          { daysCovered: 7, candidates: 1, unreadable: 0, stoppedBy: "patient-budget" },
          { daysCovered: 30, candidates: 2, unreadable: 0, stoppedBy: "complete" },
        ],
      }),
    );
    expect(out).toContain("Read up to 30 more days of the diary at each of 3 sites");
    expect(out, "the days were added up").not.toContain("37");
  });

  it("a single site still reads as it always did: no site count, no bound", () => {
    // The other direction. One site is the shipped default view scope, and a
    // sentence that hedged there would be noise bought with nothing.
    expect(miningRunSentence(report())).toBe("Read 3 more days of the diary and added 2 people.");
    expect(miningRunSentence(report())).not.toContain("up to");
    expect(miningRunSentence(report())).not.toContain("each of");
  });

  it("counts several such sites in the plural", () => {
    const out = miningRunSentence(
      report({
        sites: [
          { daysCovered: 2, candidates: 0, unreadable: 0, stoppedBy: "patient-budget" },
          { daysCovered: 2, candidates: 0, unreadable: 0, stoppedBy: "patient-budget" },
        ],
      }),
    );
    expect(out).toContain("Read 2 more days of the diary at each of 2 sites");
    expect(out).toContain("2 sites reached their share");
    expect(out).not.toContain("One site");
  });

  it("says nothing about shares when every site finished its book", () => {
    // THE OTHER DIRECTION: a sentence that always explained itself would be as
    // useless as one that never did.
    expect(miningRunSentence(report())).not.toContain("share of this run");
  });

  it("shows the patients it could not look up AT ALL, rather than losing them in a quiet total", () => {
    // The other half of W3/25. "Nobody was found" and "four people could not be
    // looked up" are different facts, and the second is one the practice can fix
    // in Dentally. Stated whatever the database's shape — the run report holds
    // the figure even where the coverage row cannot persist it yet (0101).
    const out = miningRunSentence(
      report({ sites: [{ daysCovered: 1, candidates: 0, unreadable: 4, stoppedBy: "complete" }] }),
    );
    expect(out).toContain("4 patients could not be looked up at all");
    expect(out).toContain("counted separately");
  });

  it("says patient, not patients, for one, and nothing at all for none", () => {
    expect(
      miningRunSentence(report({ sites: [{ daysCovered: 1, candidates: 0, unreadable: 1, stoppedBy: "complete" }] })),
    ).toContain("1 patient could not be looked up");
    expect(miningRunSentence(report())).not.toContain("could not be looked up");
  });

  it("says one day, not 1 days", () => {
    expect(
      miningRunSentence(report({ sites: [{ daysCovered: 1, candidates: 1, unreadable: 0, stoppedBy: "complete" }] })),
    ).toBe("Read 1 more day of the diary and added 1 person.");
  });
});
