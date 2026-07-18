// Patient practice-notes API: auth + site scoping + the cross-site IDOR guard
// (a caller for site A must not read/write notes for a site-B patient) + basic
// validation + author stamping. Client/auth/Dentally/repo are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  patient: null as { id: string; siteId: string } | null,
  created: [] as Record<string, unknown>[],
  notes: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.user,
  requireClientAccess: (u: User | null, cid: string) =>
    u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
  requireSiteAccess: (u: User | null, sid: string) =>
    u && !u.siteIds.includes(sid) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
}));
vi.mock("@/lib/dentally/read", () => ({
  getPatientById: async () => store.patient,
}));
vi.mock("@/lib/patient-notes/repository", () => ({
  listNotes: async () => store.notes,
  createNote: async (n: Record<string, unknown>) => {
    const row = { id: "n1", ...n, createdAt: "2026-07-07T00:00:00Z" };
    store.created.push(row);
    return row;
  },
}));
// The route now fires a fire-and-forget usage event; stub the server-only seam so
// this test does not pull in "server-only" (unresolved outside the Next bundler).
vi.mock("@/lib/telemetry", () => ({ recordUsage: vi.fn() }));

import { GET, POST } from "./route";

beforeEach(() => {
  store.user = { id: "u1", name: "Dr Smith", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
  store.patient = { id: "pat-1", siteId: "site-cc" };
  store.created = [];
  store.notes = [
    { id: "n0", siteId: "site-cc", patientId: "pat-1", authorName: "Dr Jones", body: "prev", source: "typed", createdAt: "2026-07-06T00:00:00Z" },
  ];
});

const getReq = (qs: string) => new Request(`http://localhost/api/patient-notes?${qs}`);
const postReq = (b: unknown) =>
  new Request("http://localhost/api/patient-notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

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
