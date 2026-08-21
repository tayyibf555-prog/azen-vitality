import { describe, it, expect } from "vitest";
import {
  ACCOUNT_COPY,
  CANNOT_READ_COPY,
  CHART_COPY,
  CORRESPONDENCE_COPY,
  EMPTY_COPY,
  FAILED_COPY,
  PATIENT_TABS,
  PATIENT_TAB_SLUGS,
  defaultPatientTabForRole,
  isPatientTab,
  partialCorrespondenceCopy,
  patientTab,
  patientTabHref,
} from "./tabs";
import { PATIENT_ADMIN_ROLES } from "./roles";
import { PATIENT_SEND_SITES } from "@/lib/inbox/send-sites";

describe("the eleven tabs", () => {
  it("are in Dentally's exact order", () => {
    expect([...PATIENT_TAB_SLUGS]).toEqual([
      "details",
      "medical",
      "chart",
      "appointments",
      "recalls",
      "notes",
      "account",
      "perio",
      "correspondence",
      "tasks",
      "audit",
    ]);
  });

  it("has one definition per slug, in the same order", () => {
    expect(PATIENT_TABS.map((t) => t.slug)).toEqual([...PATIENT_TAB_SLUGS]);
    for (const slug of PATIENT_TAB_SLUGS) {
      expect(patientTab(slug).slug).toBe(slug);
      expect(patientTab(slug).label.length).toBeGreaterThan(0);
    }
  });

  it("recognises only those eleven slugs", () => {
    expect(isPatientTab("appointments")).toBe(true);
    expect(isPatientTab("Appointments")).toBe(false);
    expect(isPatientTab("charting")).toBe(false);
    expect(isPatientTab("")).toBe(false);
  });

  it("puts Details at the record root rather than at /details", () => {
    expect(patientTabHref("/c/vitality/patients/42", "details")).toBe("/c/vitality/patients/42");
    expect(patientTabHref("/c/vitality/patients/42", "perio")).toBe("/c/vitality/patients/42/perio");
  });
});

// The test that stops the three honesty sentences drifting into each other.
describe("the honesty copy", () => {
  const unreadable = PATIENT_TABS.filter((t) => t.availability === "unreadable");

  // Chart LEFT this set the day it started rendering from
  // /v1/treatment_plan_items. MEDICAL LEFT IT TOO, for the perio reason not the
  // chart's: Dentally's /v1/medical_histories endpoint EXISTS but is permanently
  // empty for this practice, and patient.medical_alert IS readable, so the tab is
  // "partial" and AUTHORS its own questionnaire + review screen. Only perio, with no
  // Dentally periodontal endpoint of any kind, is left with no source at all.
  it("leaves only Perio with no source at all", () => {
    expect(unreadable.map((t) => t.slug)).toEqual(["perio"]);
  });

  it("moves Chart to partial, and drops its promise to write back to Dentally", () => {
    expect(patientTab("chart").availability).toBe("partial");
    expect(patientTab("chart").cannotRead).toBe("");
    expect(patientTab("chart").willHold).toBe("");
  });

  it("moves Medical to partial, blanks its cannot-read sentence, and drops its old willHold", () => {
    // Its old cannotRead asserted "no client method, no endpoint, no table, no
    // column" - every clause now false. The honesty for the switched-off feature
    // moved to MEDICAL_COPY (its own gated screen); the tab entry carries none.
    expect(patientTab("medical").availability).toBe("partial");
    expect(patientTab("medical").cannotRead).toBe("");
    expect(patientTab("medical").willHold).toBe("");
  });

  it.each(unreadable)("$slug says it cannot read, and never that there is none", (tab) => {
    expect(tab.cannotRead).toContain("cannot read");
    // "recorded" and "none" are the two words that turn "we cannot read this" into
    // "this patient has none of this", which is the confusion the rule forbids.
    expect(tab.cannotRead.toLowerCase()).not.toContain("recorded");
    expect(tab.cannotRead.toLowerCase()).not.toContain("none");
    expect(tab.willHold.length).toBeGreaterThan(0);
  });

  it("keeps the empty and failed sentences distinct for every stream that has both", () => {
    expect(EMPTY_COPY.appointments).not.toBe(FAILED_COPY.appointments);
    expect(EMPTY_COPY.dentallyNotes).not.toBe(FAILED_COPY.dentallyNotes);
    expect(EMPTY_COPY.plans).not.toBe(FAILED_COPY.plans);
    expect(EMPTY_COPY.invoices).not.toBe(FAILED_COPY.invoices);
  });

  it("phrases the correspondence and audit empties so they cannot be read too widely", () => {
    // "No messages" alone would read as "this patient has never been contacted".
    expect(EMPTY_COPY.correspondence).toContain("from this platform");
    // "No changes" alone would read as "nothing has ever happened to this record".
    expect(EMPTY_COPY.audit).toContain("through this platform");
  });

  it("sends the reader to the inbox from the correspondence EMPTY state, not only the failed one", () => {
    // THE HOLD. This panel can be empty for a patient texted minutes ago: a message
    // sent to a number identifyByPhone could not match is filed under lead:<number>,
    // and the record read (loadAgentMessagesForPatient) only ever looks under the
    // Dentally id. Identification matches on mobile_phone alone, so a landline, a
    // work number or a shared family number misses, and the missed-call lookup is
    // capped at 3 seconds. Without this pointer the emptiest screen made the widest
    // claim, in writing, on a clinical record.
    for (const empty of [EMPTY_COPY.correspondence, EMPTY_COPY.correspondenceWithDentally]) {
      expect(empty).toContain("Conversations inbox");
      expect(empty).toContain("could not be matched to this record");
      expect(empty.toLowerCase()).toContain("before assuming this patient has not been contacted");
    }
    // The same instruction the FAILED sentence gives, for the same reason.
    expect(FAILED_COPY.correspondence).toContain("Conversations inbox");
    // Still a DIFFERENT sentence from the failed one: an outage and an empty read
    // are not the same claim, which is the older rule this must not undo.
    expect(EMPTY_COPY.correspondence).not.toBe(FAILED_COPY.correspondence);
  });

  it("phrases the Dentally clinical-notes empty as a fact about the CONNECTION", () => {
    // "No clinical notes in Dentally" is a claim about the patient's record in
    // another system, made on the strength of one endpoint (/v1/notes) that we
    // read read-only and have never been able to write to. On a clinical screen
    // that overclaim is the whole risk: a clinician reads it as "nothing has been
    // written about this patient" rather than "nothing reached us".
    const s = EMPTY_COPY.dentallyNotes;
    expect(s).toBe("No clinical notes have come through from Dentally for this patient.");
    expect(s).toContain("come through from Dentally");
    expect(s).not.toBe("No clinical notes in Dentally.");
    // Still a DIFFERENT sentence from the failed one, which is the older rule
    // this must not undo: an outage must never print the empty state.
    expect(s).not.toBe(FAILED_COPY.dentallyNotes);
  });

  it("explains, on the account tab, that the three money figures need not subtract", () => {
    const s = ACCOUNT_COPY.reconciliation;
    // Names all three headline figures, so the reader knows exactly which numbers the
    // caveat is about.
    expect(s).toContain("Total invoiced");
    expect(s).toContain("Total paid");
    expect(s).toContain("Balance");
    // States the numbers are each correct and Dentally-sourced, not that one is wrong.
    expect(s).toContain("read from Dentally");
    // Never claims the patient owes or has paid nothing.
    expect(s.toLowerCase()).not.toContain("none");
  });

  it("keeps the medical flag's neutral wording, now the header pill's failed-read label", () => {
    // The header no longer renders this permanently - it computes a three-state pill
    // (medicalHeaderPill) and uses this exact wording only for the failed-read state.
    // The value is pinned here so that pill label and this constant cannot drift.
    expect(CANNOT_READ_COPY.medicalHistoryFlag).toBe("Medical history not read");
  });

  // The Account tab used to tell the reader that Dentally's payments endpoint
  // "cannot be filtered to one patient". A read-only probe on 2026-08-03 returned
  // exactly one patient's payments from ?patient_id=, and each row carried the
  // invoices it was allocated against. Blaming the supplier for our own unbuilt
  // read closes a question that is in fact open, so the sentence is pinned here.
  it("does not claim Dentally's payments cannot be filtered to one patient", () => {
    const s = CANNOT_READ_COPY.payments;
    expect(s).not.toContain("cannot be filtered");
    expect(s).not.toContain("whole site's payment history");
    expect(s).toContain("not shown here yet");
    expect(s).toContain("Dentally does return this patient's payments");
  });

  it("uses British English and no em-dash anywhere in the copy", () => {
    const all = [
      ...PATIENT_TABS.flatMap((t) => [t.cannotRead, t.willHold, t.label]),
      ...Object.values(EMPTY_COPY),
      ...Object.values(FAILED_COPY),
      ...Object.values(CANNOT_READ_COPY),
      // Added in the same edit as CHART_COPY itself, or the new sentences go
      // entirely unswept.
      ...Object.values(CHART_COPY),
      // The Account tab's reconciliation sentence, swept for the same house rules.
      ...Object.values(ACCOUNT_COPY),
      // The Correspondence tab's scope + status sentences, added in the same edit
      // as CORRESPONDENCE_COPY itself, or the new sentences go entirely unswept.
      ...Object.values(CORRESPONDENCE_COPY),
      partialCorrespondenceCopy(["Recall", "Campaign"]),
    ];
    for (const s of all) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\borganiz|\bcolor\b|\bcanceled\b/);
    }
  });
});

/**
 * The chart's own copy.
 *
 * The chart is the one screen in the record that renders a picture of the
 * patient's mouth, so a sentence missing here is not a copy nit: an empty perio
 * region reads as "no findings" when the truth is "not available here".
 */
describe("the chart copy", () => {
  // Scoped to these seven BY NAME, never a blanket sweep of CANNOT_READ_COPY:
  // the existing medicalHistoryFlag ("Medical history not read") and
  // dentallyTasks ("is not readable.") would both fail one, and widening the
  // sweep to make them pass would weaken it for the keys that matter.
  const CHART_KEYS = [
    "bpe",
    "perioOnChart",
    "toothStatus",
    "chartImages",
    "cloudGallery",
    "baseChartStatus",
    "chartHistoryScope",
  ] as const;

  it.each(CHART_KEYS)("%s says it cannot read, names Dentally, and claims nothing", (key) => {
    const s = CANNOT_READ_COPY[key];
    expect(s).toContain("cannot read");
    expect(s).toContain("Dentally");
    // The two words that turn "we cannot read this" into "this patient has
    // none of this", which is the confusion the whole rule exists for.
    expect(s.toLowerCase()).not.toContain("recorded");
    expect(s.toLowerCase()).not.toContain("none");
  });

  it("tells a clinician to check Dentally before treating, on the perio sentence", () => {
    expect(CANNOT_READ_COPY.perioOnChart).toContain("Check Dentally before treating this patient");
  });

  it("keeps the chart's empty and failed sentences distinct, for every stream that has both", () => {
    expect(EMPTY_COPY.chartItems).not.toBe(FAILED_COPY.chartItems);
    expect(EMPTY_COPY.chartDraft).not.toBe(FAILED_COPY.chartDraft);
    expect(FAILED_COPY.treatments).not.toBe(FAILED_COPY.chartItems);
    expect(FAILED_COPY.plans).not.toBe(FAILED_COPY.chartItems);
  });

  it("says the empty chart is empty IN DENTALLY, and that it is not a statement about the teeth", () => {
    expect(EMPTY_COPY.chartItems).toContain("in Dentally");
    expect(EMPTY_COPY.chartItems).toContain("not tooth status");
  });

  it("names Dentally as the place charting is authored, on the blocked write control", () => {
    expect(CHART_COPY.writeBlockedTitle).toContain("Dentally");
    expect(CHART_COPY.writeBlockedTitle.toLowerCase()).toContain("authored in dentally");
  });

  it("has a sentence for every honesty signal the chart renders, so none of them lives in JSX", () => {
    for (const key of [
      "planTemplates",
      "historyExport",
      "truncated",
      "truncatedCatalogue",
      "unreadSurfaces",
      "staleness",
      "offArch",
      "unplaced",
      "draftDisabled",
      "draftSaveFailed",
      "socketStatus",
    ] as const) {
      expect(CHART_COPY[key].length).toBeGreaterThan(0);
    }
  });

  // A truncated CATALOGUE and a truncated CHART are different facts, and they
  // shared one sentence and one flag until the read was split. The always-on
  // version of the patient sentence is the failure: a caveat printed on every
  // patient forever is a caveat that gets read as furniture.
  it("says a truncated treatment list is about the LIST and not about the patient", () => {
    expect(CHART_COPY.truncated).not.toBe(CHART_COPY.truncatedCatalogue);
    expect(CHART_COPY.truncated).toContain("this patient's chart");
    expect(CHART_COPY.truncatedCatalogue).toContain("treatment list");
    expect(CHART_COPY.truncatedCatalogue).toContain("chart itself is unaffected");
  });

  it("keeps the chart's BPE marker in words, in the same shape as the medical flag", () => {
    expect(CANNOT_READ_COPY.bpeFlag).toBe("BPE not read");
  });

  it("opens every role we actually have on Details, because there is no practitioner role yet", () => {
    for (const role of PATIENT_ADMIN_ROLES) {
      expect(defaultPatientTabForRole(role)).toBe("details");
    }
    expect(defaultPatientTabForRole(null)).toBe("details");
    // DENTALLY.md:114's behaviour, named and tested, waiting on the role.
    expect(defaultPatientTabForRole("client_practitioner")).toBe("chart");
  });
});

describe("the correspondence copy", () => {
  /**
   * A SENTENCE HERE WAS FALSE FOR MONTHS. The tab stated "Dentally does not expose
   * its correspondence through the connection we have." Dentally does: /v1/sms
   * returns a patient's message history on a scope the practice's key already
   * carries. The sentence was true-sounding, written in good faith as the honest
   * answer to a real question, and never re-checked - the same shape of defect as
   * the invented /v1/patient_notes path.
   *
   * These tests hold the replacement to the property that makes it durable: it
   * describes THIS SCREEN, never what Dentally can or cannot do.
   */
  it("no longer claims Dentally cannot expose its correspondence", () => {
    const all = Object.values(CANNOT_READ_COPY).join(" ").toLowerCase();
    expect(all).not.toContain("dentally does not expose its correspondence");
    expect(CANNOT_READ_COPY).not.toHaveProperty("dentallyCorrespondence");
  });

  it("states in both scope sentences that nothing is written back to Dentally", () => {
    // THE operationally load-bearing sentence. Without it a colleague working in
    // Dentally sees an empty correspondence page and concludes the patient was
    // never contacted.
    for (const scope of [CORRESPONDENCE_COPY.scopePlatformOnly, CORRESPONDENCE_COPY.scopeWithDentally]) {
      expect(scope.toLowerCase()).toContain("written back");
      expect(scope.toLowerCase()).toContain("dentally");
    }
  });

  it("names the modules it covers, so 'from this platform' is not a vague claim", () => {
    const scope = CORRESPONDENCE_COPY.scopePlatformOnly.toLowerCase();
    for (const named of ["recall", "reactivation", "aftercare", "balance", "review", "campaign"]) {
      expect(scope, `scope sentence omits ${named}`).toContain(named);
    }
  });

  it("names the four senders that used to be missing from it entirely", () => {
    // The sentence said "every message this platform has sent" while the missed-call
    // callback, the no-show reply, the aftercare acknowledgement and the co-pilot's
    // own send appeared nowhere on the screen. Naming them is what makes the claim
    // checkable by the person reading it rather than only by a test.
    for (const scope of [CORRESPONDENCE_COPY.scopePlatformOnly, CORRESPONDENCE_COPY.scopeWithDentally]) {
      const lower = scope.toLowerCase();
      expect(lower, "the missed-call callback is unnamed").toContain("missed call");
      expect(lower, "a colleague's own send is unnamed").toContain("co-pilot");
      expect(lower, "the confirmation reply is unnamed").toContain("appointment confirmations");
      expect(lower, "the aftercare acknowledgement is unnamed").toContain("aftercare");
    }
  });

  it("is only ALLOWED to say 'every message this platform has sent' because every send site is recorded", () => {
    // The claim and its evidence, pinned together. SEND_SITES is derived from a crawl
    // of every sendMessage call in the tree (src/lib/inbox/send-sites.test.ts), so if a
    // new patient-facing sender ships with nowhere to land, this sentence stops being
    // true and this test says so — rather than the screen going on asserting it.
    const unrecorded = PATIENT_SEND_SITES.filter((s) => !s.recordedIn?.length).map((s) => s.file);
    expect(
      unrecorded,
      `the scope sentence claims completeness, but these sends reach no source it reads: ${unrecorded.join(", ")}`,
    ).toEqual([]);
    for (const scope of [CORRESPONDENCE_COPY.scopePlatformOnly, CORRESPONDENCE_COPY.scopeWithDentally]) {
      expect(scope).toContain("Every message this platform has sent to this patient");
    }
  });

  it("does NOT let 'recorded' pass for 'on this patient's record', and names the exception", () => {
    // The registry proves each send lands in the agent store. It does NOT prove the
    // row lands under THIS patient: the four out-of-band senders key theirs from
    // identifyByPhone, and a miss files it under lead:<number>, which the record read
    // never looks at. Every trigger is routine (mobile_phone-only matching, a 3s
    // lookup cap), and nothing re-keys it afterwards, so the scope sentence has to
    // carry the exception rather than let the reader infer completeness.
    for (const scope of [CORRESPONDENCE_COPY.scopePlatformOnly, CORRESPONDENCE_COPY.scopeWithDentally]) {
      expect(scope, "the scope sentence still claims an unqualified completeness").toContain(
        "The one exception is a message sent to a number that could not be matched to this record",
      );
      expect(scope).toContain("Conversations inbox");
    }
  });

  it("explains the outbound exception where a reader is scanning the list", () => {
    const note = CORRESPONDENCE_COPY.unmatchedNumbers.toLowerCase();
    // The three routine triggers, so this reads as a thing that happens rather than
    // a disclaimer: two number shapes identification cannot match, and the timeout.
    expect(note).toContain("landline");
    expect(note).toContain("shared family number");
    expect(note).toContain("lookup is slow");
    // Where to go instead, and the fact the runbook got wrong.
    expect(note).toContain("conversations inbox");
    expect(note, "the note implies it migrates onto the record later; it does not").toContain(
      "does not move onto this record later",
    );
  });

  it("does NOT extend the same completeness claim to what the patient sent back", () => {
    // The received half has two structural exceptions. The old sentence covered both
    // halves in one breath ("sent to this patient or received from them"), which made
    // the screen assert something untrue about a reply nobody could see.
    for (const scope of [CORRESPONDENCE_COPY.scopePlatformOnly, CORRESPONDENCE_COPY.scopeWithDentally]) {
      expect(scope.toLowerCase()).not.toContain("or received from them");
      expect(scope.toLowerCase()).toContain("two exceptions");
    }
  });

  it("names those two exceptions on the screen, in words a receptionist can act on", () => {
    const gaps = CORRESPONDENCE_COPY.inboundGaps.toLowerCase();
    expect(gaps).toContain("waitlist");
    expect(gaps).toContain("stop");
    // Actionable, not merely honest: where to look instead.
    expect(gaps).toContain("no-show list");
    expect(gaps).toContain("opt-out list");
  });

  it("states the 400-row ceiling as tested copy, not as a bare string in the JSX", () => {
    expect(CORRESPONDENCE_COPY.boundedRows).toContain("400");
    expect(CORRESPONDENCE_COPY.boundedRows.toLowerCase()).toContain("oldest");
  });

  it("only claims Dentally's SMS is included in the WITH-Dentally sentence", () => {
    expect(CORRESPONDENCE_COPY.scopePlatformOnly.toLowerCase()).toContain("not shown on this screen");
    expect(CORRESPONDENCE_COPY.scopeWithDentally.toLowerCase()).toContain("also included");
  });

  it("keeps 'Dentally could not be read' distinct from 'Dentally has none'", () => {
    expect(CORRESPONDENCE_COPY.dentallyFailed).not.toBe(EMPTY_COPY.correspondenceWithDentally);
    expect(CORRESPONDENCE_COPY.dentallyFailed.toLowerCase()).toContain("could not be read");
    expect(CORRESPONDENCE_COPY.dentallyFailed.toLowerCase()).not.toContain("no messages");
  });

  it("makes the wider empty claim ONLY in the Dentally-read variant", () => {
    expect(EMPTY_COPY.correspondence).not.toContain("Dentally");
    expect(EMPTY_COPY.correspondenceWithDentally).toContain("Dentally");
    expect(EMPTY_COPY.correspondence).not.toBe(EMPTY_COPY.correspondenceWithDentally);
  });

  it("does not contradict a visible list when only the PLATFORM half failed", () => {
    // The all-failed sentence says "we could not read this patient's message
    // history". Printed above a visible list of Dentally's messages that reads as a
    // contradiction, and a reader resolves a contradiction by believing the list.
    expect(CORRESPONDENCE_COPY.platformFailedDentallyOk).not.toBe(FAILED_COPY.correspondence);
    expect(CORRESPONDENCE_COPY.platformFailedDentallyOk).toContain("This platform's own message history");
    expect(CORRESPONDENCE_COPY.platformFailedDentallyOk).toContain("Only Dentally's messages are shown");
    // Still carries the instruction that makes a failed read actionable.
    expect(CORRESPONDENCE_COPY.platformFailedDentallyOk).toContain("Conversations inbox");
  });

  it("says what Sent does and does not mean", () => {
    // A green "Sent" beside a message is read as "the patient knows". It means the
    // network accepted it, which is a materially weaker fact.
    expect(CORRESPONDENCE_COPY.sentMeaning.toLowerCase()).toContain("not that the patient read it");
    expect(CORRESPONDENCE_COPY.sentMeaning.toLowerCase()).toContain("not delivered");
  });

  it("explains why an approved-but-unsent or rejected draft is absent", () => {
    expect(CORRESPONDENCE_COPY.draftsExcluded.toLowerCase()).toContain("not shown");
    expect(CORRESPONDENCE_COPY.draftsExcluded.toLowerCase()).toContain("worklist");
  });
});

describe("partialCorrespondenceCopy", () => {
  it("NAMES the source that failed, so the reader knows where to look", () => {
    const s = partialCorrespondenceCopy(["Recall"]);
    expect(s).toContain("Recall");
    expect(s).toContain("could not be read");
  });

  it("joins several with an 'and' rather than dumping a comma list", () => {
    expect(partialCorrespondenceCopy(["Recall", "Campaign", "Balance reminder"])).toContain(
      "Recall, Campaign and Balance reminder",
    );
  });

  it("agrees its pronoun with the count", () => {
    expect(partialCorrespondenceCopy(["Recall"])).toContain("from it");
    expect(partialCorrespondenceCopy(["Recall", "Campaign"])).toContain("from them");
  });

  it("warns the list is not complete, which is the whole reason it is shown", () => {
    expect(partialCorrespondenceCopy(["Recall"]).toLowerCase()).toContain(
      "do not read this as a complete history",
    );
  });

  it("falls back to the generic sentence rather than an empty one", () => {
    expect(partialCorrespondenceCopy([])).toBe(FAILED_COPY.partialCorrespondence);
  });
});
