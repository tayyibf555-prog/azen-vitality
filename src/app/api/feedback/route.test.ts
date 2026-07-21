// Feedback API: auth required on every method, client access enforced on submit,
// agency_admin enforced on the cross-client list + mark-done, author identity
// always stamped server-side (never trusted from the body), and the webhook
// notifier is invoked best-effort without ever failing the request. Auth/client/
// repository/webhook are all mocked; see webhook.test.ts for the notifier's own
// "never throws" contract.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; email: string; role: string; clientId: string | null; siteIds: string[] } | null;

const store = vi.hoisted(() => ({
  user: null as User | Response | null,
  created: [] as Record<string, unknown>[],
  items: [] as Record<string, unknown>[],
  statusUpdates: [] as { id: string; status: string }[],
  webhookCalls: [] as unknown[][],
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined),
  CLIENTS: [{ id: "vitality", slug: "vitality", name: "Vitality Dental" }],
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.user,
  requireClientAccess: (u: User, cid: string) =>
    u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
}));

vi.mock("@/lib/feedback/repository", () => ({
  insertFeedback: async (input: Record<string, unknown>) => {
    const row = { id: "f1", status: "new", createdAt: "2026-07-16T09:00:00Z", ...input };
    store.created.push(row);
    return row;
  },
  listFeedback: async () => store.items,
  setFeedbackStatus: async (id: string, status: string) => {
    store.statusUpdates.push({ id, status });
  },
}));

vi.mock("@/lib/feedback/webhook", () => ({
  notifyFeedbackWebhook: (...args: unknown[]) => {
    store.webhookCalls.push(args);
  },
}));

import { POST, GET, PATCH } from "./route";

const owner: NonNullable<User> = { id: "u1", email: "owner@vitality.example", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const coordinator: NonNullable<User> = { id: "u2", email: "manager@vitality.example", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
const agencyAdmin: NonNullable<User> = { id: "u3", email: "agency@azen.example", role: "agency_admin", clientId: null, siteIds: [] };

beforeEach(() => {
  store.user = owner;
  store.created = [];
  store.items = [];
  store.statusUpdates = [];
  store.webhookCalls = [];
});

const postReq = (b: unknown) =>
  new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
const patchReq = (b: unknown) =>
  new Request("http://localhost/api/feedback", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

describe("POST /api/feedback", () => {
  it("requires an authed user (401 when requireUser signals unauthorized)", async () => {
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    const res = await POST(postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "x" }));
    expect(res.status).toBe(401);
    expect(store.created).toHaveLength(0);
  });

  it("404s for an unknown client", async () => {
    const res = await POST(postReq({ clientSlug: "nope", pagePath: "/c/nope", note: "x" }));
    expect(res.status).toBe(404);
  });

  it("rejects an empty note", async () => {
    const res = await POST(postReq({ clientSlug: "vitality", pagePath: "/c/vitality/patients", note: "   " }));
    expect(res.status).toBe(400);
    expect(store.created).toHaveLength(0);
  });

  it("saves a report stamped with the signed-in user's identity, ignoring any client-submitted identity fields", async () => {
    const res = await POST(
      postReq({
        clientSlug: "vitality",
        pagePath: "/c/vitality/patients",
        note: "The search spinner never stops.",
        severity: "bug",
        // An attacker (or a stale client) trying to impersonate someone else:
        userId: "someone-else",
        userEmail: "attacker@example.com",
        role: "agency_admin",
      }),
    );
    const data = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(store.created[0]).toMatchObject({
      clientId: "vitality",
      userId: "u1",
      userEmail: "owner@vitality.example",
      role: "client_owner",
      note: "The search spinner never stops.",
      severity: "bug",
    });
  });

  it("defaults an invalid or missing severity to 'bug'", async () => {
    await POST(postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "idea: dark mode", severity: "not-a-real-severity" }));
    expect(store.created[0]).toMatchObject({ severity: "bug" });
  });

  it("allows the coordinator to submit for their own client", async () => {
    store.user = coordinator;
    const res = await POST(postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "x" }));
    expect(res.status).toBe(200);
    expect(store.created[0]).toMatchObject({ userId: "u2", role: "client_coordinator" });
  });

  it("calls the webhook notifier best-effort after a successful save, and still returns ok even though the notifier is fire-and-forget", async () => {
    const res = await POST(postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "please fix" }));
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(store.webhookCalls).toHaveLength(1);
    expect(store.webhookCalls[0][1]).toBe("Vitality Dental");
  });

  it("persists the request even when the webhook is dormant (FEEDBACK_WEBHOOK_URL unset -> notifier is a no-op)", async () => {
    // Mirror notifyFeedbackWebhook's real behaviour when the URL is unset: it
    // does nothing. The row must still be saved, so requests are captured from
    // day one, before FEEDBACK_WEBHOOK_URL is ever configured. (webhook.test.ts
    // proves the notifier itself no-ops-without-throwing when the URL is unset.)
    vi.doMock("@/lib/feedback/webhook", () => ({ notifyFeedbackWebhook: () => {} }));
    vi.resetModules();
    const { POST: postWithDormantWebhook } = await import("./route");
    const res = await postWithDormantWebhook(
      postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "please tweak the header" }),
    );
    const data = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(store.created).toHaveLength(1);
    expect(store.created[0]).toMatchObject({ note: "please tweak the header" });
    vi.doUnmock("@/lib/feedback/webhook");
    vi.resetModules();
  });

  it("still returns ok:true (and has already saved the row) even if the webhook notifier throws", async () => {
    vi.doMock("@/lib/feedback/webhook", () => ({
      notifyFeedbackWebhook: () => {
        throw new Error("boom");
      },
    }));
    vi.resetModules();
    const { POST: postWithThrowingWebhook } = await import("./route");
    const res = await postWithThrowingWebhook(postReq({ clientSlug: "vitality", pagePath: "/c/vitality", note: "x" }));
    expect(res.status).toBe(200);
    // The save happens before the (throwing) notifier runs, so it is never lost.
    expect(store.created).toHaveLength(1);
    vi.doUnmock("@/lib/feedback/webhook");
    vi.resetModules();
  });
});

describe("GET /api/feedback (agency console list)", () => {
  it("is forbidden for a non-agency-admin", async () => {
    store.user = owner;
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns every item newest-first with the client name attached, for an agency admin", async () => {
    store.user = agencyAdmin;
    store.items = [{ id: "f1", clientId: "vitality", note: "x", severity: "bug", status: "new", createdAt: "2026-07-16T09:00:00Z" }];
    const res = await GET();
    const data = (await res.json()) as { ok: boolean; items: { clientName: string }[] };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.items[0].clientName).toBe("Vitality Dental");
  });
});

describe("PATCH /api/feedback (mark done)", () => {
  it("is forbidden for a non-agency-admin", async () => {
    store.user = coordinator;
    const res = await PATCH(patchReq({ id: "f1", status: "done" }));
    expect(res.status).toBe(403);
    expect(store.statusUpdates).toHaveLength(0);
  });

  it("updates the status for an agency admin", async () => {
    store.user = agencyAdmin;
    const res = await PATCH(patchReq({ id: "f1", status: "done" }));
    expect(res.status).toBe(200);
    expect(store.statusUpdates).toEqual([{ id: "f1", status: "done" }]);
  });

  it("rejects a request missing id or status", async () => {
    store.user = agencyAdmin;
    const res = await PATCH(patchReq({ id: "f1" }));
    expect(res.status).toBe(400);
  });
});
