// The chart-draft API: the feature gate, auth, site scoping, the cross-site IDOR
// guard, and the two validations that stop an undrawable value being stored.
//
// The mocks reproduce the real predicates rather than rubber-stamping them, so a
// scoping bug fails a test instead of passing one.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] };

const store = vi.hoisted(() => ({
  user: null as User | null,
  /** When set, requireUser returns this Response (the unauthenticated case). */
  authResponse: null as Response | null,
  patient: null as { id: string; siteId: string } | null,
  /** Every stored entry, keyed the way the unique index keys them. */
  rows: [] as Record<string, unknown>[],
  /** When true, every repository call throws (the database-is-down case). */
  repoThrows: false,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  // THE REAL PREDICATES, not stubs. The module gate is what keeps a `client_staff`
  // login out of the patient record, and the clinical-write gate is what keeps a
  // coordinator from authoring one. A mock that returned null unconditionally would
  // let either regress here in silence, which is the opposite of what these tests
  // are for. The tenancy mocks below stay hand-written because they need the store.
  const { canRoleAccessModule } = await import("@/lib/nav");
  const { isClinicalWriteRole } = await import("@/lib/patient/roles");
  const forbidden = () => Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  return {
    requireUser: async () => store.authResponse ?? store.user,
    requireClientAccess: (u: User | null, cid: string) =>
      u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireSiteAccess: (u: User | null, sid: string) =>
      u && !u.siteIds.includes(sid) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireModuleApiAccess: (u: User | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug) ? forbidden() : null,
    requireClinicalWriteRole: (u: User | null) => (u && !isClinicalWriteRole(u.role) ? forbidden() : null),
  };
});
vi.mock("@/lib/dentally/read", () => ({
  getPatientById: async () => store.patient,
}));
vi.mock("@/lib/patient-chart/draft-repository", () => ({
  listDraft: async () => {
    if (store.repoThrows) throw new Error("db down");
    return store.rows;
  },
  upsertDraftEntry: async (scope: Record<string, unknown>, entry: Record<string, unknown>) => {
    if (store.repoThrows) throw new Error("db down");
    store.rows.push({ ...scope, ...entry });
  },
  deleteDraftEntry: async () => {
    if (store.repoThrows) throw new Error("db down");
  },
  clearDraft: async () => {
    if (store.repoThrows) throw new Error("db down");
    store.rows = [];
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


import { GET, POST } from "./route";
import { CHART_COPY } from "@/lib/patient/tabs";

const USER: User = { id: "u1", name: "Dr Sara Malik", role: "client_clinician", clientId: "vitality", siteIds: ["site-cc"] };

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/charting/draft", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
function get(qs: string): Request {
  return new Request(`http://localhost/api/charting/draft?${qs}`);
}
/** The body every valid upsert shares, so a case shows only what it varies. */
const VALID = {
  client: "vitality", siteId: "site-cc", patientId: "pat-1", action: "upsert",
  tooth: 16, surfaces: "MOD", treatmentCode: "111", treatmentName: "Composite Filling",
  dentition: "permanent",
};

beforeEach(() => {
  store.user = USER;
  store.authResponse = null;
  store.patient = { id: "pat-1", siteId: "site-cc" };
  store.rows = [];
  store.repoThrows = false;
  vi.stubEnv("CHART_DRAFT_ENABLED", "true");
});

describe("the feature gate", () => {
  it("answers 503 with the disabled sentence when CHART_DRAFT_ENABLED is unset", async () => {
    // THE SHIPPED STATE. A 500 or a silent success would both be worse: the screen
    // needs a sentence it can print, not an error it has to guess at.
    vi.stubEnv("CHART_DRAFT_ENABLED", "");
    for (const action of ["upsert", "delete", "clear"]) {
      const res = await POST(post({ ...VALID, action }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe(CHART_COPY.draftDisabled);
    }
  });

  it("answers 503 on GET too, rather than an empty draft", async () => {
    vi.stubEnv("CHART_DRAFT_ENABLED", "");
    const res = await GET(get("client=vitality&siteId=site-cc&patientId=pat-1"));
    expect(res.status).toBe(503);
  });

  it("is off for any value other than the exact string true", async () => {
    vi.stubEnv("CHART_DRAFT_ENABLED", "yes");
    const res = await POST(post(VALID));
    expect(res.status).toBe(503);
  });
});

describe("auth and scoping", () => {
  it("refuses an unauthenticated caller", async () => {
    store.authResponse = Response.json({ error: "unauthenticated" }, { status: 401 });
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
  });

  it("refuses an unknown client", async () => {
    const res = await POST(post({ ...VALID, client: "someone-else" }));
    expect(res.status).toBe(404);
  });

  it("refuses a site the user cannot reach", async () => {
    const res = await POST(post({ ...VALID, siteId: "site-rv" }));
    expect(res.status).toBe(403);
  });

  it("answers 404, not 403, for a patient belonging to another site", async () => {
    // A caller holding site A must not be able to reach a site-B patient by pairing
    // site A with a foreign patient id, and must not learn from the status code
    // whether that patient exists at all.
    store.patient = { id: "pat-1", siteId: "site-rv" };
    const res = await POST(post(VALID));
    expect(res.status).toBe(404);
  });

  it("requires siteId and patientId", async () => {
    const res = await POST(post({ ...VALID, patientId: "" }));
    expect(res.status).toBe(400);
  });
});

describe("validation", () => {
  it("refuses a tooth that is not in the selected arch", async () => {
    // 19 is not an FDI number and 55 is deciduous, not permanent. Storing either
    // would put a value in the table that no renderer can draw.
    for (const tooth of [19, 99, 0, 55]) {
      const res = await POST(post({ ...VALID, tooth }));
      expect(res.status).toBe(400);
    }
    expect(store.rows).toHaveLength(0);
  });

  it("accepts a deciduous tooth when the dentition says deciduous", async () => {
    const res = await POST(post({ ...VALID, tooth: 55, dentition: "deciduous" }));
    expect(res.status).toBe(200);
  });

  it("refuses an unrecognised surface letter rather than storing it", async () => {
    const res = await POST(post({ ...VALID, surfaces: "MODX" }));
    expect(res.status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it("requires a treatment code", async () => {
    const res = await POST(post({ ...VALID, treatmentCode: "" }));
    expect(res.status).toBe(400);
  });

  it("refuses an unknown action", async () => {
    const res = await POST(post({ ...VALID, action: "obliterate" }));
    expect(res.status).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/charting/draft", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("failures are stated, never rendered as an empty draft", () => {
  it("returns ok:false when the repository throws on read", async () => {
    store.repoThrows = true;
    const res = await GET(get("client=vitality&siteId=site-cc&patientId=pat-1"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.draft).toBeUndefined(); // never [] — that would read as "nothing planned"
  });

  it("returns ok:false when the repository throws on save", async () => {
    store.repoThrows = true;
    const res = await POST(post(VALID));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("the happy path", () => {
  it("stores an upsert and answers with the whole draft", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.draft).toHaveLength(1);
  });

  it("clears the draft", async () => {
    await POST(post(VALID));
    const res = await POST(post({ ...VALID, action: "clear" }));
    expect((await res.json()).draft).toEqual([]);
  });
});

// ===========================================================================
// THE CLINICAL-WRITE TIGHTENING, campaign 6.
//
// Charting a tooth is a clinical act: it becomes part of the patient's record and
// is attributed to whoever made it. Before this change every role attached to the
// practice could POST here, including a coordinator (which is what the fixture user
// in this file used to be). The READ is deliberately untouched — the practice
// manager books around the plan and answers the phone about it.
//
// And one layer out: a `client_staff` login reaches neither, because "patients" is
// not in STAFF_SLUGS.
// ===========================================================================
describe("who may write the chart draft, and who may only read it", () => {
  const coordinator: User = {
    id: "u2", name: "Blerta", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"],
  };
  const staff: User = {
    id: "u3", name: "Nadia", role: "client_staff", clientId: "vitality", siteIds: ["site-cc"],
  };

  it("the coordinator may still READ a draft", async () => {
    store.user = coordinator;
    const res = await GET(get("client=vitality&siteId=site-cc&patientId=pat-1"));
    expect(res.status).toBe(200);
  });

  it("but may no longer WRITE one, and nothing is stored", async () => {
    store.user = coordinator;
    const res = await POST(post(VALID));
    expect(res.status).toBe(403);
    expect(store.rows).toEqual([]);
  });

  it("the clinician may do both", async () => {
    store.user = USER;
    expect((await GET(get("client=vitality&siteId=site-cc&patientId=pat-1"))).status).toBe(200);
    expect((await POST(post(VALID))).status).toBe(200);
    expect(store.rows).toHaveLength(1);
  });

  it("the staff role reaches NEITHER: the module gate refuses it first", async () => {
    store.user = staff;
    expect((await GET(get("client=vitality&siteId=site-cc&patientId=pat-1"))).status).toBe(403);
    expect((await POST(post(VALID))).status).toBe(403);
    expect(store.rows).toEqual([]);
  });
});
