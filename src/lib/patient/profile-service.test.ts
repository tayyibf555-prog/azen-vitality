// applyProfileEdit orchestration: the write gate, the fresh re-read, the changed-fields
// -only diff, the concurrency refusal, the active delegation and the audit trail.
// Dentally and the repositories are doubled so we pin WHAT gets sent and WHEN.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  writeEnabled: true,
  getPatient: vi.fn(),
  updatePatient: vi.fn(),
  insertProfileAudit: vi.fn(),
  applyStatusChange: vi.fn(),
}));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => h.writeEnabled,
  dentallyAgentClient: () => ({ getPatient: h.getPatient, updatePatient: h.updatePatient }),
}));
vi.mock("@/lib/patient-status/service", () => ({ applyStatusChange: h.applyStatusChange }));
vi.mock("./profile-audit", () => ({ insertProfileAudit: h.insertProfileAudit }));

import { applyProfileEdit } from "./profile-service";
import { canonicaliseProfile, parseProfileChanges, type ProfileChanges } from "./profile";

// The record as live Dentally holds it: a national-format mobile, a boolean gender.
const LIVE = {
  id: "p1",
  title: "Mr",
  first_name: "Alan",
  last_name: "Turing",
  date_of_birth: "1962-06-23",
  gender: true,
  mobile_phone: "07834 123456",
  email_address: "alan@example.co.uk",
  postcode: "N17 4AB",
  payment_plan_id: 1,
  active: true,
};

function changesOf(raw: Record<string, unknown>): ProfileChanges {
  const r = parseProfileChanges(raw);
  if (!r.ok) throw new Error(`bad fixture: ${JSON.stringify(r.errors)}`);
  return r.parsed.values;
}

function edit(raw: Record<string, unknown>, expectedRaw: Record<string, unknown> = LIVE) {
  return applyProfileEdit({
    siteId: "site-cc",
    patientId: "p1",
    changes: changesOf(raw),
    expected: canonicaliseProfile(expectedRaw),
    reason: "typo on the record",
    actorEmail: "manager@practice.co.uk",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.writeEnabled = true;
  h.getPatient.mockResolvedValue({ patient: { ...LIVE } });
  h.updatePatient.mockResolvedValue({ patient: { id: "p1" } });
  h.insertProfileAudit.mockResolvedValue(undefined);
  h.applyStatusChange.mockResolvedValue({ status: "inactive", dentally: "synced", fromStatus: null });
});

describe("the write gate", () => {
  it("refuses plainly, and never reads or POSTs, when writes are disabled", async () => {
    h.writeEnabled = false;
    const r = await edit({ email_address: "new@example.co.uk" });
    expect(r).toMatchObject({ ok: false, code: "write_disabled" });
    if (!r.ok) expect(r.message).toContain("switched off");
    expect(h.getPatient).not.toHaveBeenCalled();
    expect(h.updatePatient).not.toHaveBeenCalled();
    expect(h.insertProfileAudit).not.toHaveBeenCalled();
  });
});

describe("changed fields only", () => {
  it("sends just the field that moved, not the twenty the page loaded", async () => {
    const r = await edit({ email_address: "a.turing@example.co.uk", first_name: "Alan", last_name: "Turing" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toEqual(["email_address"]);
    expect(h.updatePatient).toHaveBeenCalledWith("p1", { email_address: "a.turing@example.co.uk" });
  });

  it("a save with nothing actually different never touches Dentally or the audit", async () => {
    const r = await edit({ first_name: "Alan", mobile_phone: "+447834123456" });
    expect(r).toMatchObject({ ok: true, changed: [] });
    expect(h.updatePatient).not.toHaveBeenCalled();
    expect(h.insertProfileAudit).not.toHaveBeenCalled();
  });

  it("diffs against a FRESH read, not against the caller's snapshot", async () => {
    // Dentally now holds a different email than LIVE; the caller's expected matches it,
    // so there is no conflict, and their requested value is genuinely a change.
    const live = { ...LIVE, email_address: "moved@example.co.uk" };
    h.getPatient.mockResolvedValue({ patient: live });
    const r = await edit({ email_address: "final@example.co.uk" }, live);
    expect(r.ok).toBe(true);
    expect(h.updatePatient).toHaveBeenCalledWith("p1", { email_address: "final@example.co.uk" });
  });

  it("404s when the record cannot be read at all", async () => {
    h.getPatient.mockResolvedValue({ patient: null });
    const r = await edit({ email_address: "new@example.co.uk" });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(h.updatePatient).not.toHaveBeenCalled();
  });
});

describe("concurrent edits", () => {
  it("refuses when the SAME field moved underneath the caller", async () => {
    h.getPatient.mockResolvedValue({ patient: { ...LIVE, email_address: "colleague@example.co.uk" } });
    const r = await edit({ email_address: "mine@example.co.uk" }); // expected still the old LIVE
    expect(r).toMatchObject({ ok: false, code: "conflict", conflicts: ["email_address"] });
    expect(h.updatePatient).not.toHaveBeenCalled();
    expect(h.insertProfileAudit).not.toHaveBeenCalled();
  });

  it("allows it when a DIFFERENT field moved (two people, two fields)", async () => {
    h.getPatient.mockResolvedValue({ patient: { ...LIVE, first_name: "Alan Mathison" } });
    const r = await edit({ email_address: "mine@example.co.uk" });
    expect(r.ok).toBe(true);
    expect(h.updatePatient).toHaveBeenCalledWith("p1", { email_address: "mine@example.co.uk" });
  });
});

describe("the active flag is delegated, never PUT here", () => {
  it("routes active through the status service and keeps it out of the profile payload", async () => {
    const r = await edit({ active: false, first_name: "Alan Mathison" });
    expect(r.ok).toBe(true);
    expect(h.applyStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc", patientId: "p1", status: "inactive" }),
    );
    expect(h.updatePatient).toHaveBeenCalledWith("p1", { first_name: "Alan Mathison" });
  });

  it("an active-only change makes no profile PUT at all", async () => {
    const r = await edit({ active: false });
    expect(r).toMatchObject({ ok: true, changed: ["active"] });
    expect(h.applyStatusChange).toHaveBeenCalled();
    expect(h.updatePatient).not.toHaveBeenCalled();
  });

  it("a REFUSED detail write leaves the patient active: the flag is never flipped first", async () => {
    // Marking someone inactive removes them from recall, reactivation and the coordinator,
    // so it must not happen while the caller is truthfully told the save failed.
    h.updatePatient.mockRejectedValue(new Error("Dentally 422: unprocessable"));
    const r = await edit({ active: false, first_name: "Alan Mathison" });
    expect(r).toMatchObject({ ok: false, code: "dentally_failed" });
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });
});

describe("the audit trail", () => {
  it("records one before/after row per changed field, with who and why", async () => {
    await edit({ email_address: "a.turing@example.co.uk", postcode: "n15 4ab" });
    expect(h.insertProfileAudit).toHaveBeenCalledWith({
      siteId: "site-cc",
      patientId: "p1",
      reason: "typo on the record",
      actorEmail: "manager@practice.co.uk",
      dentallyResult: "synced",
      rows: [
        { field: "email_address", from: "alan@example.co.uk", to: "a.turing@example.co.uk" },
        { field: "postcode", from: "N17 4AB", to: "N15 4AB" },
      ],
    });
  });

  it("records a REFUSED write as an attempt and reports the failure", async () => {
    h.updatePatient.mockRejectedValue(new Error("Dentally 422: unprocessable"));
    const r = await edit({ email_address: "a.turing@example.co.uk" });
    expect(r).toMatchObject({ ok: false, code: "dentally_failed" });
    expect(h.insertProfileAudit).toHaveBeenCalledWith(expect.objectContaining({ dentallyResult: "failed" }));
  });

  it("a write that landed but could not be audited is reported, not swallowed", async () => {
    h.insertProfileAudit.mockRejectedValue(new Error("db down"));
    const r = await edit({ email_address: "a.turing@example.co.uk" });
    expect(r).toMatchObject({ ok: true, auditRecorded: false });
  });
});
