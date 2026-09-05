import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// WHAT `sync_status` ANSWERS ABOUT — THE PRACTICE'S BOOK, NOT THE ARMING.
//
// Two questions live in this one tool result and they are not the same question:
//
//   deploymentArmed        is this deployment armed for writing? (the three
//                          DENTALLY_WRITE_* variables — what the Sync Status
//                          screen prints beside "The connection itself")
//   writingBackToDentally  does what this platform does reach the practice's
//                          real Dentally book?
//
// An armed deployment aimed at the repo's own mock-write rehearsal
// (`azen-web-mockwrite-3002`) is armed and reaches NOTHING. The module that
// assembles this payload has folded the target in everywhere else — the
// headline, the three fact groups and the ledger's own labels are all composed
// on `reachesTheBook = mode === "live" && target.live` (sync-status.ts) — and
// this field was the last surface in the tree still reading "armed" as "reaching
// the practice's book". An owner told "appointments made here are written to
// your Dentally book" while every one of them lands in a local rehearsal is the
// exact untruth the ledger's `sent` status carried until the gate learned to ask
// both halves.
//
// AND THE HEADINGS NAME A SWITCH THE READER CAN FLIP. `SYNC_GROUP_TITLES` is the
// cause-NEUTRAL wording, correct for a caller that cannot tell which of the two
// things is in the way. This caller can: it holds `master.off`. So it calls
// `syncGroupTitles(masterOff)` and the assistant says "waiting on your switch in
// System controls" to an owner who can act on it, rather than pointing them at a
// write key their agency has already supplied.
//
// The payload is stubbed at `assembleSyncStatus` — the module's own behaviour is
// tested in src/lib/dentally/sync-surface.test.ts and the gate's in
// write-gate.test.ts. What is proven HERE is the derivation this tool does on
// top of it, which nothing else covers.
// ===========================================================================

vi.mock("server-only", () => ({}));

const SITE = { id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" };
vi.mock("@/lib/mock", () => ({ getSite: () => SITE, getSites: () => [SITE], getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }) }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => SITE,
  getSites: () => [SITE],
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

/** The one payload the tool reads, swapped per scenario. */
const state = vi.hoisted(() => ({
  mode: "dry_run" as "dry_run" | "live",
  target: { host: "api.dentally.co", live: true },
  masterOff: false,
}));

vi.mock("@/lib/dentally/sync-status", () => ({
  assembleSyncStatus: async (_clientId: string, limit: number) => ({
    mode: state.mode,
    target: state.target,
    master: { slug: "dentally-write-back", off: state.masterOff },
    headline: "Writing back to Dentally is OFF.",
    facts: [
      { id: "appointment.create", label: "New appointments", detail: "…", group: "pending_on_key", sources: ["Co-pilot"] },
      { id: "notes", label: "Clinical and practice notes", detail: "…", group: "blocked_by_governance", sources: [] },
      { id: "appointment.move", label: "Appointment moves", detail: "…", group: "mirrored", sources: ["Diary"] },
    ],
    counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 0 },
    total: 0,
    countCapped: false,
    intents: [],
    more: false,
    pageSize: limit,
    ledgerError: null,
  }),
}));

import { SYNC_GROUP_TITLES, syncGroupTitle } from "@/lib/dentally/sync-surface";
import { makeCopilotDispatch } from "./tools";

const owner = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full");

async function syncStatus() {
  return JSON.parse(await owner("sync_status", {})) as Record<string, unknown>;
}

beforeEach(() => {
  state.mode = "dry_run";
  state.target = { host: "api.dentally.co", live: true };
  state.masterOff = false;
});

describe("sync_status separates 'armed' from 'reaching the practice's book'", () => {
  it("AN ARMED DEPLOYMENT AIMED AT THE MOCK ANSWERS 'OFF'", async () => {
    // The state this exists for: the three env variables are set, so the
    // deployment IS armed, and every write lands in the repo's own rehearsal
    // server. Armed, and reaching nothing.
    state.mode = "live";
    state.target = { host: "localhost:3002", live: false };
    const out = await syncStatus();
    expect(out.writingBackToDentally).toBe("off");
    // ...and the OTHER question still answers honestly, because it is a
    // different question: the owner is told the arming is done, so they know the
    // only thing left is where it points.
    expect(out.deploymentArmed).toBe(true);
    expect(out.practiceSwitchOff).toBe(false);
  });

  it("only armed AND live-targeted AND switched on answers 'on'", async () => {
    state.mode = "live";
    state.target = { host: "api.dentally.co", live: true };
    const out = await syncStatus();
    expect(out.writingBackToDentally).toBe("on");

    // Each half withdrawn on its own puts it back to "off", so no one of the
    // three can be dropped without this going red.
    state.masterOff = true;
    expect((await syncStatus()).writingBackToDentally).toBe("off");

    state.masterOff = false;
    state.mode = "dry_run";
    expect((await syncStatus()).writingBackToDentally).toBe("off");
  });

  it("an UNARMED deployment says so, whatever it is pointed at", async () => {
    state.mode = "dry_run";
    const out = await syncStatus();
    expect(out.writingBackToDentally).toBe("off");
    expect(out.deploymentArmed).toBe(false);
  });
});

describe("sync_status names the switch the owner can flip", () => {
  it("THE OWNER'S OWN SWITCH IS NAMED FIRST when it is the one in the way", async () => {
    state.masterOff = true;
    const titles = (await syncStatus()).groupTitles as Record<string, string>;
    expect(titles.pending_on_key).toBe(syncGroupTitle("pending_on_key", true));
    expect(titles.pending_on_key).toMatch(/System controls/);
    expect(titles.pending_on_key).not.toMatch(/write key/i);
    // The cause-neutral wording is what this used to send, and it is what the
    // assistant must no longer be handed when the caller knows better.
    expect(titles.pending_on_key).not.toBe(SYNC_GROUP_TITLES.pending_on_key);
  });

  it("the write key is named when the owner's switch is already on", async () => {
    state.masterOff = false;
    const titles = (await syncStatus()).groupTitles as Record<string, string>;
    expect(titles.pending_on_key).toBe(syncGroupTitle("pending_on_key", false));
    expect(titles.pending_on_key).toMatch(/write key/i);
  });

  it("the two headings that are facts about Dentally do not move", async () => {
    // Only `pending_on_key` is about a switch. "Stays in this platform" is a
    // fact about what Dentally's API can accept, and it reads the same either way.
    for (const masterOff of [true, false]) {
      state.masterOff = masterOff;
      const titles = (await syncStatus()).groupTitles as Record<string, string>;
      expect(titles.mirrored).toBe(SYNC_GROUP_TITLES.mirrored);
      expect(titles.blocked_by_governance).toBe(SYNC_GROUP_TITLES.blocked_by_governance);
    }
  });
});
