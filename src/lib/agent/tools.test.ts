import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, makeDispatch } from "./tools";

describe("AGENT_TOOLS", () => {
  it("exposes find_slots, book and escalate_to_human", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(["book", "escalate_to_human", "find_slots"]);
  });
});

describe("makeDispatch", () => {
  const context = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold", treatment: "Invisalign", fundingType: "private" as const };

  it("find_slots returns the diary slots from Dentally", async () => {
    const dentally = {
      getAvailability: vi.fn().mockResolvedValue({ availability: [{ start_time: "2026-06-22T09:00:00Z" }] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("find_slots", { treatment: "Invisalign" });
    expect(dentally.getAvailability).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-cc" }));
    expect(out).toContain("2026-06-22T09:00:00Z");
  });

  it("book calls createAppointment with booked_via_api and the patient/site", async () => {
    const dentally = {
      getAvailability: vi.fn(),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", treatment: "Invisalign" });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(payload).toMatchObject({ patient_id: "pat-010", site_id: "site-cc", booked_via_api: true });
    expect(out).toContain("appt-1");
  });

  it("escalate_to_human acknowledges without external calls", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = await dispatch("escalate_to_human", { reason: "clinical question" });
    expect(out).toContain("escalated");
  });

  it("returns an error string for an unknown tool", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    expect(await dispatch("nope", {})).toContain("unknown");
  });
});
