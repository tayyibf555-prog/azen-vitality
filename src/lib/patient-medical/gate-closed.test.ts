// ===========================================================================
// THE GATE, PROVED SHUT — end to end, with the REAL repository.
//
// gate.test.ts proves what isMedicalHistoryEnabled() returns. route.test.ts
// proves the route answers 503. Neither proves the claim this whole build rests
// on:
//
//     WITH MEDICAL_HISTORY_ENABLED UNSET, NOTHING CAN READ OR WRITE THE RECORD.
//
// So this file does the opposite of both. MEDICAL_HISTORY_ENABLED is DELETED, not
// stubbed to "false" (the shipped state is the variable ABSENT, and a `=== "false"`
// written where `!== "true"` was meant would pass every stubbed test while shipping
// on). The repository is REAL. And serviceClient — the only door to the database in
// this module — is replaced by a tripwire that throws if it is so much as
// constructed. A read or write that reached Postgres would have to call it, so if
// the tripwire never fires, no statement was ever sent.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const tripwire = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => {
    tripwire.calls += 1;
    throw new Error("TRIPWIRE: serviceClient() was constructed while medical history was switched off");
  },
  anonServerClient: () => {
    tripwire.calls += 1;
    throw new Error("TRIPWIRE: anonServerClient() was constructed while medical history was switched off");
  },
}));

import {
  saveQuestionnaire,
  latestQuestionnaire,
  listQuestionnaires,
  retractQuestionnaire,
  recordReview,
  listReviews,
  latestReview,
  getSummary,
  listOutstandingReviews,
  MedicalDisabledError,
  type MedicalScope,
  type NewQuestionnaire,
  type NewReview,
} from "./repository";
import { isMedicalHistoryEnabled, canCaptureMedicalHistory } from "./gate";
import { QUESTION_BANK_VERSION } from "./questions";
import type { MedicalClinician } from "./types";

const SCOPE: MedicalScope = { siteId: "site-cc", patientId: "p1" };
const CLINICIAN: MedicalClinician = { id: "u1", name: "Blerta Hoxha", gdcNumber: null };

const NEW_QUESTIONNAIRE: NewQuestionnaire = {
  answers: [{ key: "diabetes", answer: "no", detail: null }],
  questionBankVersion: QUESTION_BANK_VERSION,
  patientName: "Alex Berry",
  medicationsText: null,
  allergiesText: null,
  signature: { method: "typed", value: "Alex Berry", signedAt: "2026-08-01T09:00:00.000Z" },
  capturedVia: "public-link",
  recordedAt: "2026-08-01T09:00:00.000Z",
  author: null,
  supersedesId: null,
  amendmentReason: null,
};

const NEW_REVIEW: NewReview = {
  outcome: "no-changes",
  reviewedAt: "2026-08-02T09:00:00.000Z",
  appointmentId: "a1",
  questionnaireId: "q1",
  author: CLINICIAN,
};

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MEDICAL_HISTORY_ENABLED;
  delete process.env.MEDICAL_HISTORY_ENABLED;
  tripwire.calls = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MEDICAL_HISTORY_ENABLED;
  else process.env.MEDICAL_HISTORY_ENABLED = saved;
});

describe("the shipped default", () => {
  it("is off when the variable is absent from the environment entirely", () => {
    expect("MEDICAL_HISTORY_ENABLED" in process.env).toBe(false);
    expect(isMedicalHistoryEnabled()).toBe(false);
    expect(canCaptureMedicalHistory()).toBe(false);
  });
});

describe("with medical history off, no write reaches the database", () => {
  const writes: [string, () => Promise<unknown>][] = [
    ["saveQuestionnaire", () => saveQuestionnaire(SCOPE, NEW_QUESTIONNAIRE)],
    ["recordReview", () => recordReview(SCOPE, NEW_REVIEW)],
    ["retractQuestionnaire", () => retractQuestionnaire(SCOPE, "q1", "wrong patient", CLINICIAN)],
  ];

  it.each(writes)("%s throws MedicalDisabledError and never opens a client", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(MedicalDisabledError);
    expect(tripwire.calls).toBe(0);
  });

  /**
   * The amendment is the subtle one. It reads the record it supersedes BEFORE it
   * writes, so a gate placed after that read would leak a clinical record out of a
   * switched-off feature while still refusing the write.
   */
  it("refuses an amendment before it reads the record it would supersede", async () => {
    await expect(
      saveQuestionnaire(SCOPE, { ...NEW_QUESTIONNAIRE, supersedesId: "q1", amendmentReason: "updated" }),
    ).rejects.toBeInstanceOf(MedicalDisabledError);
    expect(tripwire.calls).toBe(0);
  });
});

describe("with medical history off, no read reaches the database either", () => {
  const reads: [string, () => Promise<unknown>][] = [
    ["latestQuestionnaire", () => latestQuestionnaire(SCOPE)],
    ["listQuestionnaires", () => listQuestionnaires(SCOPE)],
    ["listReviews", () => listReviews(SCOPE)],
    ["latestReview", () => latestReview(SCOPE)],
    ["getSummary", () => getSummary(SCOPE)],
    ["listOutstandingReviews", () => listOutstandingReviews(["site-cc"])],
  ];

  it.each(reads)("%s throws rather than returning an empty result", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(MedicalDisabledError);
    expect(tripwire.calls).toBe(0);
  });
});

describe("a mistyped flag does not open the gate", () => {
  it.each(["1", "TRUE", "True", "yes", "on", " true", "true ", "", "false", "0", "null", "undefined"])(
    "MEDICAL_HISTORY_ENABLED=%j still refuses every write with the client untouched",
    async (value) => {
      process.env.MEDICAL_HISTORY_ENABLED = value;
      expect(isMedicalHistoryEnabled()).toBe(false);
      await expect(saveQuestionnaire(SCOPE, NEW_QUESTIONNAIRE)).rejects.toBeInstanceOf(MedicalDisabledError);
      await expect(recordReview(SCOPE, NEW_REVIEW)).rejects.toBeInstanceOf(MedicalDisabledError);
      expect(tripwire.calls).toBe(0);
    },
  );
});

/**
 * The counter-test, and the reason the rest of this file means anything. If the
 * tripwire could never fire, every assertion above would pass on a gate that had
 * been deleted. Switching the flag ON must reach serviceClient() and trip it.
 */
describe("the tripwire is armed", () => {
  it("fires the moment medical history is switched on, which is what makes the silence above evidence", async () => {
    process.env.MEDICAL_HISTORY_ENABLED = "true";
    expect(isMedicalHistoryEnabled()).toBe(true);
    await expect(saveQuestionnaire(SCOPE, NEW_QUESTIONNAIRE)).rejects.toThrow(/TRIPWIRE/);
    expect(tripwire.calls).toBe(1);

    tripwire.calls = 0;
    await expect(latestQuestionnaire(SCOPE)).rejects.toThrow(/TRIPWIRE/);
    expect(tripwire.calls).toBe(1);
  });
});
