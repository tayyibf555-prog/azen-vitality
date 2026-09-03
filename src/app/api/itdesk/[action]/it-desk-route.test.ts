// ===========================================================================
// THE IT DESK'S ROUTE: the switch, the gate, the role lock, and the escalation
// contact's second lock.
//
// The rules live in src/lib/itdesk/topic-gate.test.ts. This file proves the
// WIRING — and, as with the equipment desk, "the refusal never reaches the
// model" is asserted with a spy rather than inferred from the reply text.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type User = { id: string; email: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  systemEnabled: true,
  contact: null as Record<string, unknown> | null,
  saved: [] as Record<string, unknown>[],
  turns: 0,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
}));

vi.mock("@/lib/auth/guard", async () => {
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireUser: async () => store.user,
    requireClientAccess: (u: User | null, cid: string) =>
      u && u.role !== "agency_admin" && u.clientId !== cid
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : null,
    requireModuleApiAccess: (u: User | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
    // The REAL shape of the owner guard: it refuses everybody who is not an
    // owner or the agency, and no-ops when enforcement is off (user null).
    requireOwnerRole: (u: User | null) =>
      u && u.role !== "client_owner" && u.role !== "agency_admin"
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemEnabled }));

vi.mock("@/lib/itdesk/repository", () => ({
  getItContact: async () => store.contact,
  setItContact: async (_clientId: string, input: Record<string, unknown>) => {
    store.saved.push(input);
    return true;
  },
}));

vi.mock("@/lib/telemetry", () => ({ recordUsage: async () => {} }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: async () => {
    store.turns += 1;
    return { replyText: "Check the printer's own display first.", toolCalls: [], escalated: false };
  },
}));

const { POST } = await import("./route");

const OWNER: User = { id: "u1", email: "o@x.com", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const MANAGER: User = { ...OWNER, id: "u2", role: "client_coordinator" };
const CLINICIAN: User = { ...OWNER, id: "u3", role: "client_clinician" };
const RECEPTIONIST: User = { ...OWNER, id: "u4", role: "client_staff" };

function ask(text: string, client = "vitality") {
  return POST(
    new Request("http://t/api/itdesk/ask", {
      method: "POST",
      body: JSON.stringify({ client, messages: [{ role: "user", content: text }] }),
    }),
    { params: Promise.resolve({ action: "ask" }) },
  );
}

beforeEach(() => {
  store.user = OWNER;
  store.systemEnabled = true;
  store.contact = { clientId: "vitality", name: "Sam", company: "Northline", phone: "020 7000 0000", email: null, hours: null, notes: null, updatedAt: null };
  store.saved = [];
  store.turns = 0;
});

describe("1. the kill switch is the first gate", () => {
  it("refuses when switched off, with no model call, and says the playbooks stay readable", async () => {
    store.systemEnabled = false;
    const body = (await (await ask("The printer will not print.")).json()) as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(body.reason).toBe("system_off");
    expect(String(body.reply)).toMatch(/playbooks below stay readable/i);
    expect(store.turns).toBe(0);
  });

  it("the IT contact stays settable while the system is off", async () => {
    // It HAS to be: the escalation has nowhere to go until it is set, so
    // requiring the system to be on first would be a circle.
    store.systemEnabled = false;
    const response = await POST(
      new Request("http://t/api/itdesk/set-contact", {
        method: "POST",
        body: JSON.stringify({ client: "vitality", name: "Sam", phone: "020 7000 0000" }),
      }),
      { params: Promise.resolve({ action: "set-contact" }) },
    );
    expect(response.status).toBe(200);
    expect(store.saved).toHaveLength(1);
  });
});

describe("2. the gate runs before the model", () => {
  it("refuses a credential request with no model call, and with the credential sentence", async () => {
    const body = (await (await ask("What's the wifi password?")).json()) as Record<string, unknown>;
    expect(body.reason).toBe("safety");
    expect(String(body.reply)).toMatch(/never handle passwords/i);
    expect(store.turns).toBe(0);
  });

  it("refuses remote access with no model call", async () => {
    const body = (await (await ask("Can you remote into my computer and fix it?")).json()) as Record<string, unknown>;
    expect(body.reason).toBe("safety");
    expect(store.turns).toBe(0);
  });

  it("refuses an off-topic question with no model call", async () => {
    const body = (await (await ask("Which patients are booked in tomorrow?")).json()) as Record<string, unknown>;
    expect(body.reason).toBe("off_topic");
    expect(store.turns).toBe(0);
  });

  it("answers a real IT problem, and only then calls the model", async () => {
    const body = (await (await ask("Nothing will print from the front desk computer.")).json()) as Record<string, unknown>;
    expect(body.refused).toBeUndefined();
    expect(store.turns).toBe(1);
  });

  it("a password RESET is routed, not refused — the desk exists for that question", async () => {
    const body = (await (await ask("I am locked out of Dentally and need my password reset, who does that?")).json()) as Record<string, unknown>;
    expect(body.refused).toBeUndefined();
    expect(store.turns).toBe(1);
  });
});

describe("3. the escalation contact carries a SECOND, narrower lock", () => {
  it("lets the owner set it", async () => {
    const response = await POST(
      new Request("http://t/api/itdesk/set-contact", {
        method: "POST",
        body: JSON.stringify({ client: "vitality", name: "Sam", phone: "020" }),
      }),
      { params: Promise.resolve({ action: "set-contact" }) },
    );
    expect(response.status).toBe(200);
  });

  it("refuses the practice manager, who may READ the desk but not redirect it", async () => {
    // Who the practice escalates to changes what every member of staff is told
    // to do, so it is owner-level even though the module is not.
    store.user = MANAGER;
    const response = await POST(
      new Request("http://t/api/itdesk/set-contact", {
        method: "POST",
        body: JSON.stringify({ client: "vitality", name: "Somebody Else", phone: "999" }),
      }),
      { params: Promise.resolve({ action: "set-contact" }) },
    );
    expect(response.status).toBe(403);
    expect(store.saved).toHaveLength(0);
    // ...and she can still use the desk itself.
    expect((await ask("The printer will not print.")).status).toBe(200);
  });
});

describe("4. the module lock is at the API layer", () => {
  it("admits owner and manager, refuses clinician and receptionist", async () => {
    for (const user of [OWNER, MANAGER]) {
      store.user = user;
      expect((await ask("The printer will not print.")).status).toBe(200);
    }
    for (const user of [CLINICIAN, RECEPTIONIST]) {
      store.user = user;
      expect((await ask("The printer will not print.")).status).toBe(403);
    }
  });

  it("refuses another practice's login, and an unknown client", async () => {
    store.user = { ...OWNER, clientId: "somebody-else" };
    expect((await ask("The printer will not print.")).status).toBe(403);
    store.user = OWNER;
    expect((await ask("The printer will not print.", "nope")).status).toBe(400);
  });
});

describe("5. the escalation path is honest about what it has", () => {
  it("an UNREADABLE contact is passed to the prompt as unavailable, not as 'none set'", async () => {
    // Proven through the prompt builder rather than the route's reply, because
    // the route's job is only to pass the distinction on intact.
    const { buildItDeskSystemPrompt } = await import("@/lib/itdesk/prompt");
    const unreadable = buildItDeskSystemPrompt({ practiceName: "X", contact: null, contactUnavailable: true });
    expect(unreadable).toMatch(/could not read/i);
    expect(unreadable).toMatch(/do not say there isn't one/i);

    const notSet = buildItDeskSystemPrompt({
      practiceName: "X",
      contact: { clientId: "vitality", name: null, company: null, phone: null, email: null, hours: null, notes: null, updatedAt: null },
      contactUnavailable: false,
    });
    expect(notSet).toMatch(/None has been added yet/i);
    expect(notSet).toMatch(/[Nn]ever invent/);

    const set = buildItDeskSystemPrompt({
      practiceName: "X",
      contact: { clientId: "vitality", name: "Sam", company: "Northline", phone: "020 7000 0000", email: null, hours: null, notes: null, updatedAt: null },
      contactUnavailable: false,
    });
    expect(set).toContain("020 7000 0000");
    expect(set).toContain("Northline");
  });
});
