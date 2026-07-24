// POST /api/onboarding/register — the one-click, human-approved action that dedupe-
// checks Dentally, creates the patient from a reviewed onboarding submission via the
// gated write client, and flips its status to "registered". Mirrors the co-pilot
// create_patient tool's discipline (src/lib/copilot/tools.ts, and its own test
// create-patient-tool.test.ts): dedupe-first, gated write client, honest 403/422
// mapping, single write, never auto-retried.
//
// Guard chain: requireUser -> requireClientAccess, resolved from the LOADED
// submission's clientId (the body carries only { submissionId, force? }, no clientSlug).
//
// getClient/getSites/getSite/dentallySiteId (src/lib/mock/clients.ts) are pure static
// config and are used FOR REAL (not mocked), exactly like create-patient-tool.test.ts,
// so the internal->Dentally site UUID mapping is proven against the real fixture data.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(),
  getSubmission: vi.fn(),
  setStatus: vi.fn(),
  searchPatients: vi.fn(),
  createPatient: vi.fn(),
  isDentallyWriteEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
}));
vi.mock("@/lib/onboarding/repository", () => ({
  getSubmission: h.getSubmission,
  setStatus: h.setStatus,
}));
vi.mock("@/lib/dentally/read", () => ({
  searchPatients: (...a: unknown[]) => h.searchPatients(...a),
}));
vi.mock("@/lib/dentally/write", () => ({
  dentallyAgentClient: () => ({ createPatient: (...a: unknown[]) => h.createPatient(...a) }),
  isDentallyWriteEnabled: () => h.isDentallyWriteEnabled(),
}));

import { POST } from "./route";
import { DentallyError } from "@/lib/dentally/client";

// The real internal->Dentally site UUID for site-cc (src/lib/mock/clients.ts). The
// create payload must carry THIS, not our internal id, proving the site mapping runs.
const SITE_CC_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";

const OWNER = {
  id: "u1",
  email: "owner@vitality.test",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-cc", "site-rv", "site-ng"],
};

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    clientId: "vitality",
    siteId: "site-cc",
    firstName: "Jane",
    lastName: "Doe",
    dateOfBirth: "1990-05-01",
    phone: "07700900123",
    email: "jane.doe@example.co.uk",
    address: null,
    medical: null,
    dental: null,
    heardAbout: null,
    files: [],
    consent: null,
    custom: null,
    status: "reviewed",
    createdAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/onboarding/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER);
  h.requireClientAccess.mockReturnValue(null);
  h.getSubmission.mockResolvedValue(submission());
  h.setStatus.mockResolvedValue(undefined);
  h.searchPatients.mockResolvedValue([]); // default: genuinely new patient
  h.createPatient.mockResolvedValue({ patient: { id: "new-pat-1" } });
  h.isDentallyWriteEnabled.mockReturnValue(true);
});

describe("auth", () => {
  it("401 when not signed in", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(401);
    expect(h.getSubmission).not.toHaveBeenCalled();
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("403 when the caller may not access this submission's client", async () => {
    h.requireClientAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(403);
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });
});

describe("lookup", () => {
  it("400s a missing submissionId and never loads anything", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(h.getSubmission).not.toHaveBeenCalled();
  });

  it("404s an unknown submission id", async () => {
    h.getSubmission.mockResolvedValue(null);
    const res = await POST(req({ submissionId: "ghost" }));
    expect(res.status).toBe(404);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("409s (and never creates) a submission that is already registered", async () => {
    h.getSubmission.mockResolvedValue(submission({ status: "registered" }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(409);
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });
});

describe("validation (never invents a missing detail)", () => {
  it("rejects a submission missing a last name", async () => {
    h.getSubmission.mockResolvedValue(submission({ lastName: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/first or last name/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("rejects a submission with neither a phone nor an email", async () => {
    h.getSubmission.mockResolvedValue(submission({ phone: null, email: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/mobile number or email/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("rejects a stored phone number that does not normalise", async () => {
    h.getSubmission.mockResolvedValue(submission({ phone: "call-me-maybe", email: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/mobile number.*does not look valid/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("rejects a stored email that does not normalise", async () => {
    h.getSubmission.mockResolvedValue(submission({ email: "not-an-email", phone: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/email address.*does not look valid/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("rejects an impossible date of birth on file rather than guessing", async () => {
    h.getSubmission.mockResolvedValue(submission({ dateOfBirth: "1990-13-40" }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/valid past date/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("rejects a future date of birth on file", async () => {
    h.getSubmission.mockResolvedValue(submission({ dateOfBirth: "2999-01-01" }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("creates without a date of birth when the form never captured one (mirrors register_patient)", async () => {
    h.getSubmission.mockResolvedValue(submission({ dateOfBirth: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    expect(h.createPatient).toHaveBeenCalledTimes(1);
    const payload = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("date_of_birth");
  });
});

describe("dedupe (short-circuits creation)", () => {
  it("finds an existing record by the same mobile and does NOT create or flip status", async () => {
    h.searchPatients.mockResolvedValue([
      { id: "pat-existing", name: "Jane Doe", phone: "+447700900123", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; created: boolean; duplicate: boolean; match: { id: string; matchedOn: string } };
    expect(j.ok).toBe(true);
    expect(j.created).toBe(false);
    expect(j.duplicate).toBe(true);
    expect(j.match.id).toBe("pat-existing");
    expect(j.match.matchedOn).toMatch(/mobile/i);
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("finds an existing record by the same name and date of birth (different phone)", async () => {
    h.searchPatients.mockResolvedValue([
      { id: "pat-namedob", name: "Jane Doe", phone: "+447700999999", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const res = await POST(req({ submissionId: "sub-1" }));
    const j = (await res.json()) as { duplicate: boolean; match: { matchedOn: string } };
    expect(j.duplicate).toBe(true);
    expect(j.match.matchedOn).toMatch(/name and date of birth/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("does NOT treat a mere name substring hit (different DOB and contact) as a duplicate", async () => {
    h.searchPatients.mockResolvedValue([
      { id: "pat-other", name: "Jane Doe-Smith", phone: "+447700111111", email: "other@example.co.uk", siteId: "site-cc", dateOfBirth: "1975-02-02", active: true },
    ]);
    const res = await POST(req({ submissionId: "sub-1" }));
    const j = (await res.json()) as { created: boolean; duplicate: boolean };
    expect(j.duplicate).toBeFalsy();
    expect(j.created).toBe(true);
    expect(h.createPatient).toHaveBeenCalledTimes(1);
  });

  it("force:true creates anyway, exactly once, skipping the dedupe search entirely", async () => {
    h.searchPatients.mockResolvedValue([
      { id: "pat-existing", name: "Jane Doe", phone: "+447700900123", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const res = await POST(req({ submissionId: "sub-1", force: true }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; created: boolean };
    expect(j.ok).toBe(true);
    expect(j.created).toBe(true);
    expect(h.createPatient).toHaveBeenCalledTimes(1);
    expect(h.searchPatients).not.toHaveBeenCalled();
    expect(h.setStatus).toHaveBeenCalledWith("sub-1", "registered");
  });
});

describe("success", () => {
  it("creates once, maps the internal site to Dentally's UUID, and flips status to registered", async () => {
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; created: boolean; patientId: string; status: string };
    expect(j.ok).toBe(true);
    expect(j.created).toBe(true);
    expect(j.patientId).toBe("new-pat-1");
    expect(j.status).toBe("registered");
    expect(h.createPatient).toHaveBeenCalledTimes(1);
    expect(h.createPatient).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Jane",
        last_name: "Doe",
        date_of_birth: "1990-05-01",
        mobile_phone: "+447700900123",
        email_address: "jane.doe@example.co.uk",
        site_id: SITE_CC_UUID,
        use_sms: true,
        use_email: true,
      }),
    );
    expect(h.setStatus).toHaveBeenCalledWith("sub-1", "registered");
    expect(h.setStatus).toHaveBeenCalledTimes(1);
  });

  it("reports a dry run when the Dentally write key is not enabled, but still flips status", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { created: boolean; dryRun: boolean };
    expect(j.created).toBe(true);
    expect(j.dryRun).toBe(true);
    expect(h.setStatus).toHaveBeenCalledWith("sub-1", "registered");
  });

  it("falls back to the client's primary site when the submission named none", async () => {
    h.getSubmission.mockResolvedValue(submission({ siteId: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const payload = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.site_id).toBe(SITE_CC_UUID); // site-cc is the client's first site
  });
});

describe("honesty (Dentally errors, never auto-retried)", () => {
  it("maps a 403 (key not permitted to create patients) honestly and does not flip status", async () => {
    h.createPatient.mockRejectedValue(new DentallyError(403, "forbidden"));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(403);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/does not allow creating patients/i);
    expect(h.createPatient).toHaveBeenCalledTimes(1); // no auto-retry
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("maps a 422 (Dentally rejected the details) honestly and does not flip status", async () => {
    h.createPatient.mockRejectedValue(new DentallyError(422, "unprocessable"));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(422);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/rejected the details/i);
    expect(h.createPatient).toHaveBeenCalledTimes(1);
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("maps an unknown/network failure to an honest generic 502", async () => {
    h.createPatient.mockRejectedValue(new Error("network blip"));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
    expect(h.setStatus).not.toHaveBeenCalled();
  });
});
