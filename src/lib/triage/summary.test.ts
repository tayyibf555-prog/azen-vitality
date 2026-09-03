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
import { FORBIDDEN_PATIENT_WORDS } from "./forbidden";
import { PreVisitSummaryPanel } from "@/components/client/patients/record/previsit-summary-panel";
import type { Role } from "@/lib/types";
import type { TriageResponse } from "./types";

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
      { key: "attending", value: "yes" },
      { key: "health-changed", value: "no" },
      { key: "visit-reason", value: "something-bothering" },
      { key: "concern-words", value: "the back one on the left has been grumbling" },
      { key: "pain-now", value: "8" },
      { key: "gums-bleed", value: "yes" },
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
      response({ answers: [{ key: "pain-now", value: String(DISCOMFORT_NOTICE_THRESHOLD - 1) }] }),
      "client_owner",
    );
    expect(below.discomfortReported).toBe(false);
    const at = projectSummary(
      response({ answers: [{ key: "pain-now", value: String(DISCOMFORT_NOTICE_THRESHOLD) }] }),
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
    const summary = projectSummary(response({ answers: [{ key: "custom-gone", value: "something" }] }), "client_owner");
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
      response({ answers: [{ key: "interest-grid", value: "x" }, { key: "attending", value: "yes" }] }),
      "client_owner",
    );
    const all = [...summary.logistics.lines, ...(summary.clinical?.lines ?? [])];
    expect(all.map((l) => l.key)).not.toContain("interest-grid");
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
