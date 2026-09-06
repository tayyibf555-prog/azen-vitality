import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE FACTS-ONLY REFUSAL AND THE HONESTY CAVEAT ARE BOTH READ OUT (handoff B139).
//
// THE DEFECT THIS PINS. `equipment_lookup` returns
//
//     { lookup, ...payload, ...(factsOnly ? { factsOnly, judgement, note } : {}) }
//
// and the facts-only object was spread AFTER `payload`, so its `note` REPLACED
// the equipment dispatch's own. That note is not decoration: it is where the two
// honesty caveats live —
//
//   * the CAPPED REGISTER sentence (ruling W3/11, charter §0/5): the read came
//     back at its own 400-row bound, so "nothing is overdue" means "nothing
//     overdue in the part I can see" and every figure is a floor;
//   * the UNREADABLE MANUAL INDEX sentence: whether a machine has a manual could
//     not be read, so nobody may say it has none.
//
// Both were silently dropped in facts-only mode — that is, in exactly the turn
// where somebody is asking whether a machine may go on being used, and the one
// turn where "nothing showed up as overdue" must not be allowed to sound like
// "nothing is overdue". The refusal survived; the caveat about what the refusal
// was computed from did not.
//
// The fix composes the two into ONE `note` key rather than adding a second key
// beside it, for the reason src/lib/equipment/tools.ts already gives when it
// joins its own two caveats: a second key is a key a model may not read.
//
// The register here is 400 assets, which is REGISTER_READ_CAP exactly, because
// that is what `registerIsCapped` tests — a fixture one row short proves nothing.
// ===========================================================================

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({ manualsFail: false }));

vi.mock("@/lib/mock", () => ({
  getSite: (id: string) => ({ id, name: "N15 Vitality Dental", clientId: "vitality" }),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => ({ id, name: "N15 Vitality Dental", clientId: "vitality" }),
  getSites: () => [{ id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" }],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));
vi.mock("@/lib/dentally/read", () => ({
  searchPatients: vi.fn(),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: () => ({}),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: async () => {} }));
vi.mock("@/lib/systems/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

// A register AT its read cap, and one machine in it is out of test. The GATE and
// the equipment dispatch are the module's own, so the boundary tripped here is
// the real one.
vi.mock("@/lib/equipment/repository", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const { REGISTER_READ_CAP } = await import("@/lib/equipment/types");
  const base = {
    clientId: "vitality", category: "sterilisation", make: "W&H", model: "Lisa",
    siteId: "site-cc", room: "Decon", supplier: "Dental Services Ltd",
    supplierPhone: "020 8000 0000", purchasedOn: "2022-01-04", lastServicedOn: "2020-06-01",
    notes: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const assets = [
    // The OVERDUE one, with a date in the past that cannot become a time bomb.
    { ...base, id: "asset-1", name: "Lisa steriliser", serial: "LS-9001", nextServiceDue: "2020-06-01" },
    ...Array.from({ length: REGISTER_READ_CAP - 1 }, (_, i) => ({
      ...base,
      id: `asset-${i + 2}`,
      name: `Handpiece ${i + 2}`,
      serial: `HP-${i + 2}`,
      // Far enough ahead that re-running this suite in a later year changes nothing.
      nextServiceDue: "2099-03-01",
    })),
  ];
  return {
    ...original,
    listAssets: async () => assets,
    listManuals: async () =>
      store.manualsFail ? null : [{ id: "m1", clientId: "vitality", assetId: "asset-1", status: "ready" }],
    getAsset: async () => ({ id: "asset-1", clientId: "vitality", name: "Lisa steriliser", category: "sterilisation" }),
    listChunksForAsset: async () => [
      { id: "c1", assetId: "asset-1", pageFrom: 12, pageTo: 12, body: "E04 indicates the water reservoir is empty." },
    ],
  };
});

import { EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";
import { makeCopilotDispatch } from "./tools";
import { copilotTurn } from "./turn";

/** The judgement question W1-D/2 caps to facts, asked in the person's own words. */
const JUDGEMENT = "the autoclave is out of test but we're fully booked - can we run it today?";

async function askEquipment(
  userTurns: string[],
  input: Record<string, unknown>,
): Promise<{ out: Record<string, unknown>; turn: ReturnType<typeof copilotTurn> }> {
  const turn = copilotTurn(userTurns);
  const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full", undefined, turn);
  const out = JSON.parse(await dispatch("equipment_lookup", input)) as Record<string, unknown>;
  return { out, turn };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.manualsFail = false;
});

describe("a facts-only equipment answer keeps the honesty caveat it was computed from", () => {
  it("CAPPED REGISTER: the 'at least, never a total' sentence survives beside the refusal", async () => {
    const { out, turn } = await askEquipment([JUDGEMENT], {
      question: "autoclave next service due date and supplier",
      lookup: "service",
    });
    // The door capped the answer, which is the precondition for the collision.
    expect(out.factsOnly, "the judgement question was not capped to facts").toBe(true);
    expect(turn.equipmentJudgementRequired).toBe(true);
    // The dispatch's own caveat reached the model...
    expect(out.registerCapped, "the fixture is not actually at the read cap").toBe(true);
    const note = String(out.note);
    expect(note, "the capped-register caveat was replaced by the refusal note").toMatch(
      /is a floor and not a total/i,
    );
    expect(note).toMatch(/"at least"/i);
    // ...and so did the sentence that must never be missing.
    expect(note, "the facts-only refusal note was lost").toMatch(
      /whether a machine may go on being used/i,
    );
    expect(note).toContain(EQUIPMENT_REFUSALS.judgement);
    // The refusal is also carried in its own field, unchanged: the note is the
    // instruction, `judgement` is the sentence.
    expect(out.judgement).toBe(EQUIPMENT_REFUSALS.judgement);
  });

  it("UNREADABLE MANUAL INDEX: 'never say a machine has no manual' survives too", async () => {
    // The other caveat that lives on the same key, and the more dangerous one to
    // lose: the desk would invite somebody to upload a manual it is about to
    // quote from.
    store.manualsFail = true;
    const { out } = await askEquipment([JUDGEMENT], {
      question: "autoclave details",
      lookup: "find",
      query: "Lisa",
    });
    expect(out.factsOnly).toBe(true);
    const note = String(out.note);
    expect(note, "the unreadable-manual caveat was replaced by the refusal note").toMatch(
      /could not be read just now/i,
    );
    expect(note).toMatch(/Never tell anyone a machine has no manual/i);
    expect(note).toContain(EQUIPMENT_REFUSALS.judgement);
  });

  it("ORDER: the caveat is read before the refusal, so the facts are qualified first", async () => {
    const { out } = await askEquipment([JUDGEMENT], {
      question: "autoclave next service due date and supplier",
      lookup: "service",
    });
    const note = String(out.note);
    expect(note.indexOf("floor and not a total")).toBeGreaterThanOrEqual(0);
    expect(note.indexOf("floor and not a total")).toBeLessThan(
      note.indexOf("whether a machine may go on being used"),
    );
  });

  it("the refusal note stands ALONE when the payload had no caveat of its own", async () => {
    // No empty joiner, no stray leading space: the composition must not degrade
    // the common case, where the register read fine and the manual index read
    // fine and there is nothing to qualify.
    const { out } = await askEquipment([JUDGEMENT], {
      question: "what does E04 mean",
      lookup: "manual",
      assetId: "asset-1",
      query: "E04",
    });
    expect(out.factsOnly).toBe(true);
    const note = String(out.note);
    expect(note.startsWith("This was a question about whether a machine")).toBe(true);
    expect(note).toContain(EQUIPMENT_REFUSALS.judgement);
  });

  it("an ORDINARY answer still carries the payload's own note, untouched", async () => {
    // The control in the other direction: nothing about this fix may change what
    // a non-judgement question gets back.
    const { out, turn } = await askEquipment(["when is the Lisa next due a service?"], {
      question: "Lisa next service due",
      lookup: "service",
    });
    expect(out.factsOnly).toBeUndefined();
    expect(turn.equipmentJudgementRequired).toBe(false);
    const note = String(out.note);
    expect(note).toMatch(/is a floor and not a total/i);
    expect(note).not.toMatch(/whether a machine may go on being used/i);
  });
});
