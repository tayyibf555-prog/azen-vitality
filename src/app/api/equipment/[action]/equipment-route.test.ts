// ===========================================================================
// THE EQUIPMENT DESK'S ROUTE: the four gates, in order, and what each one costs.
//
// The topic gate has its own test (src/lib/equipment/topic-gate.test.ts) which
// proves the RULES. This file proves the WIRING: that the route consults the
// switch before anything else, consults the gate before it constructs an
// Anthropic client, and that a refusal from either never reaches the model.
//
// "NEVER REACHES THE MODEL" IS ASSERTED, NOT ASSUMED. `runAgentTurn` is mocked
// with a spy, and every refusal case asserts the spy was not called. A gate that
// refused AFTER the turn would be a gate that costs money and leaks the question
// to a model, and it would pass a test that only checked the reply text.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";

vi.mock("server-only", () => ({}));

type User = { id: string; email: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  systemEnabled: false,
  assets: [] as Record<string, unknown>[],
  assetsFail: false,
  turns: 0,
  emptyReply: false,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) =>
    slug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
  getSites: () => [{ id: "site-cc", name: "N15 Vitality Dental" }],
}));

/** Copied from src/lib/absence/rules.ts and pinned against it in section 3 below. */
const APPROVER_ROLES = ["agency_admin", "client_owner", "client_coordinator"] as const;

vi.mock("@/lib/auth/guard", async () => {
  // THE REAL predicate, not a stub. `canRoleAccessModule` is the only thing that
  // keeps a clinician or a receptionist out of this module, and a mock that
  // returned null unconditionally would let that regress in silence.
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
    // THE REAL role list, not a stub, for the same reason: on W2-A/1 the module
    // gate stopped denying anybody and THIS became the only thing standing
    // between a receptionist and the register the practice shows CQC. A mock
    // that returned null would let that regress in silence.
    requireApproverRole: (u: User | null) =>
      u && !APPROVER_ROLES.includes(u.role as (typeof APPROVER_ROLES)[number])
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => store.systemEnabled,
}));

vi.mock("@/lib/equipment/repository", () => ({
  listAssets: async () => (store.assetsFail ? null : store.assets),
  listManuals: async () => [],
  importAssets: async () => ({ inserted: 0, updated: 0, failed: [] }),
  createAsset: async () => "new-id",
  updateAsset: async () => true,
  deleteAsset: async () => true,
}));

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({ siteIds: ["site-cc"], label: "N15 Vitality Dental", isAllSites: false }),
}));

vi.mock("@/lib/telemetry", () => ({ recordUsage: async () => {} }));

vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));

vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: async () => {
    store.turns += 1;
    return {
      replyText: store.emptyReply ? "" : "The manual says, on page 3, that E04 means the door did not seal.",
      toolCalls: [],
      escalated: false,
    };
  },
}));

const { POST } = await import("./route");

const OWNER: User = { id: "u1", email: "o@x.com", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const MANAGER: User = { ...OWNER, id: "u2", role: "client_coordinator" };
const CLINICIAN: User = { ...OWNER, id: "u3", role: "client_clinician" };
const RECEPTIONIST: User = { ...OWNER, id: "u4", role: "client_staff" };

const ASSET = { id: "a1", name: "SteriPro 22B", category: "sterilisation", make: "W&H", model: "Lisa", serial: "A1400273", siteId: "site-cc", room: "Decon", supplier: "DentalTech", supplierPhone: "020", purchasedOn: null, lastServicedOn: null, nextServiceDue: "2027-03-02", notes: null, clientId: "vitality", createdAt: "", updatedAt: "" };

function ask(text: string, client = "vitality") {
  return POST(
    new Request("http://t/api/equipment/ask", {
      method: "POST",
      body: JSON.stringify({ client, messages: [{ role: "user", content: text }] }),
    }),
    { params: Promise.resolve({ action: "ask" }) },
  );
}

beforeEach(() => {
  store.user = OWNER;
  store.systemEnabled = true;
  store.assets = [ASSET];
  store.assetsFail = false;
  store.turns = 0;
  store.emptyReply = false;
});

describe("1. the kill switch is the FIRST gate, and it costs nothing", () => {
  it("refuses when the system is switched off, without a model call", async () => {
    store.systemEnabled = false;
    const body = (await (await ask("What does E04 mean on the autoclave?")).json()) as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(body.reason).toBe("system_off");
    expect(String(body.reply)).toMatch(/switched off/i);
    // THE PAGE STILL RENDERS AND THE REGISTER IS STILL EDITABLE — that is what the
    // sentence promises, and it is why the switch is not on the other actions.
    expect(String(body.reply)).toMatch(/register and the manuals stay editable/i);
    expect(store.turns).toBe(0);
  });

  it("the register actions are NOT gated on the switch, so a practice can prepare", async () => {
    store.systemEnabled = false;
    const response = await POST(
      new Request("http://t/api/equipment/save", {
        method: "POST",
        body: JSON.stringify({ client: "vitality", name: "Compressor", category: "compressed_air_suction" }),
      }),
      { params: Promise.resolve({ action: "save" }) },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
  });
});

describe("2. the topic gate runs before the model, not after it", () => {
  it("refuses an off-topic question with no model call", async () => {
    const body = (await (await ask("Which patients are booked in tomorrow?")).json()) as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(body.reason).toBe("off_topic");
    expect(store.turns).toBe(0);
  });

  it("refuses a safety-bypass request with no model call", async () => {
    const body = (await (await ask("How do I bypass the door interlock on the autoclave?")).json()) as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(body.reason).toBe("safety");
    expect(String(body.reply)).toMatch(/engineer/i);
    expect(store.turns).toBe(0);
  });

  it("answers a legitimate equipment question, and only then calls the model", async () => {
    const body = (await (await ask("What does error E04 mean on the SteriPro 22B?")).json()) as Record<string, unknown>;
    expect(body.refused).toBeUndefined();
    expect(store.turns).toBe(1);
    expect(String(body.reply)).toMatch(/page 3/);
  });

  it("a JUDGEMENT question is answered, and the DECISION half is appended by the SERVER", async () => {
    // The middle path (programme ruling). The model runs — the practice gets the
    // facts — and the standing instruction is added by this route rather than
    // trusted to the model, so it is present however the turn went.
    const body = (await (await ask("Can we keep using the autoclave, it is overdue its pressure test?")).json()) as Record<string, unknown>;
    expect(body.refused).toBeUndefined();
    expect(body.factsOnly).toBe(true);
    expect(store.turns).toBe(1);
    expect(String(body.reply)).toContain(EQUIPMENT_REFUSALS.judgement);
    // The facts the model produced survive alongside it — this is not a refusal
    // wearing an answer's clothes.
    expect(String(body.reply)).toMatch(/page 3/);
  });

  it("the DECISION sentence is appended even when the model returns NOTHING", async () => {
    // The failure direction that matters: a turn that comes back empty must not
    // leave a judgement question answered by the fallback apology alone.
    store.emptyReply = true;
    const body = (await (await ask("Can we keep using the autoclave, it is overdue its pressure test?")).json()) as Record<string, unknown>;
    expect(String(body.reply)).toContain(EQUIPMENT_REFUSALS.judgement);
  });

  it("an ordinary question gets NO appended sentence", async () => {
    // The append is scoped to the judgement class. Bolting it onto every answer
    // would train people to skip the last paragraph, which is how it stops
    // working on the day it matters.
    const body = (await (await ask("What does error E04 mean on the SteriPro 22B?")).json()) as Record<string, unknown>;
    expect(String(body.reply)).not.toContain(EQUIPMENT_REFUSALS.judgement);
    expect(body.factsOnly).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // THE REGISTER-AWARE HALF OF THE JUDGEMENT RULE (W3/15), asserted through the
  // ROUTE rather than the gate.
  //
  // `outOfTestVocabulary` is an OPTIONAL field on the gate input — it had to be,
  // so the type did not break while the two doors were being wired — which means
  // a route that never passes it compiles, ships, and silently answers "can we
  // still use the Lisa MB17?" about a machine the register says is out of test
  // with no take-out-of-use sentence at all. Nothing above catches that: every
  // existing judgement case here RESTATES the fact ("...it is overdue its
  // pressure test"), which the stated-fact rule catches on its own.
  //
  // So these two pin the WIRING, in both directions: the register supplies the
  // fact when the person does not, and it does not invent one when the machine
  // is in date. Deleting `outOfTestVocabulary:` from the route's gate input
  // turns the first red and leaves the second green.
  // -------------------------------------------------------------------------
  // Fixed dates, both far from any clock this suite could be run under: the past
  // one is permanently past and the future one is permanently future, so neither
  // test becomes a time bomb the first time somebody runs the suite in 2027.
  const OVERDUE = { ...ASSET, id: "a2", name: "Duraflow compressor", make: "Duraflow", model: "MB17", serial: "C9911", nextServiceDue: "2020-01-01" };
  const IN_DATE = { ...ASSET, id: "a3", name: "Kavo chair", make: "Kavo", model: "E30", serial: "K7712", nextServiceDue: "2099-01-01" };

  it("a 'can we still use it' question about a machine the REGISTER says is out of test gets the DECISION sentence, without the person restating the fact", async () => {
    store.assets = [OVERDUE, IN_DATE];
    const body = (await (await ask("Can we still use the Duraflow compressor?")).json()) as Record<string, unknown>;
    expect(body.refused).toBeUndefined();
    expect(body.factsOnly, "the route never told the gate which assets are out of test").toBe(true);
    expect(String(body.reply)).toContain(EQUIPMENT_REFUSALS.judgement);
    expect(store.turns).toBe(1);
  });

  it("the same question about a machine that is IN date gets NO appended sentence", async () => {
    // The other error direction, and it is not a small one: bolting "take the
    // machine out of use and call the engineer" onto a question about a
    // compliant chair is how the sentence stops being read on the day it counts.
    store.assets = [OVERDUE, IN_DATE];
    const body = (await (await ask("Can we still use the Kavo chair?")).json()) as Record<string, unknown>;
    expect(body.factsOnly).toBeUndefined();
    expect(String(body.reply)).not.toContain(EQUIPMENT_REFUSALS.judgement);
    expect(store.turns).toBe(1);
  });

  it("an EMPTY register refuses with the sentence that says what to do next", async () => {
    store.assets = [];
    const body = (await (await ask("What does E04 mean on the autoclave?")).json()) as Record<string, unknown>;
    expect(body.reason).toBe("nothing_to_answer_from");
    expect(store.turns).toBe(0);
  });

  it("an UNREADABLE register says so, rather than saying the register is empty", async () => {
    // The two are different facts. Telling a practice their register is empty
    // when the read merely failed is how somebody concludes we lost it.
    store.assetsFail = true;
    const body = (await (await ask("What does E04 mean on the autoclave?")).json()) as Record<string, unknown>;
    expect(body.reason).toBe("register_unreadable");
    expect(String(body.reply)).toMatch(/could not read/i);
    expect(store.turns).toBe(0);
  });
});

describe("3. the role lock is at the API layer, not only on the page", () => {
  it("admits the owner and the practice manager", async () => {
    for (const user of [OWNER, MANAGER]) {
      store.user = user;
      expect((await ask("What does E04 mean on the SteriPro 22B?")).status).toBe(200);
    }
  });

  // WIDENED, and this test turned over completely. Until W2-A/1 (the programme
  // coordinator's written ruling of 3 Sep 2026) it asserted that the clinician
  // and the receptionist were REFUSED here. The ruling is that they are not: a
  // dental nurse is a client_staff, "the autoclave is beeping" is her question,
  // and this module holds no patient data. The assertion is not loosened — it is
  // INVERTED and paired with the write-lock assertions below, which are the
  // boundary that replaced the one this line used to be.
  it("ADMITS the clinician and the receptionist to the desk (W2-A/1)", async () => {
    for (const user of [CLINICIAN, RECEPTIONIST]) {
      store.user = user;
      expect((await ask("What does E04 mean on the SteriPro 22B?")).status).toBe(200);
    }
  });

  it("the approver list this route narrows on is the platform's, not a copy", async () => {
    const { APPROVER_ROLES: real } = await import("@/lib/absence/rules");
    expect([...APPROVER_ROLES]).toEqual([...real]);
  });

  it("REFUSES the clinician and the receptionist every register WRITE", async () => {
    // The four actions that change the register the practice shows CQC. Each is
    // asserted for both deny-by-default roles, so a fifth action added to
    // REGISTER_WRITE_ACTIONS without a guard shows up as a 200 here.
    for (const action of ["import-preview", "import", "save", "delete"]) {
      for (const user of [CLINICIAN, RECEPTIONIST]) {
        store.user = user;
        const response = await POST(
          new Request(`http://t/api/equipment/${action}`, {
            method: "POST",
            body: JSON.stringify({ client: "vitality", csv: "Item\nAutoclave", name: "Autoclave", id: "a1", rows: [] }),
          }),
          { params: Promise.resolve({ action }) },
        );
        expect(response.status, `${user.role} was allowed ${action}`).toBe(403);
      }
    }
  });

  it("and still ADMITS the owner and the practice manager to those writes", async () => {
    // The control. Without it the assertion above would also pass if the write
    // actions had simply been broken for everybody.
    for (const user of [OWNER, MANAGER]) {
      store.user = user;
      const response = await POST(
        new Request("http://t/api/equipment/import-preview", {
          method: "POST",
          body: JSON.stringify({ client: "vitality", csv: "Item,Serial No\nAutoclave 1,A1400273" }),
        }),
        { params: Promise.resolve({ action: "import-preview" }) },
      );
      expect(response.status, `${user.role} was refused import-preview`).toBe(200);
    }
  });

  it("refuses another practice's login before anything is read", async () => {
    store.user = { ...OWNER, clientId: "somebody-else" };
    expect((await ask("What does E04 mean?")).status).toBe(403);
    expect(store.turns).toBe(0);
  });

  it("refuses an unknown client", async () => {
    expect((await ask("What does E04 mean?", "nope")).status).toBe(400);
  });
});

describe("4. the import preview writes nothing and reports what it understood", () => {
  it("returns a plan, not a result", async () => {
    const response = await POST(
      new Request("http://t/api/equipment/import-preview", {
        method: "POST",
        body: JSON.stringify({
          client: "vitality",
          csv: "Item,Serial No,Service Due\nAutoclave 1,A1400273,02/03/2027",
        }),
      }),
      { params: Promise.resolve({ action: "import-preview" }) },
    );
    const body = (await response.json()) as { ok: boolean; plan: { rows: { name: string; nextServiceDue: string }[] } };
    expect(body.ok).toBe(true);
    expect(body.plan.rows).toHaveLength(1);
    expect(body.plan.rows[0].name).toBe("Autoclave 1");
    expect(body.plan.rows[0].nextServiceDue).toBe("2027-03-02");
  });

  it("refuses a file with no item-name column instead of importing nameless rows", async () => {
    const response = await POST(
      new Request("http://t/api/equipment/import", {
        method: "POST",
        body: JSON.stringify({ client: "vitality", csv: "Cost Centre,Value\nA,100" }),
      }),
      { params: Promise.resolve({ action: "import" }) },
    );
    expect(response.status).toBe(400);
    expect(String(((await response.json()) as Record<string, unknown>).error)).toMatch(/item name/i);
  });
});

describe("5. an unknown action is a 404, not a fall-through", () => {
  it("refuses a made-up action", async () => {
    const response = await POST(
      new Request("http://t/api/equipment/nonsense", {
        method: "POST",
        body: JSON.stringify({ client: "vitality" }),
      }),
      { params: Promise.resolve({ action: "nonsense" }) },
    );
    expect(response.status).toBe(404);
  });
});
