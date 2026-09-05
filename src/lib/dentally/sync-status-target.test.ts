import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// WHAT THE SYNC STATUS SCREEN SAYS WHEN THE DEPLOYMENT IS ARMED AND AIMED AT A
// MOCK.
//
// This is the owner-facing half of the same defect the write gate carried: the
// screen composed its headline and its "Flowing into Dentally" grouping from the
// MODE alone, and the mode says only that the three DENTALLY_WRITE_* variables
// are set — nothing about WHERE a write is aimed. Point the write base URL at
// /api/mock-dentally, which is exactly what this repo's own
// `azen-web-mockwrite-3002` rehearsal configuration does, and an owner reading
// this page was told "appointments and patient records made or changed here are
// written to your Dentally book" while nothing left the building.
//
// The ledger is faked at its seam; the mode and target predicates are REAL and
// read the environment, because the environment combination is the whole point.
// ===========================================================================

const h = vi.hoisted(() => ({
  masterOff: false,
  rows: [] as unknown[],
}));

vi.mock("./sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-ledger")>();
  return {
    ...actual,
    listWriteIntents: async () => ({ rows: h.rows, more: false }),
    countWriteIntents: async () => ({
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 0 },
      total: 0,
      capped: false,
    }),
  };
});
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => !h.masterOff,
  isSystemExplicitlyDisabled: async () => h.masterOff,
}));

import { assembleSyncStatus } from "./sync-status";

const ENV_KEYS = [
  "DENTALLY_WRITE_ENABLED",
  "DENTALLY_WRITE_API_KEY",
  "DENTALLY_WRITE_BASE_URL",
  "DENTALLY_BASE_URL",
  "DENTALLY_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

/** Armed, and aimed at the practice's real book. */
function armedAtTheBook(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DENTALLY_WRITE_ENABLED = "true";
  process.env.DENTALLY_WRITE_API_KEY = "write-key";
  process.env.DENTALLY_WRITE_BASE_URL = "https://api.dentally.co";
}

/** Armed, and aimed at the local mock — the repo's own rehearsal config. */
function armedAtTheMock(): void {
  armedAtTheBook();
  process.env.DENTALLY_WRITE_BASE_URL = "http://localhost:3002/api/mock-dentally";
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  h.masterOff = false;
  h.rows = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the Sync Status page never claims a mock write reached the practice's book", () => {
  it("headlines an armed-at-the-mock deployment as OFF, not as ON", async () => {
    armedAtTheMock();
    const payload = await assembleSyncStatus("vitality");
    expect(payload.headline, "an owner was told a rehearsal reaches their Dentally book").not.toMatch(
      /Writing back to Dentally is ON/,
    );
    expect(payload.headline).toMatch(/is OFF/);
  });

  it("puts nothing in 'Flowing into Dentally' while the writes only reach a mock", async () => {
    armedAtTheMock();
    const payload = await assembleSyncStatus("vitality");
    expect(payload.facts.filter((f) => f.group === "mirrored")).toEqual([]);
    expect(payload.facts.filter((f) => f.group === "pending_on_key").length).toBeGreaterThan(0);
  });

  it("still reports the connection itself as ARMED, because it is", async () => {
    // `mode` answers a different question from the headline — "is this deployment
    // armed for writing" — and the screen prints it beside "The connection
    // itself". Weakening that would trade one wrong sentence for another.
    armedAtTheMock();
    const payload = await assembleSyncStatus("vitality");
    expect(payload.mode).toBe("live");
    expect(payload.target).toEqual({ host: "localhost:3002", live: false });
  });

  it("CONTROL: armed and aimed at the real book DOES say it is flowing", async () => {
    armedAtTheBook();
    const payload = await assembleSyncStatus("vitality");
    expect(payload.headline).toMatch(/Writing back to Dentally is ON/);
    expect(payload.facts.filter((f) => f.group === "mirrored").length).toBeGreaterThan(0);
    expect(payload.target).toEqual({ host: "api.dentally.co", live: true });
  });

  it("the owner's own master switch still wins the sentence, mock or not", async () => {
    // Three states, not two: "you have switched it off" is the nearer fact and
    // the one the reader can act on.
    armedAtTheMock();
    h.masterOff = true;
    const payload = await assembleSyncStatus("vitality");
    expect(payload.headline).toMatch(/because you have switched it off/i);
    expect(payload.master.off).toBe(true);
  });
});
