import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

// ===========================================================================
// POST /api/rota/publish — THE ROUTE THAT TEXTS REAL PHONES.
//
// `src/lib/rota/publish.test.ts` is thorough about the snapshot and the diff, and
// says nothing about this file, because the three gates that decide whether a
// person is messaged live in the ROUTE:
//
//   GATE 1  the kill switch — publishing REFUSES while Staff rota is switched off,
//           rather than recording a version nobody was told about;
//   GATE 2  MESSAGING_DRY_RUN — a simulation counts a simulation and CHANGES
//           NOTHING ELSE, because consuming the shifts' unnotified state would
//           mean the first real send after switch-on told nobody at all;
//   GATE 3  suppression, FAIL CLOSED — a number that texted STOP is not texted,
//           and a suppression read that THROWS counts as suppressed.
//
// Two mutations survived the entire 6,455-test suite before this file existed:
// pushing the shift ids into `notifiedShiftIds` on the simulated branch, and
// flipping the suppression default (and its catch) to false. The first two tests
// below are those mutations, written as the cases that kill them.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  getViewScope: vi.fn(),
  listShifts: vi.fn(),
  listStaff: vi.fn(),
  listPublications: vi.fn(),
  recordPublication: vi.fn(),
  markPublished: vi.fn(),
  markNotified: vi.fn(),
  listApprovedAbsence: vi.fn(),
  sendMessage: vi.fn(),
  isSuppressed: vi.fn(),
  isSystemEnabledForSend: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
  getSite: (id: string) => ({ id, name: "N15" }),
}));

vi.mock("@/lib/auth/guard", async () => {
  const { APPROVER_ROLES: ROLES } = await import("@/lib/absence/rules");
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(ROLES as readonly string[]).includes(user.role)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: async () => true,
}));

vi.mock("@/lib/site-view", () => ({ getViewScope: h.getViewScope }));
vi.mock("@/lib/rota/repository", () => ({
  listShifts: h.listShifts,
  listStaff: h.listStaff,
  listPublications: h.listPublications,
  recordPublication: h.recordPublication,
  markPublished: h.markPublished,
  markNotified: h.markNotified,
}));
vi.mock("@/lib/absence/repository", () => ({ listApprovedAbsence: h.listApprovedAbsence }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: h.sendMessage }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: h.isSuppressed }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledForSend: h.isSystemEnabledForSend }));

import { GET, POST } from "./route";

const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

/** The Monday of next week, computed rather than written, so this file cannot expire. */
function nextMonday(): string {
  const now = new Date();
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(utc).getUTCDay(); // 0 Sun … 6 Sat
  const delta = ((8 - day) % 7) || 7;
  return new Date(utc + delta * 86_400_000).toISOString().slice(0, 10);
}

const WEEK_START = nextMonday();

const AMINA = { id: "staff-1", name: "Amina", phone: "+447700900001", email: null, siteId: "site-n15" };
const BEA = { id: "staff-2", name: "Bea", phone: "+447700900002", email: null, siteId: "site-n15" };

// ---------------------------------------------------------------------------
// PEOPLE WITH AN EMAIL ON FILE.
//
// Amina and Bea deliberately have `email: null`, which is what left the whole
// EMAIL half of this route unexecuted for a round: a mutation that flipped the
// email branch's `let suppressed = true` to `false` (and took a FAILED
// suppression read as consent) passed all 6,612 tests, because no fixture ever
// entered `if (person.email)`. These three do.
//
//   CARLA has both channels — the only fixture that can prove the suppression
//         question is asked PER CHANNEL, against the address and not the number.
//   DEV   has an address and NO MOBILE, which is the case the email branch
//         exists for: for him it is not a second channel, it is the only one.
//   ELIAS has neither, so "could not be reached" is proven to be a counted
//         outcome rather than a person who quietly vanishes between the buckets.
// ---------------------------------------------------------------------------
const CARLA = {
  id: "staff-3",
  name: "Carla",
  phone: "+447700900003",
  email: "carla@vitalitydental.example",
  siteId: "site-n15",
};
const DEV = {
  id: "staff-4",
  name: "Dev",
  phone: null,
  email: "dev@vitalitydental.example",
  siteId: "site-n15",
};
const ELIAS = { id: "staff-5", name: "Elias", phone: null, email: null, siteId: "site-n15" };

function shift(over: Record<string, unknown> = {}) {
  return {
    id: "shift-1",
    clientId: "vitality",
    siteId: "site-n15",
    staffId: "staff-1",
    shiftDate: WEEK_START,
    startTime: "09:00",
    endTime: "17:00",
    role: "nurse",
    status: "scheduled",
    pairedStaffId: null,
    note: null,
    ...over,
  };
}

/**
 * Publish a week staffed by exactly these people, one shift each.
 *
 * The default fixtures (Amina and Bea, SMS only) are left untouched so the gates
 * already proven above keep meaning what they meant; the email cases below stand
 * on their own team.
 */
function withTeam(...people: { id: string }[]) {
  h.listStaff.mockResolvedValue(people);
  h.listShifts.mockResolvedValue(people.map((p) => shift({ id: `shift-${p.id}`, staffId: p.id })));
}

function publish(body: Record<string, unknown> = {}) {
  return POST(
    new Request("http://localhost/api/rota/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", weekStart: WEEK_START, ...body }),
    }),
  );
}

const REAL_SEND = { provider: "twilio", id: "SM1" };
const SIMULATED_SEND = { provider: "dry-run", id: "dry-1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(MANAGER);
  h.requireCapability.mockResolvedValue(null);
  h.getViewScope.mockResolvedValue({ isAllSites: false, siteIds: ["site-n15"], label: "N15" });
  h.listShifts.mockResolvedValue([shift(), shift({ id: "shift-2", staffId: "staff-2" })]);
  h.listStaff.mockResolvedValue([AMINA, BEA]);
  h.listPublications.mockResolvedValue([]);
  h.listApprovedAbsence.mockResolvedValue([]);
  h.recordPublication.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: "pub-1",
    publishedAt: "2026-08-14T09:00:00.000Z",
  }));
  h.markPublished.mockResolvedValue(undefined);
  h.markNotified.mockResolvedValue(undefined);
  h.sendMessage.mockResolvedValue(REAL_SEND);
  h.isSuppressed.mockResolvedValue(false);
  h.isSystemEnabledForSend.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.MESSAGING_DRY_RUN;
});

describe("GATE 2: a dry run simulates, and CONSUMES NOTHING", () => {
  it("does not mark a single shift notified", async () => {
    // THE MUTATION THIS KILLS: pushing `staffShifts.map(s => s.id)` into
    // notifiedShiftIds on the `else if (simulated)` branch. It looks harmless —
    // the shifts were "handled" — and its consequence is that the first REAL
    // publish after MESSAGING_DRY_RUN is switched off skips every one of them,
    // so nobody ever receives their first text.
    process.env.MESSAGING_DRY_RUN = "true";
    h.sendMessage.mockResolvedValue(SIMULATED_SEND);

    const res = await publish();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.markNotified).not.toHaveBeenCalled();
    expect(body.simulatedStaff).toBe(2);
    expect(body.notifiedStaff).toBe(0);
    expect(body.dryRun).toBe(true);
  });

  it("still records the publication, with notified 0 and simulated counted", async () => {
    // The manager DID publish. Withholding the row would put a hole in the
    // evidence log; recording notified_count > 0 would put a lie in it.
    process.env.MESSAGING_DRY_RUN = "true";
    h.sendMessage.mockResolvedValue(SIMULATED_SEND);

    await publish();
    expect(h.recordPublication).toHaveBeenCalledWith(
      expect.objectContaining({ notifiedCount: 0, simulatedCount: 2, shiftCount: 2 }),
    );
    // The shifts are still stamped as published — that half is about the version,
    // not about anybody being told.
    expect(h.markPublished).toHaveBeenCalled();
  });

  it("a REAL send does consume it, for exactly the people who were reached", async () => {
    // The control. Without this, "markNotified was not called" could be satisfied
    // by a route that never calls it at all.
    h.sendMessage.mockResolvedValue(REAL_SEND);
    const res = await publish();
    expect((await res.json()).notifiedStaff).toBe(2);
    expect(h.markNotified).toHaveBeenCalledWith(["shift-1", "shift-2"]);
  });
});

describe("GATE 3: suppression fails CLOSED", () => {
  it("A SUPPRESSION READ THAT THROWS MEANS SUPPRESSED: nothing is sent to that number", async () => {
    // THE MUTATION THIS KILLS: `let suppressed = true` -> `false`, and
    // `catch { suppressed = false }`. A failed read would then be taken as consent
    // and somebody who texted STOP gets texted anyway. A skipped send self-heals on
    // the next publish; a send made against an opt-out does not.
    h.isSuppressed.mockRejectedValue(new Error("suppression table unreachable"));

    const res = await publish();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.notifiedStaff).toBe(0);
    // Counted as not reached — one honest number, rather than vanishing between
    // the buckets, which is what an earlier draft of this route did.
    expect(body.notReached).toBe(2);
    expect(h.markNotified).not.toHaveBeenCalled();
    expect(h.recordPublication).toHaveBeenCalledWith(expect.objectContaining({ notifiedCount: 0 }));
  });

  it("an opted-out number is never sent to, and never counted notified", async () => {
    h.isSuppressed.mockImplementation(async (_site: string, _channel: string, to: string) =>
      to === AMINA.phone,
    );

    const body = await (await publish()).json();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ to: BEA.phone }));
    expect(body.notifiedStaff).toBe(1);
    expect(body.notReached).toBe(1);
    // Only the person who was actually reached has their shift consumed.
    expect(h.markNotified).toHaveBeenCalledWith(["shift-2"]);
  });

  it("one bad number never aborts the publish for the rest of the team", async () => {
    h.sendMessage.mockImplementation(async (msg: { to: string }) => {
      if (msg.to === AMINA.phone) throw new Error("invalid number");
      return REAL_SEND;
    });

    const body = await (await publish()).json();
    expect(body.notifiedStaff).toBe(1);
    expect(body.sendFailures).toBe(1);
    expect(h.markNotified).toHaveBeenCalledWith(["shift-2"]);
  });
});

// ===========================================================================
// THE EMAIL CHANNEL WEARS THE SAME THREE GATES, AND HAD PROVEN NONE OF THEM.
//
// The route says an email is "a second channel, not a fallback", and for
// somebody with an address and no mobile it is the ONLY channel. Everything the
// SMS block above proves has to hold here too — an opt-out is honoured, a failed
// suppression read counts as suppressed, a simulation consumes nothing — and
// until this block existed none of it was executed even once.
// ===========================================================================
describe("the EMAIL path: the same gates, proven on the branch nothing reached", () => {
  it("CONTROL: a real send reaches somebody who has no mobile at all", async () => {
    // Without this the three refusals below could be satisfied by a route that
    // never emails anybody, which is the failure this whole block is about.
    withTeam(DEV);

    const body = await (await publish()).json();

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith({
      channel: "email",
      to: DEV.email,
      body: expect.stringContaining(DEV.name),
      // A rota is worth having in writing, and a subject line is what makes it
      // findable in six weeks when somebody disputes a Tuesday.
      subject: `Your shifts at Vitality Dental, week beginning ${WEEK_START}`,
    });
    expect(body.notifiedStaff).toBe(1);
    expect(body.notReached).toBe(0);
    expect(h.markNotified).toHaveBeenCalledWith([`shift-${DEV.id}`]);
  });

  it("AN OPTED-OUT ADDRESS IS NEVER EMAILED, and is never counted notified", async () => {
    // THE MUTATION THIS KILLS: dropping `if (!suppressed)` from the email branch,
    // or narrowing the suppression read to SMS. Somebody who asked not to be
    // emailed is emailed anyway, and the publication row says they were told.
    withTeam(DEV);
    h.isSuppressed.mockImplementation(
      async (_site: string, channel: string, to: string) => channel === "email" && to === DEV.email,
    );

    const res = await publish();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.notifiedStaff).toBe(0);
    expect(body.notReached).toBe(1);
    expect(h.markNotified).not.toHaveBeenCalled();
    expect(h.recordPublication).toHaveBeenCalledWith(expect.objectContaining({ notifiedCount: 0 }));
  });

  it("A SUPPRESSION READ THAT THROWS FAILS CLOSED ON EMAIL, exactly as it does on SMS", async () => {
    // THE MUTATION THIS KILLS, and the one the round-1 re-verify found alive:
    // the email branch's `let suppressed = true` -> `false` with
    // `catch { suppressed = false }`. A suppression table that is merely
    // UNREACHABLE would then read as consent from everybody who ever opted out.
    // A skipped send self-heals on the next publish; a send against an opt-out
    // does not.
    withTeam(DEV);
    h.isSuppressed.mockRejectedValue(new Error("suppression table unreachable"));

    const res = await publish();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.notifiedStaff).toBe(0);
    expect(body.notReached).toBe(1);
    // Not a send failure: nothing was attempted. The distinction is what tells a
    // manager "your provider is broken" apart from "your opt-out list is broken".
    expect(body.sendFailures).toBe(0);
    expect(h.markNotified).not.toHaveBeenCalled();
  });

  it("A DRY RUN ON THE EMAIL PATH SIMULATES, and CONSUMES NOTHING", async () => {
    // GATE 2 on the other branch. THE MUTATION THIS KILLS: `else reached = true`
    // becoming an unconditional `reached = true` on the email send, or the
    // simulated branch pushing into notifiedShiftIds. Either way Dev's first real
    // email after MESSAGING_DRY_RUN is switched off is skipped, and the one
    // person on this team who cannot be texted is never told anything at all.
    process.env.MESSAGING_DRY_RUN = "true";
    withTeam(DEV);
    h.sendMessage.mockResolvedValue(SIMULATED_SEND);

    const body = await (await publish()).json();

    expect(h.markNotified).not.toHaveBeenCalled();
    expect(body.simulatedStaff).toBe(1);
    expect(body.notifiedStaff).toBe(0);
    expect(body.dryRun).toBe(true);
    expect(h.recordPublication).toHaveBeenCalledWith(
      expect.objectContaining({ notifiedCount: 0, simulatedCount: 1 }),
    );
  });

  it("asks the suppression question PER CHANNEL, against the address and not the number", async () => {
    // Carla has both. An opt-out from TEXTS is not an opt-out from EMAIL, and a
    // branch that reused the SMS answer — or asked about `person.phone` on the
    // email channel — would silence a channel she never objected to.
    withTeam(CARLA);
    h.isSuppressed.mockImplementation(
      async (_site: string, channel: string) => channel === "sms",
    );

    const body = await (await publish()).json();

    expect(h.isSuppressed).toHaveBeenCalledWith("site-n15", "sms", CARLA.phone);
    expect(h.isSuppressed).toHaveBeenCalledWith("site-n15", "email", CARLA.email);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "email" }));
    expect(body.notifiedStaff).toBe(1);
  });

  it("...and the converse: an email opt-out still leaves the text", async () => {
    withTeam(CARLA);
    h.isSuppressed.mockImplementation(
      async (_site: string, channel: string) => channel === "email",
    );

    const body = await (await publish()).json();

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", to: CARLA.phone }),
    );
    expect(body.notifiedStaff).toBe(1);
  });

  it("a failed EMAIL send is counted and does not cost the text its delivery", async () => {
    withTeam(CARLA);
    h.sendMessage.mockImplementation(async (msg: { channel: string }) => {
      if (msg.channel === "email") throw new Error("mailbox full");
      return REAL_SEND;
    });

    const body = await (await publish()).json();

    expect(body.notifiedStaff).toBe(1);
    expect(body.sendFailures).toBe(1);
    expect(h.markNotified).toHaveBeenCalledWith([`shift-${CARLA.id}`]);
  });

  it("somebody with NEITHER a number nor an address is counted, not quietly dropped", async () => {
    withTeam(ELIAS);

    const body = await (await publish()).json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.notReached).toBe(1);
    expect(body.notifiedStaff).toBe(0);
    // The publication is still recorded — the manager published — and it says
    // out loud that nobody was told, which is the fact worth keeping.
    expect(h.recordPublication).toHaveBeenCalledWith(
      expect.objectContaining({ notifiedCount: 0, shiftCount: 1 }),
    );
  });

  it("a mixed team reaches each person on whichever channel they actually have", async () => {
    withTeam(CARLA, DEV, ELIAS);

    const body = await (await publish()).json();

    const sent = h.sendMessage.mock.calls.map((call: unknown[]) => {
      const m = call[0] as { channel: string; to: string };
      return [m.channel, m.to];
    });
    expect(sent).toEqual([
      ["sms", CARLA.phone],
      ["email", CARLA.email],
      ["email", DEV.email],
    ]);
    expect(body.notifiedStaff).toBe(2);
    expect(body.notReached).toBe(1);
    expect(h.markNotified).toHaveBeenCalledWith([`shift-${CARLA.id}`, `shift-${DEV.id}`]);
  });
});

describe("GATE 1: the kill switch refuses, rather than publishing silently", () => {
  it("refuses with a 409 and writes nothing at all", async () => {
    h.isSystemEnabledForSend.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("switched off");
    expect(h.recordPublication).not.toHaveBeenCalled();
    expect(h.markPublished).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("is checked BEFORE the week is even loaded", async () => {
    h.isSystemEnabledForSend.mockResolvedValue(false);
    await publish();
    expect(h.listShifts).not.toHaveBeenCalled();
  });
});

describe("who may publish, and what may be published", () => {
  it("refuses the staff role and the clinician on both methods", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await publish()).status, `${user.role} POST`).toBe(403);
      const preview = await GET(
        new Request(`http://localhost/api/rota/publish?client=vitality&weekStart=${WEEK_START}`),
      );
      expect(preview.status, `${user.role} GET`).toBe(403);
    }
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("asks for rota.publish on the write and only rota.view on the preview", async () => {
    await publish();
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "rota.publish");

    vi.clearAllMocks();
    h.requireUser.mockResolvedValue(MANAGER);
    h.requireCapability.mockResolvedValue(null);
    h.getViewScope.mockResolvedValue({ isAllSites: false, siteIds: ["site-n15"], label: "N15" });
    h.listShifts.mockResolvedValue([shift()]);
    h.listPublications.mockResolvedValue([]);
    h.listApprovedAbsence.mockResolvedValue([]);
    h.isSystemEnabledForSend.mockResolvedValue(true);
    await GET(new Request(`http://localhost/api/rota/publish?client=vitality&weekStart=${WEEK_START}`));
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "rota.view");
    expect(h.requireCapability).not.toHaveBeenCalledWith(MANAGER, "rota.publish");
  });

  // ONE ASSERTION SHORT OF NOTHING. Asserting that `requireCapability` was CALLED
  // proves the line exists, not that its answer is honoured; deleting
  // `if (capDenied) return capDenied;` left every test above green. These give the
  // mocked guard a real 403 and check the route stops.
  it("HONOURS a refusal from rota.publish: nobody is texted and nothing is recorded", async () => {
    h.requireCapability.mockResolvedValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );
    const res = await publish();
    expect(res.status).toBe(403);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.recordPublication).not.toHaveBeenCalled();
    expect(h.markPublished).not.toHaveBeenCalled();
  });

  it("refuses a week that does not start on a Monday", async () => {
    const res = await publish({ weekStart: "2026-08-12" });
    expect(res.status).toBe(400);
    expect(h.recordPublication).not.toHaveBeenCalled();
  });

  it("refuses an empty week rather than recording a version of nothing", async () => {
    h.listShifts.mockResolvedValue([]);
    const res = await publish();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no shifts");
    expect(h.recordPublication).not.toHaveBeenCalled();
  });

  it("excludes a cancelled shift from the snapshot", async () => {
    h.listShifts.mockResolvedValue([shift(), shift({ id: "shift-2", staffId: "staff-2", status: "cancelled" })]);
    const body = await (await publish()).json();
    expect(body.shiftCount).toBe(1);
    expect(h.markNotified).toHaveBeenCalledWith(["shift-1"]);
  });
});

describe("a publication that cannot be recorded is not a publication", () => {
  it("answers 500 and does NOT stamp the shifts as published", async () => {
    h.recordPublication.mockRejectedValue(new Error("relation rota_publication does not exist"));
    const res = await publish();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("was not published");
    expect(h.markPublished).not.toHaveBeenCalled();
    expect(h.markNotified).not.toHaveBeenCalled();
  });

  // THE SENDS HAPPEN FIRST. This branch used to say "Nothing has been changed."
  // after both people had been texted, which is false, and which invites the one
  // action that makes it worse: pressing Publish again.
  it("does NOT claim nothing changed once real messages have gone out", async () => {
    h.recordPublication.mockRejectedValue(new Error("statement timeout"));
    const body = await (await publish()).json();

    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(body.contacted).toBe(2);
    expect(body.error).not.toMatch(/nothing has been changed/i);
    expect(body.error).toMatch(/already been sent/i);
    expect(body.error).toMatch(/contact them again/i);
  });

  it("says nothing was sent when nothing was", async () => {
    h.isSuppressed.mockResolvedValue(true); // nobody is reachable
    h.recordPublication.mockRejectedValue(new Error("statement timeout"));
    const body = await (await publish()).json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.contacted).toBe(0);
    expect(body.error).toMatch(/nothing has been sent/i);
  });

  it("names the concurrent publish for what it is, and answers 409 rather than 500", async () => {
    // The unique (client, site, week, version) key: another manager won the race.
    h.recordPublication.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    const res = await publish();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.collision).toBe(true);
    expect(body.error).toMatch(/somebody else published this week/i);
    expect(body.error).toMatch(/reload/i);
    expect(h.markPublished).not.toHaveBeenCalled();
  });
});

describe("the people whose week was EMPTIED are told, not skipped", () => {
  // Amina and Bea were both published in v1. In the new rota Bea's shift is gone
  // (a tombstone, which never reaches the snapshot) and Amina's is unchanged.
  // The notify loop is driven by the NEW snapshot, so Bea has no entry in it.
  const v1 = {
    weekStart: WEEK_START,
    siteId: "site-n15",
    version: 1,
    shifts: [
      {
        id: "shift-1",
        staffId: "staff-1",
        siteId: "site-n15",
        shiftDate: WEEK_START,
        startTime: "09:00",
        endTime: "17:00",
        role: "nurse",
        pairedStaffId: null,
        note: null,
      },
      {
        id: "shift-2",
        staffId: "staff-2",
        siteId: "site-n15",
        shiftDate: WEEK_START,
        startTime: "09:00",
        endTime: "17:00",
        role: "nurse",
        pairedStaffId: null,
        note: null,
      },
    ],
  };

  beforeEach(() => {
    h.listPublications.mockResolvedValue([
      { version: 1, snapshot: v1, publishedAt: "2026-08-01T09:00:00.000Z" },
    ]);
    // Bea's row is a tombstone: still present, no longer live.
    h.listShifts.mockResolvedValue([shift(), shift({ id: "shift-2", staffId: "staff-2", status: "removed" })]);
  });

  it("texts the person who is no longer working, and says so", async () => {
    const body = await (await publish()).json();

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sent = h.sendMessage.mock.calls[0][0];
    expect(sent.to).toBe(BEA.phone);
    expect(sent.body).toMatch(/no longer down to work that week/i);
    // ...and she is counted, so the response stops implying everybody was told.
    expect(body.notifiedStaff).toBe(1);
    expect(body.notReached).toBe(0);
  });

  it("counts her as unreachable rather than silently dropping her", async () => {
    h.isSuppressed.mockResolvedValue(true);
    const body = await (await publish()).json();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(body.notifiedStaff).toBe(0);
    expect(body.notReached).toBe(1);
  });

  it("consumes no shift ids for her: she has none left to consume", async () => {
    await publish();
    expect(h.markNotified).not.toHaveBeenCalled();
  });

  it("also covers a shift REASSIGNED away from somebody who then has nothing", async () => {
    // shift-2 is now Amina's second shift, so Bea is clear of the week without
    // anything being deleted at all.
    h.listShifts.mockResolvedValue([shift(), shift({ id: "shift-2", staffId: "staff-1" })]);
    await publish();

    const recipients = h.sendMessage.mock.calls.map((c) => c[0].to);
    expect(recipients).toContain(BEA.phone);
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: BEA.phone, body: expect.stringMatching(/no longer down to work/i) }),
    );
  });

  it("says nothing to somebody who is still working, however much their week moved", async () => {
    h.listShifts.mockResolvedValue([
      shift(),
      shift({ id: "shift-2", staffId: "staff-2", startTime: "10:00" }),
    ]);
    await publish();

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0][0].body).not.toMatch(/no longer down to work/i);
  });
});

describe("re-publishing tells the people whose week changed, and not the rest", () => {
  const previousSnapshot = {
    weekStart: WEEK_START,
    siteId: "site-n15",
    version: 1,
    shifts: [
      {
        id: "shift-1",
        staffId: "staff-1",
        siteId: "site-n15",
        shiftDate: WEEK_START,
        startTime: "09:00",
        endTime: "17:00",
        role: "nurse",
        pairedStaffId: null,
        note: null,
      },
    ],
  };

  it("tells only the person who was added", async () => {
    h.listPublications.mockResolvedValue([
      { version: 1, snapshot: previousSnapshot, publishedAt: "2026-08-01T09:00:00.000Z" },
    ]);
    const body = await (await publish()).json();
    // Amina's shift is identical to v1; Bea is new. Only Bea is texted.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ to: BEA.phone }));
    expect(body.version).toBe(2);
  });

  it("notify:'all' is a deliberate re-send to everybody", async () => {
    h.listPublications.mockResolvedValue([
      { version: 1, snapshot: previousSnapshot, publishedAt: "2026-08-01T09:00:00.000Z" },
    ]);
    await publish({ notify: "all" });
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("a first publish tells everybody, because it is 100% new", async () => {
    await publish();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
    expect(APPROVER_ROLES).not.toContain("client_staff");
  });
});
