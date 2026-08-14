// The medical-history API: the gate, the attribution rule, the site scope, and
// the seam where an untrusted body meets the stored clinical record.
//
// Auth, clients, the Dentally patient read and the repository's database calls are
// mocked. TWO THINGS ARE NOT. The GATE reads the real environment, because "the
// feature is off by default" is the most important claim in this build and a
// mocked gate would let it pass while being false. And questions.ts runs for real,
// because the point of the answers test is that the route DEFERS to the bank about
// which keys are valid rather than re-deciding.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

type User = { id: string; name: string; role: string; clientId: string | null; siteIds: string[] } | null;

const store = vi.hoisted(() => ({
  user: null as unknown,
  requireUserResponse: null as Response | null,
  patientSiteId: "site-cc" as string | null,
  savedQuestionnaires: [] as { scope: unknown; input: unknown }[],
  savedReviews: [] as { scope: unknown; input: unknown }[],
  retracted: [] as { scope: unknown; id: string; reason: string; by: unknown }[],
  reads: [] as { fn: string; scope: unknown }[],
  throwOnWrite: null as unknown,
  throwOnRead: null as unknown,
  retractResult: { id: "q1" } as unknown,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.requireUserResponse ?? store.user,
  requireClientAccess: (user: User, clientId: string) =>
    user && user.clientId !== clientId ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
  requireSiteAccess: (user: User, siteId: string) =>
    user && !user.siteIds.includes(siteId) ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/dentally/read", () => ({
  getPatientById: async (id: string) => (store.patientSiteId ? { id, siteId: store.patientSiteId } : null),
}));

// PARTIAL mock: the real error classes are kept (the route does `instanceof`),
// only the database calls are stubbed.
vi.mock("@/lib/patient-medical/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-medical/repository")>();
  const read = (fn: string, value: unknown) => async (scope: unknown) => {
    if (store.throwOnRead) throw store.throwOnRead;
    store.reads.push({ fn, scope });
    return value;
  };
  return {
    ...actual,
    saveQuestionnaire: async (scope: unknown, input: unknown) => {
      if (store.throwOnWrite) throw store.throwOnWrite;
      store.savedQuestionnaires.push({ scope, input });
      return { id: "q-1", ...(input as object) };
    },
    recordReview: async (scope: unknown, input: unknown) => {
      if (store.throwOnWrite) throw store.throwOnWrite;
      store.savedReviews.push({ scope, input });
      return { id: "r-1", ...(input as object) };
    },
    retractQuestionnaire: async (scope: unknown, id: string, reason: string, by: unknown) => {
      if (store.throwOnWrite) throw store.throwOnWrite;
      store.retracted.push({ scope, id, reason, by });
      return store.retractResult;
    },
    latestQuestionnaire: read("latestQuestionnaire", null),
    latestReview: read("latestReview", null),
    listReviews: read("listReviews", []),
  };
});

import { GET, POST } from "./route";
import { MedicalRefusedError } from "@/lib/patient-medical/repository";
import { MEDICAL_COPY } from "@/lib/patient-medical/gate";

const SCOPE = { client: "vitality", siteId: "site-cc", patientId: "p1" };

function get(action: string, params: Record<string, string> = SCOPE): Promise<Response> {
  const url = new URL(`http://localhost/api/medical-history/${action}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET(new Request(url), { params: Promise.resolve({ action }) });
}
function post(action: string, payload: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/medical-history/${action}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ action }) },
  );
}
async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
async function errorOf(res: Response): Promise<string> {
  return String((await body(res)).error ?? "");
}

function questionnaireBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...SCOPE,
    answers: [
      { key: "diabetes", answer: "no" },
      { key: "anticoagulants", answer: "yes", detail: "apixaban" },
    ],
    patientName: "Alex Berry",
    signature: { method: "typed", value: "Alex Berry", signedAt: "2026-08-01T09:00:00.000Z" },
    ...overrides,
  };
}
function reviewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SCOPE, outcome: "no-changes", ...overrides };
}

beforeEach(() => {
  store.user = { id: "u1", name: "Blerta", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
  store.requireUserResponse = null;
  store.patientSiteId = "site-cc";
  store.savedQuestionnaires = [];
  store.savedReviews = [];
  store.retracted = [];
  store.reads = [];
  store.throwOnWrite = null;
  store.throwOnRead = null;
  store.retractResult = { id: "q1" };
  vi.stubEnv("MEDICAL_HISTORY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("with medical history switched off", () => {
  beforeEach(() => vi.stubEnv("MEDICAL_HISTORY_ENABLED", "false"));

  it("answers every read with 503 naming the variable, and never an empty 200", async () => {
    for (const action of ["latest", "reviews"]) {
      const res = await get(action);
      expect(res.status, action).toBe(503);
      const payload = await body(res);
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain("MEDICAL_HISTORY_ENABLED");
      expect(String(payload.error)).toContain("Dentally");
      expect(payload.questionnaire).toBeUndefined();
      expect(payload.reviews).toBeUndefined();
    }
  });

  it("answers every write with 503 and stores nothing", async () => {
    expect((await post("questionnaire", questionnaireBody())).status).toBe(503);
    expect((await post("review", reviewBody())).status).toBe(503);
    expect((await post("retract", { ...SCOPE, id: "q1", reason: "wrong patient" })).status).toBe(503);
    expect(store.savedQuestionnaires).toEqual([]);
    expect(store.savedReviews).toEqual([]);
    expect(store.retracted).toEqual([]);
  });

  it("is off for anything other than the exact string true", async () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      vi.stubEnv("MEDICAL_HISTORY_ENABLED", value);
      expect((await get("latest")).status, value).toBe(503);
    }
  });

  it("still answers an unauthorised caller with 401 or 403, not 503", async () => {
    store.requireUserResponse = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await get("latest")).status).toBe(401);
    store.requireUserResponse = null;
    store.user = { id: "u2", name: "Other", role: "client_owner", clientId: "other", siteIds: ["site-x"] };
    expect((await get("latest")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Authorisation and site scope
// ---------------------------------------------------------------------------

describe("authorisation", () => {
  it("requires a known client", async () => {
    expect((await get("latest", { ...SCOPE, client: "nope" })).status).toBe(404);
  });

  it("requires a site and a patient", async () => {
    expect((await get("latest", { client: "vitality", siteId: "", patientId: "" })).status).toBe(400);
  });

  it("refuses a site the signed-in user does not hold", async () => {
    expect((await get("latest", { ...SCOPE, siteId: "site-rv" })).status).toBe(403);
  });

  it("refuses a patient who belongs to another site, with a plain 404", async () => {
    store.patientSiteId = "site-rv";
    expect((await get("latest")).status).toBe(404);
    expect((await post("questionnaire", questionnaireBody())).status).toBe(404);
    expect(store.savedQuestionnaires).toEqual([]);
  });

  it("scopes every read and write by site AND patient", async () => {
    await get("latest");
    expect(store.reads[0].scope).toEqual({ siteId: "site-cc", patientId: "p1" });
    await post("review", reviewBody());
    expect(store.savedReviews[0].scope).toEqual({ siteId: "site-cc", patientId: "p1" });
  });

  it("does not accept a rogue action as a route", async () => {
    expect((await get("everything")).status).toBe(404);
    expect((await post("delete", SCOPE)).status).toBe(404);
  });

  it("keeps the read-only actions read-only and the write actions write-only", async () => {
    expect((await get("review")).status).toBe(404);
    expect((await post("latest", SCOPE)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Attribution — GDC 4.1.4
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("records which clinician wrote a review, and when", async () => {
    await post("review", reviewBody());
    const input = store.savedReviews[0].input as { author: unknown; reviewedAt: string };
    expect(input.author).toEqual({ id: "u1", name: "Blerta", gdcNumber: null });
    expect(Date.parse(input.reviewedAt)).not.toBeNaN();
  });

  /**
   * A staff-entered questionnaire and a review both need a named author on this
   * route; only the PUBLIC route writes a null-author (patient self-capture). With
   * auth enforcement off there is no clinician, so every write is refused.
   */
  it("refuses to write at all when it cannot name the clinician", async () => {
    store.user = null;
    expect((await post("review", reviewBody())).status).toBe(503);
    expect((await post("questionnaire", questionnaireBody())).status).toBe(503);
    expect(await errorOf(await post("review", reviewBody()))).toMatch(/clinician/i);
    expect(store.savedReviews).toEqual([]);
    expect(store.savedQuestionnaires).toEqual([]);
    // Reads are unaffected — nobody is harmed by reading a record anonymously.
    expect((await get("latest")).status).toBe(200);
  });

  it("refuses a review dated in the future", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await post("review", reviewBody({ reviewedAt: tomorrow }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Questionnaire — the seam with the versioned bank
// ---------------------------------------------------------------------------

describe("recording a questionnaire (staff fallback)", () => {
  it("stores a questionnaire, stamps the bank version, and echoes the two-records notice", async () => {
    const res = await post("questionnaire", questionnaireBody());
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.ok).toBe(true);
    expect(String(payload.notice)).toContain("Dentally");
    const input = store.savedQuestionnaires[0].input as {
      answers: { key: string; answer: string; detail: string | null }[];
      questionBankVersion: string;
      capturedVia: string;
      author: unknown;
    };
    expect(input.questionBankVersion).toMatch(/^uk-dental-mh-/);
    expect(input.capturedVia).toBe("staff");
    expect(input.author).toEqual({ id: "u1", name: "Blerta", gdcNumber: null });
    expect(input.answers).toEqual([
      { key: "diabetes", answer: "no", detail: null },
      { key: "anticoagulants", answer: "yes", detail: "apixaban" },
    ]);
  });

  it("refuses an answer whose key is not on the current form", async () => {
    const res = await post("questionnaire", questionnaireBody({ answers: [{ key: "made_up", answer: "no" }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/not a question on the current medical-history form/i);
    expect(store.savedQuestionnaires).toEqual([]);
  });

  it("refuses an answer value that is not yes, no or unknown", async () => {
    const res = await post("questionnaire", questionnaireBody({ answers: [{ key: "diabetes", answer: "maybe" }] }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/yes, no or unknown/i);
  });

  it("refuses a question answered twice", async () => {
    const res = await post(
      "questionnaire",
      questionnaireBody({ answers: [{ key: "diabetes", answer: "no" }, { key: "diabetes", answer: "yes" }] }),
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/more than once/i);
  });

  it("refuses a caller-supplied version, because versions are the record's own", async () => {
    expect((await post("questionnaire", questionnaireBody({ version: 9 }))).status).toBe(400);
  });

  it("refuses a signature with an unknown method", async () => {
    const res = await post("questionnaire", questionnaireBody({ signature: { method: "stamp", value: "x" } }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/signature method/i);
  });

  /** GDC 4.1.5: an amendment is marked with a reason. */
  it("refuses an amendment with no reason, and keeps the pair together", async () => {
    expect((await post("questionnaire", questionnaireBody({ supersedesId: "q0" }))).status).toBe(400);
    expect((await post("questionnaire", questionnaireBody({ amendmentReason: "typo" }))).status).toBe(400);
    const res = await post("questionnaire", questionnaireBody({ supersedesId: "q0", amendmentReason: "updated meds" }));
    expect(res.status).toBe(200);
    expect(store.savedQuestionnaires[0].input).toMatchObject({ supersedesId: "q0", amendmentReason: "updated meds" });
  });
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

describe("recording a review", () => {
  it("stores a review with its outcome and optional appointment link", async () => {
    const res = await post("review", reviewBody({ outcome: "updated", appointmentId: "a9", questionnaireId: "q5" }));
    expect(res.status).toBe(200);
    expect(store.savedReviews[0].input).toMatchObject({
      outcome: "updated",
      appointmentId: "a9",
      questionnaireId: "q5",
    });
  });

  it("refuses an outcome it does not know", async () => {
    expect((await post("review", reviewBody({ outcome: "whatever" }))).status).toBe(400);
    expect(store.savedReviews).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Retraction
// ---------------------------------------------------------------------------

describe("retracting a questionnaire", () => {
  it("requires an id and a reason that stays on the record", async () => {
    expect((await post("retract", { ...SCOPE, reason: "x" })).status).toBe(400);
    expect((await post("retract", { ...SCOPE, id: "q1" })).status).toBe(400);
    expect((await post("retract", { ...SCOPE, id: "q1", reason: "   " })).status).toBe(400);
    expect(store.retracted).toEqual([]);
  });

  it("passes the reason and the clinician through, and 404s a record that is not this patient's", async () => {
    const res = await post("retract", { ...SCOPE, id: "q1", reason: "recorded on the wrong patient" });
    expect(res.status).toBe(200);
    expect(store.retracted[0]).toMatchObject({
      id: "q1",
      reason: "recorded on the wrong patient",
      by: { id: "u1", name: "Blerta" },
      scope: { siteId: "site-cc", patientId: "p1" },
    });
    store.retractResult = null;
    expect((await post("retract", { ...SCOPE, id: "gone", reason: "already retracted" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("when something goes wrong", () => {
  it("answers a failed read with ok:false, never with an empty list", async () => {
    store.throwOnRead = new Error("db down");
    const res = await get("latest");
    expect(res.status).toBe(500);
    const payload = await body(res);
    expect(payload.ok).toBe(false);
    expect(payload.questionnaire).toBeUndefined();
    expect(String(payload.error)).toMatch(/not a finding that there is none/i);
  });

  it("answers a failed write with ok:false and says nothing was stored", async () => {
    store.throwOnWrite = new Error("db down");
    const res = await post("review", reviewBody());
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toMatch(/was not saved/i);
  });

  it("turns a refused amendment into a 400 the clinician can act on", async () => {
    store.throwOnWrite = new MedicalRefusedError("the questionnaire being amended has been retracted");
    const res = await post("questionnaire", questionnaireBody({ supersedesId: "q0", amendmentReason: "typo" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("retracted");
  });

  it("rejects a body that is not json", async () => {
    const res = await POST(
      new Request("http://localhost/api/medical-history/review", { method: "POST", body: "not json" }),
      { params: Promise.resolve({ action: "review" }) },
    );
    expect(res.status).toBe(400);
  });

  it("carries the two-records notice on the disabled path via the copy module", () => {
    expect(MEDICAL_COPY.disabled).toContain("MEDICAL_HISTORY_ENABLED");
  });
});
