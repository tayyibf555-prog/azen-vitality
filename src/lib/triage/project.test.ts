import { describe, it, expect } from "vitest";
import {
  INTEREST_QUESTION_KEY,
  TRIAGE_BANK,
  TRIAGE_BANK_BY_KEY,
  defaultConfigFor,
} from "./bank";
import { FORBIDDEN_IN_BRIEF, symptomTermIn } from "./forbidden";
import { projectBank, usableConfig, usableCustom } from "./project";
import type { TriageBankConfig, TriageCustomQuestion } from "./types";

// ===========================================================================
// THE CONTRACTUAL RULE, PINNED.
//
// An NHS-plan patient must never be ASKED a pain / symptom / treatment-need
// question before their visit, because a symptom they then volunteer has to be
// treated under that contract. The DEFAULT short bank contains none — but a
// default is a suggestion, because the banks are editable, custom questions
// exist, and the config is a jsonb column. So the rule lives in projectBank and
// these are the tests that hold it there.
//
// THE THREE MUTATION TARGETS, each of which must turn a NAMED test red:
//   1. the `kind === "symptom"` filter in admit()
//   2. the FORBIDDEN_IN_BRIEF label scan in admit()
//   3. the funding-word filter in admit()
// ===========================================================================

const SYMPTOM_KEYS = TRIAGE_BANK.filter((q) => q.kind === "symptom").map((q) => q.key);

describe("the shipped default banks", () => {
  it("the short bank contains NO symptom question, by classification", () => {
    const brief = defaultConfigFor("brief");
    for (const key of brief.enabledKeys) {
      const q = TRIAGE_BANK_BY_KEY.get(key);
      expect(q, `${key} is not a bank question`).toBeDefined();
      expect(q?.kind, `${key} is a ${q?.kind} question on the short bank`).not.toBe("symptom");
    }
  });

  // THE ASSERTION THE BRIEF ASKED FOR, BY NAME: the short bank is checked against
  // a FORBIDDEN-TERM LIST, not only against its own classification. A question
  // filed as "logistics" and written as "Is anything hurting?" is a symptom
  // question whatever the dropdown said.
  it("the short bank contains no symptom question, by FORBIDDEN-TERM LIST", () => {
    const projected = projectBank("brief", null);
    for (const q of projected.questions) {
      const term = symptomTermIn(q.label) ?? symptomTermIn(q.help ?? "");
      expect(term, `"${q.label}" contains the forbidden term "${term}"`).toBeNull();
    }
  });

  it("the forbidden-term list is real, not an empty array that passes vacuously", () => {
    expect(FORBIDDEN_IN_BRIEF.length).toBeGreaterThan(30);
    // Spot-pins on the vocabulary that matters most, so a list gutted down to one
    // harmless pattern still fails here.
    for (const word of ["pain", "hurts", "bleeding", "sensitive", "broken", "problem", "decay"]) {
      expect(symptomTermIn(`Do you have any ${word} today`), `"${word}" is not caught`).not.toBeNull();
    }
    // TREATMENT NEED is caught by the OBJECT rather than by the word "need", so
    // both of these fail and the practice's own logistics copy still passes.
    expect(symptomTermIn("Do you think you need any treatment?")).not.toBeNull();
    expect(symptomTermIn("Does anything need doing?")).not.toBeNull();
    expect(symptomTermIn("Do you need a filling?")).not.toBeNull();
    expect(symptomTermIn("If you need a different time, tell us here")).toBeNull();
    expect(symptomTermIn("Anything at all. Getting in and out, needing someone with you.")).toBeNull();
  });

  it("the FULL bank does contain the symptom questions, so the fork is a real fork", () => {
    // Guards the guard: if the filter were applied to both banks this file would
    // pass while the feature did nothing.
    const full = projectBank("full", null);
    const keys = full.questions.map((q) => q.key);
    for (const key of SYMPTOM_KEYS) expect(keys).toContain(key);
    expect(SYMPTOM_KEYS.length).toBeGreaterThanOrEqual(6);
  });

  it("both banks carry the interest grid and the smile question", () => {
    for (const fork of ["full", "brief"] as const) {
      const keys = projectBank(fork, null).questions.map((q) => q.key);
      expect(keys, `${fork} is missing the interest grid`).toContain(INTEREST_QUESTION_KEY);
      expect(keys, `${fork} is missing the smile question`).toContain("smile-change");
    }
  });

  it("the short bank is exactly the four the practice asked for", () => {
    // Attendance, health-changed, the smile free text and the interest grid, plus
    // the one open logistics question. Named so a fifth appearing is a decision
    // somebody made rather than a drift.
    expect(projectBank("brief", null).questions.map((q) => q.key).sort()).toEqual(
      ["anything-helpful", "attending", "health-changed", INTEREST_QUESTION_KEY, "smile-change"].sort(),
    );
  });
});

describe("projectBank refuses a symptom question ON THE SHORT BANK, whatever the config says", () => {
  // MUTATION TARGET 1: the `kind === "symptom"` filter.
  it.each(SYMPTOM_KEYS)("drops the bank question %s when an owner switches it on", (key) => {
    const config: TriageBankConfig = {
      enabledKeys: [...defaultConfigFor("brief").enabledKeys, key],
      required: {},
      custom: [],
    };
    const projected = projectBank("brief", config);
    expect(projected.questions.map((q) => q.key)).not.toContain(key);
    // AND IT SAYS SO. A silent drop is how a guard gets reported as a bug and then
    // removed; a drop that names its reason gets the question rewritten.
    const dropped = projected.dropped.find((d) => d.key === key);
    expect(dropped?.reason).toBe("symptom-on-brief");
  });

  // MUTATION TARGET 2: the label scan. This is the case the classification alone
  // cannot catch — the owner picked "logistics" from the dropdown and then wrote a
  // symptom question.
  it("drops a CUSTOM question the owner mis-classified as logistics", () => {
    const config: TriageBankConfig = {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        {
          key: "custom-hurting",
          label: "Is anything hurting before you come in?",
          type: "yesno",
          kind: "logistics", // the owner's claim
          required: false,
        },
      ],
    };
    const projected = projectBank("brief", config);
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-hurting");
    const dropped = projected.dropped.find((d) => d.key === "custom-hurting");
    expect(dropped?.reason).toBe("symptom-on-brief");
    expect(dropped?.matched?.toLowerCase()).toBe("hurting");
  });

  it("drops a CUSTOM question honestly classified as a symptom", () => {
    const config: TriageBankConfig = {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        { key: "custom-x", label: "How is it feeling today?", type: "text", kind: "symptom", required: false },
      ],
    };
    const projected = projectBank("brief", config);
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-x");
  });

  it("keeps the SAME custom question on the FULL bank", () => {
    // Proof the filter is fork-scoped rather than a blanket ban, which would make
    // the full bank useless and the test above meaningless.
    const config: TriageBankConfig = {
      enabledKeys: defaultConfigFor("full").enabledKeys,
      required: {},
      custom: [
        {
          key: "custom-hurting",
          label: "Is anything hurting before you come in?",
          type: "yesno",
          kind: "logistics",
          required: false,
        },
      ],
    };
    expect(projectBank("full", config).questions.map((q) => q.key)).toContain("custom-hurting");
  });

  it("holds against a hand-written config that names ONLY symptom questions", () => {
    // The corrupted / hostile row. The result is a bank with no symptom questions
    // at all, not a bank of them.
    const projected = projectBank("brief", { enabledKeys: SYMPTOM_KEYS, required: {}, custom: [] });
    expect(projected.questions).toEqual([]);
    expect(projected.dropped.length).toBe(SYMPTOM_KEYS.length);
  });
});

// ===========================================================================
// THE TEST project.ts NAMES BY NAME.
//
// project.ts:43 tells the next engineer that breaking either brief-bank filter
// turns `brief-bank-has-no-symptom-questions` red. Until this ran, no test of
// that name existed anywhere in the tree: `vitest -t
// "brief-bank-has-no-symptom-questions"` skipped every test and exited 0, so a
// citation meant to prove the guard was pinned read GREEN to anyone who checked
// it (ruling W3/17 — a comment naming a test that does not exist is corrected or
// the test is written).
//
// ONE test, THREE routes onto the short bank, because the comment promises one
// name for the whole rule. It must go red under each of these mutations, taken
// one at a time, in admit():
//
//   1. delete `if (kind === "symptom")`         → the honestly-classified question
//   2. delete the symptomTermIn loop            → the mis-classified LABEL
//   3. drop `o.label` / `o.value` from patientText → the mis-classified OPTION
// ===========================================================================
describe("the contractual fork, pinned under the name project.ts cites", () => {
  it("brief-bank-has-no-symptom-questions", () => {
    // ROUTE 1: an owner switches an honestly-classified symptom question on.
    for (const key of SYMPTOM_KEYS) {
      const projected = projectBank("brief", {
        enabledKeys: [...defaultConfigFor("brief").enabledKeys, key],
        required: {},
        custom: [],
      });
      expect(projected.questions.map((q) => q.key), `${key} reached the short bank`).not.toContain(key);
      expect(projected.dropped.find((d) => d.key === key)?.reason).toBe("symptom-on-brief");
    }

    // ROUTE 2: the owner picked "logistics" from the dropdown and then wrote a
    // symptom question. The classification cannot catch this one.
    const byLabel = projectBank("brief", {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        { key: "custom-hurting", label: "Is anything hurting before you come in?", type: "yesno", kind: "logistics", required: false },
      ],
    });
    expect(byLabel.questions.map((q) => q.key)).not.toContain("custom-hurting");
    expect(byLabel.dropped.find((d) => d.key === "custom-hurting")?.reason).toBe("symptom-on-brief");

    // ROUTE 3 (W3/3): the LABEL is innocuous, the classification is honest for
    // the label, and the symptom is in an ANSWER the patient taps. This is the
    // one the label scan alone walked past.
    const byOption = projectBank("brief", {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        {
          key: "custom-visit-reason",
          label: "How can we help at this visit?",
          type: "choice",
          kind: "logistics",
          options: [
            { value: "routine", label: "Just my usual check-up" },
            { value: "sore", label: "I have toothache and it is painful" },
          ],
          required: true,
        },
      ],
    });
    expect(byOption.questions.map((q) => q.key)).not.toContain("custom-visit-reason");
    const dropped = byOption.dropped.find((d) => d.key === "custom-visit-reason");
    expect(dropped?.reason).toBe("symptom-on-brief");
    // AND IT NAMES THE WORD, so the editor can tell the owner what to rewrite
    // rather than showing them a shorter form than they configured.
    expect(dropped?.matched?.toLowerCase()).toBe("painful");

    // AND THE SHIPPED SHORT BANK IS STILL THE SHORT BANK: a scan broadened over
    // option text must not start eating the questions the fork exists to ask.
    expect(projectBank("brief", null).questions.map((q) => q.key).sort()).toEqual(
      ["anything-helpful", "attending", "health-changed", INTEREST_QUESTION_KEY, "smile-change"].sort(),
    );
  });
});

// ===========================================================================
// RULING W3/3, in its own right: the OPTION labels and values of a custom
// choice question are scanned exactly like the question text.
// ===========================================================================
describe("custom choice OPTIONS are scanned like question text (W3/3)", () => {
  function withOptions(options: { value: string; label: string }[]) {
    return {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        { key: "custom-visit-reason", label: "How can we help at this visit?", type: "choice" as const, kind: "logistics" as const, options, required: true },
      ],
    };
  }

  it("a symptom word in an option LABEL keeps the question off the short bank", () => {
    const projected = projectBank("brief", withOptions([
      { value: "routine", label: "Just my usual check-up" },
      { value: "broken", label: "A broken tooth" },
    ]));
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-visit-reason");
    expect(projected.dropped.find((d) => d.key === "custom-visit-reason")?.matched?.toLowerCase()).toBe("broken");
  });

  it("a symptom word in an option VALUE keeps it off too — the value reaches a staff screen", () => {
    const projected = projectBank("brief", withOptions([
      { value: "routine", label: "Just my usual check-up" },
      { value: "pain", label: "Something I would like looked at" },
    ]));
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-visit-reason");
    expect(projected.dropped.find((d) => d.key === "custom-visit-reason")?.reason).toBe("symptom-on-brief");
  });

  it("the SAME question is still asked on the FULL bank, so the scan is fork-scoped", () => {
    const config = withOptions([
      { value: "routine", label: "Just my usual check-up" },
      { value: "sore", label: "I have toothache and it is painful" },
    ]);
    const projected = projectBank("full", { ...config, enabledKeys: defaultConfigFor("full").enabledKeys });
    expect(projected.questions.map((q) => q.key)).toContain("custom-visit-reason");
  });

  it.each(["full", "brief"] as const)("a FUNDING word in an option is dropped from %s", (fork) => {
    const config = withOptions([
      { value: "a", label: "On the NHS" },
      { value: "b", label: "Something else" },
    ]);
    const projected = projectBank(fork, { ...config, enabledKeys: defaultConfigFor(fork).enabledKeys });
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-visit-reason");
    expect(projected.dropped.find((d) => d.key === "custom-visit-reason")?.reason).toBe("funding-word");
  });

  it("an innocuous choice question is still admitted on the short bank", () => {
    // Guards the guard: a scan that refused every choice question would pass the
    // tests above while making the editor's choice type useless.
    const projected = projectBank("brief", withOptions([
      { value: "morning", label: "Mornings suit me best" },
      { value: "afternoon", label: "Afternoons suit me best" },
    ]));
    expect(projected.questions.map((q) => q.key)).toContain("custom-visit-reason");
    expect(projected.dropped.map((d) => d.key)).not.toContain("custom-visit-reason");
  });
});

// ===========================================================================
// RULING 1 (3 Sep 2026): the anxiety question is FULL-only BY DEFAULT, but the
// owner may enable it for the short bank. Both halves are load-bearing, and a
// single test cannot hold both.
// ===========================================================================
describe("the anxiety question: default-off for the short bank, but ENABLEABLE", () => {
  const ANXIETY = "anxiety";

  it("is NOT on the shipped short bank", () => {
    expect(projectBank("brief", null).questions.map((q) => q.key)).not.toContain(ANXIETY);
  });

  it("IS on the shipped full bank", () => {
    expect(projectBank("full", null).questions.map((q) => q.key)).toContain(ANXIETY);
  });

  // THE HALF THAT WOULD HAVE BEEN IMPOSSIBLE IF IT WERE CLASSIFIED `symptom`.
  it("an owner who switches it on for the short bank IS given it", () => {
    const config: TriageBankConfig = {
      enabledKeys: [...defaultConfigFor("brief").enabledKeys, ANXIETY],
      required: {},
      custom: [],
    };
    const projected = projectBank("brief", config);
    expect(projected.questions.map((q) => q.key)).toContain(ANXIETY);
    // ...and it is NOT reported as refused, which is what the owner would see if
    // the kind filter or the term scan still caught it.
    expect(projected.dropped.map((d) => d.key)).not.toContain(ANXIETY);
  });

  it("clears the forbidden-term scan on its label AND its help", () => {
    // The original help said "There's no wrong answer", and "wrong" is on the list,
    // so the question would have been refused by the very scan meant to let it
    // through. Pinned so the reassurance cannot be reworded back into a block.
    const q = TRIAGE_BANK_BY_KEY.get(ANXIETY)!;
    expect(symptomTermIn(q.label)).toBeNull();
    expect(symptomTermIn(q.help ?? "")).toBeNull();
    expect(q.kind).not.toBe("symptom");
  });

  it("carries an OWNER-facing note that names the decision the practice must take", () => {
    const q = TRIAGE_BANK_BY_KEY.get(ANXIETY)!;
    expect(q.ownerNote).toBeDefined();
    expect(q.ownerNote).toMatch(/contract adviser/i);
    // The note is owner-facing, so it MAY name the funding regime. That it does is
    // the point: the owner has to know which patients the question would affect.
    expect(q.ownerNote).toMatch(/NHS/);
  });

  it("no OTHER question smuggles a funding word in through ownerNote onto a patient screen", () => {
    // ownerNote is excluded from the patient crawl by name, so the field itself is
    // constrained here: only the questions that need one may have one.
    const withNotes = TRIAGE_BANK.filter((q) => q.ownerNote).map((q) => q.key);
    expect(withNotes).toEqual([ANXIETY]);
  });
});

describe("projectBank refuses a funding word on EITHER bank", () => {
  // MUTATION TARGET 3.
  it.each(["full", "brief"] as const)("drops a custom question naming a funding regime (%s)", (fork) => {
    const config: TriageBankConfig = {
      enabledKeys: defaultConfigFor(fork).enabledKeys,
      required: {},
      custom: [
        {
          key: "custom-funding",
          label: "Are you an NHS patient or private?",
          type: "yesno",
          kind: "logistics",
          required: false,
        },
      ],
    };
    const projected = projectBank(fork, config);
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-funding");
    expect(projected.dropped.find((d) => d.key === "custom-funding")?.reason).toBe("funding-word");
  });
});

describe("required flags", () => {
  it("honours the owner's required override", () => {
    const config: TriageBankConfig = {
      enabledKeys: ["attending", "anything-helpful"],
      required: { attending: true, "anything-helpful": true },
      custom: [],
    };
    const q = projectBank("brief", config).questions;
    expect(q.find((x) => x.key === "attending")?.required).toBe(true);
    // A question that is NOT requirable is never required, whatever the config
    // says: forcing a patient to type something about their mouth before they can
    // confirm an appointment is how a form gets abandoned.
    expect(q.find((x) => x.key === "anything-helpful")?.required).toBe(false);
  });

  it("no free-text question in the bank is requirable", () => {
    for (const q of TRIAGE_BANK) {
      if (q.type === "text" || q.type === "textarea") {
        expect(q.requirable, `${q.key} is free text and requirable`).toBe(false);
      }
    }
  });
});

describe("usableConfig", () => {
  it("falls back to the fork's defaults for a null, empty or broken row", () => {
    for (const raw of [null, undefined, {}, { enabledKeys: [] }, "nonsense", 7, []]) {
      const config = usableConfig("brief", raw);
      expect(config.enabledKeys).toEqual(defaultConfigFor("brief").enabledKeys);
    }
  });

  it("does NOT repair a partial row into a shorter form", () => {
    // A config whose enabledKeys did not survive a write is a broken row, not a
    // practice that wants no questions. Rendering an empty form off it would look
    // exactly like a working one.
    expect(usableConfig("full", { required: { attending: true } }).enabledKeys.length).toBeGreaterThan(5);
  });

  it("keeps a real config as given", () => {
    const config = usableConfig("full", { enabledKeys: ["attending"], required: { attending: true }, custom: [] });
    expect(config.enabledKeys).toEqual(["attending"]);
    expect(config.required.attending).toBe(true);
  });

  // THE DATA LOSS THIS FUNCTION USED TO CAUSE, in the projection rather than on a
  // screen. Switching every shipped question off is a supported thing for an owner
  // to do — the editor warns, it does not refuse — and the fallback used to return
  // `defaultConfigFor(fork)` WHOLE, taking the practice's own questions with it.
  // The stored row still held them, so nothing anywhere could show what had gone.
  //
  // Both routes out of the fallback are asserted, because they are separate `if`s
  // and a fix to one leaves the other losing the same data: an empty enabledKeys
  // array (the owner's own doing) and a missing one (a half-written row).
  it("keeps the practice's OWN questions when the bank selection falls back", () => {
    const custom: TriageCustomQuestion[] = [
      { key: "custom-heard", label: "How did you hear about us?", type: "text", kind: "logistics", required: false },
      { key: "custom-parking", label: "Do you need a parking space?", type: "yesno", kind: "logistics", required: false },
    ];

    // (a) every shipped question switched off.
    const emptied = usableConfig("full", { enabledKeys: [], required: {}, custom });
    expect(emptied.enabledKeys).toEqual(defaultConfigFor("full").enabledKeys);
    expect(emptied.custom.map((c) => c.key)).toEqual(["custom-heard", "custom-parking"]);

    // (b) enabledKeys missing entirely — a broken row, not an empty practice.
    const partial = usableConfig("full", { required: {}, custom });
    expect(partial.custom.map((c) => c.key)).toEqual(["custom-heard", "custom-parking"]);

    // And they are ASKED, not merely carried: the projection is what the patient
    // sees, and a config kept in a field nobody projects is the same loss.
    const projected = projectBank("full", { enabledKeys: [], required: {}, custom });
    expect(projected.questions.map((q) => q.key)).toContain("custom-heard");
    expect(projected.questions.map((q) => q.key)).toContain("custom-parking");
  });

  it("restoring a custom question does NOT restore it past the two scans", () => {
    // Carrying `custom` onto the fallback must not become a door around `admit`.
    // A funding word is refused on both banks; a symptom question is refused on
    // the brief one — on the fallback path exactly as on the ordinary one.
    const projected = projectBank("brief", {
      enabledKeys: [],
      required: {},
      custom: [
        { key: "custom-nhs", label: "Are you an NHS patient?", type: "yesno", kind: "logistics", required: false },
        { key: "custom-pain", label: "Is anything hurting today?", type: "yesno", kind: "logistics", required: false },
      ],
    });
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-nhs");
    expect(projected.questions.map((q) => q.key)).not.toContain("custom-pain");
    expect(projected.dropped.find((d) => d.key === "custom-nhs")?.reason).toBe("funding-word");
    expect(projected.dropped.find((d) => d.key === "custom-pain")?.reason).toBe("symptom-on-brief");
  });
});

describe("usableCustom", () => {
  const base = { key: "custom-a", label: "How did you hear about us?", type: "text", kind: "logistics" };

  it("requires the custom- prefix, which is what makes a bank collision impossible", () => {
    expect(usableCustom({ ...base, key: "attending" })).toBeNull();
    expect(usableCustom({ ...base, key: "custom-a" })).not.toBeNull();
  });

  it("refuses an interest type or kind: the grid is one fixed question with one table", () => {
    expect(usableCustom({ ...base, type: "interest" })).toBeNull();
    expect(usableCustom({ ...base, kind: "interest" })).toBeNull();
  });

  it("refuses a choice question with nothing to choose", () => {
    expect(usableCustom({ ...base, type: "choice", options: [] })).toBeNull();
    expect(usableCustom({ ...base, type: "choice", options: [{ value: "a", label: "A" }] })).toBeNull();
    expect(
      usableCustom({ ...base, type: "choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }),
    ).not.toBeNull();
  });

  it("never marks a free-text custom question required", () => {
    expect(usableCustom({ ...base, type: "text", required: true })?.required).toBe(false);
    expect(usableCustom({ ...base, type: "textarea", required: true })?.required).toBe(false);
    expect(usableCustom({ ...base, type: "yesno", required: true })?.required).toBe(true);
  });

  it("refuses junk rather than coercing it", () => {
    for (const raw of [null, undefined, 7, "x", {}, { ...base, label: "" }, { ...base, type: "video" }]) {
      expect(usableCustom(raw)).toBeNull();
    }
  });
});
