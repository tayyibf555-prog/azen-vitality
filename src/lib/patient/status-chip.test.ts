// The one status chip both surfaces of the patient record render.
//
// The case that matters most is the first one below. getOverride THROWS on any
// database error, and both the record shell and the Details tab caught it to null,
// which fell through to Dentally's active flag: a patient the practice had marked
// do_not_contact after a complaint was presented with a green "Active" pill, and
// nothing on the screen said the marker could not be read.
import { describe, it, expect } from "vitest";
import { patientStatusChip } from "./status-chip";

describe("patientStatusChip", () => {
  it("says the read failed rather than falling back to Active", () => {
    const chip = patientStatusChip({ overrideStatus: null, overrideUnavailable: true, active: true });
    expect(chip.unavailable).toBe(true);
    expect(chip.label).toBe("Status not read");
    expect(chip.tone).not.toBe("success");
  });

  it("still says the read failed when an override happens to be in hand", () => {
    // An override value loaded from a stale prop must not outrank a failed read.
    const chip = patientStatusChip({
      overrideStatus: "active",
      overrideUnavailable: true,
      active: true,
    });
    expect(chip.unavailable).toBe(true);
  });

  it("lets the platform override beat Dentally's active flag", () => {
    const chip = patientStatusChip({ overrideStatus: "do_not_contact", active: true });
    expect(chip).toEqual({ tone: "danger", label: "Do not contact", unavailable: false });
  });

  it("falls back to Dentally's flag when no override is set", () => {
    expect(patientStatusChip({ overrideStatus: null, active: true })).toEqual({
      tone: "success",
      label: "Active",
      unavailable: false,
    });
    expect(patientStatusChip({ overrideStatus: null, active: false, archivedReason: "lapsed" })).toEqual({
      tone: "neutral",
      label: "Lapsed",
      unavailable: false,
    });
    expect(patientStatusChip({ overrideStatus: null, active: false, archivedReason: null })).toEqual({
      tone: "neutral",
      label: "Inactive",
      unavailable: false,
    });
  });

  it("never renders a do-not-contact patient in a reassuring tone", () => {
    expect(patientStatusChip({ overrideStatus: "do_not_contact", active: true }).tone).toBe("danger");
    expect(patientStatusChip({ overrideStatus: "do_not_contact", active: false }).tone).toBe("danger");
  });
});
