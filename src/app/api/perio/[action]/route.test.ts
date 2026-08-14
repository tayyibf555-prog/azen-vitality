// The perio API: the gate, the attribution rule, the site scope, and the seam
// where an untrusted body meets the tested clinical modules.
//
// Auth, clients, the Dentally patient read and the repository's database calls
// are mocked. TWO THINGS ARE NOT. The GATE reads the real environment, because
// "the feature is off by default" is the most important claim in this build and
// a mocked gate would let it pass while being false. And bpe.ts / pocket-chart.ts
// run for real, because the point of these tests is that the route DEFERS to
// them rather than re-deciding what a BPE code or a valid tooth is.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] } | null;

const store = vi.hoisted(() => ({
  user: null as unknown,
  requireUserResponse: null as Response | null,
  patientSiteId: "site-cc" as string | null,
  saved: [] as { scope: unknown; input: unknown }[],
  retracted: [] as { scope: unknown; id: string; reason: string; by: unknown }[],
  reads: [] as { fn: string; scope: unknown; arg?: unknown }[],
  throwOnWrite: null as unknown,
  throwOnRead: null as unknown,
  chart: null as unknown,
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
    requireUser: async () => store.requireUserResponse ?? store.user,
    requireClientAccess: (user: User, clientId: string) =>
      user && user.clientId !== clientId ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireSiteAccess: (user: User, siteId: string) =>
      user && !user.siteIds.includes(siteId) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
    requireModuleApiAccess: (user: User, slug: string) =>
      user && !canRoleAccessModule(user.role as Parameters<typeof canRoleAccessModule>[0], slug) ? forbidden() : null,
    requireClinicalWriteRole: (user: User) => (user && !isClinicalWriteRole(user.role) ? forbidden() : null),
  };
});

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/dentally/read", () => ({
  getPatientById: async (id: string) => (store.patientSiteId ? { id, siteId: store.patientSiteId } : null),
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


// PARTIAL mock: the real error classes are kept (the route does `instanceof` on
// them), only the database calls are stubbed.
vi.mock("@/lib/perio/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/perio/repository")>();
  const write = (name: string) => async (scope: unknown, input: unknown) => {
    if (store.throwOnWrite) throw store.throwOnWrite;
    store.saved.push({ scope, input });
    return { id: `${name}-1`, ...(input as object) };
  };
  const read = (fn: string, value: unknown) => async (scope: unknown, arg?: unknown) => {
    if (store.throwOnRead) throw store.throwOnRead;
    store.reads.push({ fn, scope, arg });
    return value;
  };
  const retract = (name: string) => async (scope: unknown, id: string, reason: string, by: unknown) => {
    if (store.throwOnWrite) throw store.throwOnWrite;
    store.retracted.push({ scope, id, reason, by });
    return { id, kind: name };
  };
  return {
    ...actual,
    saveBpeExam: write("exam"),
    savePerioChart: write("chart"),
    listBpeExams: read("listBpeExams", []),
    latestBpeExam: read("latestBpeExam", null),
    listPerioChartHeaders: read("listPerioChartHeaders", []),
    getPerioChart: async (scope: unknown, id: unknown) => {
      if (store.throwOnRead) throw store.throwOnRead;
      store.reads.push({ fn: "getPerioChart", scope, arg: id });
      return store.chart;
    },
    latestPerioCharts: read("latestPerioCharts", []),
    retractBpeExam: retract("bpe"),
    retractPerioChart: retract("chart"),
  };
});

import { GET, POST } from "./route";
import { PerioRefusedError } from "@/lib/perio/repository";
import { PERIO_COPY } from "@/lib/perio/gate";
import { BPE_TEETH, DEFAULT_PROBE, SEXTANT_TEETH } from "@/lib/perio/bpe";
import {
  bpeEntryReducer,
  initBpeEntry,
  saveRefusal,
  toSavePayload,
  type BpeEntryState,
} from "@/lib/perio/bpe-entry-state";

const SCOPE = { client: "vitality", siteId: "site-cc", patientId: "p1" };

function get(action: string, params: Record<string, string> = SCOPE): Promise<Response> {
  const url = new URL(`http://localhost/api/perio/${action}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET(new Request(url), { params: Promise.resolve({ action }) });
}

function post(action: string, payload: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/perio/${action}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ action }) },
  );
}

/** A complete BPE grid: every one of the six sextants addressed. */
function bpeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...SCOPE,
    scores: { UR: 2, UA: 1, UL: "3*", LR: 4, LA: 0, LL: null },
    statuses: { LL: "insufficient-teeth" },
    ...overrides,
  };
}

function sixSites(): Record<string, unknown>[] {
  return ["mb", "b", "db", "ml", "l", "dl"].map((site) => ({
    site,
    probingDepth: 3,
    recession: 1,
    bleeding: false,
  }));
}

/** A sextant-scoped chart: one molar in the upper right, fully sited. */
function chartBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...SCOPE,
    sextants: ["UR"],
    trigger: "bpe-3",
    teeth: [{ tooth: 16, mobility: 1, furcation: 2, sites: sixSites() }],
    ...overrides,
  };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
async function errorOf(res: Response): Promise<string> {
  const payload = await body(res);
  return [String(payload.error ?? ""), ...((payload.issues as string[]) ?? [])].join(" | ");
}

beforeEach(() => {
  store.user = { id: "u1", name: "Dr Sara Malik", role: "client_clinician", clientId: "vitality", siteIds: ["site-cc"] };
  store.requireUserResponse = null;
  store.patientSiteId = "site-cc";
  store.saved = [];
  store.retracted = [];
  store.reads = [];
  store.throwOnWrite = null;
  store.throwOnRead = null;
  store.chart = null;
  vi.stubEnv("PERIO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("with perio switched off", () => {
  beforeEach(() => vi.stubEnv("PERIO_ENABLED", "false"));

  /**
   * The three wrong answers, all of which this build exists to avoid: a 404 says
   * the feature does not exist, a 500 says something broke, and an empty 200 says
   * this patient has no periodontal findings -- which a clinician reads as a
   * healthy BPE 0.
   */
  it("answers every read with 503 and an explanation naming the variable", async () => {
    for (const action of ["bpe", "charts", "chart", "comparison"]) {
      const res = await get(action, { ...SCOPE, id: "c1" });
      expect(res.status, action).toBe(503);
      const payload = await body(res);
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain("PERIO_ENABLED");
      expect(String(payload.error)).toContain("Dentally");
      expect(payload.exams).toBeUndefined();
      expect(payload.charts).toBeUndefined();
    }
  });

  it("answers every write with 503 and stores nothing", async () => {
    expect((await post("bpe", bpeBody())).status).toBe(503);
    expect((await post("chart", chartBody())).status).toBe(503);
    expect((await post("retract", { ...SCOPE, kind: "bpe", id: "e1", reason: "wrong patient" })).status).toBe(503);
    expect(store.saved).toEqual([]);
    expect(store.retracted).toEqual([]);
  });

  it("is off for anything other than the exact string true", async () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      vi.stubEnv("PERIO_ENABLED", value);
      expect((await get("bpe")).status, value).toBe(503);
    }
  });

  /** The flag's state is not something an unauthenticated prober may learn. */
  it("still answers an unauthorised caller with 401 or 403, not 503", async () => {
    store.requireUserResponse = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await get("bpe")).status).toBe(401);
    store.requireUserResponse = null;
    store.user = { id: "u2", name: "Other", role: "client_owner", clientId: "other", siteIds: ["site-x"] };
    expect((await get("bpe")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Authorisation and site scope
// ---------------------------------------------------------------------------

describe("authorisation", () => {
  it("requires a known client", async () => {
    expect((await get("bpe", { ...SCOPE, client: "nope" })).status).toBe(404);
  });

  it("requires a site and a patient", async () => {
    expect((await get("bpe", { client: "vitality", siteId: "", patientId: "" })).status).toBe(400);
  });

  it("refuses a site the signed-in user does not hold", async () => {
    expect((await get("bpe", { ...SCOPE, siteId: "site-rv" })).status).toBe(403);
  });

  /**
   * The IDOR class getPatientDetail already shipped once: pairing a site the
   * caller holds with a patient id from another site. Answered with the same 404
   * as a missing patient, so a probe learns nothing from the difference.
   */
  it("refuses a patient who belongs to another site, with a plain 404", async () => {
    store.patientSiteId = "site-rv";
    expect((await get("bpe")).status).toBe(404);
    expect((await post("bpe", bpeBody())).status).toBe(404);
    expect(store.saved).toEqual([]);
  });

  it("scopes every read and write by site AND patient", async () => {
    await get("bpe");
    expect(store.reads[0].scope).toEqual({ siteId: "site-cc", patientId: "p1" });
    await post("bpe", bpeBody());
    expect(store.saved[0].scope).toEqual({ siteId: "site-cc", patientId: "p1" });
  });

  it("does not accept a rogue action as a route", async () => {
    expect((await get("everything")).status).toBe(404);
    expect((await post("delete", SCOPE)).status).toBe(404);
  });

  it("keeps the read-only actions read-only and the write actions write-only", async () => {
    expect((await get("retract")).status).toBe(404);
    expect((await post("comparison", SCOPE)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Attribution -- GDC 4.1.4
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("records which clinician wrote the entry, and when", async () => {
    await post("bpe", bpeBody());
    const input = store.saved[0].input as { recorded: { clinician: unknown; at: string } };
    expect(input.recorded.clinician).toEqual({ id: "u1", name: "Dr Sara Malik", gdcNumber: null });
    expect(Date.parse(input.recorded.at)).not.toBeNaN();
  });

  /**
   * With auth enforcement off there is no identified clinician, and GDC 4.1.4
   * puts the treating clinician on the record. Writing 'Team' onto a periodontal
   * finding would fill the column and fail the standard, so the write is refused
   * and says why. Reads are untouched -- nobody is harmed by reading.
   */
  it("refuses to write at all when it cannot name the clinician", async () => {
    store.user = null;
    const res = await post("bpe", bpeBody());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatch(/clinician/i);
    expect(store.saved).toEqual([]);
    expect((await get("bpe")).status).toBe(200);
  });

  it("refuses an examination dated in the future", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await post("bpe", bpeBody({ recordedAt: tomorrow }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// BPE -- the grid path
// ---------------------------------------------------------------------------

describe("recording a BPE from the six-box grid", () => {
  it("stores a complete exam and echoes the FP17 double-entry notice", async () => {
    const res = await post("bpe", bpeBody());
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.ok).toBe(true);
    expect(String(payload.notice)).toContain("FP17");
    const input = store.saved[0].input as {
      scores: Record<string, unknown>;
      statuses: Record<string, string>;
    };
    // Parsed by bpe.ts, so "3*" is a code with a furcation and not a string.
    expect(input.scores.UL).toEqual({ code: 3, furcation: true });
    expect(input.scores.LA).toEqual({ code: 0, furcation: false });
    expect(input.scores.LL).toBeNull();
    expect(input.statuses.LL).toBe("insufficient-teeth");
    expect(input.statuses.UR).toBe("scorable");
  });

  it("refuses a code outside 0 to 4, whatever form it arrives in", async () => {
    for (const bad of [5, -1, 3.5, "7", "3**", "three"]) {
      const res = await post("bpe", bpeBody({ scores: { ...(bpeBody().scores as object), UR: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect(await errorOf(res)).toMatch(/upper right/i);
    }
    expect(store.saved).toEqual([]);
  });

  /**
   * An unscored sextant defaulted to 0 is a healthy reading nobody took, and
   * defaulted to unscorable is a claim about the patient's dentition nobody
   * made. So it has to say which, in the clinical vocabulary.
   */
  it("refuses an unscored sextant that does not say why", async () => {
    const res = await post("bpe", bpeBody({ statuses: {} }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/never read as a 0/i);
    expect(store.saved).toEqual([]);
  });

  it("refuses a missing sextant, because a BPE records all six", async () => {
    const scores = { ...(bpeBody().scores as Record<string, unknown>) };
    delete scores.LR;
    const res = await post("bpe", bpeBody({ scores }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/lower right/i);
  });

  it("refuses a sextant that is both scored and unscorable", async () => {
    const res = await post("bpe", bpeBody({ statuses: { LL: "insufficient-teeth", UR: "no-teeth" } }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/cannot also be/i);
  });

  it("refuses a caller-supplied version, because versions are the record's own", async () => {
    expect((await post("bpe", bpeBody({ version: 9 }))).status).toBe(400);
  });

  it("refuses a probe it does not know, and an unnamed other", async () => {
    expect((await post("bpe", bpeBody({ probe: "a ruler" }))).status).toBe(400);
    expect((await post("bpe", bpeBody({ probe: "other" }))).status).toBe(400);
    expect((await post("bpe", bpeBody({ probe: "other", probeNote: "UNC-15" }))).status).toBe(200);
  });

  /** GDC 4.1.5: an amendment is clearly marked and dated. A mark with no reason
   *  is not a mark, so an unexplained amendment is refused. */
  it("refuses an amendment with no reason, and keeps the pair together", async () => {
    expect((await post("bpe", bpeBody({ supersedesId: "e1" }))).status).toBe(400);
    expect((await post("bpe", bpeBody({ amendmentReason: "typo" }))).status).toBe(400);
    const res = await post("bpe", bpeBody({ supersedesId: "e1", amendmentReason: "wrong sextant" }));
    expect(res.status).toBe(200);
    expect(store.saved[0].input).toMatchObject({ supersedesId: "e1", amendmentReason: "wrong sextant" });
  });

  /**
   * DENTALLY'S 24-HOUR CORRECTION, THROUGH THIS ROUTE — and the reason it can
   * never become an overwrite.
   *
   * Dentally lets a saved exam be edited for 24 hours. We show the clinician
   * that affordance and store the result as an APPEND, because GDC 4.1.5 wants
   * an amendment marked and dated and an overwritten reading is an amendment
   * nobody can see. So the assertions are: it is a WRITE, not an update; the
   * amendment carries its OWN author and instant rather than inheriting the
   * original's; and neither of the two fields that would let a caller land on
   * top of an existing row — the version and the id — survives the route.
   */
  it("records a chart correction as a NEW record that names the one it replaces", async () => {
    const res = await post(
      "chart",
      chartBody({ supersedesId: "c-original", amendmentReason: "depth mis-keyed at 16 mesiobuccal" }),
    );
    expect(res.status).toBe(200);
    expect(store.saved.length).toBe(1);
    const input = store.saved[0].input as {
      supersedesId: string;
      amendmentReason: string;
      recorded: { clinician: { id: string; name: string }; at: string };
    };
    expect(input.supersedesId).toBe("c-original");
    expect(input.amendmentReason).toBe("depth mis-keyed at 16 mesiobuccal");
    // The amender's own name and their own instant. An amendment attributed to
    // the original's author is a record of a correction nobody made.
    expect(input.recorded.clinician).toMatchObject({ id: "u1", name: "Dr Sara Malik" });
    expect(Date.parse(input.recorded.at)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("refuses a chart amendment with no reason, and stores nothing", async () => {
    for (const reason of [undefined, "", "   "]) {
      store.saved = [];
      const res = await post("chart", chartBody({ supersedesId: "c-original", amendmentReason: reason }));
      expect(res.status, JSON.stringify(reason)).toBeGreaterThanOrEqual(400);
      expect(store.saved, JSON.stringify(reason)).toEqual([]);
    }
  });

  it("lets no caller choose the version or carry an id onto an existing row", async () => {
    // The version is assigned by the database on insert. A caller who could set
    // it could write version 3 twice, and the second one would be the amendment
    // that never happened.
    const versioned = await post("chart", chartBody({ version: 1 }));
    expect(versioned.status).toBe(400);
    expect(await errorOf(versioned)).toMatch(/version/i);
    expect(store.saved).toEqual([]);

    await post("chart", chartBody({ id: "c-original" }));
    const input = store.saved[0]?.input as Record<string, unknown> | undefined;
    expect(input && "id" in input).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// BPE -- the reading path, where the clinical refusals live
// ---------------------------------------------------------------------------

describe("recording a BPE from individual readings", () => {
  const readings = {
    ...SCOPE,
    context: { presentTeeth: [17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27] },
    observations: [
      { tooth: 16, code: 3, furcation: true },
      { tooth: 17, code: 2 },
      { tooth: 11, code: 1 },
      { tooth: 26, code: 4 },
    ],
  };

  it("rolls each sextant up to its highest code and returns what charting is now due", async () => {
    const res = await post("bpe", readings);
    expect(res.status).toBe(200);
    const input = store.saved[0].input as { scores: Record<string, unknown> };
    // Highest code in the upper right, with the star carried across.
    expect(input.scores.UR).toEqual({ code: 3, furcation: true });
    const payload = await body(res);
    // A 4 anywhere means a full-mouth chart from the outset, and the exam is
    // useless if the screen stores the score and loses the instruction.
    expect(payload.requirement).toMatchObject({ kind: "full-mouth-6-point" });
  });

  /** BPE is NEVER used around implants. bpe.ts grades that a refusal, and a
   *  refusal that still writes the row is decorative. */
  it("refuses the write when a reading was taken around an implant", async () => {
    const res = await post("bpe", {
      ...readings,
      context: { ...readings.context, implantTeeth: [16] },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/never used around implants/i);
    expect(store.saved).toEqual([]);
  });

  /** BPE cannot measure treatment response; only a repeat 6-point chart can. */
  it("refuses a serial BPE on a patient already under periodontal care", async () => {
    const res = await post("bpe", {
      ...readings,
      context: { ...readings.context, underPeriodontalCare: true, previousExamCount: 2 },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/cannot measure the response/i);
    expect(store.saved).toEqual([]);
  });

  it("refuses a reading that is not a BPE code, or names nothing", async () => {
    expect((await post("bpe", { ...readings, observations: [{ tooth: 16, code: 9 }] })).status).toBe(400);
    expect((await post("bpe", { ...readings, observations: [{ code: 3 }] })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The 6-point chart -- every clinical rule comes from pocket-chart.ts
// ---------------------------------------------------------------------------

describe("recording a 6-point chart", () => {
  it("stores a sextant-scoped chart", async () => {
    const res = await post("chart", chartBody());
    expect(res.status).toBe(200);
    const input = store.saved[0].input as { sextants: string[]; teeth: { sites: unknown[] }[] };
    expect(input.sextants).toEqual(["UR"]);
    expect(input.teeth[0].sites).toHaveLength(6);
  });

  /**
   * CAL is depth + recession and is computed, never typed. The raw site object
   * reaches validatePocketChart intact precisely so this can be REFUSED rather
   * than silently dropped -- a 200 whose stored CAL disagrees with what the
   * caller sent is how a clinician comes to trust a number nobody wrote.
   */
  it("refuses a CAL sent from the client rather than silently dropping it", async () => {
    for (const field of ["cal", "attachmentLoss", "clinicalAttachmentLevel"]) {
      const sites = sixSites();
      sites[0][field] = 4;
      const res = await post("chart", chartBody({ teeth: [{ tooth: 16, sites }] }));
      expect(res.status, field).toBe(400);
      expect(await errorOf(res)).toMatch(/never typed/i);
    }
    expect(store.saved).toEqual([]);
  });

  /** A chart claiming a sextant it holds no teeth for reads to the next
   *  clinician as "examined, and fine". */
  it("refuses a chart claiming a sextant it does not contain", async () => {
    const res = await post("chart", chartBody({ sextants: ["UR", "UL"] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/upper left sextant but records no teeth/i);
    expect(store.saved).toEqual([]);
  });

  it("refuses a tooth outside the sextants the chart declares", async () => {
    const res = await post("chart", chartBody({ teeth: [{ tooth: 26, sites: sixSites() }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("26");
  });

  it("refuses a deciduous tooth, because six-point charting is a permanent-dentition procedure", async () => {
    const res = await post("chart", chartBody({ sextants: ["UR"], teeth: [{ tooth: 55, sites: sixSites() }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/deciduous/i);
  });

  it("refuses a duplicated tooth and a duplicated site", async () => {
    expect(
      (await post("chart", chartBody({ teeth: [{ tooth: 16, sites: [...sixSites(), { site: "mb", probingDepth: 2 }] }] }))).status,
    ).toBe(400);
    expect(
      (
        await post("chart", chartBody({ teeth: [{ tooth: 16, sites: sixSites() }, { tooth: 16, sites: sixSites() }] }))
      ).status,
    ).toBe(400);
  });

  it("refuses an out-of-range depth, and keeps recession signed", async () => {
    const deep = sixSites();
    deep[0].probingDepth = 40;
    expect((await post("chart", chartBody({ teeth: [{ tooth: 16, sites: deep }] }))).status).toBe(400);

    // Negative recession is real: the margin sits coronal to the CEJ.
    const coronal = sixSites();
    coronal[0].recession = -2;
    expect((await post("chart", chartBody({ teeth: [{ tooth: 16, sites: coronal }] }))).status).toBe(200);
  });

  // DENTALLY'S SCALES, THROUGH THE ROUTE. furcation grades 1-4, mobility stages
  // 1-3. The two assertions that used to live here -- mobility 4 refused,
  // furcation 0 refused -- were true under Hamp I-III and Miller 0-III as well,
  // so they pinned nothing: the route could have gone on validating the old
  // scales and this file would have stayed green. The two cases below are the
  // ones that CHANGED, and each fails against the old ranges.
  it("ACCEPTS a grade 4 furcation, which the old Hamp I-III range refused", async () => {
    // The headline of this correction. A hygienist who types a grade 4 furcation
    // and is refused is a hygienist who stops trusting the screen.
    const res = await post("chart", chartBody({ teeth: [{ tooth: 16, furcation: 4, sites: sixSites() }] }));
    expect(res.status).toBe(200);
    // A 200 IS NOT ENOUGH. A route that clamped the grade to 3 on the way past
    // would also answer 200, and the record would then hold a milder finding
    // than the clinician made. What was STORED is the assertion.
    const input = store.saved[0].input as { teeth: { tooth: number; furcation: number | null }[] };
    expect(input.teeth[0].furcation).toBe(4);
  });

  it("REFUSES a mobility of 0, which the old Miller 0-III range accepted", async () => {
    // There is no stage 0. "No mobility found" is the absence of a finding --
    // null -- and a 0 stored beside it is a second way of saying nothing, free
    // to mean "tested, none" on one screen and "not tested" on the next.
    const res = await post("chart", chartBody({ teeth: [{ tooth: 16, mobility: 0, sites: sixSites() }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/stages 1, 2 and 3/);
  });

  it("still refuses what is outside the corrected scales in the other direction", async () => {
    expect((await post("chart", chartBody({ teeth: [{ tooth: 16, mobility: 4, sites: sixSites() }] }))).status).toBe(400);
    expect((await post("chart", chartBody({ teeth: [{ tooth: 16, furcation: 5, sites: sixSites() }] }))).status).toBe(400);
    expect((await post("chart", chartBody({ teeth: [{ tooth: 16, furcation: 0, sites: sixSites() }] }))).status).toBe(400);
  });

  it("names Dentally's scale in the refusal, and never a scale the keyboard does not use", async () => {
    // A refusal that says "Hamp" sends a hygienist looking for a control that is
    // not on their keyboard. The `f` key cycles grades; the message says grades.
    const res = await post("chart", chartBody({ teeth: [{ tooth: 16, furcation: 9, sites: sixSites() }] }));
    const message = await errorOf(res);
    expect(message).toMatch(/grades 1, 2, 3 and 4/);
    expect(message).not.toMatch(/Hamp|Miller/);
  });

  /** A furcation grade on an incisor is a mis-keyed tooth: it has no furcation. */
  it("refuses a furcation grade on a single-rooted tooth", async () => {
    const res = await post("chart", chartBody({ sextants: ["UA"], teeth: [{ tooth: 11, furcation: 2, sites: sixSites() }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/single-rooted/i);
  });

  /** A finding at a site that was never probed cannot be placed. */
  it("refuses bleeding recorded at a site with no probing depth", async () => {
    const sites = sixSites();
    sites[0] = { site: "mb", probingDepth: null, bleeding: true };
    const res = await post("chart", chartBody({ teeth: [{ tooth: 16, sites }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/not probed/i);
  });

  it("returns every problem at once rather than one per round trip", async () => {
    const res = await post("chart", chartBody({ sextants: ["UR", "UL"], teeth: [{ tooth: 16, mobility: 9, sites: sixSites() }] }));
    expect(res.status).toBe(400);
    expect(((await body(res)).issues as string[]).length).toBeGreaterThan(1);
  });

  it("refuses a stage, grade or extent outside the 2017/18 classification", async () => {
    expect((await post("chart", chartBody({ diagnosis: { stage: "V" } }))).status).toBe(400);
    expect((await post("chart", chartBody({ diagnosis: { grade: "D" } }))).status).toBe(400);
    expect((await post("chart", chartBody({ diagnosis: { extent: "molar_incisor" } }))).status).toBe(400);
    expect((await post("chart", chartBody({ diagnosis: { stage: "III", grade: "C", extent: "molar-incisor" } }))).status).toBe(200);
  });

  it("refuses a trigger it does not know", async () => {
    expect((await post("chart", chartBody({ trigger: "because" }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Retraction -- the only alternative to deleting, which is not available
// ---------------------------------------------------------------------------

describe("retracting a record", () => {
  it("requires a kind, an id and a reason that stays on the record", async () => {
    expect((await post("retract", { ...SCOPE, id: "e1", reason: "x" })).status).toBe(400);
    expect((await post("retract", { ...SCOPE, kind: "bpe", reason: "x" })).status).toBe(400);
    expect((await post("retract", { ...SCOPE, kind: "bpe", id: "e1" })).status).toBe(400);
    expect((await post("retract", { ...SCOPE, kind: "bpe", id: "e1", reason: "   " })).status).toBe(400);
    expect(store.retracted).toEqual([]);
  });

  it("passes the reason and the clinician through", async () => {
    const res = await post("retract", { ...SCOPE, kind: "chart", id: "c1", reason: "recorded on the wrong patient" });
    expect(res.status).toBe(200);
    expect(store.retracted[0]).toMatchObject({
      id: "c1",
      reason: "recorded on the wrong patient",
      by: { id: "u1", name: "Dr Sara Malik" },
      scope: { siteId: "site-cc", patientId: "p1" },
    });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("when something goes wrong", () => {
  /** The claim "this patient has no periodontal findings" must never be made by
   *  a failed read. */
  it("answers a failed read with ok:false, never with an empty list", async () => {
    store.throwOnRead = new Error("db down");
    const res = await get("bpe");
    expect(res.status).toBe(500);
    const payload = await body(res);
    expect(payload.ok).toBe(false);
    expect(payload.exams).toBeUndefined();
    expect(String(payload.error)).toMatch(/not a finding that there are none/i);
  });

  it("answers a failed write with ok:false and says nothing was stored", async () => {
    store.throwOnWrite = new Error("db down");
    const res = await post("bpe", bpeBody());
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toMatch(/was not saved/i);
  });

  /** A refused amendment is the clinician's problem to fix, not a server fault. */
  it("turns a refused amendment into a 400 the clinician can act on", async () => {
    store.throwOnWrite = new PerioRefusedError("the BPE being amended has been retracted");
    const res = await post("bpe", bpeBody({ supersedesId: "e1", amendmentReason: "typo" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("retracted");
  });

  it("rejects a body that is not json", async () => {
    const res = await POST(new Request("http://localhost/api/perio/bpe", { method: "POST", body: "not json" }), {
      params: Promise.resolve({ action: "bpe" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("reading", () => {
  it("returns the history and the standing BPE together", async () => {
    const res = await get("bpe");
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload).toHaveProperty("exams");
    expect(payload).toHaveProperty("latest");
    expect(store.reads.map((r) => r.fn).sort()).toEqual(["latestBpeExam", "listBpeExams"]);
  });

  /** The comparison is the clinical point: a single chart is nearly useless. */
  it("returns this chart and the one before it", async () => {
    const res = await get("comparison");
    const payload = await body(res);
    expect(payload).toHaveProperty("latest");
    expect(payload).toHaveProperty("previous");
    expect(store.reads[0]).toMatchObject({ fn: "latestPerioCharts", arg: 2 });
  });

  it("needs an id to load one chart, and 404s on a chart that is not this patient's", async () => {
    expect((await get("chart")).status).toBe(400);
    store.chart = null;
    expect((await get("chart", { ...SCOPE, id: "c-elsewhere" })).status).toBe(404);
    store.chart = { id: "c1", teeth: [] };
    expect((await get("chart", { ...SCOPE, id: "c1" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// THE ENTRY SCREEN'S CONTRACT WITH THIS ROUTE.
//
// bpe-entry.tsx posts toSavePayload(state), and it does so from a browser, where
// nothing checks that its shape is the shape this route parses. Prose agreement
// between the two files is not agreement. So these tests build a real entry state
// with the real machine, hand its real payload to the REAL route, and assert the
// route accepts it and stores what was typed.
//
// This is the seam that would otherwise only be exercised by a clinician, at a
// chairside, with six numbers they cannot call out again.
// ---------------------------------------------------------------------------

describe("the BPE entry screen's payload", () => {
  /** Score every scorable sextant in the travel order the screen uses. */
  function typeWholeMouth(state: BpeEntryState, codes: number[]): BpeEntryState {
    return codes.reduce((s, code) => bpeEntryReducer(s, { type: "code", code }), state);
  }

  it("is accepted verbatim by this route, and stores exactly what was typed", async () => {
    // "Two, one, three star, four, zero, zero" — spoken, in the clinical order.
    let state = initBpeEntry({ presentTeeth: BPE_TEETH });
    state = bpeEntryReducer(state, { type: "code", code: 2 });
    state = bpeEntryReducer(state, { type: "code", code: 1 });
    state = bpeEntryReducer(state, { type: "code", code: 3 });
    state = bpeEntryReducer(state, { type: "furcation" });
    state = typeWholeMouth(state, [4, 0, 0]);
    expect(saveRefusal(state)).toBeNull();

    const res = await post("bpe", { ...SCOPE, ...toSavePayload(state) });
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.ok).toBe(true);
    // Every successful write carries the FP17 double-entry sentence, and the
    // entry screen prints it from the response rather than from a prop, so it
    // cannot be switched off by forgetting to pass one.
    expect(String(payload.notice)).toContain("FP17");

    const input = store.saved[0].input as {
      scores: Record<string, { code: number; furcation: boolean } | null>;
      statuses: Record<string, string>;
      probe: string;
    };
    expect(input.scores.UR).toEqual({ code: 2, furcation: false });
    // The star survives the whole round trip: screen → serialiser → wire →
    // parseBpeScore → repository input.
    expect(input.scores.UL).toEqual({ code: 3, furcation: true });
    expect(input.scores.LL).toEqual({ code: 0, furcation: false });
    expect(input.probe).toBe(DEFAULT_PROBE);

    // WORTH KNOWING, AND THE REASON THE SCREEN CALLS THE ENGINE ITSELF: the grid
    // path returns NO requirement. postBpe only computes one on the observations
    // path, where it has individual readings to roll up. So for a BPE typed as six
    // boxes — which is how a BPE is actually typed — the charting consequence of a
    // 3 or a 4 is stated by the entry screen or by nobody, which is why
    // bpe-entry.tsx renders chartingRequirement() live rather than waiting for the
    // response to tell it.
    expect(payload.requirement).toBeNull();
  });

  it("carries a REASON for a sextant that cannot be scored, so the route never stores it as a 0", async () => {
    // One tooth in the upper right: below MIN_TEETH_PER_SEXTANT, so the machine
    // skips it and the payload must say why. Without the reason this route refuses
    // the write outright — which is the behaviour the screen is built around.
    const teeth = BPE_TEETH.filter((t) => !SEXTANT_TEETH.UR.includes(t) || t === 17);
    let state = initBpeEntry({ presentTeeth: teeth });
    state = typeWholeMouth(state, [0, 1, 2, 3, 4]);
    expect(saveRefusal(state)).toBeNull();

    const sent = toSavePayload(state);
    expect(sent.scores.UR).toBeNull();
    expect(sent.statuses.UR).toBe("insufficient-teeth");

    const res = await post("bpe", { ...SCOPE, ...sent });
    expect(res.status).toBe(200);
    const input = store.saved[0].input as {
      scores: Record<string, unknown>;
      statuses: Record<string, string>;
    };
    // THE WHOLE POINT. Null, with a reason — never a 0.
    expect(input.scores.UR).toBeNull();
    expect(input.statuses.UR).toBe("insufficient-teeth");
  });

  it("is refused by the route in exactly the case the screen refuses first", async () => {
    // A scorable sextant with no score. saveRefusal() stops the button; if it ever
    // did not, the route stops the write — and this proves the two agree about
    // which case that is rather than each guessing.
    let state = initBpeEntry({ presentTeeth: BPE_TEETH });
    state = typeWholeMouth(state, [0, 0, 0, 0, 0]);
    expect(saveRefusal(state)).toContain("lower left");

    const res = await post("bpe", { ...SCOPE, ...toSavePayload(state) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/lower left sextant has no score/i);
    expect(store.saved).toHaveLength(0);
  });

  it("is refused with PERIO_COPY.noAuthor when the server cannot name a clinician", async () => {
    // GDC 4.1.4. The screen prints this sentence and disables the button; the
    // route refuses with the same one, so a browser that got past the button is
    // told the same thing rather than something new.
    store.user = null;
    let state = initBpeEntry({ presentTeeth: BPE_TEETH });
    state = typeWholeMouth(state, [0, 0, 0, 0, 0, 0]);
    const res = await post("bpe", { ...SCOPE, ...toSavePayload(state) });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe(PERIO_COPY.noAuthor);
    expect(store.saved).toHaveLength(0);
  });

  it('sends the probe note only when the probe is "other", which is when it names something', async () => {
    let state = initBpeEntry({ presentTeeth: BPE_TEETH });
    state = typeWholeMouth(state, [0, 0, 0, 0, 0, 0]);
    expect(toSavePayload(state).probeNote).toBeNull();

    state = bpeEntryReducer(state, { type: "probe", probe: "other", note: "Michigan O" });
    expect(saveRefusal(state)).toBeNull();
    const res = await post("bpe", { ...SCOPE, ...toSavePayload(state) });
    expect(res.status).toBe(200);
    expect(store.saved[0].input).toMatchObject({ probe: "other", probeNote: "Michigan O" });
  });
});

// ===========================================================================
// THE CLINICAL-WRITE TIGHTENING, campaign 6.
//
// Recording a periodontal finding — or retracting one — is a clinical act: it
// becomes part of the patient's record and is attributed to whoever made it (GDC
// 4.1.4). Before this change every role attached to the practice could POST here,
// the fixture user in this file included, which was a coordinator. The READ is
// deliberately untouched.
//
// And one layer out: a `client_staff` login reaches neither, because "patients" is
// not in STAFF_SLUGS.
// ===========================================================================
describe("who may write a perio record, and who may only read one", () => {
  const coordinator = { id: "u2", name: "Blerta", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
  const staff = { id: "u3", name: "Nadia", role: "client_staff", clientId: "vitality", siteIds: ["site-cc"] };

  it("the coordinator may still READ", async () => {
    store.user = coordinator;
    expect((await get("bpe")).status).toBe(200);
  });

  it("but may no longer write a BPE, a chart or a retraction, and nothing is stored", async () => {
    store.user = coordinator;
    for (const [action, payload] of [
      ["bpe", bpeBody()],
      ["chart", chartBody()],
      ["retract", { ...SCOPE, id: "x", reason: "entered on the wrong patient record" }],
    ] as const) {
      expect((await post(action, payload)).status, action).toBe(403);
    }
    expect(store.saved).toEqual([]);
    expect(store.retracted).toEqual([]);
  });

  it("the clinician may still do both", async () => {
    expect((await get("bpe")).status).toBe(200);
    expect((await post("bpe", bpeBody())).status).toBe(200);
    expect(store.saved).toHaveLength(1);
  });

  it("the staff role reaches NEITHER: the module gate refuses it first", async () => {
    store.user = staff;
    expect((await get("bpe")).status).toBe(403);
    expect((await post("bpe", bpeBody())).status).toBe(403);
    expect(store.saved).toEqual([]);
  });
});
