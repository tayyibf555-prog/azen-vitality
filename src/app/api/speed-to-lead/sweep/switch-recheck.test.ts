import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// RULING W1-B/5 ON THE SPEED-TO-LEAD SLA SWEEP (the sixth sweep).
//
// This route runs for up to 300 seconds and calls the model to draft a first
// contact for every lead it claims. It used to read the speed-to-lead switch
// ONCE, at the top, and then loop: an owner who switched the system off in the
// middle of a batch kept paying for drafts, and kept texting, until the batch
// ran out. Lane W2-C found it; the fix is the same shared gate the other five
// sweeps use (src/lib/systems/live-switch.ts), so the bound is ten rows rather
// than the whole run.
//
// It matters here more than anywhere else: the abandoned-booking rescue has no
// sweep of its own and rides this one (src/lib/agent-wiring/roster.ts names this
// file as its guard), so before the gate the rescue was the one agent no mid-run
// switch could stop.
//
// These tests drive the REAL route with the REAL gate. Only the boundary is
// faked: the switch is a mutable toggle the "owner" flips from inside a contact,
// exactly as flipping it in System controls mid-run would.
// ===========================================================================

const store = { systemEnabled: true, contacts: 0, flipOffAtContact: 0 };

const cronUnauthorized = vi.fn();
const nurtureSweep = vi.fn();
const acquireCronLock = vi.fn();
const releaseCronLock = vi.fn();
const resetStaleContacting = vi.fn();
const listUncontacted = vi.fn();
const claimLeadForContact = vi.fn();
const releaseLeadClaim = vi.fn();
const convertAbandonedHolds = vi.fn();

vi.mock("@/lib/cron", () => ({ cronUnauthorized: (...a: unknown[]) => cronUnauthorized(...a) }));
// contactLead stands in for the whole draft-and-send: counting its calls is how
// these tests measure "how many rows did this run actually draft for".
vi.mock("@/lib/speed-to-lead/contact", () => ({
  contactLead: vi.fn(async () => {
    store.contacts += 1;
    if (store.contacts === store.flipOffAtContact) store.systemEnabled = false;
  }),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listUncontacted: (...a: unknown[]) => listUncontacted(...a),
  claimLeadForContact: (...a: unknown[]) => claimLeadForContact(...a),
  releaseLeadClaim: (...a: unknown[]) => releaseLeadClaim(...a),
  resetStaleContacting: (...a: unknown[]) => resetStaleContacting(...a),
}));
vi.mock("@/lib/speed-to-lead/nurture", () => ({ nurtureSweep: (...a: unknown[]) => nurtureSweep(...a) }));
vi.mock("@/lib/booking/abandoned-holds", () => ({
  convertAbandonedHolds: (...a: unknown[]) => convertAbandonedHolds(...a),
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (...a: unknown[]) => acquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => releaseCronLock(...a),
}));
// The gate reads the switch through this same module, so one fake serves both
// the top-of-run check and every re-read inside the loop.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => store.systemEnabled),
  isSystemEnabledForSend: vi.fn(async () => store.systemEnabled),
}));

import { POST } from "./route";
import { SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";

function req(): Request {
  return new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" });
}

/** `n` leads past the SLA window, all first-contactable. */
function seedStale(n: number): void {
  listUncontacted.mockResolvedValue(
    Array.from({ length: n }, (_, i) => ({ id: `lead-${i}`, siteId: "site-cc", phone: `+44770090${1000 + i}` })),
  );
}

async function sweep(): Promise<Record<string, unknown>> {
  return (await (await POST(req())).json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.systemEnabled = true;
  store.contacts = 0;
  store.flipOffAtContact = 0;
  cronUnauthorized.mockReturnValue(null); // authorized
  acquireCronLock.mockResolvedValue(true);
  releaseCronLock.mockResolvedValue(undefined);
  resetStaleContacting.mockResolvedValue(0);
  claimLeadForContact.mockResolvedValue(true);
  releaseLeadClaim.mockResolvedValue(undefined);
  convertAbandonedHolds.mockResolvedValue({ converted: 0 });
  listUncontacted.mockResolvedValue([]);
  nurtureSweep.mockResolvedValue({ due: 0, sent: 0, exited: 0, retired: 0, capped: 0, failed: 0, completed: 0, skipped: 0 });
});

describe("ruling W1-B/5: the speed-to-lead SLA sweep re-reads its switch mid-run", () => {
  it("stops first-contacting within ten rows of a mid-run switch-off", async () => {
    seedStale(60);
    store.flipOffAtContact = 13; // the owner flips it off once the 13th lead is contacted

    const body = await sweep();

    // It must not stop instantly (that would mean a read per row, which the
    // ruling deliberately does not ask for), and it must not run past the bound.
    expect(store.contacts, "the sweep stopped before the flip; the gate is reading too eagerly").toBeGreaterThan(12);
    expect(store.contacts, "the sweep kept drafting past the ten-row bound after a mid-run switch-off").toBeLessThanOrEqual(
      13 + SWITCH_RECHECK_EVERY_ROWS,
    );
    expect(body.switchedOffMidRun, "the run did not report that the owner stopped it").toBe(true);
    expect(body.contacted).toBe(store.contacts);
  });

  it("claims no lead it will not contact, so a stopped run strands none at 'contacting'", async () => {
    seedStale(60);
    store.flipOffAtContact = 13;

    await sweep();

    // The gate is consulted BEFORE claimLeadForContact: every claimed lead was
    // contacted, and every lead the gate refused is untouched at 'new' for the
    // next tick rather than waiting ten minutes for resetStaleContacting. The
    // bound is asserted here too, so a sweep that simply never stopped fails this
    // step rather than passing it by claiming all sixty.
    expect(claimLeadForContact).toHaveBeenCalledTimes(store.contacts);
    expect(claimLeadForContact.mock.calls.length, "leads were claimed past the ten-row bound").toBeLessThanOrEqual(
      13 + SWITCH_RECHECK_EVERY_ROWS,
    );
  });

  it("does not start the nurture pass once the switch has been read as off", async () => {
    seedStale(60);
    store.flipOffAtContact = 13;

    const body = await sweep();

    // A nurture touch is a model-drafted message too. Stopping the first-contact
    // loop and then drafting ten nudges would honour the letter of the ruling and
    // miss its point.
    expect(nurtureSweep).not.toHaveBeenCalled();
    expect(body.nurture).toMatchObject({ skipped: "system switched off mid-run" });
  });

  it("CONTROL: with the switch left on, every stale lead is contacted and nurture runs", async () => {
    // Without this the assertions above would pass against a sweep that stopped
    // for any reason at all, including one that contacted nobody.
    seedStale(60);

    const body = await sweep();

    expect(store.contacts).toBe(60);
    expect(body).toMatchObject({ ok: true, contacted: 60, switchedOffMidRun: false });
    expect(nurtureSweep).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a switch that was already off never reaches the loop at all", async () => {
    seedStale(60);
    store.systemEnabled = false;

    const body = await sweep();

    expect(body).toMatchObject({ ok: true, skipped: "system off" });
    expect(store.contacts).toBe(0);
    expect(acquireCronLock).not.toHaveBeenCalled();
  });
});
