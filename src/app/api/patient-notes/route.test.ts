// Patient practice-notes API: auth + site scoping + the cross-site IDOR guard
// (a caller for site A must not read/write notes for a site-B patient) + basic
// validation + author stamping. Client/auth/Dentally/repo are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] };

/** One stored note, as the repository sees it (authorship included, never returned). */
type StoredNote = {
  id: string;
  siteId: string;
  patientId: string;
  authorId: string | null;
  createdAt: string;
  pinnedAt: string | null;
  colour: string | null;
  body: string;
};

const store = vi.hoisted(() => ({
  user: null as User | null,
  patient: null as { id: string; siteId: string } | null,
  created: [] as Record<string, unknown>[],
  notes: [] as Record<string, unknown>[],
  /** The PATCH surface's own rows, keyed by nothing: the mock enforces the same
   *  three-part predicate the real queries do, so a scoping bug fails the test. */
  rows: [] as StoredNote[],
  pinnedCount: 0,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));
vi.mock("@/lib/auth/guard", async () => {
  // THE REAL predicate for the module gate, not a stub: it is the only thing that
  // keeps a `client_staff` login out of the patient record, and a mock returning
  // null unconditionally would let that regress in silence.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.user,
    requireClientAccess: (u: User | null, cid: string) =>
      u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireSiteAccess: (u: User | null, sid: string) =>
      u && !u.siteIds.includes(sid) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireModuleApiAccess: (u: User | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});
vi.mock("@/lib/dentally/read", () => ({
  getPatientById: async () => store.patient,
}));
// The mock honours the real three-part predicate (id AND site AND patient) so a
// missing .eq() in the repository would surface here as a passing mutation.
const find = (noteId: string, siteId: string, patientId: string): StoredNote | undefined =>
  store.rows.find((r) => r.id === noteId && r.siteId === siteId && r.patientId === patientId);

vi.mock("@/lib/patient-notes/repository", () => ({
  listNotes: async () => store.notes,
  createNote: async (n: Record<string, unknown>) => {
    const row = { id: "n1", ...n, createdAt: "2026-07-07T00:00:00Z" };
    store.created.push(row);
    return row;
  },
  getNoteAuthorship: async (a: { noteId: string; siteId: string; patientId: string }) => {
    const row = find(a.noteId, a.siteId, a.patientId);
    return row ? { authorId: row.authorId, createdAt: row.createdAt, pinnedAt: row.pinnedAt } : null;
  },
  countPinned: async () => store.pinnedCount,
  pinNote: async (a: Record<string, unknown>) => {
    const row = find(a.noteId as string, a.siteId as string, a.patientId as string);
    if (!row) return null;
    store.updates.push({ verb: "pin", ...a });
    row.pinnedAt = a.pinned ? "2026-07-31T12:00:00Z" : null;
    return { ...row };
  },
  setColour: async (a: Record<string, unknown>) => {
    const row = find(a.noteId as string, a.siteId as string, a.patientId as string);
    if (!row) return null;
    store.updates.push({ verb: "colour", ...a });
    row.colour = (a.colour as string) ?? null;
    return { ...row };
  },
  updateBody: async (a: Record<string, unknown>) => {
    const row = find(a.noteId as string, a.siteId as string, a.patientId as string);
    if (!row) return null;
    store.updates.push({ verb: "body", ...a });
    row.body = a.body as string;
    return { ...row };
  },
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

// The route now fires a fire-and-forget usage event; stub the server-only seam so
// this test does not pull in "server-only" (unresolved outside the Next bundler).
vi.mock("@/lib/telemetry", () => ({ recordUsage: vi.fn() }));

import { GET, POST, PATCH } from "./route";

/** Fresh enough to be inside the fifteen-minute author edit window. */
const justNow = () => new Date(Date.now() - 60_000).toISOString();
/** Old enough that the window has closed. */
const longAgo = "2024-01-01T09:00:00Z";

beforeEach(() => {
  store.user = { id: "u1", name: "Dr Smith", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
  store.patient = { id: "pat-1", siteId: "site-cc" };
  store.created = [];
  store.notes = [
    { id: "n0", siteId: "site-cc", patientId: "pat-1", authorName: "Dr Jones", body: "prev", source: "typed", createdAt: "2026-07-06T00:00:00Z" },
  ];
  store.updates = [];
  store.pinnedCount = 0;
  store.rows = [
    // This patient's own note, written by the signed-in user a minute ago.
    { id: "mine", siteId: "site-cc", patientId: "pat-1", authorId: "u1", createdAt: justNow(), pinnedAt: null, colour: null, body: "chipped incisor" },
    // Same site, DIFFERENT patient. Reaching this by id is the attack guard 5 stops.
    { id: "other-patient", siteId: "site-cc", patientId: "pat-9", authorId: "u1", createdAt: justNow(), pinnedAt: null, colour: null, body: "someone else" },
    // This patient's, but written by somebody else and long ago.
    { id: "theirs-old", siteId: "site-cc", patientId: "pat-1", authorId: "u2", createdAt: longAgo, pinnedAt: null, colour: null, body: "old note" },
    // This patient's own, already pinned.
    { id: "pinned", siteId: "site-cc", patientId: "pat-1", authorId: "u1", createdAt: longAgo, pinnedAt: "2026-07-01T09:00:00Z", colour: "green", body: "allergic to latex" },
  ];
});

const getReq = (qs: string) => new Request(`http://localhost/api/patient-notes?${qs}`);
const postReq = (b: unknown) =>
  new Request("http://localhost/api/patient-notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
const patchReq = (b: unknown) =>
  new Request("http://localhost/api/patient-notes", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
/** The scope every valid PATCH carries. */
const scope = { client: "vitality", siteId: "site-cc", patientId: "pat-1" };

describe("patient-notes API", () => {
  it("GET requires siteId + patientId", async () => {
    expect((await GET(getReq("client=vitality"))).status).toBe(400);
  });

  it("GET returns the patient's notes", async () => {
    const res = await GET(getReq("client=vitality&siteId=site-cc&patientId=pat-1"));
    const d = (await res.json()) as { ok: boolean; notes: unknown[] };
    expect(res.status).toBe(200);
    expect(d.ok).toBe(true);
    expect(d.notes).toHaveLength(1);
  });

  it("GET 404s when the patient belongs to a different site (IDOR guard)", async () => {
    store.patient = { id: "pat-1", siteId: "site-rv" };
    expect((await GET(getReq("client=vitality&siteId=site-cc&patientId=pat-1"))).status).toBe(404);
  });

  it("POST rejects an empty note", async () => {
    expect((await POST(postReq({ client: "vitality", siteId: "site-cc", patientId: "pat-1", body: "   " }))).status).toBe(400);
  });

  it("POST saves a note stamped with the signed-in author", async () => {
    const res = await POST(postReq({ client: "vitality", siteId: "site-cc", patientId: "pat-1", body: "chipped upper incisor", source: "voice" }));
    const d = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(d.ok).toBe(true);
    expect(store.created[0]).toMatchObject({
      clientId: "vitality",
      siteId: "site-cc",
      patientId: "pat-1",
      authorId: "u1",
      authorName: "Dr Smith",
      body: "chipped upper incisor",
      source: "voice",
    });
  });

  it("POST 404s and saves nothing for a cross-site patient (IDOR guard)", async () => {
    store.patient = { id: "pat-1", siteId: "site-rv" };
    const res = await POST(postReq({ client: "vitality", siteId: "site-cc", patientId: "pat-1", body: "x" }));
    expect(res.status).toBe(404);
    expect(store.created).toHaveLength(0);
  });
});

// PATCH is pin / unpin / recolour / correct. It carries the SAME four guards the
// other verbs do plus a fifth of its own, and dropping any of them on a new verb
// would be a security regression against the cases above.
describe("patient-notes PATCH", () => {
  it("pins a note", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "mine", pinned: true }));
    expect(res.status).toBe(200);
    expect(store.updates).toEqual([expect.objectContaining({ verb: "pin", pinned: true, noteId: "mine" })]);
  });

  it("unpins a note", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "pinned", pinned: false }));
    expect(res.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ verb: "pin", pinned: false });
  });

  it("recolours a note, and refuses a colour outside the vocabulary", async () => {
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", colour: "orange" }))).status).toBe(200);
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", colour: "puce" }))).status).toBe(400);
    expect(store.updates.filter((u) => u.verb === "colour")).toHaveLength(1);
  });

  it("clears a colour when null is sent", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "pinned", colour: null }));
    expect(res.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ verb: "colour", colour: null });
  });

  it("rejects a request that changes nothing", async () => {
    expect((await PATCH(patchReq({ ...scope, noteId: "mine" }))).status).toBe(400);
    expect(store.updates).toHaveLength(0);
  });

  it("requires siteId, patientId and noteId", async () => {
    expect((await PATCH(patchReq({ client: "vitality", pinned: true }))).status).toBe(400);
  });

  // Guard 1-3.
  it("403s a caller who does not hold the site", async () => {
    store.user = { id: "u1", name: "Dr Smith", role: "client_owner", clientId: "vitality", siteIds: ["site-rv"] };
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", pinned: true }))).status).toBe(403);
    expect(store.updates).toHaveLength(0);
  });

  it("403s a caller from another client", async () => {
    store.user = { id: "u1", name: "Dr Smith", role: "client_owner", clientId: "other", siteIds: ["site-cc"] };
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", pinned: true }))).status).toBe(403);
    expect(store.updates).toHaveLength(0);
  });

  it("404s an unknown client", async () => {
    expect((await PATCH(patchReq({ ...scope, client: "nope", noteId: "mine", pinned: true }))).status).toBe(404);
  });

  // Guard 4: the patient must belong to the site.
  it("404s and changes nothing for a cross-site patient", async () => {
    store.patient = { id: "pat-1", siteId: "site-rv" };
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", pinned: true }))).status).toBe(404);
    expect(store.updates).toHaveLength(0);
  });

  // Guard 5, and it is the one the study did not have.
  it("404s and changes nothing when the note belongs to another patient in the same site", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "other-patient", pinned: true }));
    expect(res.status).toBe(404);
    expect(store.updates).toHaveLength(0);
    expect(store.rows.find((r) => r.id === "other-patient")?.pinnedAt).toBeNull();
  });

  it("404s a note id that does not exist at all, with the same response", async () => {
    expect((await PATCH(patchReq({ ...scope, noteId: "made-up", pinned: true }))).status).toBe(404);
  });

  // The cap.
  it("refuses a twelfth-and-first pin with a sentence the reader can act on", async () => {
    store.pinnedCount = 12;
    const res = await PATCH(patchReq({ ...scope, noteId: "mine", pinned: true }));
    expect(res.status).toBe(409);
    const d = (await res.json()) as { error: string };
    expect(d.error).toBe("This patient already has 12 pinned notes. Unpin one first.");
    expect(store.updates).toHaveLength(0);
  });

  it("still allows an unpin, and a recolour, at the cap", async () => {
    store.pinnedCount = 12;
    expect((await PATCH(patchReq({ ...scope, noteId: "pinned", pinned: false }))).status).toBe(200);
    expect((await PATCH(patchReq({ ...scope, noteId: "pinned", colour: "blue" }))).status).toBe(200);
  });

  it("does not count an already-pinned note against the cap when it is re-pinned", async () => {
    store.pinnedCount = 12;
    expect((await PATCH(patchReq({ ...scope, noteId: "pinned", pinned: true }))).status).toBe(200);
  });

  // The edit window.
  it("lets the author correct their own note inside the window", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "mine", body: "chipped upper incisor" }));
    expect(res.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ verb: "body", body: "chipped upper incisor" });
  });

  it("refuses a rewrite of somebody else's old note", async () => {
    const res = await PATCH(patchReq({ ...scope, noteId: "theirs-old", body: "rewritten" }));
    expect(res.status).toBe(403);
    expect(store.updates).toHaveLength(0);
    expect(store.rows.find((r) => r.id === "theirs-old")?.body).toBe("old note");
  });

  it("LETS the author rewrite their own note however old it is, matching Dentally", async () => {
    // This assertion is inverted from what it was. The build originally refused an
    // author's own edit after fifteen minutes; the owner reviewed that and chose to
    // match Dentally, whose pencil has no window. Attribution carries the safety
    // instead: the update stamps updated_at and updated_by.
    const res = await PATCH(patchReq({ ...scope, noteId: "pinned", body: "rewritten" }));
    expect(res.status).toBe(200);
    expect(store.updates).toHaveLength(1);
  });

  it("still lets anyone pin a note they may not edit", async () => {
    expect((await PATCH(patchReq({ ...scope, noteId: "theirs-old", pinned: true }))).status).toBe(200);
  });

  it("refuses to empty a note, and refuses an overlong one", async () => {
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", body: "   " }))).status).toBe(400);
    expect((await PATCH(patchReq({ ...scope, noteId: "mine", body: "x".repeat(5001) }))).status).toBe(400);
    expect(store.updates).toHaveLength(0);
  });

  it("rejects malformed json", async () => {
    const req = new Request("http://localhost/api/patient-notes", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await PATCH(req)).status).toBe(400);
  });
});
