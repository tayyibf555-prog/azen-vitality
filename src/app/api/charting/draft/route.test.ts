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
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.authResponse ?? store.user,
  requireClientAccess: (u: User | null, cid: string) =>
    u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
  requireSiteAccess: (u: User | null, sid: string) =>
    u && !u.siteIds.includes(sid) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
}));
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

import { GET, POST } from "./route";
import { CHART_COPY } from "@/lib/patient/tabs";

const USER: User = { id: "u1", name: "Blerta", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };

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
