import { describe, it, expect, vi, beforeEach } from "vitest";

// The co-pilot create_patient tool: a HIGH-STAKES write to the practice's real Dentally
// book. Mirrors the send_sms two-step discipline — strict validation, a dedupe short-
// circuit, a preview WITHOUT confirm that never writes, a single write only WITH confirm,
// audit logging and honest dry-run/error read-backs. The Dentally read (dedupe) and write
// clients plus the audit log are mocked so we test the branching deterministically.

const searchPatients = vi.fn();
const createPatient = vi.fn();
const isDentallyWriteEnabled = vi.fn();
const logCopilotAction = vi.fn();

vi.mock("@/lib/dentally/read", () => ({
  searchPatients: (...a: unknown[]) => searchPatients(...a),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
}));
vi.mock("@/lib/dentally/write", () => ({
  dentallyAgentClient: () => ({ createPatient: (...a: unknown[]) => createPatient(...a) }),
  isDentallyWriteEnabled: () => isDentallyWriteEnabled(),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));

import { makeCopilotDispatch } from "./tools";
import { DentallyError } from "@/lib/dentally/client";

// The real internal->Dentally site UUID for site-cc (from src/lib/mock/clients.ts). The
// write payload must carry THIS, not our internal id, proving the site mapping is applied.
const SITE_CC_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

// A complete, valid new-patient input (nobody matching in the mocked search).
const GOOD = {
  firstName: "Jane",
  lastName: "Doe",
  dateOfBirth: "1990-05-01",
  phone: "07700900123",
  email: "jane.doe@example.co.uk",
};

beforeEach(() => {
  vi.clearAllMocks();
  searchPatients.mockResolvedValue([]); // default: genuinely new patient
  createPatient.mockResolvedValue({ patient: { id: "new-pat-1" } });
  isDentallyWriteEnabled.mockReturnValue(true);
  logCopilotAction.mockResolvedValue(undefined);
});

describe("create_patient validation (never invents a missing detail)", () => {
  it("rejects a missing last name and never touches the write client", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", dateOfBirth: "1990-05-01", phone: "07700900123" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/first and last name/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a missing date of birth", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", phone: "07700900123" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a FUTURE date of birth", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "2999-01-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an impossible / malformed date of birth", async () => {
    const bad = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "1990-13-40" }));
    expect(bad.created).toBe(false);
    expect(bad.error).toMatch(/valid date of birth/i);
    const notADate = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "last tuesday" }));
    expect(notADate.created).toBe(false);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an absurdly old date of birth (age over 120)", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "1850-01-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a bad phone number", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", phone: "abc" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid mobile number/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a bad email address", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", email: "not-an-email" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid email address/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects when neither a phone nor an email is given", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/at least a mobile number or an email/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised gender rather than guessing", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "unsure" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/did not recognise the gender/i);
    expect(createPatient).not.toHaveBeenCalled();
  });
});

describe("create_patient dedupe (short-circuits creation)", () => {
  it("finds an existing record by the same mobile and does NOT create", async () => {
    searchPatients.mockResolvedValue([
      { id: "pat-existing", name: "Jane Doe", phone: "+447700900123", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.match.id).toBe("pat-existing");
    expect(out.match.matchedOn).toMatch(/mobile/i);
    // The dedupe short-circuits BEFORE any write, even with confirm true.
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("finds an existing record by the same name and date of birth (different phone)", async () => {
    searchPatients.mockResolvedValue([
      { id: "pat-namedob", name: "Jane Doe", phone: "+447700999999", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.match.id).toBe("pat-namedob");
    expect(out.match.matchedOn).toMatch(/name and date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("does NOT treat a mere name substring hit (different DOB and contact) as a duplicate", async () => {
    // A broad text hit that is clearly a different person must not block a real new patient.
    searchPatients.mockResolvedValue([
      { id: "pat-other", name: "Jane Doe-Smith", phone: "+447700111111", email: "other@example.co.uk", siteId: "site-cc", dateOfBirth: "1975-02-02", active: true },
    ]);
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(true);
    expect(createPatient).toHaveBeenCalledTimes(1);
  });
});

describe("create_patient two-step confirm", () => {
  it("previews (does not write) when not confirmed, reading back every field", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "female" }));
    expect(out.created).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.firstName).toBe("Jane");
    expect(out.lastName).toBe("Doe");
    expect(out.dateOfBirth).toBe("1990-05-01");
    expect(out.phone).toBe("+447700900123"); // normalised to E.164
    expect(out.email).toBe("jane.doe@example.co.uk");
    expect(out.gender).toBe("female");
    expect(out.site).toBe("N15 Vitality Dental");
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("creates exactly once on confirm, mapping the internal site id to Dentally's UUID", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "female", confirm: true }));
    expect(out.created).toBe(true);
    expect(out.patientId).toBe("new-pat-1");
    expect(createPatient).toHaveBeenCalledTimes(1);
    expect(createPatient).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Jane",
        last_name: "Doe",
        date_of_birth: "1990-05-01",
        mobile_phone: "+447700900123",
        email_address: "jane.doe@example.co.uk",
        gender: "Female",
        site_id: SITE_CC_UUID,
        use_sms: true,
        use_email: true,
      }),
    );
    expect(logCopilotAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_patient", status: "created", targetRef: "patient:new-pat-1" }),
    );
  });

  it("omits gender from the payload when the owner did not state it", async () => {
    await dispatch("create_patient", { ...GOOD, confirm: true });
    const payload = createPatient.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("gender");
  });
});

describe("create_patient honesty (dry-run and errors)", () => {
  it("reports a dry run when the Dentally write key is not enabled", async () => {
    isDentallyWriteEnabled.mockReturnValue(false);
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.note).toMatch(/test mode/i);
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "created:dry_run" }));
  });

  it("surfaces a 403 (key not permitted to create patients) honestly and never retries", async () => {
    createPatient.mockRejectedValue(new DentallyError(403, "forbidden"));
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("dentally_error");
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/does not allow creating patients/i);
    expect(createPatient).toHaveBeenCalledTimes(1); // no auto-retry
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "error:create_failed" }));
  });

  it("surfaces a generic Dentally failure honestly", async () => {
    createPatient.mockRejectedValue(new DentallyError(422, "unprocessable"));
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("dentally_error");
    expect(out.status).toBe(422);
    expect(createPatient).toHaveBeenCalledTimes(1);
  });
});
