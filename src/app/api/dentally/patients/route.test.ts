// The patients LIST endpoint, and the two defects this rebuild fixed in it.
//
//   1. It returned a REDUCED eight-field row, not the full PatientRecord. A record
//      opened from search comes through here, so it showed a confident "Not on file"
//      date of birth and a confident "No marketing consent" for a patient who had
//      both. A false negative on a clinical record is worse than a slightly larger
//      payload.
//   2. Recall-segment rows are sourced from our own recall_target table (so the
//      segment can be COMPLETE rather than capped at the list's first few hundred),
//      and that table holds no contact details. They were returned with phone: null
//      and email: null, which the table rendered as "No contact" for every single
//      recall row. They now carry partial: true, and the table renders a dash.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getClient: vi.fn(),
  getViewSiteIds: vi.fn(),
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
  listTargets: vi.fn(),
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(),
}));

vi.mock("@/lib/mock", () => ({ getClient: h.getClient }));
vi.mock("@/lib/site-view", () => ({ getViewSiteIds: h.getViewSiteIds }));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: h.listPatients,
  searchPatients: h.searchPatients,
}));
vi.mock("@/lib/recall/repository", () => ({ listTargets: h.listTargets }));
vi.mock("@/lib/auth/guard", async () => {
  // The module gate uses the REAL predicate. It is the only guard on this route
  // that asks about the caller's ROLE — requireUser and requireClientAccess both
  // admit every role attached to the practice — so a stub returning null would let
  // a `client_staff` login search the whole patient base with the suite still green.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: h.requireUser,
    requireClientAccess: h.requireClientAccess,
    requireModuleApiAccess: (u: { role?: string } | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

import { GET } from "./route";

const FULL_PATIENT = {
  id: "p1",
  name: "Alex Berry",
  title: "Mr",
  email: "alex@example.com",
  phone: "07700900123",
  siteId: "site-cc",
  active: true,
  archivedReason: null,
  recallDueAt: "2026-10-01",
  dentistRecallAt: "2026-10-01",
  hygienistRecallAt: null,
  lastVisitAt: "2025-10-01T09:00:00.000Z",
  dateOfBirth: "1967-05-17",
  gender: "male",
  smsConsent: true,
  emailConsent: true,
  paymentPlanId: 2,
};

function call(qs: string) {
  return GET(new Request(`http://localhost/api/dentally/patients?${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getClient.mockReturnValue({ id: "vitality", slug: "vitality" });
  h.requireUser.mockResolvedValue({ id: "u1", role: "client_owner", clientId: "vitality" });
  h.requireClientAccess.mockReturnValue(null);
  h.getViewSiteIds.mockResolvedValue(["site-cc"]);
  h.listPatients.mockResolvedValue([FULL_PATIENT]);
  h.searchPatients.mockResolvedValue([FULL_PATIENT]);
  h.listTargets.mockResolvedValue([]);
});

describe("GET /api/dentally/patients", () => {
  it("returns the FULL patient record, not a reduced subset", async () => {
    const body = await (await call("client=vitality")).json();
    expect(body.patients[0]).toEqual(FULL_PATIENT);
  });

  it("returns the full record from a search too, so a record opened from search is complete", async () => {
    const body = await (await call("client=vitality&search=berry")).json();
    expect(body.patients[0].dateOfBirth).toBe("1967-05-17");
    expect(body.patients[0].smsConsent).toBe(true);
    expect(body.patients[0].title).toBe("Mr");
  });

  it("marks recall rows PARTIAL rather than presenting a missing phone as 'no contact'", async () => {
    h.listTargets.mockResolvedValue([
      {
        id: "site-cc:p9:dentist",
        siteId: "site-cc",
        dentallyPatientId: "p9",
        patientName: "Jo Nash",
        recallType: "dentist",
        dueAt: "2026-06-01",
        overdueDays: 60,
        lastVisitAt: "2025-06-01T09:00:00.000Z",
        priorAttempts: 1,
        status: "due",
        consent: { sms: true, email: false, marketing: true },
        updatedFromDentallyAt: "2026-07-01T09:00:00.000Z",
      },
    ]);
    const body = await (await call("client=vitality&filter=recall")).json();
    const row = body.patients[0];
    expect(row.partial).toBe(true);
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
    // The consent flags DO come from the target, so they are real, not nulled.
    expect(row.smsConsent).toBe(true);
    expect(row.emailConsent).toBe(false);
    // And the recall date is split the way the record shows it.
    expect(row.dentistRecallAt).toBe("2026-06-01");
    expect(row.hygienistRecallAt).toBeNull();
  });

  it("does NOT mark a real Dentally row as partial", async () => {
    const body = await (await call("client=vitality")).json();
    expect(body.patients[0].partial).toBeUndefined();
  });

  it("still 404s an unknown client before any guard or read runs", async () => {
    h.getClient.mockReturnValue(undefined);
    const res = await call("client=nope");
    expect(res.status).toBe(404);
    expect(h.requireUser).not.toHaveBeenCalled();
  });
});
