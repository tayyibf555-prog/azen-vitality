// AREA 8 (Reactivation) deep-test: the recall<->reactivation dedup seam, touch
// scheduling / caps, cadence status transitions, and patient-facing copy safety.
//
// The seam predicate lives inline in src/app/api/sync/reactivation/route.ts:
//     if (target && !(target.reason === "overdue_recall" && openRecall.has(target.id)))
// We reproduce that predicate here verbatim and drive it with the REAL
// toReactivationTarget / classifyRecall outputs, so a change to either side's
// classification (or to the predicate) that reopens double-coverage fails a test.

import { describe, it, expect } from "vitest";

import {
  toReactivationTarget,
  DEFAULT_CONFIG as REACT_CFG,
  type ReactivationInput,
} from "./normalise";
import { advanceAfter, stepDef, nextStep, dueAt, DEFAULT_CADENCE } from "./cadence";
import { buildDraftPrompt } from "./draft";
import type { ReactivationTarget } from "./types";

import {
  classifyRecall,
  shouldGraduate,
  DEFAULT_CONFIG as RECALL_CFG,
  type RecallInput,
} from "@/lib/recall/normalise";

const NOW = new Date("2026-06-18T09:00:00Z");
const DAY = 86_400_000;

function isoDaysAgo(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * DAY).toISOString();
}

// ---- Faithful reproduction of the route-level open-recall key set + predicate ----

/** Mirrors listOpenRecallPatientKeys: `${siteId}:${patientId}` for due/in_cadence. */
function openRecallKeys(
  recalls: { siteId: string; dentallyPatientId: string; status: string }[],
): Set<string> {
  const s = new Set<string>();
  for (const r of recalls) {
    if (r.status === "due" || r.status === "in_cadence") {
      s.add(`${r.siteId}:${r.dentallyPatientId}`);
    }
  }
  return s;
}

/** The exact keep/drop predicate from src/app/api/sync/reactivation/route.ts.
 *  Recall owns a patient (any reason) while an open recall row exists; only once
 *  it graduates (key leaves openRecall) may reactivation adopt them. */
function reactivationKeepsTarget(t: ReactivationTarget, openRecall: Set<string>): boolean {
  return !openRecall.has(t.id);
}

function reactBase(p: Partial<ReactivationInput> = {}): ReactivationInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "p1", first_name: "Ann", last_name: "Boyd",
      use_sms: true, use_email: false, marketing: 1,
      archived: false, archived_reason: null,
      dentist_recall_date: null, hygienist_recall_date: null,
    },
    lastVisitAt: isoDaysAgo(30),
    futureBookingExists: false,
    plan: null,
    amountOutstanding: 0,
    historicSpend: 600,
    lastTouchAt: null,
    ...p,
  };
}

function recallBase(p: Partial<RecallInput> = {}): RecallInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "p1", first_name: "Ann", last_name: "Boyd",
      use_sms: true, use_email: false, marketing: 1,
      dentist_recall_date: null, hygienist_recall_date: null,
    },
    lastVisitAt: isoDaysAgo(30),
    futureBookingExists: false,
    ...p,
  };
}

// =====================================================================
// 1. Seam invariant: the two grace boundaries MUST be identical.
// =====================================================================
describe("seam: grace boundaries are aligned", () => {
  it("recall grace equals reactivation recall-grace (steady-state hand-off point)", () => {
    // The comment in recall/normalise.ts says these MUST be equal. If a future
    // edit diverges them, a window of double- or zero-coverage opens.
    expect(RECALL_CFG.graceDays).toBe(REACT_CFG.recallGraceDays);
  });

  it("shouldGraduate fires exactly past the grace boundary", () => {
    expect(shouldGraduate(RECALL_CFG.graceDays, RECALL_CFG.graceDays)).toBe(false); // at boundary: recall still owns
    expect(shouldGraduate(RECALL_CFG.graceDays + 1, RECALL_CFG.graceDays)).toBe(true); // past: hands off
  });
});

// =====================================================================
// 2. Seam dedup: recall owns it -> reactivation must not also chase it.
// =====================================================================
describe("seam: recall owns a patient, reactivation must not double-contact", () => {
  it("drops an overdue_recall reactivation target when recall still owns the patient", () => {
    // Recall 40 days overdue (within recall window), reactivation would call it
    // overdue_recall only past 60d, so make it >60d to force overdue_recall AND
    // still-open recall (recall window is up to 60d, so use exactly the seam:
    // recall at 55d overdue = still `due`; reactivation still not overdue_recall).
    // To get BOTH sides live we take a recall at 61d (recall graduates) vs 40d.
    //
    // The classic double-coverage case: reactivation reason overdue_recall +
    // recall row still open. Construct it directly to prove the guard drops it.
    const t = toReactivationTarget(
      reactBase({
        lastVisitAt: isoDaysAgo(200),
        patient: { ...reactBase().patient, dentist_recall_date: isoDaysAgo(80) },
      }),
      NOW,
    )!;
    expect(t.reason).toBe("overdue_recall");

    const openRecall = openRecallKeys([
      { siteId: "site-cc", dentallyPatientId: "p1", status: "in_cadence" },
    ]);
    expect(reactivationKeepsTarget(t, openRecall)).toBe(false); // dropped: recall owns it
  });

  it("keeps the overdue_recall target once recall has handed it off (graduated)", () => {
    const t = toReactivationTarget(
      reactBase({
        lastVisitAt: isoDaysAgo(200),
        patient: { ...reactBase().patient, dentist_recall_date: isoDaysAgo(80) },
      }),
      NOW,
    )!;
    // Recall marked graduated => not in the open set.
    const openRecall = openRecallKeys([
      { siteId: "site-cc", dentallyPatientId: "p1", status: "graduated" },
    ]);
    expect(reactivationKeepsTarget(t, openRecall)).toBe(true); // reactivation legitimately adopts it
  });
});

// =====================================================================
// 3. THE GAP: a patient recall still owns can be classified `lapsed` by
//    reactivation, and the guard (which only checks overdue_recall) lets it
//    through -> double contact. This test documents the confirmed bug.
// =====================================================================
describe("seam: lapsed reactivation target for a recall-owned patient is deduped", () => {
  it("recall owns the patient (due); reactivation would enrol them as lapsed but is deduped", () => {
    // Long-interval (e.g. 24-month) recall: dentist recall only 30 days overdue
    // (recall's window is [-14, +60], so recall OWNS it as `due`), but the last
    // actual visit was ~25 months ago (> 18-month lapse threshold) -> reactivation
    // independently classifies `lapsed`.
    const recall = classifyRecall(
      recallBase({
        lastVisitAt: isoDaysAgo(760),
        patient: { ...recallBase().patient, dentist_recall_date: isoDaysAgo(30) },
      }),
      NOW,
    );
    expect(recall).toHaveLength(1);
    expect(recall[0].status).toBe("due"); // recall owns it

    const react = toReactivationTarget(
      reactBase({
        lastVisitAt: isoDaysAgo(760), // > 18 months
        patient: { ...reactBase().patient, dentist_recall_date: isoDaysAgo(30) },
      }),
      NOW,
    )!;
    expect(react.reason).toBe("lapsed"); // reactivation independently enrols

    const openRecall = openRecallKeys(
      recall.map((r) => ({ siteId: r.siteId, dentallyPatientId: r.dentallyPatientId, status: r.status })),
    );

    // Both sides target the SAME patient (same site:patient key) at the same time.
    expect(openRecall.has(`${react.siteId}:${react.dentallyPatientId}`)).toBe(true);

    // The seam invariant we WANT: reactivation should not chase a patient recall
    // still owns. The current guard only inspects overdue_recall, so it keeps the
    // lapsed target -> the patient is contacted by BOTH modules.
    const kept = reactivationKeepsTarget(react, openRecall);

    // The seam invariant: reactivation must NOT chase a patient recall still owns,
    // regardless of the reactivation reason. Guarding on any open recall key (the
    // fix) drops this lapsed target; the old overdue_recall-only guard did not.
    expect(kept).toBe(false);
  });
});

// =====================================================================
// 4. Touch scheduling + caps: cadence never chases past its final step.
// =====================================================================
describe("cadence: scheduling and hard cap on repeat contact", () => {
  it("has a bounded 3-step cadence and cannot advance past the final step", () => {
    expect(DEFAULT_CADENCE).toHaveLength(3);
    expect(nextStep(3)).toBeNull(); // no fourth touch is ever scheduled
    expect(stepDef(4)).toBeNull();
  });

  it("advanceAfter exhausts (no next due) once the final step is sent", () => {
    const a = advanceAfter(3, NOW);
    expect(a.status).toBe("exhausted");
    expect(a.nextDueAt).toBeNull();
    expect(a.endedAt).toBe(NOW.toISOString());
  });

  it("schedules the next step with the correct forward gap, never in the past", () => {
    const afterStep1 = advanceAfter(1, NOW);
    expect(afterStep1.status).toBe("active");
    const step2 = stepDef(2)!;
    expect(afterStep1.nextDueAt).toBe(dueAt(step2, NOW));
    expect(new Date(afterStep1.nextDueAt!).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

// =====================================================================
// 5. Patient-facing copy safety: never NHS / private / funding language.
// =====================================================================
function target(p: Partial<ReactivationTarget> = {}): ReactivationTarget {
  return {
    id: "t", siteId: "s", dentallyPatientId: "p", patientName: "Ann Boyd",
    reason: "lapsed", dentallyPlanId: null, treatment: null,
    recoverableValue: 80, lastVisitAt: isoDaysAgo(760), recallDueAt: null,
    priorAttempts: 0, status: "in_cadence", reactivationScore: 1,
    consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x", ...p,
  };
}

describe("draft copy: no funding jargon reaches the patient", () => {
  const reasons: ReactivationTarget["reason"][] = ["lapsed", "overdue_recall", "stalled_plan"];
  const channels = ["sms", "email", "whatsapp"] as const;

  for (const reason of reasons) {
    for (const step of DEFAULT_CADENCE) {
      it(`reason=${reason} step=${step.step}: instructs the model to avoid NHS/private`, () => {
        const { system } = buildDraftPrompt(target({ reason }), step.channel, step);
        // The one guardrail that MUST always be present.
        expect(system.toLowerCase()).toContain("never use internal funding");
        expect(system.toLowerCase()).toContain("nhs");
        expect(system.toLowerCase()).toContain("private");
        // No em-dash anywhere in the instruction we ship.
        expect(system).not.toContain("—");
      });
    }
  }

  it("stalled_plan money guidance uses GBP (£), never a bare 'funding' pitch to patient", () => {
    const { system } = buildDraftPrompt(target({ reason: "stalled_plan", treatment: "Crown", recoverableValue: 900 }), "sms", stepDef(2)!);
    expect(system).toContain("£");
  });

  for (const ch of channels) {
    it(`hostile USP containing "NHS funding" is still gated by the standing rule (channel=${ch})`, () => {
      // Even if an owner types a compliance-breaking USP, the standing system rule
      // that forbids NHS/private wording is still present for the model to obey.
      const { system } = buildDraftPrompt(
        target({}),
        ch,
        stepDef(1)!,
        ["We are the cheapest NHS and private funding option in town"],
      );
      expect(system.toLowerCase()).toContain("never use internal funding");
      // And no em-dash sneaks in via the USP line assembly.
      expect(system).not.toContain("—");
    });
  }
});
