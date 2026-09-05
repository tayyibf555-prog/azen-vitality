// THE PATIENT'S CANCEL LEAVES THE SAME TRACE AS THE RECEPTIONIST'S.
//
// Ruling W3/16 (programme law): "A patient SMS cancellation while write-back is
// off records a blocked ledger row like the desk cancel (W1-A/1 record → then
// refuse). The W1-E early-return trade was granted to copilot create_patient
// ONLY." Charter §2 W1-A: "Every write the platform WOULD make is visible even
// while writes are off."
//
// What was wrong: `handleNoshowInbound` wrapped its Dentally cancel in
// `if (target && writesEnabled)`, so with write-back off (today's production
// state) the gate was never asked and no `dentally_write_intent` row was filed.
// The DESK cancel in src/app/api/noshow/[action]/route.ts had already been
// changed the other way this wave; the inbound door kept the old shape. Nobody
// was misled — the patient is correctly told reception will confirm — but the
// Sync Status screen showed the receptionist's cancellations and not the
// patients', so "what did we try to send to Dentally while write-back was off"
// was an incomplete answer, and the day the write key arrives there would be no
// record that these appointments were cancelled here and not there.
//
// These tests drive the REAL write gate (only the ledger writer and the systems
// toggle reads are doubled), so what they assert is the gate's own policy
// answer, not a reason this door invented for itself.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { WriteIntentInput } from "@/lib/dentally/sync-ledger";
import type { NoshowTarget, NoshowCadence } from "./types";

const store = vi.hoisted(() => ({
  targetStatus: new Map<string, string>(),
  cadencePatch: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  reoffered: [] as string[],
  cancelAppointment: vi.fn(),
  recordWriteIntent: vi.fn<(input: WriteIntentInput) => Promise<string | null>>(async () => "intent-1"),
  explicitlyDisabled: false,
  systemEnabled: true,
  target: null as NoshowTarget | null,
  cadence: null as NoshowCadence | null,
}));

vi.mock("./repository", () => ({
  findOpenOfferByAddress: vi.fn(async () => null),
  claimOffer: vi.fn(async () => null),
  slotIsFilled: vi.fn(async () => false),
  setOfferStatus: vi.fn(async () => {}),
  setWaitlistStatus: vi.fn(async () => {}),
  findTargetByAddress: vi.fn(async () =>
    store.target ? { targetId: store.target.id, siteId: store.target.siteId } : null,
  ),
  listActiveTargetIdsByAddress: vi.fn(async () => (store.target ? [store.target.id] : [])),
  getTarget: vi.fn(async () => store.target),
  getCadenceByTarget: vi.fn(async () => store.cadence),
  insertInboundTouch: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async (id: string, status: string) => {
    store.targetStatus.set(id, status);
  }),
  updateCadence: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    store.cadencePatch.push({ id, patch });
  }),
}));

vi.mock("./fill", () => ({
  offerSlotToNextCandidate: vi.fn(async (slot: { appointmentId: string }) => {
    store.reoffered.push(slot.appointmentId);
    return { waitlistId: "next" };
  }),
}));

vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: (body: string) => /^\s*(stop|end|quit|unsubscribe)\b/i.test(body),
}));

// The ledger's ONE writer, doubled so the row can be read back. Everything else
// in the gate — the mode, the target host, the refusal order — is the real thing.
vi.mock("@/lib/dentally/sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/sync-ledger")>();
  return { ...actual, recordWriteIntent: store.recordWriteIntent };
});

// The owner's switches, doubled so a test says which lever is down rather than
// depending on a database that is not there.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => store.systemEnabled),
  isSystemEnabledStrict: vi.fn(async () => store.systemEnabled),
  isSystemExplicitlyDisabled: vi.fn(async () => store.explicitlyDisabled),
}));

import { handleNoshowInbound } from "./inbound";

function fakeDentally() {
  return { cancelAppointment: store.cancelAppointment } as unknown as import("@/lib/dentally/client").DentallyClient;
}

function seedTarget(): NoshowTarget {
  const t = {
    id: "site-cc:pat-9:appt-77",
    siteId: "site-cc",
    dentallyPatientId: "pat-9",
    appointmentId: "appt-77",
    patientName: "A Patient",
    appointmentStartAt: "2026-07-10T09:30:00.000Z",
    durationMin: 30,
    practitioner: "Dr Khan",
    status: "reminded",
  } as unknown as NoshowTarget;
  store.target = t;
  store.cadence = { id: "cad-1", status: "active" } as unknown as NoshowCadence;
  return t;
}

// Production's shape: the read base URL is the live practice book, and the write
// path is not armed. dentallyWriteTarget() resolves `live` from exactly this.
const previousBaseUrl = process.env.DENTALLY_BASE_URL;
beforeEach(() => {
  process.env.DENTALLY_BASE_URL = "https://api.dentally.co";
  store.targetStatus.clear();
  store.cadencePatch.length = 0;
  store.reoffered.length = 0;
  store.target = null;
  store.cadence = null;
  store.explicitlyDisabled = false;
  store.systemEnabled = true;
  store.cancelAppointment.mockReset().mockResolvedValue({ appointment: { id: "appt-77", state: "cancelled" } });
  store.recordWriteIntent.mockReset().mockResolvedValue("intent-1");
});
afterAll(() => {
  if (previousBaseUrl === undefined) delete process.env.DENTALLY_BASE_URL;
  else process.env.DENTALLY_BASE_URL = previousBaseUrl;
});

async function cancelBySms(writesEnabled: boolean) {
  return handleNoshowInbound({
    from: "+447700900001",
    body: "No",
    channel: "sms",
    dentally: fakeDentally(),
    writesEnabled,
    now: new Date("2026-07-08T09:00:00Z"),
  });
}

describe("W3/16: a patient's CANCEL while write-back is off is RECORDED, not lost", () => {
  it("files a blocked appointment.cancel intent for the patient's reply, like the desk cancel", async () => {
    seedTarget();
    const res = await cancelBySms(false);

    expect(store.recordWriteIntent).toHaveBeenCalledTimes(1);
    expect(store.recordWriteIntent.mock.calls[0][0]).toMatchObject({
      clientId: "vitality",
      siteId: "site-cc",
      kind: "appointment.cancel",
      source: "noshow",
      moduleSlug: "no-show-defence",
      dentallyPatientId: "pat-9",
      dentallyAppointmentId: "appt-77",
      target: "api.dentally.co",
      status: "blocked",
      blockedReason: "writes_disabled",
      // W1-A/2: an agent slug, never a person.
      actor: "agent:no-show-defence",
    });

    // ...and NOTHING about what the patient is told has changed.
    expect(store.cancelAppointment).not.toHaveBeenCalled();
    expect(store.targetStatus.get("site-cc:pat-9:appt-77")).toBe("cancelled");
    expect(res.reply).toMatch(/reception/i);
    expect(res.reply).not.toMatch(/that is cancelled/i);
    expect(store.reoffered).toHaveLength(0);
  });

  it("takes the blocked REASON from the gate's own policy, not from this door", async () => {
    // The owner's master Dentally write-back switch is explicitly off. The desk
    // cancel would file master_off here; so does the patient's, because both ask
    // the same evaluateGate and neither spells a reason of its own.
    seedTarget();
    store.explicitlyDisabled = true;

    const res = await cancelBySms(false);

    expect(store.recordWriteIntent).toHaveBeenCalledTimes(1);
    expect(store.recordWriteIntent.mock.calls[0][0]).toMatchObject({
      kind: "appointment.cancel",
      status: "blocked",
      blockedReason: "master_off",
    });
    expect(store.cancelAppointment).not.toHaveBeenCalled();
    expect(res.reply).toMatch(/reception/i);
  });

  it("files EXACTLY ONE row per cancellation — the write path is not double-recorded", async () => {
    // With writes enabled the gate performs and records the attempt itself; the
    // precheck must not run as well, or one cancellation would appear twice on
    // the Sync Status screen.
    seedTarget();
    const res = await cancelBySms(true);

    expect(store.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(store.recordWriteIntent).toHaveBeenCalledTimes(1);
    expect(store.recordWriteIntent.mock.calls[0][0]).toMatchObject({
      kind: "appointment.cancel",
      // Simulated, because the deployment env is not armed: it ran, and not
      // against the real book.
      status: "dry_run",
    });
    expect(res.reply).toMatch(/that is cancelled/i);
    expect(store.reoffered).toEqual(["appt-77"]);
  });

  it("a ledger failure never changes what the patient is told", async () => {
    // recordWriteIntent is fail-soft by contract, but a contract is not a
    // guarantee: an escaped error here would be a 500 on a Twilio webhook, and
    // Twilio retries a non-2xx — re-running the whole turn.
    seedTarget();
    store.recordWriteIntent.mockRejectedValue(new Error("relation dentally_write_intent does not exist"));

    const res = await cancelBySms(false);

    expect(res.handled).toBe(true);
    expect(res.reply).toMatch(/reception/i);
    expect(res.reply).not.toMatch(/that is cancelled/i);
    expect(store.targetStatus.get("site-cc:pat-9:appt-77")).toBe("cancelled");
    expect(store.reoffered).toHaveLength(0);
  });

  it("records nothing for a reply that is not a cancel", async () => {
    // The row means "the platform tried to write to Dentally". A confirmation
    // writes nothing, so it must not appear on the sync screen at all.
    seedTarget();
    const res = await handleNoshowInbound({
      from: "+447700900001",
      body: "Yes",
      channel: "sms",
      dentally: fakeDentally(),
      writesEnabled: false,
      now: new Date("2026-07-08T09:00:00Z"),
    });
    expect(res.reply).toMatch(/thanks for confirming/i);
    expect(store.recordWriteIntent).not.toHaveBeenCalled();
  });
});
