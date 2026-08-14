import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE STAFF CAGE ON THE ONE PAGE EVERY LOGIN LANDS ON.
//
// `/c/[client]` IS the practice dashboard: the takings strip, outstanding
// accounts, invoiced totals, UDA, and the day's appointment list carrying
// patient names. `client_staff` — a nurse, a receptionist — is the one role
// defined as having neither the money nor the diary, and it lands here, because
// "/" routes every non-agency, non-owner role to /c/[client] and "" has to stay
// in STAFF_SLUGS or that routing loops for ever.
//
// So the PAGE forwards. This file proves the forward happens and, just as
// important, that it happens BEFORE the dashboard is read: a redirect issued
// after `readPracticeDashboard` would still have pulled the practice's takings
// for somebody who may not see them, and "they never saw the response" is not
// the same as "we never asked".
//
// The other four roles are asserted UNCHANGED in the same loop, from the same
// mocks, because the risk of a fix like this is not that it fails to cage the
// fifth role — it is that it quietly cages a fourth.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  readPracticeDashboard: vi.fn(),
  redirect: vi.fn((to: string) => {
    // The real `redirect()` throws, and everything downstream of it depends on
    // that: a mock that returned normally would let the page carry on and read
    // the dashboard anyway, and this file would pass while the hole was open.
    throw new RedirectSignal(to);
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: h.redirect,
  notFound: () => {
    throw new Error("notFound");
  },
}));

// Enforcement ON. Every guard in this codebase is a deliberate no-op where
// sign-in is not configured, so with the real `authEnforced()` (false in a node
// test) this file would assert nothing at all.
vi.mock("@/lib/auth/guard", () => ({ authEnforced: () => true }));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: h.getSessionUser,
  getAuthEmail: async () => "someone@example.com",
  canAccessClient: () => true,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/dashboard/read", () => ({ readPracticeDashboard: h.readPracticeDashboard }));

vi.mock("@/lib/site-view", () => ({
  ALL_SITES: "all",
  getViewSiteSelection: async () => "all",
}));

// The three view components: this test is about the guard, not the markup, and
// dragging the real dashboard tree into a node test would prove nothing extra.
vi.mock("@/components/primitives", () => ({ PageHeader: () => null }));
vi.mock("@/components/client/dashboard/practice-dashboard", () => ({ PracticeDashboard: () => null }));
vi.mock("@/components/client/task-queue/task-queue-board", () => ({ TaskQueueBoard: () => null }));

import ClientHomePage from "./page";
import { indexRedirectFor } from "@/lib/nav";
import type { Role } from "@/lib/types";

const OTHER_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
];

function session(role: Role) {
  return {
    id: `u-${role}`,
    name: "Test",
    email: "t@example.com",
    role,
    clientId: "vitality",
    siteIds: ["site-n15"],
  };
}

function render() {
  return ClientHomePage({ params: Promise.resolve({ client: "vitality" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readPracticeDashboard.mockResolvedValue({ sites: [], today: null });
});

describe("a client_staff login never renders the practice dashboard", () => {
  it("is forwarded to its own surface", async () => {
    h.getSessionUser.mockResolvedValue(session("client_staff"));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(h.redirect).toHaveBeenCalledWith("/c/vitality/my-work");
  });

  it("AND THE TAKINGS ARE NEVER READ — the forward precedes the fetch", async () => {
    h.getSessionUser.mockResolvedValue(session("client_staff"));
    await render().catch(() => {});
    // The assertion that makes this a cage rather than a curtain. `redirect()`
    // throwing is what enforces it; if the call ever moved below the read, the
    // response would still be a redirect and this line would still fail.
    expect(h.readPracticeDashboard).not.toHaveBeenCalled();
  });

  it("the destination is the pure rule's, not a second opinion typed into the page", async () => {
    h.getSessionUser.mockResolvedValue(session("client_staff"));
    await render().catch(() => {});
    expect(h.redirect).toHaveBeenCalledWith(indexRedirectFor("client_staff", "vitality"));
  });
});

describe("the other four roles are untouched", () => {
  it.each(OTHER_ROLES)("%s still renders the Overview, with the dashboard read", async (role) => {
    h.getSessionUser.mockResolvedValue(session(role));
    await expect(render()).resolves.toBeDefined();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.readPracticeDashboard).toHaveBeenCalledTimes(1);
  });

  it("an unresolved session is the layout guard's business, not this page's", async () => {
    // /c/[client]/layout.tsx redirects an anonymous visitor to /login. This page
    // must not invent a second answer for that case, and must not fail closed into
    // a redirect loop of its own.
    h.getSessionUser.mockResolvedValue(null);
    await expect(render()).resolves.toBeDefined();
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
