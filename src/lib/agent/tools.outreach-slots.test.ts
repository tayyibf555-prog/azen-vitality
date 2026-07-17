// find_slots practitioner targeting: the pure filter, plus the dispatch behaviour
// where a segment-outreach invite primes a preferred clinician and "any" broadens
// back to every clinician.
import { describe, it, expect, vi } from "vitest";
import { filterSlotsByPractitioner, makeDispatch } from "./tools";
import type { AgentContext } from "./types";

describe("filterSlotsByPractitioner", () => {
  const slots = [
    { start_time: "2026-07-18T09:00:00Z", practitioner_id: "p1" },
    { start_time: "2026-07-18T09:30:00Z", practitioner_id: "p2" },
    { start_time: "2026-07-18T10:00:00Z", practitioner_id: "p1" },
  ];

  it("returns every slot when no practitioner is given", () => {
    expect(filterSlotsByPractitioner(slots, null)).toHaveLength(3);
    expect(filterSlotsByPractitioner(slots, "")).toHaveLength(3);
  });

  it("keeps only the named practitioner's slots", () => {
    const only = filterSlotsByPractitioner(slots, "p1");
    expect(only).toHaveLength(2);
    expect(only.every((s) => (s as { practitioner_id: string }).practitioner_id === "p1")).toBe(true);
  });

  it("returns nothing for a practitioner with no availability", () => {
    expect(filterSlotsByPractitioner(slots, "p9")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dispatch integration: find_slots honours the campaign's preferred practitioner
// from context, and the "any" override broadens back to all clinicians.
// ---------------------------------------------------------------------------

const AVAILABILITY = [
  { start_time: "2026-07-18T09:00:00Z", finish_time: "2026-07-18T09:30:00Z", practitioner_id: "p1" },
  { start_time: "2026-07-18T09:30:00Z", finish_time: "2026-07-18T10:00:00Z", practitioner_id: "p2" },
  { start_time: "2026-07-18T10:00:00Z", finish_time: "2026-07-18T10:30:00Z", practitioner_id: "p1" },
];

function deps(overrides: Partial<AgentContext> = {}) {
  const context: AgentContext = {
    patientId: "123",
    siteId: "site-cc",
    patientName: "Sam",
    treatment: "hygiene",
    fundingType: null,
    ...overrides,
  };
  const dentally = {
    listPractitioners: vi.fn(async () => ({ practitioners: [{ id: "p1", active: true }, { id: "p2", active: true }] })),
    getAvailability: vi.fn(async () => ({ availability: AVAILABILITY })),
    createAppointment: vi.fn(),
    createPatient: vi.fn(),
    getPatientAppointments: vi.fn(),
    updateAppointment: vi.fn(),
    cancelAppointment: vi.fn(),
  };
  return { context, dentally };
}

async function callFindSlots(d: ReturnType<typeof deps>, input: Record<string, unknown>) {
  const dispatch = makeDispatch(d as never);
  const out = await dispatch("find_slots", input);
  return JSON.parse(out) as { slots: Array<{ practitioner_id: string }> };
}

describe("find_slots dispatch practitioner targeting", () => {
  it("offers the outreach-invited clinician's slots first, without the model passing an id", async () => {
    const d = deps({ outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr P1", practitionerId: "p1" } });
    const { slots } = await callFindSlots(d, { treatment: "hygiene" });
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.practitioner_id === "p1")).toBe(true);
  });

  it('broadens to every clinician when the model passes practitionerId "any"', async () => {
    const d = deps({ outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr P1", practitionerId: "p1" } });
    const { slots } = await callFindSlots(d, { treatment: "hygiene", practitionerId: "any" });
    expect(slots).toHaveLength(3);
  });

  it("an explicit practitionerId overrides the invited default", async () => {
    const d = deps({ outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr P1", practitionerId: "p1" } });
    const { slots } = await callFindSlots(d, { treatment: "hygiene", practitionerId: "p2" });
    expect(slots).toHaveLength(1);
    expect(slots[0].practitioner_id).toBe("p2");
  });

  it("SOFT-prefers: when the invited clinician has NO slots, falls back to other clinicians (finding #7)", async () => {
    // p3 was invited but has no availability in the window. The patient must still be
    // offered every clinician's slots, not told there is nothing free.
    const d = deps({ outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr Gone", practitionerId: "p3" } });
    const { slots } = await callFindSlots(d, { treatment: "hygiene" });
    expect(slots).toHaveLength(3);
  });

  it("an EXPLICIT practitionerId with no slots stays a hard filter (does not fall back)", async () => {
    // An explicit clinician request is an intentional choice: honour it even when empty,
    // unlike the soft outreach preference. Only the invite path softens.
    const d = deps({ outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr P1", practitionerId: "p1" } });
    const { slots } = await callFindSlots(d, { treatment: "hygiene", practitionerId: "p3" });
    expect(slots).toHaveLength(0);
  });

  it("returns all slots for an ordinary conversation (no outreach invite)", async () => {
    const d = deps();
    const { slots } = await callFindSlots(d, { treatment: "hygiene" });
    expect(slots).toHaveLength(3);
  });
});
