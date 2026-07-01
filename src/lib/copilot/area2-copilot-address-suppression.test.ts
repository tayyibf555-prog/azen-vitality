import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): the co-pilot send tools dispatch via
// sendMessage directly (they do NOT pass through the shared drain), so they must
// enforce BOTH suppression forms themselves. A STOP from a number that could not
// be identified at the time is recorded by ADDRESS (see the inbound webhook), not
// by patient ref. If the co-pilot only checks patient:<id>, the owner can text a
// number whose holder has opted out. This mirrors the drain's dual-ref invariant.

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const logCopilotAction = vi.fn();
const listPatients = vi.fn();

vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: (...a: unknown[]) => listPatients(...a),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
}));

import { makeCopilotDispatch } from "./tools";

const PHONE = "+447700900333";
const PATIENTS = [
  {
    id: "pat-a1", name: "Ana AddressStop", phone: PHONE, email: "ana@example.co.uk",
    siteId: "site-cc", active: true, archivedReason: null, recallDueAt: null, lastVisitAt: null,
    dateOfBirth: null, smsConsent: true, emailConsent: true,
  },
];

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

beforeEach(() => {
  vi.clearAllMocks();
  listPatients.mockResolvedValue(PATIENTS);
  isSuppressed.mockResolvedValue(false);
  sendMessage.mockResolvedValue({ providerMessageId: "dry-sms-1", provider: "dry-run", status: "dry_run" });
});

describe("co-pilot send honours an ADDRESS-form suppression", () => {
  it("blocks a confirmed send when the patient's number opted out while unidentified", async () => {
    // STOP was recorded by address (the sender was not identified at the time),
    // so there is no patient:pat-a1 row, only one for the raw number.
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === PHONE);
    const out = JSON.parse(await dispatch("send_sms", { patient: "Ana", message: "Hi Ana.", confirm: true }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("opted_out");
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked:suppressed" }));
  });

  it("control: sends when neither ref form is suppressed", async () => {
    const out = JSON.parse(await dispatch("send_sms", { patient: "Ana", message: "Hi Ana.", confirm: true }));
    expect(out.sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
