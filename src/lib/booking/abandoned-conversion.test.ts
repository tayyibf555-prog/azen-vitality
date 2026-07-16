import { describe, it, expect, vi, beforeEach } from "vitest";

// The lazy abandoned-hold -> lead conversion the speed-to-lead sweep hosts.
// Guarantees under test: it converts an abandoned hold into an 'abandoned-booking'
// lead, DEDUPES on the contact (never a second lead for someone already open), and
// is per-hold best-effort so one failing hold can NEVER throw into the sweep.

const h = vi.hoisted(() => ({
  listAbandonedHolds: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  markHoldExpired: vi.fn(async (..._a: unknown[]) => {}),
  findOpenLeadByAddress: vi.fn(async (..._a: unknown[]) => null as unknown),
  insertLead: vi.fn(async (..._a: unknown[]) => ({ id: "lead-1" })),
}));

vi.mock("./holds", () => ({
  listAbandonedHolds: (...a: unknown[]) => h.listAbandonedHolds(...a),
  markHoldExpired: (...a: unknown[]) => h.markHoldExpired(...a),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findOpenLeadByAddress: (...a: unknown[]) => h.findOpenLeadByAddress(...a),
  insertLead: (...a: unknown[]) => h.insertLead(...a),
}));

import { convertAbandonedHolds } from "./abandoned-holds";

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: "hold-1",
    clientId: "vitality",
    siteId: "site-cc",
    slotStart: "2026-07-21T09:00:00.000Z",
    slotFinish: "2026-07-21T09:30:00.000Z",
    practitionerId: "7",
    practitionerName: null,
    treatment: "Exam",
    name: "Alex Patient",
    phone: "+447700900123",
    email: null,
    status: "held",
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-07-20T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.findOpenLeadByAddress.mockResolvedValue(null);
  h.insertLead.mockResolvedValue({ id: "lead-1" });
  h.markHoldExpired.mockResolvedValue(undefined);
});

describe("convertAbandonedHolds", () => {
  it("queries with a 20-minute abandonment window and a 48h staleness floor", async () => {
    h.listAbandonedHolds.mockResolvedValue([]);
    await convertAbandonedHolds(NOW);
    const [olderThanIso, freshestIso, limit] = h.listAbandonedHolds.mock.calls[0]!;
    // 20 minutes before NOW.
    expect(olderThanIso).toBe(new Date(NOW.getTime() - 20 * 60_000).toISOString());
    // 48 hours before NOW.
    expect(freshestIso).toBe(new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString());
    expect(limit).toBeGreaterThan(0);
  });

  it("converts a fresh abandoned hold into an 'abandoned-booking' lead and expires it", async () => {
    h.listAbandonedHolds.mockResolvedValue([hold()]);
    const res = await convertAbandonedHolds(NOW);

    expect(h.insertLead).toHaveBeenCalledTimes(1);
    const lead = h.insertLead.mock.calls[0]![0] as Record<string, unknown>;
    expect(lead.source).toBe("abandoned-booking");
    expect(lead.channel).toBe("sms");
    expect(lead.siteId).toBe("site-cc");
    expect(lead.phone).toBe("+447700900123");
    expect(lead.consent).toMatchObject({ sms: true });
    // The wanted slot rides along in treatment_interest (no notes column on leads).
    expect(String(lead.treatmentInterest)).toContain("Exam");
    expect(String(lead.treatmentInterest).toLowerCase()).toContain("wanted");

    expect(h.markHoldExpired).toHaveBeenCalledWith("hold-1");
    expect(res).toMatchObject({ checked: 1, converted: 1, deduped: 0 });
  });

  it("dedupes against an already-open lead: no new lead, hold still retired", async () => {
    h.listAbandonedHolds.mockResolvedValue([hold()]);
    h.findOpenLeadByAddress.mockResolvedValue({ id: "existing-lead" });
    const res = await convertAbandonedHolds(NOW);

    expect(h.insertLead).not.toHaveBeenCalled();
    expect(h.markHoldExpired).toHaveBeenCalledWith("hold-1");
    expect(res).toMatchObject({ converted: 0, deduped: 1 });
  });

  it("is best-effort per hold: one failure never throws and does not stop the rest", async () => {
    h.listAbandonedHolds.mockResolvedValue([hold({ id: "bad" }), hold({ id: "good", phone: "+447700900999" })]);
    // The first hold's insert blows up; the second must still convert.
    h.insertLead
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ id: "lead-2" });

    const res = await convertAbandonedHolds(NOW);

    // Did not throw, and the healthy hold still converted + expired.
    expect(res.converted).toBe(1);
    expect(h.markHoldExpired).toHaveBeenCalledWith("good");
    // The failed hold was NOT expired (left 'held' for a retry next tick).
    expect(h.markHoldExpired).not.toHaveBeenCalledWith("bad");
  });
});
