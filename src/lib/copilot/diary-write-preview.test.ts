import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ===========================================================================
// WHAT THE OWNER IS TOLD BEFORE THEY SAY YES — AND IT TAKES FOUR QUESTIONS.
//
// `diary_write` is a two-step tool: the first call returns a read-back the model
// must say out loud, and the owner's "yes" in the NEXT message is what performs
// the write. So the sentence in that read-back is the whole of the owner's
// informed consent, and there is exactly one way for it to be wrong that
// matters: promising a change to the practice's real Dentally diary that
// confirming will not make.
//
// IT PROMISED THAT TWICE. The field was computed as `mode === "live" &&
// !masterOff`, which is two of the four questions the write path asks:
//
//   THE TARGET. `mode === "live"` says only that the three DENTALLY_WRITE_*
//   variables are set. The rehearsal profile the repo itself ships
//   (`azen-web-mockwrite-3002`) sets all three AND points them at
//   http://localhost:3002/api/mock-dentally, and `runWrite` files exactly that
//   combination as `dry_run` rather than `sent` (write-gate.ts). Armed, and
//   reaching nothing. The sibling `sync_status` tool folds this in already, in
//   its own words "the one untruth this field can tell"; this one did not.
//
//   THE MODULE SWITCH. Ruling W3/2 put all three co-pilot diary kinds under
//   `calendar-writes` — "Diary appointment moves" — and `performMove` re-reads
//   that switch STRICT before anything else. With it off the confirm gets the
//   desk's 503 and nothing moves, while the preview had just said the real diary
//   would change.
//
// EVERY EXISTING ASSERTION ON THIS FIELD CHECKS ONLY THE "OFF" SIDE UNDER AN
// UNARMED DEPLOYMENT (battery.test.ts, w2a-tools.test.ts, the J1 journey), so
// the expression was never once evaluated with `mode === "live"`. This file is
// the other side of it: each of the four conjuncts is withdrawn on its own and
// the answer has to fall back to "off", so no one of them can be deleted without
// a named test going red.
//
// NOTHING IS CONFIRMED HERE. Every call passes `confirm` false, so no write is
// attempted, no gate is entered and no ledger row is written — this is the
// PREVIEW's own arithmetic, driven through the real dispatch.
// ===========================================================================

vi.mock("server-only", () => ({}));

const SITE = { id: "site-ng", name: "N15 Vitality Dental", clientId: "vitality" };
vi.mock("@/lib/mock", () => ({
  getSite: () => SITE,
  getSites: () => [SITE],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => SITE,
  getSites: () => [SITE],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));
vi.mock("@/lib/dentally/read", () => ({
  searchPatients: vi.fn(async () => []),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: () => ({}),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: async () => {} }));

/**
 * The two switches, per slug. The MASTER read goes through the same repository
 * (`isDentallyWriteMasterOff` calls `isSystemEnabledStrict` on
 * `dentally-write-back` while live), so one mock answers both and the test
 * cannot accidentally prove the tool asked a switch it never asked.
 */
const switches = vi.hoisted(() => ({ enabled: new Map<string, boolean>() }));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async (_c: string, slug: string) => switches.enabled.get(slug) ?? true,
  isSystemEnabledStrict: async (_c: string, slug: string) => switches.enabled.get(slug) ?? true,
  isSystemExplicitlyDisabled: async (_c: string, slug: string) => switches.enabled.get(slug) === false,
  isSystemEnabledForSend: async (_c: string, slug: string) => switches.enabled.get(slug) ?? true,
  getSystemStates: async () => ({}),
  disabledSlugsFor: async () => new Set<string>(),
}));

/**
 * ONLY THE FIVE WRITE DOORS ARE REPLACED. `dentallyWriteMode`,
 * `dentallyWriteTarget`, `isDentallyWriteMasterOff` and `targetLabel` come
 * through from the real module, because they are the arithmetic under test; what
 * is stubbed is the one thing that would otherwise open a socket to whatever
 * DENTALLY_WRITE_BASE_URL names. So the confirmed half below exercises the real
 * mode/target resolution and returns without a network call.
 */
vi.mock("@/lib/dentally/write-gate", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    dentallyWrite: {
      cancelAppointment: async () => ({ appointment: { id: 9001 } }),
      createAppointment: async () => ({ appointment: { id: 9002 } }),
      updateAppointment: async () => ({ appointment: { id: 9001 } }),
      createPatient: async () => ({ patient: { id: 5001 } }),
      updatePatient: async () => ({ patient: { id: 5001 } }),
    },
  };
});

import { makeCopilotDispatch } from "./tools";
import { DENTALLY_WRITE_MASTER_SLUG } from "@/lib/dentally/write-vocabulary";

const DIARY_SLUG = "calendar-writes";
const owner = makeCopilotDispatch(["site-ng"], "vitality", "user-42", "full");

/** A MOVE preview: no patient lookup, one site, nothing confirmed. */
async function previewMove(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await owner("diary_write", {
      action: "move",
      appointmentId: "9001",
      start: "2026-09-10T09:00:00Z",
      finish: "2026-09-10T09:30:00Z",
      practitionerId: "prac-1",
      currentStart: "2026-09-10T11:00:00Z",
      currentFinish: "2026-09-10T11:30:00Z",
      currentPractitionerId: "prac-2",
      confirm: false,
    }),
  ) as Record<string, unknown>;
}

/** Arm the deployment at a chosen base URL, exactly as the three env vars do. */
function armAt(baseUrl: string | null): void {
  if (baseUrl === null) {
    delete process.env.DENTALLY_WRITE_ENABLED;
    delete process.env.DENTALLY_WRITE_API_KEY;
    delete process.env.DENTALLY_WRITE_BASE_URL;
    return;
  }
  process.env.DENTALLY_WRITE_ENABLED = "true";
  process.env.DENTALLY_WRITE_API_KEY = "test-write-key";
  process.env.DENTALLY_WRITE_BASE_URL = baseUrl;
}

const ENV_KEYS = ["DENTALLY_WRITE_ENABLED", "DENTALLY_WRITE_API_KEY", "DENTALLY_WRITE_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  switches.enabled = new Map<string, boolean>([
    [DENTALLY_WRITE_MASTER_SLUG, true],
    [DIARY_SLUG, true],
  ]);
  armAt("https://api.dentally.co");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("diary_write's pre-confirm verdict asks every question the write path asks", () => {
  it("says 'on' ONLY when armed AND aimed at the real book AND both switches are on", async () => {
    const out = await previewMove();
    expect(out.preview).toBe(true);
    expect(out.done).toBe(false);
    expect(out.writingBackToDentally).toBe("on");
    expect(String(out.note)).toMatch(/Confirming will change the practice's real Dentally diary/);
  });

  it("AN ARMED DEPLOYMENT AIMED AT THE LOCAL MOCK ANSWERS 'OFF' AND NAMES WHERE IT POINTS", async () => {
    // The rehearsal the repo itself ships. Armed, and reaching nothing: the gate
    // opens, the write is performed against localhost and filed as `dry_run`.
    // The owner must not be told their real diary is about to change.
    armAt("http://localhost:3002/api/mock-dentally");
    const out = await previewMove();
    expect(out.writingBackToDentally).toBe("off");
    expect(String(out.note)).not.toMatch(/will change the practice's real Dentally diary/);
    expect(String(out.note)).toMatch(/localhost:3002 \(local mock\)/);
    expect(String(out.note)).toMatch(/NOT at the practice's real Dentally book/);
  });

  it("THE DIARY SWITCH BEING OFF ANSWERS 'OFF' AND SAYS THE CONFIRM IS REFUSED", async () => {
    // W3/2 + performMove: `calendar-writes` is re-read STRICT before anything
    // else, so with it off the confirm gets the desk's 503. "Will record what was
    // wanted" would be wrong here — a move refused by the desk never reaches the
    // gate, so there is no ledger row either.
    switches.enabled.set(DIARY_SLUG, false);
    const out = await previewMove();
    expect(out.writingBackToDentally).toBe("off");
    expect(String(out.note)).toMatch(/Diary appointment moves is switched OFF in System controls/);
    expect(String(out.note)).toMatch(/confirming is REFUSED/);
    expect(String(out.note)).not.toMatch(/will change the practice's real Dentally diary/);
  });

  it("names BOTH switches when both are off, rather than only the first one it found", async () => {
    switches.enabled.set(DIARY_SLUG, false);
    switches.enabled.set(DENTALLY_WRITE_MASTER_SLUG, false);
    const out = await previewMove();
    expect(out.writingBackToDentally).toBe("off");
    expect(String(out.note)).toMatch(/Diary appointment moves is switched OFF/);
    expect(String(out.note)).toMatch(/and so is Dentally write-back/);
  });

  it("keeps the two sentences it already had for the master switch and the unarmed deployment", async () => {
    // Unchanged behaviour, pinned so the new branches cannot be added by
    // rewording the ones that were already right.
    switches.enabled.set(DENTALLY_WRITE_MASTER_SLUG, false);
    const masterOff = await previewMove();
    expect(masterOff.writingBackToDentally).toBe("off");
    expect(String(masterOff.note)).toMatch(
      /Dentally write-back is switched OFF in System controls, so confirming will RECORD what was wanted and change nothing in Dentally/,
    );

    switches.enabled.set(DENTALLY_WRITE_MASTER_SLUG, true);
    armAt(null);
    const unarmed = await previewMove();
    expect(unarmed.writingBackToDentally).toBe("off");
    expect(String(unarmed.note)).toMatch(
      /Writing back to Dentally is not switched on for this practice yet, so confirming will RECORD what was wanted and change nothing in Dentally/,
    );
  });

  it("NO ONE OF THE FOUR CONJUNCTS CAN BE DROPPED: each withdrawn alone puts it back to 'off'", async () => {
    // The mutation guard. The defect this file exists for was a missing conjunct,
    // so the shape of the pin is "remove exactly one thing, get 'off' back".
    expect((await previewMove()).writingBackToDentally).toBe("on");

    armAt(null); // 1. the deployment's arming
    expect((await previewMove()).writingBackToDentally).toBe("off");
    armAt("https://api.dentally.co");

    armAt("http://localhost:3002/api/mock-dentally"); // 2. the target
    expect((await previewMove()).writingBackToDentally).toBe("off");
    armAt("https://api.dentally.co");

    switches.enabled.set(DENTALLY_WRITE_MASTER_SLUG, false); // 3. the master switch
    expect((await previewMove()).writingBackToDentally).toBe("off");
    switches.enabled.set(DENTALLY_WRITE_MASTER_SLUG, true);

    switches.enabled.set(DIARY_SLUG, false); // 4. the module's own switch
    expect((await previewMove()).writingBackToDentally).toBe("off");
    switches.enabled.set(DIARY_SLUG, true);

    expect((await previewMove()).writingBackToDentally).toBe("on");
  });
});

// ===========================================================================
// AND THE SENTENCE AFTER THE OWNER SAYS YES.
//
// The preview is half the promise; the success note is the other half, and it
// used to read "Cancelled appointment 9001 in Dentally" whatever the deployment
// was aimed at. On the rehearsal profile that told the owner a real appointment
// had been cancelled while `runWrite` filed the very same action as `dry_run` —
// the note and the ledger row describing the same event differently.
// ===========================================================================

describe("diary_write's success note says where the write actually landed", () => {
  it("says plainly 'in Dentally' when the deployment really is aimed at the practice's book", async () => {
    const out = JSON.parse(
      await owner("diary_write", { action: "cancel", appointmentId: "9001", confirm: true }),
    ) as Record<string, unknown>;
    expect(out.done).toBe(true);
    expect(String(out.note)).toMatch(/Cancelled appointment 9001 in Dentally\./);
  });

  it("NAMES THE REHEARSAL TARGET INSTEAD when the arming points at the local mock", async () => {
    armAt("http://localhost:3002/api/mock-dentally");
    const out = JSON.parse(
      await owner("diary_write", { action: "cancel", appointmentId: "9001", confirm: true }),
    ) as Record<string, unknown>;
    expect(out.done).toBe(true);
    expect(String(out.note)).toMatch(/against localhost:3002 \(local mock\)/);
    expect(String(out.note)).toMatch(/NOT in the practice's real Dentally book/);
    // The words that would have been the untruth.
    expect(String(out.note)).not.toMatch(/Cancelled appointment 9001 in Dentally/);
  });
});
