import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  CLINICAL_SUMMARY_ROLES,
  DISCOMFORT_NOTICE_THRESHOLD,
  SUMMARY_COPY,
  canReadClinicalSummary,
  projectSummary,
} from "./summary";
import { INTEREST_QUESTION_KEY, TRIAGE_BANK } from "./bank";
import { FORBIDDEN_PATIENT_WORDS } from "./forbidden";
import { UNKNOWN_ANSWER_KIND, readStoredAnswers, readStoredInterest } from "./kind";
import type { CustomQuestionIndex } from "./kind";
import { PreVisitSummaryPanel } from "@/components/client/patients/record/previsit-summary-panel";
import type { Role } from "@/lib/types";
import type { TriageQuestionKind, TriageResponse } from "./types";

// ===========================================================================
// THE DENTIST'S PRE-VISIT SUMMARY, and the role decision inside it.
//
// Four roles can open a patient record at all (it is gated on "patients", which
// `client_staff` does not hold). This file pins which of them may read what the
// patient said about their MOUTH, and pins that the ones who may not are told the
// answers EXIST rather than being left to conclude the patient said nothing.
// ===========================================================================

const ALL_RECORD_ROLES: Role[] = ["agency_admin", "client_owner", "client_coordinator", "client_clinician"];

function response(over: Partial<TriageResponse> = {}): TriageResponse {
  return {
    id: "r1",
    targetId: "site-cc:appt-1",
    siteId: "site-cc",
    dentallyPatientId: "p1",
    fork: "full",
    answers: [
      { key: "attending", value: "yes", kind: "logistics" },
      { key: "health-changed", value: "no", kind: "logistics" },
      { key: "visit-reason", value: "something-bothering", kind: "symptom" },
      { key: "concern-words", value: "the back one on the left has been grumbling", kind: "symptom" },
      { key: "pain-now", value: "8", kind: "symptom" },
      { key: "gums-bleed", value: "yes", kind: "symptom" },
    ],
    interest: [
      { treatment: "whitening", answer: "yes" },
      { treatment: "implants", answer: "not_now" },
    ],
    submittedAt: "2026-09-10T09:00:00.000Z",
    ...over,
  };
}

describe("who may read what the patient said about their mouth", () => {
  it("the clinician, the owner and the agency may", () => {
    for (const role of ["client_clinician", "client_owner", "agency_admin"] as const) {
      expect(canReadClinicalSummary(role), `${role} was refused`).toBe(true);
      expect(projectSummary(response(), role).clinical).not.toBeNull();
    }
  });

  // THE DECISION, NAMED. The practice manager (a client_coordinator here) sees the
  // logistics and interest answers and NOT the symptom ones. It is deliberately
  // narrower than the platform's existing posture for the chart and the medical
  // history, which she does read — the difference being that those are records the
  // practice authored and these are a patient's own words, given in the belief
  // that the person examining them would read them.
  it("the practice manager may NOT, and gets null rather than an empty section", () => {
    const summary = projectSummary(response(), "client_coordinator");
    expect(canReadClinicalSummary("client_coordinator")).toBe(false);
    // NULL, not []. An empty section renders a heading that reads as "the patient
    // said nothing", which is a different and false clinical fact.
    expect(summary.clinical).toBeNull();
  });

  it("she still sees the logistics and the interest grid, which are her job", () => {
    const summary = projectSummary(response(), "client_coordinator");
    expect(summary.logistics.lines.map((l) => l.key).sort()).toEqual(["attending", "health-changed"]);
    expect(summary.interest.length).toBe(2);
  });

  // THE PART THAT MAKES THE RESTRICTION SAFE RATHER THAN MERELY TIDY. She is told
  // the answers exist and how many, so a front desk that cannot read them can
  // still escalate. Showing nothing at all would be worse than showing everything.
  it("she is told the answers EXIST, so she does not conclude the patient said nothing", () => {
    const summary = projectSummary(response(), "client_coordinator");
    expect(summary.flaggedForClinician).toBe(4);
    expect(SUMMARY_COPY.restricted(4)).toMatch(/A clinician can see what they said/i);
    expect(SUMMARY_COPY.restricted(1)).toMatch(/one question/i);
  });

  it("and she sees the discomfort FLAG, which is a front-desk decision", () => {
    // "Book them in a fortnight" vs "ring them today" is her call, and she cannot
    // make it without knowing. The flag carries no symptom, only the fact.
    const summary = projectSummary(response(), "client_coordinator");
    expect(summary.discomfortReported).toBe(true);
  });

  it("the discomfort flag is a threshold on the patient's OWN scale, not a grading", () => {
    expect(DISCOMFORT_NOTICE_THRESHOLD).toBe(7);
    const below = projectSummary(
      response({ answers: [{ key: "pain-now", value: String(DISCOMFORT_NOTICE_THRESHOLD - 1), kind: "symptom" }] }),
      "client_owner",
    );
    expect(below.discomfortReported).toBe(false);
    const at = projectSummary(
      response({ answers: [{ key: "pain-now", value: String(DISCOMFORT_NOTICE_THRESHOLD), kind: "symptom" }] }),
      "client_owner",
    );
    expect(at.discomfortReported).toBe(true);
  });

  it("a null role is the unenforced pilot and reads as permitted, like every other guard", () => {
    // requireUser, requireOwnerRole and requireModuleApiAccess are all no-ops with
    // enforcement off. A projection that alone stayed shut would make the local
    // build look broken rather than safe.
    expect(canReadClinicalSummary(null)).toBe(true);
    expect(canReadClinicalSummary(undefined)).toBe(true);
  });

  it("an unknown role is refused, so a sixth role does not inherit the clinical half", () => {
    expect(canReadClinicalSummary("client_staff")).toBe(false);
    expect(canReadClinicalSummary("some_future_role")).toBe(false);
  });

  it("the role list is a real constant, so widening it is a one-line change with a test", () => {
    expect([...CLINICAL_SUMMARY_ROLES].sort()).toEqual(
      ["agency_admin", "client_clinician", "client_owner"].sort(),
    );
  });
});

describe("the projection itself", () => {
  it("renders a CHOICE answer's label, never its stored value", () => {
    const summary = projectSummary(response(), "client_owner");
    const reason = summary.clinical?.lines.find((l) => l.key === "visit-reason");
    expect(reason?.answer).toBe("Something is bothering me");
    expect(reason?.answer).not.toContain("something-bothering");
  });

  it("marks free text as free text, so a reader knows whose words they are", () => {
    const summary = projectSummary(response(), "client_owner");
    expect(summary.clinical?.lines.find((l) => l.key === "concern-words")?.freeText).toBe(true);
    expect(summary.logistics.lines.find((l) => l.key === "attending")?.freeText).toBe(false);
  });

  it("passes the discomfort score as a NUMBER as well as a string", () => {
    const summary = projectSummary(response(), "client_owner");
    expect(summary.clinical?.lines.find((l) => l.key === "pain-now")?.scale).toBe(8);
  });

  it("keeps an answer whose question the practice has since deleted", () => {
    // What the patient told us is a fact, and it must not disappear because the
    // owner edited the bank afterwards.
    const summary = projectSummary(
      response({ answers: [{ key: "custom-gone", value: "something", kind: "logistics" }] }),
      "client_owner",
    );
    const all = [...summary.logistics.lines, ...(summary.clinical?.lines ?? [])];
    expect(all.map((l) => l.key)).toContain("custom-gone");
  });

  it("labels the fork in staff words and never in funding words", () => {
    for (const fork of ["full", "brief"] as const) {
      const summary = projectSummary(response({ fork }), "client_owner");
      for (const text of [summary.forkLabel, summary.forkNote]) {
        for (const re of FORBIDDEN_PATIENT_WORDS) {
          expect(re.test(text), `"${text}" matches ${re}`).toBe(false);
        }
      }
    }
  });

  it("never puts the interest grid itself among the answers", () => {
    const summary = projectSummary(
      response({
        answers: [
          { key: "interest-grid", value: "x", kind: "interest" },
          { key: "attending", value: "yes", kind: "logistics" },
        ],
      }),
      "client_owner",
    );
    const all = [...summary.logistics.lines, ...(summary.clinical?.lines ?? [])];
    expect(all.map((l) => l.key)).not.toContain("interest-grid");
  });
});

// ===========================================================================
// THE QUESTION'S KIND, AND THE DEFECT THAT MADE THIS BLOCK NECESSARY.
//
// The manager/clinician split is made on one field: an answer's KIND. The
// projection used to read that field out of the SHIPPED bank and, for a key it
// could not find, fall back to `logistics` — the class every role reads. An
// OWNER-AUTHORED question (`custom-...`) is by definition not in the shipped bank,
// so a custom question the owner classified `symptom` put the patient's own words
// on the front desk's screen. Exactly what ruling W1-C/2 forbids.
//
// The fix is two independent parts and each is named below: the kind now TRAVELS
// WITH THE ANSWER (stamped at submit, required on the type), and an answer whose
// kind nothing can name resolves to `symptom` — restricted — never `logistics`.
// ===========================================================================
describe("an owner-authored question's KIND decides who reads it", () => {
  const OWN_WORDS = "my jaw clicks every morning and it is getting worse";

  /** A question the PRACTICE wrote, classified `symptom` in the owner editor. */
  function withCustomSymptom(kindOnTheAnswer: TriageQuestionKind): TriageResponse {
    return response({
      answers: [
        { key: "attending", value: "yes", kind: "logistics" },
        { key: "custom-jaw", value: OWN_WORDS, kind: kindOnTheAnswer },
      ],
    });
  }

  const authoredAsSymptom: CustomQuestionIndex = new Map([
    ["custom-jaw", { label: "Anything else about your jaw?", kind: "symptom" as const }],
  ]);

  it("a custom SYMPTOM question is restricted from the manager and shown to the clinician", () => {
    const resp = withCustomSymptom("symptom");

    const clinician = projectSummary(resp, "client_clinician", authoredAsSymptom);
    expect(clinician.clinical?.lines.map((l) => l.answer)).toContain(OWN_WORDS);
    expect(clinician.clinical?.lines.find((l) => l.key === "custom-jaw")?.question).toBe(
      "Anything else about your jaw?",
    );

    const manager = projectSummary(resp, "client_coordinator", authoredAsSymptom);
    expect(manager.clinical, "the manager was handed a clinical section").toBeNull();
    expect(
      JSON.stringify(manager),
      "the patient's own words reached the practice manager",
    ).not.toContain(OWN_WORDS);
    // She is still told there is something for a clinician to read.
    expect(manager.flaggedForClinician).toBe(1);
    expect(manager.logistics.lines.map((l) => l.key)).toEqual(["attending"]);
  });

  it("the stamped kind alone is enough — no bank config, no leak", () => {
    // The practice deleted the question after the patient answered it, so nothing
    // in any config can still say what it was. This is the case the old code got
    // wrong in the most invisible way, and the reason the kind is persisted.
    const manager = projectSummary(withCustomSymptom("symptom"), "client_coordinator");
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain(OWN_WORDS);
    expect(manager.flaggedForClinician).toBe(1);
  });

  it("and the stamp is READ, not merely defaulted over: a deleted LOGISTICS question stays the manager's", () => {
    // The other direction, and the one that proves the stamp is load-bearing
    // rather than decorative. The practice wrote "Do you need step-free access?",
    // classified it logistics, a patient answered it and the owner then deleted
    // the question. No config can name it any more. The manager is the person who
    // acts on that answer, so it must NOT be swept into the restricted half — and
    // the ONLY thing that can still say so is the kind stored on the answer.
    const summary = projectSummary(
      response({
        answers: [{ key: "custom-access", value: "step-free access please", kind: "logistics" }],
      }),
      "client_coordinator",
    );
    expect(summary.logistics.lines.map((l) => l.key)).toEqual(["custom-access"]);
    expect(summary.logistics.lines[0].answer).toBe("step-free access please");
    expect(summary.flaggedForClinician).toBe(0);
  });

  it("the practice's CURRENT classification also restricts, whatever the answer was stamped", () => {
    // The owner re-classified an existing question as a symptom question. The
    // answers already stored say `logistics`; most-restrictive wins.
    const manager = projectSummary(withCustomSymptom("logistics"), "client_coordinator", authoredAsSymptom);
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain(OWN_WORDS);
  });

  it("an answer of UNKNOWN kind is restricted, never logistics", () => {
    // THE FAIL DIRECTION, stated on its own. Nothing knows what this question was:
    // not the shipped bank, not the stored answer, not the practice's config.
    expect(UNKNOWN_ANSWER_KIND).toBe("symptom");
    const [unknown] = readStoredAnswers([{ key: "custom-mystery", value: OWN_WORDS }]);
    expect(unknown.kind, "an unstamped stored answer did not fail to symptom").toBe("symptom");

    const manager = projectSummary(
      response({ answers: [{ key: "attending", value: "yes", kind: "logistics" }, unknown] }),
      "client_coordinator",
    );
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain(OWN_WORDS);
    expect(manager.flaggedForClinician).toBe(1);
    expect(manager.logistics.lines.map((l) => l.key)).toEqual(["attending"]);
  });

  it("a junk kind in the jsonb column is unknown, and unknown is restricted", () => {
    for (const junk of ["", "LOGISTICS", "clinical", 7, null, {}]) {
      const [row] = readStoredAnswers([{ key: "custom-x", value: OWN_WORDS, kind: junk }]);
      expect(row.kind, `${JSON.stringify(junk)} was accepted as a kind`).toBe("symptom");
    }
  });

  // THE SHIPPED BANKS ARE UNCHANGED. The fix must not re-classify a single question
  // the practice already has, in either direction: a bank question's kind is
  // in-code and is not a thing a stored row may contradict.
  it("every SHIPPED question still lands in the section its own bank kind names", () => {
    for (const q of TRIAGE_BANK) {
      if (q.key === INTEREST_QUESTION_KEY) continue; // its own renderer
      const summary = projectSummary(
        response({ answers: [{ key: q.key, value: "3", kind: q.kind }] }),
        "client_owner",
      );
      const inClinical = summary.clinical?.lines.some((l) => l.key === q.key) ?? false;
      const inLogistics = summary.logistics.lines.some((l) => l.key === q.key);
      expect(inClinical, `${q.key} (${q.kind}) is in the wrong half`).toBe(q.kind === "symptom");
      expect(inLogistics, `${q.key} (${q.kind}) is in the wrong half`).toBe(q.kind !== "symptom");
    }
  });

  it("a tampered stored kind cannot DOWNGRADE a shipped symptom question", () => {
    const manager = projectSummary(
      response({ answers: [{ key: "concern-words", value: OWN_WORDS, kind: "logistics" }] }),
      "client_coordinator",
    );
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain(OWN_WORDS);
  });
});

// ===========================================================================
// A PRACTICE-WRITTEN QUESTION IS A REAL QUESTION, and the summary has to read it
// the way the patient answered it.
//
// The projection used to take a line's TYPE from the shipped bank alone. A
// `custom-` key is by definition not in the shipped bank, so every question the
// practice wrote itself was typeless: `scale` was always null and `freeText` was
// always true. Two things followed, and the second is the one that matters.
//
//   The number was printed in quotation marks, as if the patient had typed it.
//   And `discomfortReported` — the flag the practice manager gets INSTEAD of the
//   words (ruling W1-C/2) — was read off the shipped key `pain-now` alone, so a
//   patient who rated their discomfort 9 on the practice's own slider was recorded
//   as `false`. The PATIENT-facing half already handled this case: the public form
//   shows the help-now line for every symptom-kind scale. The two halves of one
//   module disagreed about what a number on a slider means.
// ===========================================================================
describe("an owner-authored 0-10 scale is a discomfort scale (the flag is not one key)", () => {
  /** The practice's own slider, as `customQuestionsFor` would index it. */
  const ownSlider: CustomQuestionIndex = new Map([
    [
      "custom-discomfort",
      {
        label: "How uncomfortable is your tooth right now?",
        kind: "symptom" as const,
        type: "scale" as const,
      },
    ],
  ]);

  function rated(score: string): TriageResponse {
    return response({
      answers: [
        { key: "attending", value: "yes", kind: "logistics" },
        { key: "custom-discomfort", value: score, kind: "symptom" },
      ],
    });
  }

  it("owner-authored-discomfort-scale-raises-the-flag", () => {
    const summary = projectSummary(rated("9"), "client_owner", ownSlider);
    expect(summary.discomfortReported, "a 9 out of 10 on the practice's own slider was not flagged").toBe(true);

    const line = summary.clinical?.lines.find((l) => l.key === "custom-discomfort");
    expect(line?.scale, "the number was not passed as a number").toBe(9);
    expect(line?.freeText, "a slider reading was quoted as the patient's own words").toBe(false);
  });

  it("and the FLAG reaches the practice manager, who has nothing else to go on", () => {
    // She gets the count and the flag and never the words. With the flag false she
    // had a bare count of one and no reason to ring anybody.
    const manager = projectSummary(rated("9"), "client_coordinator", ownSlider);
    expect(manager.clinical).toBeNull();
    expect(manager.flaggedForClinician).toBe(1);
    expect(manager.discomfortReported).toBe(true);
  });

  it("the threshold is the same threshold, not a second one", () => {
    expect(projectSummary(rated(String(DISCOMFORT_NOTICE_THRESHOLD - 1)), "client_owner", ownSlider).discomfortReported).toBe(false);
    expect(projectSummary(rated(String(DISCOMFORT_NOTICE_THRESHOLD)), "client_owner", ownSlider).discomfortReported).toBe(true);
  });

  it("a COSMETIC scale never raises it, because 10 there is good news", () => {
    // "How happy are you with how your smile looks?" is not a pain scale, and a
    // flag that fired on it would train the front desk to ignore the flag.
    const smile: CustomQuestionIndex = new Map([
      ["custom-smile-score", { label: "How happy are you with your smile?", kind: "cosmetic" as const, type: "scale" as const }],
    ]);
    const summary = projectSummary(
      response({ answers: [{ key: "custom-smile-score", value: "10", kind: "cosmetic" }] }),
      "client_owner",
      smile,
    );
    expect(summary.discomfortReported).toBe(false);
    // It is still rendered as a number, in the half every role reads.
    expect(summary.logistics.lines.find((l) => l.key === "custom-smile-score")?.scale).toBe(10);
  });

  it("a DELETED question keeps the old fallback: quoted, and no scale claimed", () => {
    // Nothing can say what control it rendered as, so the answer is printed as the
    // patient's words rather than as a reading. An answer must never disappear.
    const summary = projectSummary(rated("9"), "client_owner");
    const line = summary.clinical?.lines.find((l) => l.key === "custom-discomfort");
    expect(line?.scale).toBeNull();
    expect(line?.freeText).toBe(true);
    expect(summary.discomfortReported).toBe(false);
  });

  it("a custom CHOICE answer renders the label the patient tapped, not its stored value", () => {
    const index: CustomQuestionIndex = new Map([
      [
        "custom-travel",
        {
          label: "How are you getting here?",
          kind: "logistics" as const,
          type: "choice" as const,
          options: [
            { value: "car", label: "By car" },
            { value: "bus", label: "By bus" },
          ],
        },
      ],
    ]);
    const summary = projectSummary(
      response({ answers: [{ key: "custom-travel", value: "bus", kind: "logistics" }] }),
      "client_coordinator",
      index,
    );
    const line = summary.logistics.lines.find((l) => l.key === "custom-travel");
    expect(line?.answer).toBe("By bus");
    expect(line?.freeText, "a tapped option is not the patient's own words").toBe(false);
  });
});

// ===========================================================================
// THE CHECK ON THE OWNER'S DROPDOWN RUNS ON BOTH FORKS (W1-C/2).
//
// `admit` in project.ts scans a custom question's own words and says why: "a
// custom question the owner classified as 'logistics' and wrote as 'Is anything
// hurting before you come in?' is a symptom question whatever the dropdown said."
// That scan sits behind `if (fork !== "brief") return null`, because REFUSING the
// question is a brief-bank rule — the full bank exists to ask those questions.
//
// But the classification decides a second thing that is not fork-scoped: whether
// the patient's own words reach the practice manager. On the full bank that
// question was admitted unscanned, resolved to logistics from every source, and
// its answer landed in the section the front desk reads, with
// `flaggedForClinician: 0`.
// ===========================================================================
describe("a symptom-WORDED custom question is restricted on the FULL bank too", () => {
  const THROBBING = "my back molar has been throbbing all week and the gum is swollen";

  it("symptom-worded-custom-question-is-restricted-on-every-fork", () => {
    // Exactly the fixture project.test.ts uses for the brief fork, on the full one.
    const index: CustomQuestionIndex = new Map([
      ["custom-hurting", { label: "Is anything hurting before you come in?", kind: "logistics" as const, type: "textarea" as const }],
    ]);
    const manager = projectSummary(
      response({ answers: [{ key: "custom-hurting", value: THROBBING, kind: "logistics" }] }),
      "client_coordinator",
      index,
    );
    expect(manager.clinical, "the manager was handed a clinical section").toBeNull();
    expect(JSON.stringify(manager), "the patient's own symptom words reached the practice manager").not.toContain(THROBBING);
    expect(manager.flaggedForClinician, "the count that stands in for the words said there was nothing").toBe(1);

    // And the clinician, who may read it, still does.
    const clinician = projectSummary(
      response({ answers: [{ key: "custom-hurting", value: THROBBING, kind: "logistics" }] }),
      "client_clinician",
      index,
    );
    expect(clinician.clinical?.lines.map((l) => l.answer)).toContain(THROBBING);
  });

  it("an OPTION's words count too, exactly as they do in the projection (W3/3)", () => {
    // The label is innocuous and the symptom is in the answer the patient tapped.
    // Which option they chose is itself the disclosure.
    const index: CustomQuestionIndex = new Map([
      [
        "custom-visit-reason",
        {
          label: "How can we help at this visit?",
          kind: "logistics" as const,
          type: "choice" as const,
          options: [
            { value: "routine", label: "Just my usual check-up" },
            { value: "second", label: "A broken tooth" },
          ],
        },
      ],
    ]);
    const manager = projectSummary(
      response({ answers: [{ key: "custom-visit-reason", value: "second", kind: "logistics" }] }),
      "client_coordinator",
      index,
    );
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain("A broken tooth");
    expect(manager.flaggedForClinician).toBe(1);
  });

  it("and it is NOT a blanket ban: a real logistics question stays the manager's", () => {
    // The scan only moves a question whose own words read like a symptom question.
    // A practice question that reads like what it is stays where the front desk
    // can act on it, which is the whole point of them having it.
    const index: CustomQuestionIndex = new Map([
      ["custom-access", { label: "Do you need step-free access?", kind: "logistics" as const, type: "yesno" as const }],
    ]);
    const summary = projectSummary(
      response({ answers: [{ key: "custom-access", value: "yes", kind: "logistics" }] }),
      "client_coordinator",
      index,
    );
    expect(summary.logistics.lines.map((l) => l.key)).toEqual(["custom-access"]);
    expect(summary.flaggedForClinician).toBe(0);
  });

  it("a SHIPPED question's kind is never re-read from its words", () => {
    // The word list is deliberately over-broad and the shipped kinds are in-code
    // and authoritative, so the scan is custom-keys-only. `health-changed` is
    // logistics and stays logistics even with an index that names its key.
    const hostile: CustomQuestionIndex = new Map([
      ["health-changed", { label: "Is anything hurting?", kind: "logistics" as const }],
    ]);
    const summary = projectSummary(
      response({ answers: [{ key: "health-changed", value: "no", kind: "logistics" }] }),
      "client_coordinator",
      hostile,
    );
    expect(summary.logistics.lines.map((l) => l.key)).toEqual(["health-changed"]);
    expect(summary.flaggedForClinician).toBe(0);
  });
});

// ===========================================================================
// THE OTHER JSONB COLUMN. `answers` stopped being a cast in the wave-2 fix lane;
// `interest` was still `Array.isArray(...) ? (raw as ...) : []` three lines below
// it, which checks the ARRAY and nothing inside it.
// ===========================================================================
describe("the stored interest grid is read, not cast", () => {
  it("stored-interest-drops-what-it-cannot-read", () => {
    const rows = readStoredInterest([
      { treatment: "whitening", answer: "yes" },
      null,                                          // threw a TypeError out of a pure projection
      "implants",                                    // not an object at all
      { treatment: "veneers", answer: "yes" },       // near miss: the key is "veneers-bonding"
      { treatment: "implants", answer: "maybe" },    // an answer the grid never offers
      { answer: "yes" },                             // no treatment at all
      { treatment: "implants", answer: "not_now" },
    ]);
    expect(rows).toEqual([
      { treatment: "whitening", answer: "yes" },
      { treatment: "implants", answer: "not_now" },
    ]);
  });

  it("a null element no longer takes the record screen down with it", () => {
    // projectSummary is pure and both callers place it OUTSIDE their catch, so a
    // throw here is a 500 on the patient record rather than a degraded panel.
    const summary = projectSummary(
      response({ interest: readStoredInterest([null, { treatment: "whitening", answer: "yes" }]) }),
      "client_owner",
    );
    expect(summary.interest).toEqual([{ treatment: "whitening", label: "Whitening", answer: "yes" }]);
  });

  it("a near-miss treatment never reaches a clinician or the co-pilot as a real one", () => {
    // The `treatment_interest` table has a CHECK on both columns; this jsonb copy
    // of the same fact had none, so "veneers"/"maybe" rendered as a treatment the
    // practice offers and was handed to a model by the previsit_summary tool.
    const summary = projectSummary(
      response({ interest: readStoredInterest([{ treatment: "veneers", answer: "maybe" }]) }),
      "client_owner",
    );
    expect(summary.interest).toEqual([]);
  });

  it("a non-array column is an empty grid, not a crash", () => {
    for (const junk of [null, undefined, {}, "", 7]) {
      expect(readStoredInterest(junk)).toEqual([]);
    }
  });
});

describe("the screens that read a summary resolve the practice's own questions", () => {
  const REPO = process.cwd();

  it("the patient RECORD goes through previsitSummaryFor, not the bare projection", () => {
    // The defect was a caller forgetting the third argument. The record screen is
    // the surface ruling W1-C/2 is about, so it is pinned by name: it must call the
    // resolving entry point, and must not call the pure projection directly.
    const src = readFileSync(
      join(REPO, "src/components/client/patients/record/record-tab-content.tsx"),
      "utf8",
    );
    expect(src).toContain('from "@/lib/triage/summary-read"');
    expect(src).toMatch(/previsitSummaryFor\(\{/);
    expect(src).toContain("clientId: client.id");
    expect(src, "the record screen calls the unresolved projection").not.toMatch(
      /projectSummary\(/,
    );
  });

  it("an unreadable bank config degrades to restricted rather than to a blank screen", () => {
    // customQuestionsFor swallows the read failure and returns an empty index; with
    // an empty index the projection still has the stamped kind, and an answer with
    // no usable kind is a symptom. Asserted on the projection, which is the thing
    // that would leak.
    const manager = projectSummary(
      response({ answers: readStoredAnswers([{ key: "custom-unresolvable", value: "aching" }]) }),
      "client_coordinator",
    );
    expect(manager.clinical).toBeNull();
    expect(JSON.stringify(manager)).not.toContain("aching");
  });
});

describe("the summary RENDERS", () => {
  /**
   * Markup carries HTML entities, so an apostrophe in the copy renders as &#x27;
   * and a naive `toContain` on the source string fails for the wrong reason.
   * Compare on the text a reader actually sees.
   */
  function text(markup: string): string {
    return markup
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
      .replace(/&amp;/g, "&");
  }

  function render(role: Role | null, resp = response(), failed = false): string {
    return renderToStaticMarkup(
      createElement(PreVisitSummaryPanel, {
        failed,
        summary: failed ? null : projectSummary(resp, role),
      }),
    );
  }

  it("shows the answers to a clinician, in the patient's own words", () => {
    const markup = render("client_clinician");
    expect(markup).toContain("What the patient shared before this visit");
    expect(markup).toContain("grumbling");
    expect(markup).toContain("Something is bothering me");
  });

  it("does NOT show them to the practice manager, and says why", () => {
    const markup = render("client_coordinator");
    expect(markup, "the patient's words leaked to the manager").not.toContain("grumbling");
    expect(markup).not.toContain("Something is bothering me");
    expect(markup).toContain("A clinician can see what they said");
    // ...but she does see the logistics half and the grid.
    expect(markup).toContain("Are you still able to come to your appointment?");
    expect(markup).toContain("Whitening");
  });

  it("prints the provenance line BEFORE any answer", () => {
    // A clinician reading "8 out of 10" three inches under a Dentally-mirrored
    // appointment list must be told which of those two things they are looking at.
    const markup = text(render("client_clinician"));
    expect(markup.indexOf(SUMMARY_COPY.provenance)).toBeGreaterThan(-1);
    expect(markup.indexOf(SUMMARY_COPY.provenance)).toBeLessThan(markup.indexOf("grumbling"));
    expect(SUMMARY_COPY.provenance).toMatch(/not a clinical assessment/i);
  });

  it("shows the discomfort prompt to every role that can open the record", () => {
    for (const role of ALL_RECORD_ROLES) {
      expect(render(role), `${role} did not see the discomfort prompt`).toContain(SUMMARY_COPY.discomfort);
    }
  });

  it("prints a refusal as plainly as a yes", () => {
    // A patient who said no was ASKED, and a panel showing only the yeses would
    // invite the practice to ask them again next month.
    expect(render("client_owner")).toContain("not right now");
  });

  it("renders NOTHING when no answers have been captured", () => {
    const markup = renderToStaticMarkup(createElement(PreVisitSummaryPanel, { summary: null }));
    expect(markup).toBe("");
  });

  it("a FAILED read says so, and is not the same screen as 'none captured'", () => {
    const markup = text(render("client_owner", response(), true));
    expect(markup).toContain(SUMMARY_COPY.readFailed);
    expect(SUMMARY_COPY.readFailed).toMatch(/failure to read them, not a finding/i);
    expect(SUMMARY_COPY.none).toMatch(/not a finding that they had nothing/i);
    expect(SUMMARY_COPY.readFailed).not.toBe(SUMMARY_COPY.none);
  });
});
