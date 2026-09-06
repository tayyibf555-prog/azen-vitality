// ===========================================================================
// THE LEADS WORKLIST'S "RESEND" BUTTON AND THE KILL SWITCH.
//
// `resend` is the only action on this route that puts a message on the wire, and
// it does it the way speed-to-lead does everything: `contactLead` dispatches
// through `sendMessage` DIRECTLY. There is no outbox row, so the drain's
// `getDisabledSlugsForSend` never gets a second look at it. The switch check in
// the route IS the whole distance between a receptionist's click and a real SMS.
//
// So this file drives the REAL route and asserts the FAIL DIRECTION of that one
// check (ruling W1-B/1-5): a toggle-table read that THROWS while messaging is
// live must refuse, not send. That is a property `expect(src).toContain(...)`
// cannot see — the source crawl in roster.test.ts accepts the literal
// `isSystemEnabled(` and `isSystemEnabledForSend(` alike, so it proves a toggle
// is read and never which direction it fails in.
//
// The REAL `isSystemEnabledForSend` runs here (only `serviceClient` is faked),
// because the fail direction lives inside it and a stubbed toggle reader would
// be testing the stub.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

type User = { id: string; email: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  /** Throw from the system_toggle read, as a saturated pooler would. */
  toggleReadThrows: false,
  /** The row system_toggle holds for (vitality, speed-to-lead), or null. */
  toggleRow: null as { enabled: boolean } | null,
  lead: null as Record<string, unknown> | null,
  contacted: [] as string[],
  stages: [] as Array<{ id: string; stage: string }>,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.user,
  requireSiteAccess: () => null,
  requireModuleApiAccess: () => null,
}));

vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => (id === "site-cc" ? { id: "site-cc", clientId: "vitality" } : undefined),
}));

vi.mock("@/lib/speed-to-lead/repository", () => ({
  getLead: async () => store.lead,
  setLeadStage: async (id: string, stage: string) => {
    store.stages.push({ id, stage });
  },
  claimLeadFromStage: async () => true,
}));

vi.mock("@/lib/speed-to-lead/contact", () => ({
  contactLead: async (lead: { id: string }) => {
    store.contacted.push(lead.id);
  },
}));

// The REAL systems repository, with only its database seam faked, so the fail
// direction under test is the shipped one.
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (store.toggleReadThrows) throw new Error("system_toggle read failed");
              return { data: store.toggleRow, error: null };
            },
          }),
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

const ORIGINAL_DRY_RUN = process.env.MESSAGING_DRY_RUN;

function resend(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/speed-to-lead/resend", {
      method: "POST",
      body: JSON.stringify({ leadId: "lead-1" }),
    }),
    { params: Promise.resolve({ action: "resend" }) },
  );
}

beforeEach(() => {
  store.user = {
    id: "u-1",
    email: "reception@vitality.example",
    role: "client_staff",
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
  store.toggleReadThrows = false;
  store.toggleRow = { enabled: true };
  store.lead = { id: "lead-1", siteId: "site-cc", stage: "new" };
  store.contacted = [];
  store.stages = [];
});

afterEach(() => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.MESSAGING_DRY_RUN;
  else process.env.MESSAGING_DRY_RUN = ORIGINAL_DRY_RUN;
});

describe("resend consults the kill switch", () => {
  it("sends when the switch is on", async () => {
    const res = await resend();
    expect(res.status).toBe(200);
    expect(store.contacted).toEqual(["lead-1"]);
  });

  it("refuses when the practice has switched speed-to-lead off", async () => {
    store.toggleRow = { enabled: false };
    const res = await resend();
    expect(res.status).toBe(409);
    expect(store.contacted).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE FAIL DIRECTION (ruling W1-B/1-5). This is the named test the mutation
  // `isSystemEnabledForSend` -> `isSystemEnabled` reddens, and nothing else in
  // the tree does.
  // -------------------------------------------------------------------------
  it("resend-refuses-an-unreadable-switch-once-messaging-is-live", async () => {
    process.env.MESSAGING_DRY_RUN = "false"; // live: the exact string, per charter §0/6
    store.toggleReadThrows = true;
    const res = await resend();
    expect(res.status, "an unreadable switch must not resolve to the default-ON catalog value").toBe(409);
    expect(store.contacted, "no lead may be first-contacted off a switch we could not read").toEqual([]);
  });

  it("still sends on an unreadable switch while messaging is only simulated", async () => {
    // The fail-open half, stated so the fix is understood as a change of DIRECTION
    // and not of behaviour: under dry-run this door behaves exactly as it did.
    process.env.MESSAGING_DRY_RUN = "true";
    store.toggleReadThrows = true;
    const res = await resend();
    expect(res.status).toBe(200);
    expect(store.contacted).toEqual(["lead-1"]);
  });

  // -------------------------------------------------------------------------
  // THE SECOND HALF OF THE SAME FIX: the check used to be skipped entirely when
  // `getSite(lead.siteId)?.clientId` came back undefined, so a lead carrying a
  // site id SITES no longer maps reached the send with NO switch consulted.
  // -------------------------------------------------------------------------
  it("resend-consults-the-switch-for-a-lead-on-an-unmapped-site", async () => {
    store.lead = { id: "lead-1", siteId: "site-gone", stage: "new" };
    store.toggleRow = { enabled: false };
    const res = await resend();
    expect(res.status, "an unrecognised site id must not skip the kill switch").toBe(409);
    expect(store.contacted).toEqual([]);
  });
});

describe("the other actions are gated by the same switch", () => {
  it("mark-booked is refused while the system is off", async () => {
    store.toggleRow = { enabled: false };
    const res = await POST(
      new Request("http://localhost/api/speed-to-lead/mark-booked", {
        method: "POST",
        body: JSON.stringify({ leadId: "lead-1" }),
      }),
      { params: Promise.resolve({ action: "mark-booked" }) },
    );
    expect(res.status).toBe(409);
    expect(store.stages).toEqual([]);
  });
});
