import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock everything the send tools touch, so we test the consent / suppression /
// dry-run / disambiguation branching deterministically without real DB or network.
const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const logCopilotAction = vi.fn();
const listPatients = vi.fn();
const searchPatients = vi.fn();

vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: (...a: unknown[]) => listPatients(...a),
  searchPatients: (...a: unknown[]) => searchPatients(...a),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
}));

import { makeCopilotDispatch } from "./tools";

const PATIENTS = [
  {
    id: "pat-c1", name: "Cora Consented", phone: "+447700900001", email: "cora@example.co.uk",
    siteId: "site-cc", active: true, archivedReason: null, recallDueAt: null, lastVisitAt: null,
    dateOfBirth: null, smsConsent: true, emailConsent: true,
  },
  {
    id: "pat-n1", name: "Niall NoConsent", phone: "+447700900002", email: "niall@example.co.uk",
    siteId: "site-cc", active: true, archivedReason: null, recallDueAt: null, lastVisitAt: null,
    dateOfBirth: null, smsConsent: false, emailConsent: false,
  },
];

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

beforeEach(() => {
  vi.clearAllMocks();
  listPatients.mockResolvedValue(PATIENTS);
  // Faithful stand-in for Dentally's server-side `query=` search: match name/phone/
  // email, and (like the real one) return nothing for a query under 2 chars.
  searchPatients.mockImplementation(async (_siteIds: string[], q: string) => {
    const ql = String(q).trim().toLowerCase();
    if (ql.length < 2) return [];
    return PATIENTS.filter(
      (p) => p.name.toLowerCase().includes(ql) || (p.phone ?? "").includes(String(q)) || (p.email ?? "").toLowerCase().includes(ql),
    );
  });
  isSuppressed.mockResolvedValue(false);
  sendMessage.mockResolvedValue({ providerMessageId: "dry-sms-1", provider: "dry-run", status: "dry_run" });
});

describe("send_sms", () => {
  it("previews (does not send) when not confirmed, even for a consented patient", async () => {
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "Hi Cora, your check-up is due." }));
    expect(out.sent).toBe(false);
    expect(out.preview).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends to a consented patient on confirm and reports a dry run", async () => {
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "Hi Cora, your check-up is due.", confirm: true }));
    expect(out.sent).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ channel: "sms", to: "+447700900001", body: "Hi Cora, your check-up is due.", subject: undefined });
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "dry_run", channel: "sms", targetRef: "patient:pat-c1" }));
  });

  it("refuses to send to a patient with no SMS consent and never calls the provider", async () => {
    const out = JSON.parse(await dispatch("send_sms", { patient: "Niall", message: "Hi" }));
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("no_consent");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked:no_consent" }));
  });

  it("refuses to send to an opted-out (suppressed) patient", async () => {
    isSuppressed.mockResolvedValue(true);
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "Hi" }));
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("opted_out");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked:suppressed" }));
  });

  it("asks which patient when the name matches more than one", async () => {
    // "co" is a real (>=2 char) query that both "Cora Consented" and
    // "Niall NoConsent" contain, so the server-side search returns both.
    const out = JSON.parse(await dispatch("send_sms", { patient: "co", message: "Hi" }));
    expect(out.sent).toBe(false);
    expect(out.multiple).toBe(true);
    expect(out.matches.length).toBe(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("needs both a patient and a message", async () => {
    const out = JSON.parse(await dispatch("send_sms", { patient: "Cora", message: "" }));
    expect(out.sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("send_email", () => {
  it("sends to a consented patient with a subject on confirm", async () => {
    sendMessage.mockResolvedValue({ providerMessageId: "dry-email-1", provider: "dry-run", status: "dry_run" });
    const out = JSON.parse(await dispatch("send_email", { patient: "Cora", subject: "Your check-up", message: "Hi Cora", confirm: true }));
    expect(out.sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ channel: "email", to: "cora@example.co.uk", body: "Hi Cora", subject: "Your check-up" });
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "dry_run", body: "Subject: Your check-up\n\nHi Cora" }));
  });

  it("requires a subject", async () => {
    const out = JSON.parse(await dispatch("send_email", { patient: "Cora", subject: "", message: "Hi" }));
    expect(out.sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
