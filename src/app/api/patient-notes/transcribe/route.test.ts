// ===========================================================================
// THE GAP THIS ROUTE SHIPPED WITH.
//
// /api/patient-notes/transcribe carried `requireUser` and nothing else. Every
// signed-in role of the practice could therefore reach it, which was two problems
// at once: it dictates INTO the patient record, and it spends a paid third-party
// transcription call on every request. Its parent (/api/patient-notes) has always
// carried the full chain; this one was simply missed.
//
// Adding the fifth role forced the issue — a `client_staff` login must reach no part
// of the patient record — so the module gate was added here as part of that change.
// These tests are the proof, and they are the only tests this route has ever had.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] } | null;

const store: { user: User; authResponse: Response | null; enabled: boolean; text: string } = {
  user: null,
  authResponse: null,
  enabled: true,
  text: "patient reports no pain since the filling",
};

vi.mock("@/lib/auth/guard", async () => {
  // The REAL module predicate, not a stub. requireUser admits every signed-in role,
  // so this is the only guard on the route that asks who the caller is; a mock
  // returning null unconditionally would assert nothing at all.
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.authResponse ?? store.user,
    requireModuleApiAccess: (u: User, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

const transcribeCalls: string[] = [];
vi.mock("@/lib/transcription/transcribe", () => ({
  transcriptionEnabled: () => store.enabled,
  transcribeAudio: async (_audio: Blob, filename: string) => {
    transcribeCalls.push(filename);
    return store.text;
  },
  TranscriptionNotConfiguredError: class extends Error {},
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


import { POST } from "./route";

function upload(bytes = 32): Request {
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(bytes)], "note.webm", { type: "audio/webm" }));
  return new Request("http://localhost/api/patient-notes/transcribe", { method: "POST", body: form });
}

function user(role: string): User {
  return { id: `u-${role}`, name: "Test", email: "t@example.com", role, clientId: "vitality", siteIds: ["site-cc"] } as User;
}

beforeEach(() => {
  store.user = user("client_owner");
  store.authResponse = null;
  store.enabled = true;
  transcribeCalls.length = 0;
});

describe("who may dictate into the patient record", () => {
  it.each(["agency_admin", "client_owner", "client_coordinator", "client_clinician"])(
    "%s may transcribe",
    async (role) => {
      store.user = user(role);
      const res = await POST(upload());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, text: store.text });
    },
  );

  it("client_staff is refused with a 403 — the whole point of the fifth role", async () => {
    store.user = user("client_staff");
    const res = await POST(upload());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "forbidden" });
  });

  it("and the refusal costs nothing: the paid provider is never called", async () => {
    // The order matters and this is what pins it. The module gate runs BEFORE the
    // provider, so a refused caller cannot spend the practice's transcription budget
    // by hammering an endpoint they are not allowed to use.
    store.user = user("client_staff");
    await POST(upload());
    expect(transcribeCalls).toEqual([]);
  });

  it("an unauthenticated caller is still refused first of all", async () => {
    store.authResponse = Response.json({ error: "unauthorized" }, { status: 401 });
    const res = await POST(upload());
    expect(res.status).toBe(401);
    expect(transcribeCalls).toEqual([]);
  });

  it("passes through unchanged when enforcement is off (null user), like every guard", async () => {
    store.user = null;
    expect((await POST(upload())).status).toBe(200);
  });
});

describe("the feature gate stays behind the access gate", () => {
  it("a permitted caller with no provider configured gets 503 and a sentence to print", async () => {
    store.enabled = false;
    const res = await POST(upload());
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).toMatch(/not switched on/i);
  });

  it("a REFUSED caller learns nothing about the provider's state", async () => {
    // 403 not 503: the access decision comes first, so an unauthorised caller cannot
    // probe whether the practice has transcription configured.
    store.enabled = false;
    store.user = user("client_staff");
    expect((await POST(upload())).status).toBe(403);
  });
});
