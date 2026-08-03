// ===========================================================================
// THE GATE, PROVED SHUT — end to end, with the REAL repository.
//
// gate.test.ts proves what isPerioEnabled() returns. route.test.ts proves the
// route answers 503. Neither proves the claim that actually matters, which is
// the one this whole build rests on:
//
//     WITH PERIO_ENABLED UNSET, NOTHING CAN WRITE PERIODONTAL DATA.
//
// Both of those files fall short of it in the same two ways. They stub the
// variable to the string "false", so they never exercise the SHIPPED state,
// which is the variable not being set at all — and a `!== "true"` that was
// written as `=== "false"` would pass every one of them while shipping on.
// And route.test.ts mocks the repository wholesale, so it can only show that a
// mock was not called; the real repository, the real gate and the real Supabase
// seam never meet.
//
// So this file does the opposite of both. PERIO_ENABLED is DELETED, not stubbed.
// The repository is REAL. And serviceClient — the only door to the database in
// this module, and the one holding the service role that bypasses RLS — is
// replaced by a tripwire that throws if it is so much as constructed. A write
// that reached Postgres would have to call it, so if the tripwire never fires,
// no statement was ever sent.
//
// Nothing here mocks @/lib/perio/gate or @/lib/perio/repository. That is the
// point: a mocked gate would let the most important claim in this build pass
// while being false.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const tripwire = vi.hoisted(() => ({ calls: 0 }));

/**
 * The database door, wired to an alarm. serviceClient() holds the service-role
 * key, so it is the single point every perio read and write must pass through —
 * including the ones that would bypass row-level security.
 */
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => {
    tripwire.calls += 1;
    throw new Error("TRIPWIRE: serviceClient() was constructed while perio was switched off");
  },
  anonServerClient: () => {
    tripwire.calls += 1;
    throw new Error("TRIPWIRE: anonServerClient() was constructed while perio was switched off");
  },
}));

import {
  saveBpeExam,
  listBpeExams,
  latestBpeExam,
  retractBpeExam,
  savePerioChart,
  listPerioChartHeaders,
  getPerioChart,
  latestPerioCharts,
  retractPerioChart,
  PerioDisabledError,
  type PerioScope,
  type NewBpeExam,
  type NewPerioChart,
} from "./repository";
import { isPerioEnabled, canSavePerio } from "./gate";
import type { ClinicianRef, PerioAttribution } from "./types";

const SCOPE: PerioScope = { siteId: "site-cc", patientId: "p1" };
const CLINICIAN: ClinicianRef = { id: "u1", name: "Blerta Hoxha", gdcNumber: null };
const RECORDED: PerioAttribution = { clinician: CLINICIAN, at: "2026-08-01T09:00:00.000Z" };

const NEW_EXAM: NewBpeExam = {
  recorded: RECORDED,
  probe: "who-621",
  probeNote: null,
  scores: {
    UR: { code: 4, furcation: false },
    UA: { code: 3, furcation: true },
    UL: { code: 2, furcation: false },
    LR: { code: 1, furcation: false },
    LA: { code: 0, furcation: false },
    LL: null,
  },
  statuses: { UR: "scorable", UA: "scorable", UL: "scorable", LR: "scorable", LA: "scorable", LL: "no-teeth" },
  notes: null,
  supersedesId: null,
  amendmentReason: null,
};

const NEW_CHART: NewPerioChart = {
  recorded: RECORDED,
  probe: "who-621",
  probeNote: null,
  sextants: ["UR"],
  teeth: [
    {
      tooth: 16,
      mobility: 1,
      furcation: 2,
      sites: (["mb", "b", "db", "ml", "l", "dl"] as const).map((site) => ({
        site,
        probingDepth: 8,
        recession: 3,
        bleeding: true,
        suppuration: false,
        plaque: true,
      })),
    },
  ],
  trigger: "bpe-4",
  bpeExamId: null,
  diagnosis: null,
  notes: null,
  supersedesId: null,
  amendmentReason: null,
};

/**
 * The shipped state, reproduced exactly: the variable absent from the
 * environment, not set to a falsey string. vitest's config loads no .env file
 * and the repository's .env.local does not mention PERIO_ENABLED, so deleting it
 * here is the whole truth about how this code runs on a machine where nobody has
 * switched perio on.
 */
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PERIO_ENABLED;
  delete process.env.PERIO_ENABLED;
  tripwire.calls = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PERIO_ENABLED;
  else process.env.PERIO_ENABLED = saved;
});

describe("the shipped default", () => {
  it("is off when the variable is absent from the environment entirely", () => {
    expect("PERIO_ENABLED" in process.env).toBe(false);
    expect(isPerioEnabled()).toBe(false);
    expect(canSavePerio()).toBe(false);
  });
});

describe("with perio off, no write reaches the database", () => {
  /** Every function in the repository that can create or alter a row. */
  const writes: [string, () => Promise<unknown>][] = [
    ["saveBpeExam", () => saveBpeExam(SCOPE, NEW_EXAM)],
    ["savePerioChart", () => savePerioChart(SCOPE, NEW_CHART)],
    ["retractBpeExam", () => retractBpeExam(SCOPE, "e1", "wrong patient", CLINICIAN)],
    ["retractPerioChart", () => retractPerioChart(SCOPE, "c1", "wrong patient", CLINICIAN)],
  ];

  it.each(writes)("%s throws PerioDisabledError and never opens a client", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(PerioDisabledError);
    expect(tripwire.calls).toBe(0);
  });

  /**
   * An amendment is the subtle one. It reads the record it supersedes BEFORE it
   * writes, so a gate placed after that read would leak a whole clinical record
   * out of a switched-off feature while still refusing the write.
   */
  it("refuses an amendment before it reads the record it would supersede", async () => {
    await expect(
      saveBpeExam(SCOPE, { ...NEW_EXAM, supersedesId: "e1", amendmentReason: "transposed sextants" }),
    ).rejects.toBeInstanceOf(PerioDisabledError);
    await expect(
      savePerioChart(SCOPE, { ...NEW_CHART, supersedesId: "c1", amendmentReason: "wrong tooth" }),
    ).rejects.toBeInstanceOf(PerioDisabledError);
    expect(tripwire.calls).toBe(0);
  });
});

describe("with perio off, no read reaches the database either", () => {
  const reads: [string, () => Promise<unknown>][] = [
    ["listBpeExams", () => listBpeExams(SCOPE)],
    ["latestBpeExam", () => latestBpeExam(SCOPE)],
    ["listPerioChartHeaders", () => listPerioChartHeaders(SCOPE)],
    ["getPerioChart", () => getPerioChart(SCOPE, "c1")],
    ["latestPerioCharts", () => latestPerioCharts(SCOPE, 2)],
  ];

  /**
   * A read THROWS rather than returning []. An empty array would be rendered as
   * "this patient has no periodontal findings" — indistinguishable from a healthy
   * BPE 0, and a claim about a patient that the database was never asked about.
   */
  it.each(reads)("%s throws rather than returning an empty result", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(PerioDisabledError);
    expect(tripwire.calls).toBe(0);
  });
});

/**
 * The near misses. A deploy that types the value wrongly must fail SHUT, and it
 * must fail shut at the database seam, not merely in the boolean.
 */
describe("a mistyped flag does not open the gate", () => {
  it.each(["1", "TRUE", "True", "yes", "on", " true", "true ", "", "false", "0", "null", "undefined"])(
    "PERIO_ENABLED=%j still refuses every write with the client untouched",
    async (value) => {
      process.env.PERIO_ENABLED = value;
      expect(isPerioEnabled()).toBe(false);
      await expect(saveBpeExam(SCOPE, NEW_EXAM)).rejects.toBeInstanceOf(PerioDisabledError);
      await expect(savePerioChart(SCOPE, NEW_CHART)).rejects.toBeInstanceOf(PerioDisabledError);
      expect(tripwire.calls).toBe(0);
    },
  );
});

/**
 * The counter-test, and the reason the rest of this file means anything.
 *
 * If the tripwire could never fire, every assertion above would pass on a gate
 * that had been deleted. Switching the flag ON must reach serviceClient() and
 * trip it — which also proves these writes really do go to the database rather
 * than to some stub, and that the gate is the only thing standing between them.
 */
describe("the tripwire is armed", () => {
  it("fires the moment perio is switched on, which is what makes the silence above evidence", async () => {
    process.env.PERIO_ENABLED = "true";
    expect(isPerioEnabled()).toBe(true);
    await expect(saveBpeExam(SCOPE, NEW_EXAM)).rejects.toThrow(/TRIPWIRE/);
    expect(tripwire.calls).toBe(1);

    tripwire.calls = 0;
    await expect(listBpeExams(SCOPE)).rejects.toThrow(/TRIPWIRE/);
    expect(tripwire.calls).toBe(1);
  });
});
