import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { INTEREST_TREATMENTS, TRIAGE_BANK, defaultConfigFor } from "@/lib/triage/bank";
import { projectSummary } from "@/lib/triage/summary";
import type { TriageAnswer, TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// THE STAMP IS THE RESOLVED KIND, NOT THE OWNER'S DROPDOWN (ruling W1-C/2).
//
// THE DEFECT. `parseAnswers` stamped `q.kind` — whatever the owner picked in the
// bank editor. `resolveAnswerKind` (src/lib/triage/kind.ts) has a fourth opinion
// that the dropdown does not: the question's OWN WORDS. A custom question filed
// `logistics` and written "Is anything hurting before you come in?" is a symptom
// question whatever the dropdown said, and the read side caught that — by
// scanning the LIVE bank config.
//
// Which means it caught it only while the question still existed. The practice
// deletes the question; nothing is left to scan; the stamp in the jsonb column
// still says `logistics`; and the patient's own words about their mouth move
// permanently into the half the front desk reads, with no configuration anywhere
// that could still say otherwise. That is exactly the class W1-C/2 protects, and
// the deletion is an ordinary thing for a practice to do.
//
// THE FIX is one line at the write boundary: resolve while the evidence is still
// here. It cannot loosen anything — `resolveAnswerKind` takes the MOST
// RESTRICTIVE of every source with an opinion, and `q.kind` is one of those
// sources, so the stamp is either `q.kind` or `symptom` and never wider.
//
// Every I/O seam is mocked; the REAL route handler, the REAL projection and the
// REAL kind resolution run. The harness is the sibling of public-gates.test.ts.
// ===========================================================================

const SITE = { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" };
const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

/** Filed `logistics` by the owner; written as a symptom question. */
const SYMPTOM_WORDED_KEY = "custom-hurt";
const SYMPTOM_WORDED_LABEL = "Is anything hurting before you come in?";
/** Filed `logistics` and genuinely logistics, so the other direction is proved. */
const HONEST_LOGISTICS_KEY = "custom-parking";

function target(over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: "site-cc:appt-1",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
    patientName: "Alex Berry",
    fork: "full",
    appointmentAt: new Date(NOW + 27 * HOUR).toISOString(),
    dueAt: new Date(NOW - HOUR).toISOString(),
    status: "sent",
    stopReason: null,
    consentSms: true,
    linkToken: TOKEN,
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 24 * HOUR).toISOString(),
    ...over,
  };
}

const h = vi.hoisted(() => {
  const state = {
    target: null as unknown,
    savedConfig: null as unknown,
    recorded: null as null | { answers: unknown[] },
  };
  return {
    state,
    consumeBudget: vi.fn(async () => true),
    getSite: vi.fn((id: string) => (id === "site-cc" ? SITE : undefined)),
    isSystemEnabledStrict: vi.fn(async () => true),
    isSystemEnabled: vi.fn(async () => true),
    getTargetByLinkToken: vi.fn(async () => state.target),
    getBank: vi.fn(async () => (state.savedConfig ? { config: state.savedConfig } : null)),
    recordResponse: vi.fn(async (input: { answers: unknown[] }) => {
      state.recorded = { answers: input.answers };
      return { ok: true as const, response: { id: "resp-1" } };
    }),
  };
});

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/mock/clients", () => ({ getSite: h.getSite }));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  isSystemEnabled: h.isSystemEnabled,
}));
vi.mock("@/lib/triage/repository", () => ({
  getTargetByLinkToken: h.getTargetByLinkToken,
  getBank: h.getBank,
  recordResponse: h.recordResponse,
}));

import { POST } from "./route";

/** A complete grid, every row answered. Declining is answering. */
function grid() {
  return INTEREST_TREATMENTS.map((t) => ({ treatment: t.key, answer: "not_now" as const }));
}

/** Every REQUIRED non-grid answer for the full fork, so a submit is complete. */
function requiredAnswers() {
  const config = defaultConfigFor("full");
  return Object.keys(config.required)
    .filter((k) => k !== "interest-grid")
    .map((key) => {
      const q = TRIAGE_BANK.find((x) => x.key === key)!;
      return { key, value: q.type === "choice" ? (q.options?.[0].value as string) : "yes" };
    });
}

/** The full bank's defaults plus two owner-written questions, both filed logistics. */
function configWithCustom() {
  const base = defaultConfigFor("full");
  // The custom questions go in `custom` ONLY. `projectBank` walks `enabledKeys`
  // against the shipped bank first, so a custom key listed there is recorded as
  // an unknown key and then skipped by the custom pass as already seen.
  return {
    ...base,
    custom: [
      {
        key: SYMPTOM_WORDED_KEY,
        label: SYMPTOM_WORDED_LABEL,
        type: "text" as const,
        kind: "logistics" as const,
        required: false,
      },
      {
        key: HONEST_LOGISTICS_KEY,
        label: "Will you be arriving by car?",
        type: "yesno" as const,
        kind: "logistics" as const,
        required: false,
      },
    ],
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/previsit/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

async function submit(extra: Array<{ key: string; value: string }>): Promise<TriageAnswer[]> {
  const res = await POST(
    req({ token: TOKEN, answers: [...requiredAnswers(), ...extra], interest: grid() }),
  );
  expect(res.status, "the submit itself was refused; the fixture is wrong").toBe(200);
  return (h.state.recorded?.answers ?? []) as TriageAnswer[];
}

function stamped(answers: TriageAnswer[], key: string): TriageAnswer {
  const found = answers.find((a) => a.key === key);
  expect(found, `${key} was not stored at all`).toBeTruthy();
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.target = target();
  h.state.savedConfig = configWithCustom();
  h.state.recorded = null;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what the submit route writes into the kind column", () => {
  it("previsit-submit-stamps-symptom-for-a-symptom-worded-custom-question", async () => {
    const answers = await submit([
      { key: SYMPTOM_WORDED_KEY, value: "My back molar has been throbbing all week." },
    ]);
    expect(
      stamped(answers, SYMPTOM_WORDED_KEY).kind,
      "the owner's dropdown was written down instead of the resolved kind",
    ).toBe("symptom");
  });

  it("previsit-submit-keeps-symptom-after-the-question-is-deleted", async () => {
    // THE WHOLE POINT. Read-time resolution scans the LIVE config; once the
    // practice deletes the question there is nothing left to scan, so the stamp
    // is the last word. It has to already say `symptom`.
    const answers = await submit([
      { key: SYMPTOM_WORDED_KEY, value: "My back molar has been throbbing all week." },
    ]);
    const stored = stamped(answers, SYMPTOM_WORDED_KEY);

    // The PRACTICE MANAGER's view of a practice that has since deleted the
    // question: no custom index at all, because no config names it any more.
    const summary = projectSummary(
      {
        id: "resp-1",
        targetId: "site-cc:appt-1",
        siteId: "site-cc",
        dentallyPatientId: "p-1",
        fork: "full",
        answers: [stored],
        interest: [],
        submittedAt: new Date(NOW).toISOString(),
      },
      // The practice manager (`client_coordinator` is the role behind that
      // title in this codebase) — the reader ruling W1-C/2 is about.
      "client_coordinator",
    );
    expect(summary.clinical, "the manager was handed the clinical half").toBeNull();
    expect(
      JSON.stringify(summary),
      "the patient's own words reached the manager's projection",
    ).not.toContain("throbbing");
    // And the count that stands in for the words says there IS something to read.
    expect(summary.flaggedForClinician).toBe(1);
  });

  it("leaves an honestly-filed logistics question exactly as the owner filed it", async () => {
    // THE OTHER DIRECTION. A stamp that answered `symptom` for everything would
    // pass the two tests above and destroy the summary the clinician reads.
    const answers = await submit([{ key: HONEST_LOGISTICS_KEY, value: "yes" }]);
    expect(stamped(answers, HONEST_LOGISTICS_KEY).kind).toBe("logistics");
  });

  it("leaves the shipped bank's own questions on their in-code kinds", async () => {
    // Custom keys ONLY. FORBIDDEN_IN_BRIEF is deliberately over-broad, and running
    // it over shipped questions could only re-classify the module's own logistics
    // questions against their own definition.
    const answers = await submit([]);
    for (const stored of answers) {
      const shipped = TRIAGE_BANK.find((q) => q.key === stored.key);
      if (!shipped) continue;
      expect(stored.kind, `${stored.key} drifted off its in-code kind`).toBe(shipped.kind);
    }
  });
});
