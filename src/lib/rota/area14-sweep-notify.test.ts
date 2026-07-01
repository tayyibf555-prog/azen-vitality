import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 14 (rota): the staff-SMS sweep's notify decision.
//
// Proves the dry-run-safe / markNotified bug class is handled:
//  1. In DRY-RUN (provider === "dry-run") the sweep must NOT markNotified — else
//     the very first real text would be permanently skipped once live. It counts
//     the simulation instead.
//  2. On a REAL send (provider !== "dry-run") the sweep DOES markNotified, and
//     marks exactly the shifts it texted (no more, no less).
//  3. A staff member with no phone is skipped (shifts left unnotified for a later
//     run once a number is added), and NOT marked.
//  4. A send that throws does NOT markNotified (retried later), and does not abort
//     the rest of the sweep.
//  5. No opt-out / consent gate: staff are employees, so a person is never
//     suppressed the way a patient would be. Confirmed by a normal person always
//     being considered for a send.

const listStaff = vi.fn<(...a: unknown[]) => unknown>();
const getConfig = vi.fn<(...a: unknown[]) => unknown>();
const insertShifts = vi.fn<(...a: unknown[]) => unknown>();
const listUnnotifiedUpcoming = vi.fn<(...a: unknown[]) => unknown>();
const markNotified = vi.fn<(...a: unknown[]) => unknown>();
const sendMessage = vi.fn<(...a: unknown[]) => unknown>();
const generateShifts = vi.fn<(...a: unknown[]) => unknown>();

vi.mock("@/lib/rota/repository", () => ({
  listStaff: (...a: unknown[]) => listStaff(...a),
  getConfig: (...a: unknown[]) => getConfig(...a),
  insertShifts: (...a: unknown[]) => insertShifts(...a),
  listUnnotifiedUpcoming: (...a: unknown[]) => listUnnotifiedUpcoming(...a),
  markNotified: (...a: unknown[]) => markNotified(...a),
}));
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
// Keep generation inert: the notify path is what we are testing, not generation.
vi.mock("@/lib/rota/generate", () => ({
  generateShifts: (...a: unknown[]) => generateShifts(...a),
  upcomingWeekStarts: () => ["2026-07-06"],
}));
// Single client, single site, so the sweep loops exactly once.
vi.mock("@/lib/mock/clients", () => ({
  CLIENTS: [{ id: "vitality", name: "Vitality Dental" }],
  getSites: () => [
    { id: "site-a", name: "Site A", openingHours: { monday: "09:00-17:30" } },
  ],
  getSite: (id: string) => ({ id, name: id === "site-a" ? "Site A" : id }),
  getClient: (slug: string) => ({ id: slug, name: "Vitality Dental" }),
}));
vi.mock("@/lib/rota/config", () => ({
  practiceName: () => "Vitality Dental",
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/rota/sweep/route";

function sweepRequest(): Request {
  return new Request("http://localhost/api/rota/sweep", { method: "POST" });
}

interface FakeShift {
  id: string;
  clientId: string;
  siteId: string;
  staffId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  role: string;
  status: string;
}

function shift(over: Partial<FakeShift> & Pick<FakeShift, "id" | "staffId">): FakeShift {
  return {
    clientId: "vitality",
    siteId: "site-a",
    shiftDate: "2026-07-06",
    startTime: "09:00",
    endTime: "17:30",
    role: "dentist",
    status: "scheduled",
    ...over,
  };
}

const PERSON = {
  id: "d1",
  clientId: "vitality",
  siteId: null,
  name: "Sam Smith",
  role: "dentist",
  phone: "+447700900001",
  email: null,
  active: true,
  availability: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", ""); // dev-open so the handler runs
  getConfig.mockResolvedValue({
    rolesNeeded: { dentist: 1 },
    notifyLeadDays: 7,
    generateWeeksAhead: 1,
  });
  generateShifts.mockReturnValue([]); // insert path is irrelevant here
  insertShifts.mockResolvedValue(0);
  markNotified.mockResolvedValue(undefined);
});

describe("rota sweep — dry-run must NOT mark notified", () => {
  it("counts a simulated staff send but leaves shifts unnotified (no permanent skip)", async () => {
    listStaff.mockResolvedValue([PERSON]);
    listUnnotifiedUpcoming.mockResolvedValue([
      shift({ id: "s1", staffId: "d1" }),
      shift({ id: "s2", staffId: "d1", shiftDate: "2026-07-07" }),
    ]);
    sendMessage.mockResolvedValue({
      providerMessageId: "dry-sms-1",
      provider: "dry-run",
      status: "dry_run",
    });

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The critical assertion: a dry-run send must never consume the unnotified state.
    expect(markNotified).not.toHaveBeenCalled();
    expect(json.simulatedStaff).toBe(1);
    expect(json.notifiedStaff).toBe(0);
    expect(json.notifiedShifts).toBe(0);
  });
});

describe("rota sweep — a real send marks notified", () => {
  it("marks exactly the texted shifts as notified when the provider is real", async () => {
    listStaff.mockResolvedValue([PERSON]);
    listUnnotifiedUpcoming.mockResolvedValue([
      shift({ id: "s1", staffId: "d1" }),
      shift({ id: "s2", staffId: "d1", shiftDate: "2026-07-07" }),
    ]);
    sendMessage.mockResolvedValue({
      providerMessageId: "SM123",
      provider: "twilio",
      status: "queued",
    });

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledTimes(1);
    // Marks exactly the two shift ids it texted, nothing else.
    expect(markNotified).toHaveBeenCalledWith(["s1", "s2"]);
    expect(json.notifiedStaff).toBe(1);
    expect(json.notifiedShifts).toBe(2);
    expect(json.simulatedStaff).toBe(0);
    expect(json.providers).toContain("twilio");
  });

  it("texts the E.164 phone on file (staff are employees, no opt-out/consent gate)", async () => {
    listStaff.mockResolvedValue([PERSON]);
    listUnnotifiedUpcoming.mockResolvedValue([shift({ id: "s1", staffId: "d1" })]);
    sendMessage.mockResolvedValue({ providerMessageId: "SM1", provider: "twilio", status: "queued" });

    await POST(sweepRequest());

    // No suppression list is consulted; the person is sent to purely on having a phone.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", to: "+447700900001" }),
    );
  });
});

describe("rota sweep — no phone / send failure never mark", () => {
  it("skips a phoneless staff member without texting or marking", async () => {
    listStaff.mockResolvedValue([{ ...PERSON, phone: null }]);
    listUnnotifiedUpcoming.mockResolvedValue([shift({ id: "s1", staffId: "d1" })]);

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
    expect(json.skippedNoPhone).toBe(1);
    expect(json.notifiedStaff).toBe(0);
  });

  it("a throwing send is counted as a failure and does NOT mark (retried later)", async () => {
    listStaff.mockResolvedValue([PERSON]);
    listUnnotifiedUpcoming.mockResolvedValue([shift({ id: "s1", staffId: "d1" })]);
    sendMessage.mockRejectedValue(new Error("provider 500"));

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(markNotified).not.toHaveBeenCalled();
    expect(json.sendFailures).toBe(1);
    expect(json.notifiedStaff).toBe(0);
  });

  it("one staff member's send failure does not abort the rest of the sweep", async () => {
    const other = { ...PERSON, id: "d2", name: "Alex Jones", phone: "+447700900002" };
    listStaff.mockResolvedValue([PERSON, other]);
    listUnnotifiedUpcoming.mockResolvedValue([
      shift({ id: "s1", staffId: "d1" }),
      shift({ id: "s2", staffId: "d2" }),
    ]);
    // First send throws, second succeeds (real provider).
    sendMessage
      .mockRejectedValueOnce(new Error("bad number"))
      .mockResolvedValueOnce({ providerMessageId: "SM2", provider: "twilio", status: "queued" });

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(json.sendFailures).toBe(1);
    // The second, healthy staff member is still notified.
    expect(json.notifiedStaff).toBe(1);
    expect(markNotified).toHaveBeenCalledWith(["s2"]);
  });
});
