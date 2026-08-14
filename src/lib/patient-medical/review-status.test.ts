import { describe, it, expect } from "vitest";
import { medicalHeaderPill, medicalReviewStatus } from "./review-status";

// ===========================================================================
// THE RULE, tested exhaustively — it is the legal decision this whole feature
// turns on, and it lives in a pure function precisely so a test can hold it.
// ===========================================================================

const NOW = "2026-08-14T12:00:00.000Z";
// London is BST on this date, so an appointment "today" spans this UTC window.
const TODAY = "2026-08-14T09:00:00.000Z";
const TOMORROW = "2026-08-15T09:00:00.000Z";
const YESTERDAY = "2026-08-13T09:00:00.000Z";

describe("medicalReviewStatus", () => {
  it("is never-captured when no questionnaire has ever been captured here", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: null,
        latestReviewAt: null,
        appointments: [{ start: TOMORROW }],
        now: NOW,
      }),
    ).toBe("never-captured");
  });

  it("is review-due when a questionnaire exists, an appointment is today or upcoming, and nothing has been reviewed since capture", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: null,
        appointments: [{ start: TOMORROW }],
        now: NOW,
      }),
    ).toBe("review-due");
  });

  it("counts an appointment TODAY as upcoming, even one earlier today than now", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: null,
        appointments: [{ start: TODAY }],
        now: NOW,
      }),
    ).toBe("review-due");
  });

  it("is up-to-date when a review happened at or after the latest questionnaire", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: "2026-08-10T10:00:00.000Z",
        appointments: [{ start: TOMORROW }],
        now: NOW,
      }),
    ).toBe("up-to-date");
  });

  it("is review-due again once the questionnaire is UPDATED after the last review", () => {
    // The answers changed (a newer questionnaire) after the last review, so the
    // current answers have not been reviewed.
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-12T10:00:00.000Z",
        latestReviewAt: "2026-08-10T10:00:00.000Z",
        appointments: [{ start: TOMORROW }],
        now: NOW,
      }),
    ).toBe("review-due");
  });

  it("is up-to-date when a questionnaire exists but nothing is scheduled that demands a fresh review", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: null,
        appointments: [{ start: YESTERDAY }],
        now: NOW,
      }),
    ).toBe("up-to-date");
  });

  it("treats no appointments as nothing to review for, given a questionnaire exists", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: null,
        appointments: [],
        now: NOW,
      }),
    ).toBe("up-to-date");
  });

  it("fails SAFE to review-due on an unparseable questionnaire timestamp rather than reading as up-to-date", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "not-a-date",
        latestReviewAt: "2026-08-10T10:00:00.000Z",
        appointments: [{ start: TOMORROW }],
        now: NOW,
      }),
    ).toBe("review-due");
  });

  it("ignores an unparseable appointment date rather than treating it as upcoming", () => {
    expect(
      medicalReviewStatus({
        latestQuestionnaireAt: "2026-08-01T10:00:00.000Z",
        latestReviewAt: null,
        appointments: [{ start: "garbage" }],
        now: NOW,
      }),
    ).toBe("up-to-date");
  });
});

// ===========================================================================
// THE HEADER PILL. The four states, and above all the two failure modes that
// must never render as a confident "none".
// ===========================================================================

describe("medicalHeaderPill", () => {
  it("shows a red alert with the text when Dentally flags a medical alert, and it wins over everything", () => {
    const pill = medicalHeaderPill({
      medicalAlert: true,
      medicalAlertText: "Penicillin anaphylaxis",
      // Even a failed review read must not suppress the red alert.
      review: { ok: false, state: null },
    });
    expect(pill.tone).toBe("alert");
    expect(pill.detail).toBe("Penicillin anaphylaxis");
  });

  it("renders NOTHING when there is no alert and the feature is off (review not computed)", () => {
    const pill = medicalHeaderPill({ medicalAlert: false, medicalAlertText: null, review: null });
    expect(pill.tone).toBe("none");
    expect(pill.label).toBe("");
  });

  it("never renders 'none' on a FAILED review read — it says the status could not be read", () => {
    const pill = medicalHeaderPill({
      medicalAlert: false,
      medicalAlertText: null,
      review: { ok: false, state: null },
    });
    expect(pill.tone).toBe("unread");
    expect(pill.label).toMatch(/not read/i);
  });

  it("shows an amber review-due pill when a review is outstanding", () => {
    const pill = medicalHeaderPill({
      medicalAlert: false,
      medicalAlertText: null,
      review: { ok: true, state: "review-due" },
    });
    expect(pill.tone).toBe("review-due");
    expect(pill.label).toMatch(/review due/i);
  });

  it("prompts capture when the feature is on but nothing has been captured", () => {
    const pill = medicalHeaderPill({
      medicalAlert: false,
      medicalAlertText: null,
      review: { ok: true, state: "never-captured" },
    });
    expect(pill.tone).toBe("review-due");
    expect(pill.label).toMatch(/not captured/i);
  });

  it("renders nothing when a review is up to date and there is no alert", () => {
    const pill = medicalHeaderPill({
      medicalAlert: false,
      medicalAlertText: null,
      review: { ok: true, state: "up-to-date" },
    });
    expect(pill.tone).toBe("none");
  });
});
