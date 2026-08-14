import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

// ===========================================================================
// /api/staff-check-in — THE FIFTH "My work" TAB, and the one nothing tested.
//
// My work has five tabs. Four of them (`absence`, `rota/shifts`, `hr/document`,
// `hr/policy`) have a route test proving their SELF branch and a `self-service`
// entry in the API coverage sweep. This one, which My clock reads on every open
// and posts to on every tap, had neither: it pre-dates the shared self-service
// seam and resolves the caller through `findStaffByAppUser` directly, so the
// sweep's `mine=1` proof never applied to it and nobody wrote the route test.
//
// WHAT IS UNDER TEST IS THE SECURITY CLAIM, not the happy path:
//
//   * GET narrows a non-approver to ONE row — their own — and narrows it AT THE
//     QUERY (`listEventsForDay` is asked about their staff id and nobody else's),
//     so a direct call returns no more than the tab renders;
//   * an UNLINKED login sees nothing rather than everything: `me` is null, and
//     the filter must not degrade into "show the whole team";
//   * POST with no staffId records against the SESSION's staff row;
//   * POST naming SOMEBODY ELSE is a different act — an approver role AND
//     `people.clock.record-for-other` — so a nurse cannot clock a colleague in;
//   * a login with no staff record gets the honest 409 and its copy, not a 500
//     and not a silent success;
//   * the manager's view is untouched by any of it.
//
// `requireApproverRole` is reimplemented from the REAL, IMPORTED `APPROVER_ROLES`
// rather than stubbed to a fixed answer: importing the actual guard would drag
// server-only Supabase plumbing into a node test, and hard-coding the role list
// would let this file keep passing after the real one changed.
//
// The clocking RULES are not stubbed at all. `buildTodayView` and `validateClock`
// are pure and are exercised for real, because a route test that mocked them
// would prove the route calls something rather than that the something decides.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  getViewScope: vi.fn(),
  findStaffByAppUser: vi.fn(),
  listEvents: vi.fn(),
  listEventsForDay: vi.fn(),
  recordEvent: vi.fn(),
  getStaff: vi.fn(),
  listStaff: vi.fn(),
  listShifts: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
  getSites: () => [{ id: "site-n15", name: "N15" }],
}));

vi.mock("@/lib/auth/guard", async () => {
  const { APPROVER_ROLES: ROLES } = await import("@/lib/absence/rules");
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireSiteAccess: () => null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(ROLES as readonly string[]).includes(user.role)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

// The per-person gate is a spy, not a stub with an opinion: which KEY each
// branch asks for is part of what this file proves, and the guard's own
// behaviour is proven in src/lib/auth/capability-guard.test.ts.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: async () => true,
}));

vi.mock("@/lib/site-view", () => ({ getViewScope: h.getViewScope }));
vi.mock("@/lib/clock/repository", () => ({
  findStaffByAppUser: h.findStaffByAppUser,
  listEvents: h.listEvents,
  listEventsForDay: h.listEventsForDay,
  recordEvent: h.recordEvent,
}));
vi.mock("@/lib/rota/repository", () => ({
  getStaff: h.getStaff,
  listStaff: h.listStaff,
  listShifts: h.listShifts,
}));

import { GET, POST } from "./route";

const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

const ME = { id: "staff-1", name: "Amina", role: "nurse", siteId: "site-n15", active: true };
const COLLEAGUE = { id: "staff-2", name: "Bea", role: "nurse", siteId: "site-n15", active: true };

/** Today in London, computed rather than written, so this file cannot expire. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

const TODAY = today();

function get(query = "client=vitality") {
  return GET(new Request(`http://localhost/api/staff-check-in?${query}`));
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/staff-check-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", ...body }),
    }),
  );
}

function shift(staffId: string) {
  return {
    id: `shift-${staffId}`,
    staffId,
    siteId: "site-n15",
    shiftDate: TODAY,
    startTime: "09:00",
    endTime: "17:00",
    status: "scheduled",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(NURSE);
  h.requireCapability.mockResolvedValue(null);
  h.getViewScope.mockResolvedValue({ isAllSites: false, siteIds: ["site-n15"], label: "N15" });
  h.findStaffByAppUser.mockResolvedValue(ME);
  h.listStaff.mockResolvedValue([ME, COLLEAGUE]);
  h.listShifts.mockResolvedValue([shift(ME.id), shift(COLLEAGUE.id)]);
  h.listEventsForDay.mockResolvedValue({ ready: true, events: [] });
  h.listEvents.mockResolvedValue({ ready: true, events: [] });
  h.getStaff.mockResolvedValue(ME);
  h.recordEvent.mockImplementation(async (input: Record<string, unknown>) => ({ id: "evt-1", ...input }));
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    // Every 403 and every `canManage:false` below changes meaning if this list
    // changes, so it is imported and pinned rather than assumed.
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
    expect(APPROVER_ROLES).not.toContain("client_staff");
    expect(APPROVER_ROLES).not.toContain("client_clinician");
  });
});

describe("GET: a non-approver is narrowed to their own row, AT THE QUERY", () => {
  it("asks the database only about the session's own staff id", async () => {
    // THE MUTATION THIS KILLS: `canManage ? all : all.filter(s => s.id === me?.id)`
    // becoming `toClockStaff(allStaff)`. The tab would look identical — it renders
    // one row by id — and the RESPONSE would carry the whole team's attendance.
    const res = await get();
    expect(res.status).toBe(200);

    expect(h.listEventsForDay).toHaveBeenCalledWith(
      "vitality",
      TODAY,
      expect.objectContaining({ staffIds: [ME.id] }),
    );
    const body = await res.json();
    expect(body.canManage).toBe(false);
    expect(body.view.rows).toHaveLength(1);
    expect(body.view.rows[0].staffId).toBe(ME.id);
  });

  it("HANDS BACK NOTHING ABOUT ANYBODY ELSE — not a name, not an id, not a shift", async () => {
    // The colleague is in `listStaff` and on today's rota, so she is present in
    // everything the route reads. She must be absent from everything it returns.
    const body = await (await get()).json();
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(COLLEAGUE.id);
    expect(wire).not.toContain(COLLEAGUE.name);
    expect(wire).not.toContain(`shift-${COLLEAGUE.id}`);
  });

  it("IGNORES a staffId in the query string, so a filter cannot become a bypass", async () => {
    // The route reads no staff id from the query at all. Asserted rather than
    // assumed, because "reads none" and "reads one and ignores it" are the same
    // to a reader and very different to whoever adds the next parameter.
    const body = await (await get(`client=vitality&staffId=${COLLEAGUE.id}`)).json();
    expect(h.listEventsForDay).toHaveBeenCalledWith(
      "vitality",
      TODAY,
      expect.objectContaining({ staffIds: [ME.id] }),
    );
    expect(body.view.rows.map((r: { staffId: string }) => r.staffId)).toEqual([ME.id]);
  });

  it("an UNLINKED login sees NOBODY, which is the fail-closed direction", async () => {
    // THE MUTATION THIS KILLS: any rewrite of the filter that treats "I could not
    // identify you" as "show everything" — `me ? filter : all`, or dropping the
    // `?.` so an undefined id matches nothing in one direction and everything in
    // the other. A login with no staff record is the least identified caller the
    // route has, and must therefore see the least.
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.me).toBeNull();
    expect(body.canManage).toBe(false);
    expect(body.view.rows).toEqual([]);
    expect(h.listEventsForDay).toHaveBeenCalledWith(
      "vitality",
      TODAY,
      expect.objectContaining({ staffIds: [] }),
    );
  });

  it("the clinician is on the self path too, not on the manager one", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    const body = await (await get()).json();
    expect(body.canManage).toBe(false);
    expect(body.view.rows).toHaveLength(1);
  });

  it("says clocking is not switched on rather than rendering an empty day", async () => {
    // `ready:false` means migration 0068 is unapplied. An empty `rows` with no
    // flag would read as "nobody turned up today", which is a different and false
    // statement about real people.
    h.listEventsForDay.mockResolvedValue({ ready: false, events: [] });
    expect((await (await get()).json()).ready).toBe(false);
  });
});

describe("GET: the manager's view is unchanged", () => {
  it("an approver still sees the whole team", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const body = await (await get()).json();
    expect(body.canManage).toBe(true);
    expect(body.view.rows.map((r: { staffId: string }) => r.staffId).sort()).toEqual([
      ME.id,
      COLLEAGUE.id,
    ]);
    expect(h.listEventsForDay).toHaveBeenCalledWith(
      "vitality",
      TODAY,
      expect.objectContaining({ staffIds: [ME.id, COLLEAGUE.id] }),
    );
  });

  it("a manager who is also on the rota still gets her own `me`", async () => {
    // One screen shows the team AND her own state; `me` is read for both callers.
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await (await get()).json()).me).toMatchObject({ id: ME.id });
  });
});

describe("POST: clocking YOURSELF in resolves you from the session", () => {
  it("records against the session's staff row, marked `manual`, with no staffId in the body", async () => {
    const res = await post({ kind: "in" });
    expect(res.status).toBe(201);
    expect(h.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "vitality",
        staffId: ME.id,
        kind: "in",
        source: "manual",
        recordedBy: NURSE.id,
      }),
    );
    // The self act, gated on its own key — the one a nurse holds.
    expect(h.requireCapability).toHaveBeenCalledWith(NURSE, "people.clock.self");
    expect(h.requireCapability).not.toHaveBeenCalledWith(NURSE, "people.clock.record-for-other");
  });

  it("naming YOUR OWN staff id is still the self path, because the fork is on identity", async () => {
    // Not on whether the field was sent. A route that forked on "a staffId is
    // present" would 403 the tab the moment it started echoing the id back.
    const res = await post({ kind: "in", staffId: ME.id });
    expect(res.status).toBe(201);
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ source: "manual" }));
    expect(h.requireCapability).toHaveBeenCalledWith(NURSE, "people.clock.self");
  });

  it("the SERVER re-checks the rule: a second clock-in is a 409 that writes nothing", async () => {
    h.listEvents.mockResolvedValue({
      ready: true,
      events: [
        {
          id: "e1",
          clientId: "vitality",
          siteId: "site-n15",
          staffId: ME.id,
          kind: "in",
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          source: "manual",
        },
      ],
    });
    const res = await post({ kind: "in" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Already clocked in");
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("refuses a kind that is neither in nor out", async () => {
    expect((await post({ kind: "lunch" })).status).toBe(400);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("says clocking is not switched on rather than writing into a table that is not there", async () => {
    h.listEvents.mockResolvedValue({ ready: false, events: [] });
    expect((await post({ kind: "in" })).status).toBe(503);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });
});

describe("POST: clocking SOMEBODY ELSE in is a different act, and is refused", () => {
  it("A NURSE NAMING A COLLEAGUE IS REFUSED — the IDOR this endpoint exists to stop", async () => {
    // THE MUTATION THIS KILLS: dropping the `requireApproverRole` from the
    // `onBehalf` branch, or resolving `targetId` from the body FIRST and only
    // then asking who the caller is. Either way anybody could clock anybody in
    // — the exact defect B6 was raised for — and the event would be signed with
    // the victim's staff id.
    h.getStaff.mockResolvedValue(COLLEAGUE);
    const res = await post({ kind: "in", staffId: COLLEAGUE.id });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "forbidden" });
    expect(h.recordEvent).not.toHaveBeenCalled();
    // Refused BEFORE the staff row is even fetched: the endpoint is not an
    // existence oracle over the practice's team either.
    expect(h.getStaff).not.toHaveBeenCalled();
  });

  it("...and the clinician is refused on exactly the same branch", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    h.getStaff.mockResolvedValue(COLLEAGUE);
    expect((await post({ kind: "in", staffId: COLLEAGUE.id })).status).toBe(403);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("an UNLINKED login cannot borrow the self path to write somebody else's record", async () => {
    // With no staff row of their own, EVERY target is somebody else, so the
    // approver guard is what stands between an unlinked login and the team's
    // attendance. `targetId !== me?.id` is true against undefined, which is the
    // fail-closed direction.
    h.findStaffByAppUser.mockResolvedValue(null);
    h.getStaff.mockResolvedValue(COLLEAGUE);
    expect((await post({ kind: "in", staffId: COLLEAGUE.id })).status).toBe(403);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("an approver may record for a colleague, marked `admin` and signed with who pressed it", async () => {
    // The control. Without it, every 403 above could be satisfied by a route that
    // refuses everybody, and the practice manager's screen would be dead.
    h.requireUser.mockResolvedValue(MANAGER);
    h.findStaffByAppUser.mockResolvedValue(null); // a manager who is not on the rota
    h.getStaff.mockResolvedValue(COLLEAGUE);

    const res = await post({ kind: "in", staffId: COLLEAGUE.id });
    expect(res.status).toBe(201);
    expect(h.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: COLLEAGUE.id,
        // The log says who it was ABOUT and who WROTE it, which is the whole
        // difference between an attendance record and an assertion.
        source: "admin",
        recordedBy: MANAGER.id,
      }),
    );
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "people.clock.record-for-other");
  });

  it("the two acts carry two DIFFERENT keys, so an owner can withhold either alone", async () => {
    // Revoking `people.clock.record-for-other` from a named manager must not stop
    // her clocking herself in, and vice versa. Proven by refusing one key at a
    // time and watching the other act still succeed.
    h.requireUser.mockResolvedValue(MANAGER);
    h.requireCapability.mockImplementation(async (_u: unknown, key: string) =>
      key === "people.clock.record-for-other"
        ? Response.json({ ok: false, error: "capability" }, { status: 403 })
        : null,
    );
    h.getStaff.mockResolvedValue(COLLEAGUE);
    expect((await post({ kind: "in", staffId: COLLEAGUE.id })).status).toBe(403);
    expect(h.recordEvent).not.toHaveBeenCalled();

    // The same person, the same session, her own tap: still allowed.
    h.getStaff.mockResolvedValue(ME);
    h.findStaffByAppUser.mockResolvedValue(ME);
    expect((await post({ kind: "in" })).status).toBe(201);
  });
});

describe("POST: a login with no staff record is told so, honestly", () => {
  it("answers 409 with the copy that tells her what to do about it", async () => {
    // Not a 500, not a cheerful 201 against nobody. The tab renders this sentence
    // verbatim, so the copy is part of the contract.
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await post({ kind: "in" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not linked to a staff record");
    expect(body.error).toContain("practice manager");
    expect(h.recordEvent).not.toHaveBeenCalled();
    // And it stops there: no staff lookup, no capability question about a person
    // the route could not identify.
    expect(h.getStaff).not.toHaveBeenCalled();
    expect(h.requireCapability).not.toHaveBeenCalled();
  });
});

describe("POST: the site the tap is recorded against is this practice's", () => {
  it("refuses a site id that belongs to somebody else", async () => {
    // requireSiteAccess alone is not enough: an agency admin holds every site of
    // every client, so the route checks the id against THIS client's sites.
    const res = await post({ kind: "in", siteId: "site-another-practice" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No site");
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("falls back to the staff member's own site when none is given", async () => {
    await post({ kind: "in" });
    expect(h.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-n15" }));
  });
});
