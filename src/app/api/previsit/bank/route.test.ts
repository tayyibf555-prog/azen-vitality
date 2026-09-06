// ===========================================================================
// THE OWNER EDITOR'S BANK ROUTE: who may open it, and what it refuses to store.
//
// WHY THIS FILE EXISTS AT ALL. Until now the directory held `route.ts` alone —
// no test anywhere imported the module, so neither handler was ever executed by
// the suite. Its three pins were source greps:
//   - src/lib/triage/gating.test.ts   expect(src).toContain("requireOwnerRole(")
//   - src/components/client/previsit/bank-editor.test.ts (same, as prose)
//   - client-api-module-guard-coverage.test.ts's hasRoleGuard() regex
// A grep cannot see whether the guard's RESULT is acted on. Mutating the route's
// own line to `if (false && ownerDenied) return { ok: false, response: ownerDenied };`
// left every one of those satisfied and the whole 14,225-test suite green, while
// a receptionist could rewrite the questions every patient in the practice is
// asked before their appointment.
//
// AND THE GUARD IS THE WHOLE DOOR HERE. This route is switch-EXEMPT by ruling
// W2-C/4 (banks must be preparable before the module is switched on), so the
// kill switch is deliberately not a second line of defence; `requireClientAccess`
// proves tenancy only, and `src/proxy.ts` never matches `/api`.
//
// Two sections:
//   1. THE OWNER LOCK, driven through both handlers, for every clearance.
//   2. RULING W3/3's first half: a custom question carrying a forbidden word is
//      REFUSED AT SAVE, not stored and dropped at render.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  /** Every config the route actually wrote, in order. */
  saved: [] as Array<{ fork: string; config: Record<string, unknown> }>,
}));

// PARTIAL: requireClientAccess and requireOwnerRole are the REAL guards; only
// the session read is faked. A stubbed role predicate would be testing the stub.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => store.user };
});

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/triage/repository", () => ({
  getBanks: async () => ({}),
  saveBank: async (_clientId: string, fork: string, config: Record<string, unknown>) => {
    store.saved.push({ fork, config });
  },
}));

import { GET, PUT } from "./route";
import { defaultConfigFor } from "@/lib/triage/bank";
import { projectBank } from "@/lib/triage/project";

/** Every clearance in the platform, and whether it may edit the question banks. */
const CLEARANCES: ReadonlyArray<{ role: string; mayEdit: boolean; who: string }> = [
  { role: "agency_admin", mayEdit: true, who: "the agency" },
  { role: "client_owner", mayEdit: true, who: "the practice owner" },
  { role: "client_coordinator", mayEdit: false, who: "the practice manager" },
  { role: "client_clinician", mayEdit: false, who: "a dentist" },
  { role: "client_staff", mayEdit: false, who: "a nurse or receptionist" },
];

function asRole(role: string) {
  store.user = {
    id: `u-${role}`,
    name: role,
    email: `${role}@vitality.example`,
    role,
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
}

function read(): Promise<Response> {
  return GET(new Request("http://localhost/api/previsit/bank?client=vitality"));
}

function write(config: unknown, fork = "full"): Promise<Response> {
  return PUT(
    new Request("http://localhost/api/previsit/bank", {
      method: "PUT",
      body: JSON.stringify({ clientSlug: "vitality", fork, config }),
    }),
  );
}

beforeEach(() => {
  store.user = null;
  store.saved = [];
});

// ---------------------------------------------------------------------------
// 1. THE OWNER LOCK.
// ---------------------------------------------------------------------------

describe("the question banks are owner-only on the API, not only on the page", () => {
  it("previsit-bank-owner-lock-refuses-every-non-owner", async () => {
    for (const c of CLEARANCES.filter((x) => !x.mayEdit)) {
      store.saved = [];
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) read the question banks`).toBe(403);
      const body = (await got.json()) as { banks?: unknown[] };
      expect(body.banks, `${c.who} was handed the banks`).toBeUndefined();

      const put = await write({ enabledKeys: [defaultConfigFor("full").enabledKeys[0]], required: {}, custom: [] });
      expect(put.status, `${c.who} (${c.role}) rewrote the question banks`).toBe(403);
      expect(store.saved, `${c.who} changed what patients are asked`).toEqual([]);
    }
  });

  it("previsit-bank-owner-lock-admits-the-owner-and-the-agency", async () => {
    // The fail direction is CLOSED, not shut: a guard tightened to refuse
    // everybody would pass the refusal test above against an editor no owner
    // could use.
    for (const c of CLEARANCES.filter((x) => x.mayEdit)) {
      store.saved = [];
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) could not read the banks`).toBe(200);
      const body = (await got.json()) as { ok?: boolean; banks?: Array<{ fork: string }> };
      expect(body.ok).toBe(true);
      expect((body.banks ?? []).map((b) => b.fork).sort()).toEqual(["brief", "full"]);

      const put = await write({ enabledKeys: [defaultConfigFor("full").enabledKeys[0]], required: {}, custom: [] });
      expect(put.status, `${c.who} (${c.role}) could not save`).toBe(200);
      expect(store.saved.length).toBe(1);
    }
  });

  it("an unauthenticated caller reaches neither handler", async () => {
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await read()).status).toBe(401);
    expect((await write({ enabledKeys: [], required: {}, custom: [] })).status).toBe(401);
    expect(store.saved).toEqual([]);
  });

  it("the admitted clearances are exactly requireOwnerRole's own list", async () => {
    const { requireOwnerRole } = await import("@/lib/auth/guard");
    for (const c of CLEARANCES) {
      const user = { id: "u", name: "Probe", email: "e", role: c.role, clientId: "vitality", siteIds: [] };
      const denied = requireOwnerRole(user as Parameters<typeof requireOwnerRole>[0]);
      expect(denied === null, `${c.role} disagrees with the table`).toBe(c.mayEdit);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. RULING W3/3, FIRST HALF: REFUSED AT SAVE.
//
// The second half — "already-stored offenders excluded at projection (fail
// closed)" — was implemented and is pinned by src/lib/triage/project.test.ts.
// The first half was not: `parseConfig` ran only `usableCustom`, which validates
// the SHAPE of a question and runs neither forbidden-word scan, so an owner who
// wrote a funding-worded question got a 200 and the strings sat in
// `previsit_bank.config` for good.
//
// Every case below asserts `store.saved` is EMPTY as well as the status. A 400
// returned after the write would pass a status-only check and leave exactly the
// row this ruling exists to prevent.
// ---------------------------------------------------------------------------

/** A custom choice question, in the shape `usableCustom` accepts. */
function choice(over: Record<string, unknown> = {}) {
  return {
    key: "custom-how",
    label: "How can we help at this visit?",
    type: "choice",
    kind: "logistics",
    options: [
      { value: "check", label: "A check-up" },
      { value: "clean", label: "A clean" },
    ],
    ...over,
  };
}

/** A real key from the shipped short bank, so `dropped` reflects only the custom
 *  question under test rather than an invented key the catalogue never knew. */
const A_SHIPPED_BRIEF_KEY = defaultConfigFor("brief").enabledKeys[0];

function configWith(custom: unknown) {
  return { enabledKeys: [A_SHIPPED_BRIEF_KEY], required: {}, custom: [custom] };
}

describe("a custom question carrying a forbidden word is refused at save", () => {
  beforeEach(() => asRole("client_owner"));

  it("previsit-bank-refuses-a-funding-word-in-a-custom-option-label", async () => {
    // The exact shape the finder reproduced: the label is clean, the funding word
    // is in an OPTION the patient reads. Refused for the FULL bank, which has no
    // symptom filter at all — so nothing but the funding scan can be refusing it.
    const res = await write(
      configWith(
        choice({
          key: "custom-funding",
          label: "How would you like to pay?",
          options: [
            { value: "nhs", label: "On the NHS" },
            { value: "priv", label: "Something else" },
          ],
        }),
      ),
      "full",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error, "the refusal must name the word that stopped it").toContain("NHS");
    expect(body.error).toContain("How would you like to pay?");
    expect(store.saved, "a forbidden word was written into previsit_bank").toEqual([]);
  });

  it("previsit-bank-refuses-a-funding-word-in-a-custom-option-VALUE", async () => {
    // The value is not rendered on the form, but it is what a staff screen falls
    // back to when the bank cannot name a practice-written answer, so `admit`
    // scans it and so does this.
    const res = await write(
      configWith(
        choice({
          options: [
            { value: "private", label: "The usual" },
            { value: "other", label: "Something else" },
          ],
        }),
      ),
      "full",
    );
    expect(res.status).toBe(400);
    expect(store.saved).toEqual([]);
  });

  it("previsit-bank-refuses-a-funding-word-in-a-custom-LABEL", async () => {
    const res = await write(configWith(choice({ label: "Are you on a payment plan?" })), "full");
    expect(res.status).toBe(400);
    expect(store.saved).toEqual([]);
  });

  it("previsit-bank-refuses-a-symptom-word-on-the-SHORT-bank", async () => {
    // The NHS contractual fork. `kind: "logistics"` is the owner's honest-looking
    // classification; the word in the option is what actually decides.
    const offending = choice({
      key: "custom-help",
      label: "How can we help at this visit?",
      options: [
        { value: "hurt", label: "Something is hurting" },
        { value: "check", label: "Just a check-up" },
      ],
    });
    const res = await write(configWith(offending), "brief");
    expect(res.status).toBe(400);
    expect(store.saved).toEqual([]);

    // …AND THE SAME QUESTION IS FINE ON THE FULL BANK, which exists to ask it.
    // Without this half the test would pass against a route that refused every
    // custom question on every fork.
    const allowed = await write(configWith(offending), "full");
    expect(allowed.status, "the long bank exists to ask symptom questions").toBe(200);
    expect(store.saved.length).toBe(1);
  });

  it("an ordinary custom question is still saved, and is projected", async () => {
    const res = await write(configWith(choice()), "brief");
    expect(res.status, "a clean logistics question was refused").toBe(200);
    const body = (await res.json()) as { dropped?: unknown[]; questions?: Array<{ key: string }> };
    expect(body.dropped).toEqual([]);
    expect((body.questions ?? []).some((q) => q.key === "custom-how")).toBe(true);
    expect(store.saved.length).toBe(1);
  });

  it("a malformed custom question is refused rather than dropped silently", async () => {
    // `usableCustom`'s own layer, unchanged: a choice question with one option is
    // not a question, and the save is refused rather than storing a shape the
    // projection would discard.
    const res = await write(configWith(choice({ options: [{ value: "a", label: "A" }] })), "full");
    expect(res.status).toBe(400);
    expect(store.saved).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE OTHER HALF OF THE HEADER'S PROMISE, which is a DIFFERENT behaviour and
  // is deliberately not a refusal: a shipped BANK question switched on for the
  // wrong fork is stored and reported in `dropped`.
  // -------------------------------------------------------------------------
  it("a shipped bank question on the wrong fork is stored and REPORTED, not refused", async () => {
    // Find a symptom question the catalogue actually ships, rather than naming
    // one: a key hard-coded here would rot the day the bank is re-cut.
    const fullKeys = defaultConfigFor("full").enabledKeys;
    const symptomKey = fullKeys.find(
      (k) => projectBank("brief", { enabledKeys: [k], required: {}, custom: [] }).dropped.length === 1,
    );
    expect(symptomKey, "the shipped long bank has no question the short bank refuses").toBeTruthy();

    const res = await write({ enabledKeys: [symptomKey], required: {}, custom: [] }, "brief");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions?: unknown[]; dropped?: Array<{ key: string; matched: string | null }> };
    expect(store.saved.length, "the config the owner configured was not stored").toBe(1);
    expect(body.questions).toEqual([]);
    expect((body.dropped ?? []).map((d) => d.key)).toEqual([symptomKey]);
    expect((body.dropped ?? [])[0]?.matched, "the editor is told which word stopped it").toBeTruthy();
  });
});
