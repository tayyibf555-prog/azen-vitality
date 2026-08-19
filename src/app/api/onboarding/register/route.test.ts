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
  // The route's module lock. Stubbed open here because these cases are about the
  // route's own behaviour, not the clinician deny-list — that lives in
  // src/lib/auth/module-api-guard.test.ts, and its presence on every route is
  // proven by src/app/api/client-api-module-guard-coverage.test.ts.
  requireModuleApiAccess: () => null,
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

// The PER-PERSON gate, faked at the seam. Its own behaviour — the 403, and the
// 503 when auth is not enforced — is proven in
// src/lib/auth/capability-guard.test.ts; the fs sweep in
// src/app/api/destructive-route-capability-coverage.test.ts proves this route
// calls it. Stubbed open here so these cases stay about the route's own logic.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));


import { POST } from "./route";
import { DentallyError } from "@/lib/dentally/client";
import { REGISTER_WRITES_OFF } from "@/lib/onboarding/register-result";

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

/**
 * A register request.
 *
 * `title` and `funding` come from the STAFF MEMBER's confirm dialogue, not from the
 * submission: live Dentally will not create a patient without a title and a payment
 * plan, and this onboarding form asks the patient for neither. They are defaulted
 * into every well-formed body here so the cases that are about something else read
 * exactly as they always did; the cases that ARE about them pass their own value, or
 * `undefined` to leave the field off the wire entirely.
 */
function req(body: unknown): Request {
  const withStaffChoices =
    body && typeof body === "object" && !Array.isArray(body)
      ? { title: "Mrs", funding: "NHS", ...(body as Record<string, unknown>) }
      : body;
  return new Request("http://localhost/api/onboarding/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(withStaffChoices),
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

  // ---------------------------------------------------------------------------
  // THE THREE FIELDS LIVE DENTALLY REFUSES A REGISTRATION WITHOUT.
  //
  // This route used to send names, contact, site, and a date of birth only when the
  // form happened to have asked for one. Live requires date_of_birth, title and
  // payment_plan, and a BOOLEAN gender (DENTALLY.md; memory
  // dentally-createpatient-422) — so every "Register in Dentally" click against the
  // real practice would have failed, and the receptionist would have been told to go
  // and check details that were perfectly fine.
  //
  // The case below this one used to assert the OPPOSITE: "creates without a date of
  // birth when the form never captured one (mirrors register_patient)". It passed,
  // and it was wrong on both counts — live does require one, and register_patient was
  // not precedent but the same bug in another file. Both are fixed.
  // ---------------------------------------------------------------------------
  it("refuses a submission with no date of birth instead of sending a write live rejects", async () => {
    h.getSubmission.mockResolvedValue(submission({ dateOfBirth: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/no date of birth/i);
    // It says what to DO about it, to both audiences: ask the patient, or add the
    // question to the form so the next one arrives complete.
    expect(j.error).toMatch(/date-of-birth question/i);
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("refuses without a title, which this form never asks the patient for", async () => {
    const res = await POST(req({ submissionId: "sub-1", title: undefined }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/Mr, Mrs, Miss, Ms, Master/);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("refuses a title that is not one of the five, however it is spelled", async () => {
    // Dr and Rev are real in this practice's live data and carry no sex signal, so
    // they are refused here exactly as the public funnel refuses them. "constructor"
    // is the prototype key that used to walk straight through a bare object lookup.
    for (const title of ["Dr", "Rev", "Sir", "constructor", "__proto__", ""]) {
      const res = await POST(req({ submissionId: "sub-1", title }));
      expect(res.status, `title "${title}" must be refused`).toBe(400);
    }
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("refuses without knowing how the patient is to be seen", async () => {
    const res = await POST(req({ submissionId: "sub-1", funding: undefined }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/NHS or Private/i);
    expect(j.error).toMatch(/payment plan/i);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("refuses a plan this practice has but this screen does not offer", async () => {
    // UDC (47752) is the practice's biggest plan by volume and is deliberately not
    // selectable: a plan nobody chose must not be reachable by naming it in a body.
    for (const funding of ["UDC", "47752", "Denplan A", "constructor", ""]) {
      const res = await POST(req({ submissionId: "sub-1", funding }));
      expect(res.status, `funding "${funding}" must be refused`).toBe(400);
    }
    expect(h.createPatient).not.toHaveBeenCalled();
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
    // THE WHOLE PAYLOAD, not a subset. The defect this route shipped with was three
    // ABSENT fields, and objectContaining cannot see an absence.
    expect(h.createPatient).toHaveBeenCalledWith({
      first_name: "Jane",
      last_name: "Doe",
      title: "Mrs", // the staff member's choice, from the confirm dialogue
      date_of_birth: "1990-05-01",
      payment_plan_id: 1, // NHS, confirmed against GET /v1/payment_plans
      // A BOOLEAN, derived from that title: this route used to send no sex at all,
      // and live answers "gender: must be male or female" to a registration without.
      gender: false,
      email_address: "jane.doe@example.co.uk",
      mobile_phone: "+447700900123",
      site_id: SITE_CC_UUID,
      use_sms: true,
      use_email: true,
    });
    expect(h.setStatus).toHaveBeenCalledWith("sub-1", "registered");
    expect(h.setStatus).toHaveBeenCalledTimes(1);
  });

  it("derives the boolean sex from the staff member's chosen title", async () => {
    for (const [title, expected] of [
      ["Mr", true],
      ["Master", true],
      ["Mrs", false],
      ["Miss", false],
      ["Ms", false],
    ] as const) {
      h.createPatient.mockClear();
      const res = await POST(req({ submissionId: "sub-1", title }));
      expect(res.status).toBe(200);
      const payload = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.title).toBe(title);
      expect(payload.gender, `${title} follows its live majority`).toBe(expected);
      expect(typeof payload.gender).toBe("boolean");
    }
  });

  it("maps Private to the id that IS Private live (2), not to a positional guess", async () => {
    const res = await POST(req({ submissionId: "sub-1", funding: "Private" }));
    expect(res.status).toBe(200);
    expect((h.createPatient.mock.calls[0]![0] as Record<string, unknown>).payment_plan_id).toBe(2);
  });

  it("falls back to the client's primary site when the submission named none", async () => {
    h.getSubmission.mockResolvedValue(submission({ siteId: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const payload = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.site_id).toBe(SITE_CC_UUID); // site-cc is the client's first site
  });
});

// THE WRITE GATE. This block replaces a test called "reports a dry run when the
// Dentally write key is not enabled, but still flips status", which asserted that
// with writes OFF the route still called createPatient and still flipped the
// submission to "registered" — it pinned the defect in place. The route computed
// isDentallyWriteEnabled() and used it only as a label (`dryRun: !writeEnabled`)
// while the create ran unconditionally through dentallyAgentClient(), whose disabled
// branch defaults its base URL to https://api.dentally.co. With DENTALLY_BASE_URL
// unset that is a REAL patient in a book of ~51,000 people, created while the API
// answered `dryRun: true` and the worklist said "Recorded in test mode".
describe("the Dentally write gate (enforced, not merely reported)", () => {
  it("503s and creates NOTHING when writes are switched off", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(503);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("leaves the submission's status untouched, so it stays on the worklist", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    await POST(req({ submissionId: "sub-1" }));
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("says so honestly, and never reports a dry run that created anything", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    const res = await POST(req({ submissionId: "sub-1" }));
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.error).toBe(REGISTER_WRITES_OFF);
    expect(j.created).toBeUndefined();
    expect(j.patientId).toBeUndefined();
    expect(j).not.toHaveProperty("dryRun");
  });

  // force:true is the "this really is a different person" escape hatch past dedupe.
  // It must not also be an escape hatch past the write gate.
  it("refuses force:true just the same", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    const res = await POST(req({ submissionId: "sub-1", force: true }));
    expect(res.status).toBe(503);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  // The gate sits AFTER validation and dedupe deliberately, so the answer stays the
  // most useful true thing: a submission missing a surname is still told that, and a
  // likely duplicate is still surfaced, neither of which involves a write.
  it("still reports a missing name rather than the gate", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    h.getSubmission.mockResolvedValue(submission({ lastName: null }));
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(400);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("still surfaces a likely duplicate rather than the gate", async () => {
    h.isDentallyWriteEnabled.mockReturnValue(false);
    h.searchPatients.mockResolvedValue([
      { id: "pat-existing", name: "Jane Doe", phone: "+447700900123", email: null, siteId: "site-cc", dateOfBirth: "1990-05-01", active: true },
    ]);
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { duplicate: boolean };
    expect(j.duplicate).toBe(true);
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  // The success path must NOT carry dryRun any more: past the gate it could only
  // ever be false, and while it existed the UI read it as permission to call a real
  // create "recorded in test mode".
  it("carries no dryRun field on a real create", async () => {
    const res = await POST(req({ submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("dryRun");
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
