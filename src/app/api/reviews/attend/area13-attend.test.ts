// AREA 13 (Reviews attend): marking an appointment attended schedules exactly one
// review request, consent- and suppression-aware. Verifies: opted-out patient is
// recorded 'suppressed' (never scheduled for send), no-consent is 'skipped',
// consented patient is 'scheduled', a double-attend does not duplicate the row,
// and attended:false schedules nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface StoredRequest {
  id: string;
  siteId: string;
  dentallyAppointmentId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  attendedAt: string;
  sendAt: string;
  status: string;
  createdAt: string;
}

const fakes = vi.hoisted(() => ({
  requests: [] as StoredRequest[],
  isSuppressed: vi.fn((..._a: unknown[]) => Promise.resolve(false)),
  patients: [] as Array<{ id: string; smsConsent: boolean; emailConsent: boolean }>,
  appts: [] as Array<{ id: string; siteId: string; patientId: string; patientName: string; start: string; state: string; practitioner: string | null }>,
  seq: 0,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: () => Promise.resolve({ userId: "u1", siteIds: ["site-1"] }),
  requireClientAccess: (_auth: unknown, _clientId: unknown) => null,
}));
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", name: "Vitality Dental" } : null),
  getSites: (_clientId: string) => [{ id: "site-1" }],
}));
vi.mock("@/lib/dentally/read", () => ({
  listAppointments: (_siteIds: string[], _range: unknown) => Promise.resolve(fakes.appts),
  // The route now resolves the patient via a direct by-id read (not a full-list scan).
  getPatientById: (patientId: string) =>
    Promise.resolve(fakes.patients.find((p) => p.id === patientId) ?? null),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: (siteId: string, channel: string, ref: string) => fakes.isSuppressed(siteId, channel, ref),
}));
vi.mock("@/lib/reviews/repository", () => ({
  getByAppointment: (apptId: string) =>
    Promise.resolve(fakes.requests.find((r) => r.dentallyAppointmentId === apptId) ?? null),
  createScheduled: (input: Omit<StoredRequest, "id" | "status" | "createdAt">) => {
    const existing = fakes.requests.find((r) => r.dentallyAppointmentId === input.dentallyAppointmentId);
    if (existing) return Promise.resolve(existing);
    fakes.seq += 1;
    const row: StoredRequest = { ...input, id: `req-${fakes.seq}`, status: "scheduled", createdAt: input.attendedAt };
    fakes.requests.push(row);
    return Promise.resolve(row);
  },
  markStatus: (id: string, status: string) => {
    const r = fakes.requests.find((x) => x.id === id);
    if (r) r.status = status;
    return Promise.resolve();
  },
}));

import { POST } from "./route";

function attendRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/reviews/attend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedAppt(overrides: Partial<(typeof fakes.appts)[number]> = {}) {
  const a = {
    id: "appt-1", siteId: "site-1", patientId: "pat-1", patientName: "Sam Lee",
    start: "2026-07-01T09:00:00.000Z", state: "attended", practitioner: null,
    ...overrides,
  };
  fakes.appts.push(a);
  return a;
}
function seedPatient(overrides: Partial<(typeof fakes.patients)[number]> = {}) {
  const p = { id: "pat-1", smsConsent: true, emailConsent: true, ...overrides };
  fakes.patients.push(p);
  return p;
}

beforeEach(() => {
  fakes.requests.length = 0;
  fakes.patients.length = 0;
  fakes.appts.length = 0;
  fakes.seq = 0;
  fakes.isSuppressed.mockReset();
  fakes.isSuppressed.mockResolvedValue(false);
  vi.stubEnv("REVIEW_DELAY_HOURS", "3");
  vi.stubEnv("REVIEW_CUTOFF_HOUR", "15");
  vi.stubEnv("REVIEW_MORNING_HOUR", "10");
});
afterEach(() => vi.unstubAllEnvs());

describe("reviews attend", () => {
  it("schedules a single review request for a consented, attended patient", async () => {
    seedAppt();
    seedPatient({ smsConsent: true });
    const json = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }))).json();
    expect(json).toMatchObject({ ok: true, attended: true, status: "scheduled" });
    expect(fakes.requests.length).toBe(1);
    expect(fakes.requests[0].channel).toBe("sms");
    expect(fakes.requests[0].status).toBe("scheduled");
  });

  it("an already opted-out patient is recorded 'suppressed' and NEVER scheduled for send", async () => {
    seedAppt();
    seedPatient({ smsConsent: true });
    fakes.isSuppressed.mockImplementation((_s: unknown, _c: unknown, ref: unknown) =>
      Promise.resolve(ref === "patient:pat-1"));
    const json = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }))).json();
    expect(json).toMatchObject({ ok: true, attended: true, status: "suppressed" });
    expect(fakes.requests.length).toBe(1);
    expect(fakes.requests[0].status).toBe("suppressed");
  });

  it("no consent on either channel -> 'skipped', not scheduled", async () => {
    seedAppt();
    seedPatient({ smsConsent: false, emailConsent: false });
    const json = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }))).json();
    expect(json).toMatchObject({ ok: true, attended: true, status: "skipped", reason: "no consent" });
    expect(fakes.requests[0].status).toBe("skipped");
  });

  it("falls back to email when SMS consent is absent but email consent present", async () => {
    seedAppt();
    seedPatient({ smsConsent: false, emailConsent: true });
    await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }));
    expect(fakes.requests[0].channel).toBe("email");
    expect(fakes.requests[0].status).toBe("scheduled");
  });

  it("double-attend is idempotent: no duplicate request for the same appointment", async () => {
    seedAppt();
    seedPatient({ smsConsent: true });
    const first = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }))).json();
    const second = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }))).json();
    expect(fakes.requests.length).toBe(1);
    expect(second.request.id).toBe(first.request.id);
    expect(second.status).toBe("scheduled");
  });

  it("attended:false schedules nothing", async () => {
    seedAppt({ state: "booked" });
    seedPatient({ smsConsent: true });
    const json = await (await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: false }))).json();
    expect(json).toMatchObject({ ok: true, attended: false });
    expect(fakes.requests.length).toBe(0);
  });

  it("the scheduled send time is later the same day when attended before the London cutoff", async () => {
    // 09:00Z on 1 Jul is 10:00 London (BST), before the 15:00 cutoff -> +3h.
    vi.setSystemTime(new Date("2026-07-01T09:00:00.000Z"));
    seedAppt();
    seedPatient({ smsConsent: true });
    await POST(attendRequest({ clientSlug: "vitality", appointmentId: "appt-1", attended: true }));
    const req = fakes.requests[0];
    const gap = new Date(req.sendAt).getTime() - new Date(req.attendedAt).getTime();
    expect(gap).toBe(3 * 3_600_000);
    vi.useRealTimers();
  });

  it("rejects a missing appointmentId with 400", async () => {
    const res = await POST(attendRequest({ clientSlug: "vitality", attended: true }));
    expect(res.status).toBe(400);
  });
});
