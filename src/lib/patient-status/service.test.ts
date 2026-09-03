// applyStatusChange orchestration: override upsert + audit + Dentally sync mapping +
// suppression routing. Repository, suppression and the Dentally write client are doubled
// so we pin the ORCHESTRATION (what gets called, with what, in response to each status).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  current: null as { status: string } | null,
  updatePatient: vi.fn(async () => ({ patient: { id: "p1", active: true } })),
  writeEnabled: false,
}));

vi.mock("./repository", () => ({
  getOverride: vi.fn(async () => h.current),
  upsertOverride: vi.fn(async () => {}),
  markOverrideSynced: vi.fn(async () => {}),
  insertAudit: vi.fn(async () => {}),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  addAdminDoNotContact: vi.fn(async () => {}),
  clearAdminDoNotContact: vi.fn(async () => {}),
}));
// The WriteGate consults the OWNER's master Dentally write-back switch, and then
// the switch on the module that is writing. Both readers are stubbed ON here:
// this file's subject is what its own module does with the answer, and the
// switches have their own tests in src/lib/systems/repository.test.ts and
// src/lib/dentally/write-gate.test.ts.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => h.writeEnabled,
  dentallyAgentClient: () => ({ updatePatient: h.updatePatient }),
  // Added when the WriteGate landed. The gate resolves the target host through
  // the same predicate the client factory uses, so a partial mock of this module
  // has to carry it — and `true` is the posture these tests are ABOUT: a
  // production deployment whose base URL is the live practice book. That is
  // exactly when "writes are off" has to mean nothing happens at all, rather
  // than a write landing in a local mock.
  targetsRealDentally: () => true,
}));

import { applyStatusChange } from "./service";
import { upsertOverride, markOverrideSynced, insertAudit } from "./repository";
import { addAdminDoNotContact, clearAdminDoNotContact } from "@/lib/messaging/suppression";

beforeEach(() => {
  vi.clearAllMocks();
  h.current = null;
  h.writeEnabled = false;
  h.updatePatient.mockResolvedValue({ patient: { id: "p1", active: true } });
});

describe("applyStatusChange - Dentally sync mapping", () => {
  it("active with writes DISABLED: dentally 'skipped', no updatePatient, override upserted, audit records skipped", async () => {
    const r = await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "active", actorEmail: "o@x" });
    expect(r).toEqual({ status: "active", dentally: "skipped", fromStatus: null });
    expect(h.updatePatient).not.toHaveBeenCalled();
    expect(upsertOverride).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc", patientId: "p1", status: "active", setBy: "o@x" }),
    );
    expect(markOverrideSynced).not.toHaveBeenCalled();
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ toStatus: "active", dentallyResult: "skipped" }));
  });

  it("inactive with writes ENABLED: PUTs active:false, dentally 'synced', marks synced", async () => {
    h.writeEnabled = true;
    const r = await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "inactive" });
    expect(h.updatePatient).toHaveBeenCalledWith("p1", { active: false });
    expect(r.dentally).toBe("synced");
    expect(markOverrideSynced).toHaveBeenCalledWith("site-cc", "p1");
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ toStatus: "inactive", dentallyResult: "synced" }));
  });

  it("do_not_contact: NEVER writes to Dentally, dentally 'unsupported'", async () => {
    h.writeEnabled = true; // even with writes on, do_not_contact has no Dentally field
    const r = await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "do_not_contact" });
    expect(h.updatePatient).not.toHaveBeenCalled();
    expect(r.dentally).toBe("unsupported");
    expect(markOverrideSynced).not.toHaveBeenCalled();
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ dentallyResult: "unsupported" }));
  });

  it("write FAILURE degrades honestly: override still upserted, dentally 'failed', not marked synced", async () => {
    h.writeEnabled = true;
    h.updatePatient.mockRejectedValueOnce(new Error("Dentally 500"));
    const r = await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "active" });
    expect(r.dentally).toBe("failed");
    expect(upsertOverride).toHaveBeenCalled(); // platform override STILL applied
    expect(markOverrideSynced).not.toHaveBeenCalled();
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ dentallyResult: "failed" }));
  });
});

describe("applyStatusChange - suppression routing", () => {
  it("do_not_contact ADDS admin suppression rows and does not clear", async () => {
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "do_not_contact" });
    expect(addAdminDoNotContact).toHaveBeenCalledWith("site-cc", "patient:p1");
    expect(clearAdminDoNotContact).not.toHaveBeenCalled();
  });

  it("INACTIVE creates NO suppression rows (clears admin rows only) - patient-initiated flows stay open", async () => {
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "inactive" });
    expect(addAdminDoNotContact).not.toHaveBeenCalled();
    expect(clearAdminDoNotContact).toHaveBeenCalledWith("site-cc", "patient:p1");
  });

  it("active clears admin suppression rows (lifting a prior do_not_contact)", async () => {
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "active" });
    expect(addAdminDoNotContact).not.toHaveBeenCalled();
    expect(clearAdminDoNotContact).toHaveBeenCalledWith("site-cc", "patient:p1");
  });
});

describe("applyStatusChange - audit from->to", () => {
  it("records the prior status as fromStatus", async () => {
    h.current = { status: "active" };
    const r = await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "do_not_contact", reason: "asked us to" });
    expect(r.fromStatus).toBe("active");
    expect(insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: "active", toStatus: "do_not_contact", reason: "asked us to" }),
    );
  });
});
