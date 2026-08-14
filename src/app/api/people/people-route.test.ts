// People & Logins API: the owner lock, the two lockout guards, the tenancy on the
// staff link, and the promise that no password ever passes through this platform.
// Auth, the client registry and the repository are mocked; the RULES are the real,
// tested ones, because mocking those away would leave nothing worth asserting.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Person, LinkableStaff } from "@/lib/provisioning/types";

type User = { id: string; name: string; email: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  available: true,
  people: [] as Person[],
  staff: [] as LinkableStaff[],
  authReadable: true,
  staffReadable: true,
  authIds: {} as Record<string, string>,
  existingByEmail: null as { id: string; client_id: string | null } | null,
  /** Every write the route performed, in order. The audit the tests read. */
  calls: [] as { fn: string; args: unknown[] }[],
}));

const record = (fn: string, ...args: unknown[]) => {
  store.calls.push({ fn, args });
};

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.user,
  requireClientAccess: (u: User | null, cid: string) =>
    u && u.role !== "agency_admin" && u.clientId !== cid
      ? Response.json({ error: "forbidden" }, { status: 403 })
      : null,
  // The real shape of requireOwnerRole: owner + agency admin, nobody else.
  requireOwnerRole: (u: User | null) =>
    u && u.role !== "client_owner" && u.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
}));

vi.mock("@/lib/provisioning/repository", () => ({
  provisioningAvailable: () => store.available,
  readPeople: async () => ({
    people: store.people,
    authReadable: store.authReadable,
    authError: store.authReadable ? null : "auth down",
    staffReadable: store.staffReadable,
    staff: store.staff,
    activeOwnerCount: store.people.filter(
      (p) => p.role === "client_owner" && (p.authStatus === "active" || p.authStatus === "invited"),
    ).length,
  }),
  readAuthDirectory: async () => ({
    byEmail: new Map(Object.entries(store.authIds).map(([email, id]) => [email, { id, facts: {} }])),
    readable: store.authReadable,
    error: store.authReadable ? null : "auth down",
  }),
  findAuthUserId: async (email: string) => store.authIds[email.toLowerCase()] ?? null,
  findPersonByEmail: async () => store.existingByEmail,
  createPersonRow: async (input: Record<string, unknown>) => {
    record("createPersonRow", input);
    return { id: "new-1", email: input.email, name: input.name, role: input.role, client_id: input.clientId };
  },
  updatePersonRole: async (clientId: string, id: string, role: string) => {
    record("updatePersonRole", clientId, id, role);
  },
  setAuthBanned: async (authUserId: string, banned: boolean) => {
    record("setAuthBanned", authUserId, banned);
  },
  setStaffLink: async (input: Record<string, unknown>) => {
    record("setStaffLink", input);
    return { ok: true as const };
  },
  clearStaffLinkForPerson: async (clientId: string, appUserId: string) => {
    record("clearStaffLinkForPerson", clientId, appUserId);
  },
  generateInviteToken: async (email: string) => {
    record("generateInviteToken", email);
    return { authUserId: "auth-new", tokenHash: "HASH-INVITE" };
  },
  generateRecoveryToken: async (email: string) => {
    record("generateRecoveryToken", email);
    return { tokenHash: "HASH-RECOVERY", type: "recovery" as const };
  },
  inviteByEmail: async (email: string) => {
    record("inviteByEmail", email);
    return { authUserId: "auth-new", tokenHash: null };
  },
  sendRecoveryEmail: async (email: string) => {
    record("sendRecoveryEmail", email);
  },
}));

const { GET, POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

const OWNER: User = {
  id: "u-owner",
  name: "Jawad",
  email: "jawad@v.co.uk",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-n15"],
};

function person(over: Partial<Person> = {}): Person {
  return {
    id: "p1",
    email: "blerta@v.co.uk",
    name: "Blerta Hoxha",
    role: "client_coordinator",
    clientId: "vitality",
    authStatus: "active",
    lastSignInAt: "2026-08-01T09:00:00Z",
    invitedAt: null,
    linkedStaff: null,
    ...over,
  } as Person;
}

const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://localhost/api/people/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ client: "vitality", ...body }),
    }),
    { params: Promise.resolve({ id }) },
  );

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/people", { method: "POST", body: JSON.stringify({ client: "vitality", ...body }) }));

beforeEach(() => {
  store.user = OWNER;
  store.available = true;
  store.authReadable = true;
  store.staffReadable = true;
  store.people = [];
  store.staff = [];
  store.authIds = {};
  store.existingByEmail = null;
  store.calls = [];
  vi.unstubAllEnvs();
});

describe("the owner lock", () => {
  it("refuses the practice manager on GET", async () => {
    store.user = { ...OWNER, id: "u-mgr", role: "client_coordinator" };
    const res = await GET(new Request("http://localhost/api/people?client=vitality"));
    expect(res.status).toBe(403);
  });

  it("refuses the practice manager on POST", async () => {
    store.user = { ...OWNER, id: "u-mgr", role: "client_coordinator" };
    expect((await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" })).status).toBe(403);
  });

  it("refuses the clinician on PATCH", async () => {
    store.user = { ...OWNER, id: "u-cl", role: "client_clinician" };
    expect((await patch("p1", { action: "deactivate" })).status).toBe(403);
  });

  it("refuses an owner of a DIFFERENT practice (tenancy, not just role)", async () => {
    store.user = { ...OWNER, clientId: "otherclient" };
    expect((await GET(new Request("http://localhost/api/people?client=vitality"))).status).toBe(403);
  });

  it("admits the owner", async () => {
    const res = await GET(new Request("http://localhost/api/people?client=vitality"));
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(true);
  });
});

describe("an environment that cannot provision says so", () => {
  it("GET reports available:false with a reason instead of an empty list", async () => {
    store.available = false;
    const body = await (await GET(new Request("http://localhost/api/people?client=vitality"))).json();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/service-role key/i);
    expect(body.people).toEqual([]);
  });

  it("POST refuses with 503 rather than pretending to invite", async () => {
    store.available = false;
    const res = await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" });
    expect(res.status).toBe(503);
    expect(store.calls).toEqual([]);
  });

  it("PATCH refuses with 503", async () => {
    store.available = false;
    expect((await patch("p1", { action: "deactivate" })).status).toBe(503);
  });
});

describe("the two guards that stop a practice locking itself out", () => {
  it("an owner cannot deactivate their own login", async () => {
    store.people = [person({ id: OWNER.id, role: "client_owner", email: OWNER.email }), person({ id: "p2", role: "client_owner", email: "x@v.co.uk" })];
    store.authIds = { [OWNER.email]: "auth-owner" };
    const res = await patch(OWNER.id, { action: "deactivate" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/your own login/i);
    expect(store.calls).toEqual([]);
  });

  it("the last active owner cannot be deactivated", async () => {
    store.people = [person({ id: "p-only-owner", role: "client_owner", email: "solo@v.co.uk" })];
    store.authIds = { "solo@v.co.uk": "auth-solo" };
    const res = await patch("p-only-owner", { action: "deactivate" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last owner/i);
    expect(store.calls).toEqual([]);
  });

  it("...but a second owner CAN be, and the ban is what actually happens", async () => {
    store.people = [
      person({ id: "p-a", role: "client_owner", email: "a@v.co.uk" }),
      person({ id: "p-b", role: "client_owner", email: "b@v.co.uk" }),
    ];
    store.authIds = { "a@v.co.uk": "auth-a", "b@v.co.uk": "auth-b" };
    const res = await patch("p-b", { action: "deactivate" });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ fn: "setAuthBanned", args: ["auth-b", true] }]);
  });

  it("reactivating lifts the ban rather than creating anything", async () => {
    store.people = [person({ id: "p-b", role: "client_coordinator", email: "b@v.co.uk", authStatus: "deactivated" })];
    store.authIds = { "b@v.co.uk": "auth-b" };
    const res = await patch("p-b", { action: "reactivate" });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ fn: "setAuthBanned", args: ["auth-b", false] }]);
  });

  it("the last owner cannot be demoted either", async () => {
    store.people = [person({ id: "p-solo", role: "client_owner", email: "solo@v.co.uk" })];
    const res = await patch("p-solo", { action: "role", role: "client_staff" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last owner/i);
    expect(store.calls).toEqual([]);
  });

  it("nobody can be promoted to agency_admin from this screen", async () => {
    store.people = [person(), person({ id: "p-owner", role: "client_owner", email: "o@v.co.uk" })];
    const res = await patch("p1", { action: "role", role: "agency_admin" });
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("a legitimate role change is written, scoped to the practice", async () => {
    store.people = [person(), person({ id: "p-owner", role: "client_owner", email: "o@v.co.uk" })];
    const res = await patch("p1", { action: "role", role: "client_clinician" });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ fn: "updatePersonRole", args: ["vitality", "p1", "client_clinician"] }]);
  });

  it("a person from another practice is a 404, not a silent success", async () => {
    store.people = [person({ id: "p1" })];
    expect((await patch("p-elsewhere", { action: "deactivate" })).status).toBe(404);
    expect(store.calls).toEqual([]);
  });

  it("an unreadable auth directory blocks status changes instead of guessing", async () => {
    store.authReadable = false;
    store.people = [person({ authStatus: "unknown" })];
    const res = await patch("p1", { action: "deactivate" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/could not be read/i);
    expect(store.calls).toEqual([]);
  });
});

describe("link login -> staff record (the writer that never existed)", () => {
  const staffRow: LinkableStaff = {
    id: "s1",
    name: "Blerta Hoxha",
    role: "Practice manager",
    siteId: "site-n15",
    appUserId: null,
    active: true,
  };

  it("writes rota_staff.app_user_id scoped by BOTH client and staff id", async () => {
    store.people = [person()];
    store.staff = [staffRow];
    const res = await patch("p1", { action: "link-staff", staffId: "s1" });
    expect(res.status).toBe(200);
    // The old row is released first (the partial unique index allows exactly one).
    expect(store.calls[0]).toEqual({ fn: "clearStaffLinkForPerson", args: ["vitality", "p1"] });
    expect(store.calls[1]).toEqual({
      fn: "setStaffLink",
      args: [{ clientId: "vitality", staffId: "s1", appUserId: "p1" }],
    });
  });

  it("refuses an archived staff record", async () => {
    store.people = [person()];
    store.staff = [{ ...staffRow, active: false }];
    const res = await patch("p1", { action: "link-staff", staffId: "s1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/archived/i);
    expect(store.calls).toEqual([]);
  });

  it("refuses a staff id that is not in this practice's list", async () => {
    store.people = [person()];
    store.staff = [staffRow];
    const res = await patch("p1", { action: "link-staff", staffId: "s-other-practice" });
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("unlinks with staffId null", async () => {
    store.people = [person({ linkedStaff: { id: "s1", name: "B", role: "r", siteId: null } })];
    store.staff = [{ ...staffRow, appUserId: "p1" }];
    const res = await patch("p1", { action: "link-staff", staffId: null });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ fn: "clearStaffLinkForPerson", args: ["vitality", "p1"] }]);
  });

  it("says so honestly when rota records are unavailable", async () => {
    store.staffReadable = false;
    store.people = [person()];
    const res = await patch("p1", { action: "link-staff", staffId: "s1" });
    expect(res.status).toBe(503);
    expect(store.calls).toEqual([]);
  });
});

describe("inviting somebody", () => {
  it("NEVER creates a user with a password: it mints a one-time link and returns it once", async () => {
    const res = await post({ email: "New.Person@V.co.uk", name: "New Person", role: "client_staff" });
    expect(res.status).toBe(201);
    const body = await res.json();
    // The profile row is written first, so a failed invite leaves a visible row.
    expect(store.calls[0].fn).toBe("createPersonRow");
    expect(store.calls[0].args[0]).toMatchObject({ email: "new.person@v.co.uk", role: "client_staff" });
    expect(store.calls[1].fn).toBe("generateInviteToken");
    expect(body.link).toBe("/set-password?token_hash=HASH-INVITE&type=invite");
    // Nothing resembling a password anywhere in the response.
    expect(JSON.stringify(body).toLowerCase()).not.toContain("password\":");
    expect(store.calls.some((c) => c.fn.toLowerCase().includes("createuser"))).toBe(false);
  });

  it("lets Supabase send the email when SMTP is declared, and returns no link at all", async () => {
    vi.stubEnv("SUPABASE_SMTP_CONFIGURED", "true");
    const body = await (await post({ email: "a@b.co.uk", name: "A B", role: "client_clinician" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["createPersonRow", "inviteByEmail"]);
    expect(body.link).toBeNull();
    expect(body.delivery).toBe("email");
  });

  it("refuses an invite that names agency_admin", async () => {
    const res = await post({ email: "a@b.co.uk", name: "A B", role: "agency_admin" });
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("refuses a malformed email before touching anything", async () => {
    expect((await post({ email: "not-an-email", name: "A B", role: "client_staff" })).status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("refuses an email already on this practice's list", async () => {
    store.existingByEmail = { id: "p9", client_id: "vitality" };
    const res = await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already on this practice/i);
  });

  it("refuses an email belonging to another practice, without saying which", async () => {
    store.existingByEmail = { id: "p9", client_id: "otherclient" };
    const res = await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" });
    expect(res.status).toBe(409);
    const error = (await res.json()).error as string;
    expect(error).toMatch(/already in use/i);
    expect(error).not.toContain("otherclient");
  });

  it("uses a RECOVERY link when the Auth account already exists (invite would be refused)", async () => {
    store.authIds = { "a@b.co.uk": "auth-existing" };
    const body = await (await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["createPersonRow", "generateRecoveryToken"]);
    expect(body.link).toContain("type=recovery");
  });

  it("emails the recovery instead when SMTP is declared: no link leaks in email mode", async () => {
    vi.stubEnv("SUPABASE_SMTP_CONFIGURED", "true");
    store.authIds = { "a@b.co.uk": "auth-existing" };
    const body = await (await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["createPersonRow", "sendRecoveryEmail"]);
    expect(body.link).toBeNull();
  });

  it("refuses to invite while the auth directory is unreadable", async () => {
    store.authReadable = false;
    const res = await post({ email: "a@b.co.uk", name: "A B", role: "client_staff" });
    expect(res.status).toBe(502);
    expect(store.calls).toEqual([]);
  });
});

describe("resending an invite", () => {
  it("issues a recovery link for somebody who already has a login", async () => {
    store.people = [person({ authStatus: "invited" })];
    const body = await (await patch("p1", { action: "resend-invite" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["generateRecoveryToken"]);
    expect(body.link).toContain("type=recovery");
  });

  it("issues a fresh INVITE for a profile with no login behind it", async () => {
    store.people = [person({ authStatus: "missing" })];
    const body = await (await patch("p1", { action: "resend-invite" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["generateInviteToken"]);
    expect(body.link).toContain("type=invite");
  });

  it("in email mode it sends, and returns no link either way", async () => {
    vi.stubEnv("SUPABASE_SMTP_CONFIGURED", "true");
    store.people = [person({ id: "p1", authStatus: "missing" }), person({ id: "p2", authStatus: "invited" })];
    const first = await (await patch("p1", { action: "resend-invite" })).json();
    const second = await (await patch("p2", { action: "resend-invite" })).json();
    expect(store.calls.map((c) => c.fn)).toEqual(["inviteByEmail", "sendRecoveryEmail"]);
    expect(first.link).toBeNull();
    expect(second.link).toBeNull();
  });
});

describe("input hygiene", () => {
  it("rejects an unknown action rather than falling through to a default", async () => {
    store.people = [person()];
    expect((await patch("p1", { action: "delete-everything" })).status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("rejects an unknown client", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/people/p1", {
        method: "PATCH",
        body: JSON.stringify({ client: "nope", action: "deactivate" }),
      }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/people/p1", { method: "PATCH", body: "{" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(400);
  });
});
