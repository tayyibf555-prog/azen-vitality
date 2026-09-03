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

  it("a caveat states the age exclusion rather than hiding it", () => {
    expect(MINING_CAVEATS[3]).toMatch(/left off and counted, not assumed to be an adult/i);
  });

  it("the title promises a conversation, not a shortlist", () => {
    expect(MINING_TITLE).toBe("People who might want to hear about implants");
    expect(MINING_TITLE).not.toMatch(/suitable|candidate|eligible|qualif/i);
  });
});
