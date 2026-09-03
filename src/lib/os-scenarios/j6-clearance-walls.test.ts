// ===========================================================================
// JOURNEY 6 — A DAY'S WORTH OF QUESTIONS, AT FOUR CLEARANCES.
//
// Wave 1's battery asks sixty questions and checks each one's verdict. This is
// the other half of that claim: not "does this question get the right answer"
// but "can a person with this login get ANYWHERE they should not, across a whole
// day of ordinary work". So each role here is given the questions that role
// actually asks — the manager about the diary and a patient, the clinician about
// their list, the nurse about her own shifts, the owner about everything — and
// then the same questions are asked at every OTHER clearance and required to
// fail.
//
// THE MATRIX IS THE TEST. A per-role list of allowed tools proves a catalog. A
// per-role list plus the SAME list refused at every lower clearance proves a
// wall, and it is the second half that catches a widening: a tool quietly added
// to the manager's catalog passes a manager test and fails here.
//
// FOUR THINGS THE MANAGER MUST NEVER REACH (charter, W1-E): money, reports,
// marketing performance, and any send. The clinician must never send at all
// (ruling W1-E/1). Staff reach their own work and nothing else. An unknown role
// reaches nothing — and "unknown" includes the shapes an attacker would try.
//
// STUBBED: @/lib/dentally/read (the network boundary). The clearance Record, the
// dispatch gate, the projection and the knowledge tier are real, and the
// knowledge tier is PROVED rather than trusted: the retrieval seam records the
// maxTier it was actually asked for.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { CLIENT, SITE, createOsWorld, installFetchGuard, type FetchGuard } from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

const H = vi.hoisted(() => ({
  /** Every maxTier the practice brain was asked for. */
  knowledgeTiers: [] as number[],
  /** Every message that reached the provider. Must stay empty for four of five roles. */
  sent: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));

vi.mock("@/lib/dentally/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/read")>();
  const PATIENT = {
    id: "pat-002",
    name: "Rajesh Patel",
    title: null,
    email: "rajesh.patel@example.co.uk",
    phone: "+447700900002",
    siteId: "site-cc",
    active: true,
    archivedReason: null,
    recallDueAt: "2026-11-01",
    lastVisitAt: "2026-05-15T10:00:00Z",
    dateOfBirth: null,
    gender: null,
    smsConsent: true,
    emailConsent: true,
  };
  return {
    ...actual,
    listPatients: async () => [PATIENT],
    searchPatients: async () => [PATIENT],
    listAppointments: async () => [],
    listOutstanding: async () => [
      { patientName: "Rajesh Patel", planName: "Implant UR6", outstanding: 1200, planned: 2400, siteId: "site-cc" },
    ],
    getPatientDetail: async () => ({
      appointments: [],
      plans: [{ name: "Implant UR6", planned: 2400, outstanding: 1200, acceptedAt: null }],
      notes: [{ id: "n1", body: "Nervous patient.", author: "Dr Priya Adeyemi", createdAt: "2026-05-20T10:10:00Z" }],
      lifetimeSpend: 7350,
      outstanding: 1200,
      credit: 0,
      totalInvoiced: 8550,
      invoices: [],
      reads: { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" },
    }),
    listSitePractitioners: async () => [{ id: "prac-1", name: "Dr Priya Adeyemi" }],
    dentallyReadKey: () => "test-key",
  };
});

vi.mock("@/lib/practice-brain/retrieval", () => ({
  searchKnowledge: async (_c: string, _q: string, maxTier: number) => {
    H.knowledgeTiers.push(maxTier);
    return [{ node: { id: "k1", title: "Cancellation policy", body: "24 hours notice." }, score: 9, snippet: "24 hours." }];
  },
}));

vi.mock("@/lib/messaging/send", () => ({
  sendMessage: async (m: unknown) => {
    H.sent.push(m);
    return { provider: "test", providerMessageId: "SM-1", status: "queued" };
  },
}));

import { makeCopilotDispatch, COPILOT_TOOLS } from "@/lib/copilot/tools";
import { copilotAccessForRole, copilotToolsFor } from "@/lib/copilot/scope";
import { COPILOT_TOOL_NAMES, TOOL_CATALOG, TOOL_DOMAIN, ACCESS_DOMAINS } from "@/lib/copilot/clearance";
import type { CopilotToolName } from "@/lib/copilot/clearance";
import type { Role } from "@/lib/types";

const ORIGINAL_ENV = { ...process.env };
let guard: FetchGuard;

beforeEach(() => {
  world.reset();
  H.knowledgeTiers.length = 0;
  H.sent.length = 0;
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.DENTALLY_WRITE_ENABLED;
  delete process.env.DENTALLY_BASE_URL;
  delete process.env.MESSAGING_DRY_RUN;
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

/**
 * The real dispatch at a real role's clearance.
 *
 * `resolveStaff` is the SESSION's own staff row, exactly as the route resolves
 * it. No scenario may pass a staff id; there is no parameter for one, which is
 * what makes "their own work" structural rather than a filter somebody applies.
 */
function dispatchAs(role: Role) {
  const access = copilotAccessForRole(role);
  const real = makeCopilotDispatch([SITE], CLIENT, `user-${role}`, access, {
    resolveStaff: async () => ({ id: "staff-nadia", name: "Nadia Khan" }),
  });
  return async (name: string, input: Record<string, unknown> = {}) =>
    JSON.parse(await real(name, input)) as Record<string, unknown>;
}

/** True when the dispatch refused this tool on CLEARANCE grounds. */
function isScopeRefusal(out: Record<string, unknown>): boolean {
  return out.denied === true && out.error === "out_of_scope";
}

/**
 * True when this clearance cannot reach this tool AT ALL — either the gate
 * refused it, or the tool does not exist for anyone.
 *
 * The two are different outcomes and both are acceptable walls. `full` short-
 * circuits the catalog, so for the owner a name that is not a tool falls through
 * to "unknown tool" rather than to a refusal; for every other clearance the gate
 * fires first. A test that demanded one specific shape would be asserting an
 * implementation detail of the catalog rather than the wall.
 */
function isWalledOff(out: Record<string, unknown>): boolean {
  return isScopeRefusal(out) || (typeof out.error === "string" && out.error.startsWith("unknown tool"));
}

// ---------------------------------------------------------------------------
// A DAY'S WORK, per role. These are the questions each login actually asks, in
// the tools the co-pilot would reach for.
// ---------------------------------------------------------------------------

interface DayItem {
  /** What the person is trying to do, in their words. */
  ask: string;
  tool: string;
  input?: Record<string, unknown>;
}

const OWNER_DAY: DayItem[] = [
  { ask: "How much is outstanding across the practice?", tool: "outstanding_balances" },
  { ask: "Give me the practice overview", tool: "practice_overview" },
  { ask: "Pull up Rajesh Patel's record", tool: "patient_record", input: { query: "Rajesh Patel" } },
  { ask: "What's in the diary today?", tool: "appointments" },
  { ask: "What's our cancellation policy?", tool: "search_knowledge", input: { query: "cancellation" } },
  { ask: "Who came in from the assessment this week?", tool: "list_recent_assessment_leads" },
  { ask: "Show me the leads worklist", tool: "list_speed_to_lead" },
  { ask: "Where are people dropping out of the assessment?", tool: "assessment_dropoff_summary", input: { slug: "smile" } },
];

const MANAGER_DAY: DayItem[] = [
  { ask: "Pull up Rajesh Patel's record", tool: "patient_record", input: { query: "Rajesh Patel" } },
  { ask: "Find me a patient called Patel", tool: "search_patients", input: { query: "Patel" } },
  { ask: "What's in the diary today?", tool: "appointments" },
  { ask: "What's our cancellation policy?", tool: "search_knowledge", input: { query: "cancellation" } },
  { ask: "Show me the leads worklist", tool: "list_speed_to_lead" },
  { ask: "Who came in from the assessment this week?", tool: "list_recent_assessment_leads" },
];

const CLINICIAN_DAY: DayItem[] = [
  { ask: "Pull up Rajesh Patel's record", tool: "patient_record", input: { query: "Rajesh Patel" } },
  { ask: "Find me a patient called Patel", tool: "search_patients", input: { query: "Patel" } },
  { ask: "What's my list today?", tool: "appointments" },
  { ask: "What does our policy say about consent?", tool: "search_knowledge", input: { query: "consent" } },
  { ask: "Give me a second look at Rajesh Patel", tool: "second_opinion", input: { patient: "Rajesh Patel" } },
  { ask: "What am I working this week?", tool: "my_work" },
];

// A DENTAL NURSE'S DAY, widened by ruling W2-A/1 of 3 Sep 2026. She is a
// `client_staff` login, and "the autoclave is beeping" and "I am locked out of
// the computer" are two of her three most common questions — so both desks are
// hers. Neither holds patient data, and both refuse identically for every role.
const STAFF_DAY: DayItem[] = [
  { ask: "What shifts am I on this week?", tool: "my_work" },
  { ask: "When is the autoclave next due a service?", tool: "equipment_lookup", input: { question: "when is the autoclave due?", lookup: "service" } },
  { ask: "The reception printer will not print", tool: "it_desk", input: { question: "the printer will not print" } },
];

/**
 * Every tool this clearance does NOT hold.
 *
 * DERIVED FROM THE CLEARANCE, not from the day above, and that is deliberate.
 * Wave 2 is still adding tools; a wall written as "everything not on my
 * hand-written list" would go red every time a lane legitimately widens a
 * catalog, and the person fixing it would be tempted to fix it by deleting the
 * assertion. Written this way it stays exactly as strong — every tool outside
 * the catalog must be refused — while the catalog itself is pinned by the
 * DOMAIN assertions, which are the thing the charter actually rules on.
 */
function outsideCatalog(access: keyof typeof TOOL_CATALOG): string[] {
  const held = new Set<string>(TOOL_CATALOG[access]);
  return COPILOT_TOOL_NAMES.filter((n) => !held.has(n));
}

/** Every tool a day's work names must actually be in that clearance's catalog. */
function dayIsInsideCatalog(day: DayItem[], access: keyof typeof TOOL_CATALOG): string[] {
  const held = new Set<string>(TOOL_CATALOG[access]);
  return day.map((d) => d.tool).filter((t) => !held.has(t));
}

describe("JOURNEY 6 — the clearance walls, one ordinary day at a time", () => {
  it("the owner's day: every question is answered, and the owner's catalog is the whole tool list", async () => {
    // THE CONTROL FOR EVERY REFUSAL BELOW. If the owner could not do these
    // things either, every "the manager cannot" assertion in this file would be
    // passing for the wrong reason.
    const ask = dispatchAs("client_owner");
    for (const item of OWNER_DAY) {
      const out = await ask(item.tool, item.input);
      expect(isWalledOff(out), `the owner was refused "${item.ask}": ${JSON.stringify(out).slice(0, 200)}`).toBe(false);
    }
    expect(TOOL_CATALOG.full.length).toBe(COPILOT_TOOL_NAMES.length);
  });

  it("the manager's day: the diary, patients, enquiries and how the practice does things", async () => {
    const ask = dispatchAs("client_coordinator");
    for (const item of MANAGER_DAY) {
      const out = await ask(item.tool, item.input);
      expect(isWalledOff(out), `the manager was refused "${item.ask}"`).toBe(false);
    }
  });

  it("the manager reaches NO money, NO reports, NO marketing, NO sends and NO controls", async () => {
    const ask = dispatchAs("client_coordinator");
    const domains = ACCESS_DOMAINS.manager;

    // Stated as a property of the clearance Record first, so a new tool filed
    // under one of these domains is caught even before anyone writes a scenario.
    expect(domains.acts, "the manager clearance grew an act domain").toEqual([]);
    for (const forbidden of ["money", "reports", "marketing", "controls", "hr", "compliance", "clinical-support"]) {
      expect(domains.reads, `the manager clearance grew "${forbidden}"`).not.toContain(forbidden);
    }

    // The manager's day is inside her catalog, so the refusals below are about
    // the wall rather than about a question nobody can ask.
    expect(dayIsInsideCatalog(MANAGER_DAY, "manager")).toEqual([]);

    // Then driven, tool by tool, through the real dispatch.
    for (const tool of outsideCatalog("manager")) {
      const out = await ask(tool, { query: "x", patient: "Rajesh Patel", confirm: true });
      expect(isWalledOff(out), `the manager reached ${tool}: ${JSON.stringify(out).slice(0, 200)}`).toBe(true);
    }
    expect(H.sent, "a manager's turn put a message on the wire").toEqual([]);
  });

  it("the manager's patient record is projected: the clinical half, and a note where the money was", async () => {
    const out = await dispatchAs("client_coordinator")("patient_record", { query: "Rajesh Patel" });
    const text = JSON.stringify(out);

    expect(text, "lifetime spend reached a manager").not.toMatch(/lifetimeSpend|7350|7,350/);
    expect(text, "an outstanding balance reached a manager").not.toMatch(/1200|1,200/);
    // And it says so, rather than silently omitting — a screen that shows a
    // patient with no balance reads as a patient who owes nothing.
    expect(out.moneyNote, JSON.stringify(out).slice(0, 300)).toBeTruthy();

    // CONTROL: the owner's read of the SAME patient does carry the money.
    const owner = await dispatchAs("client_owner")("patient_record", { query: "Rajesh Patel" });
    expect(JSON.stringify(owner)).toMatch(/1200|7350/);
    expect(owner.moneyNote).toBeUndefined();
  });

  it("whatever pre-visit tool the manager holds, it never returns a patient's own symptom words", async () => {
    // A CROSS-MODULE WALL. Ruling W1-C/2 says the manager sees a symptom COUNT
    // and a discomfort FLAG, never the patient's words — and that ruling is about
    // the RECORD screen. The co-pilot is a second door onto the same data, so the
    // ruling has to hold there too or it has a hole in it.
    //
    // Written to survive the tool being added, renamed or absent: whatever tool
    // the manager's catalog holds whose domain is "patients", asked about a
    // patient with a pre-visit response on file, must not come back with words the
    // patient typed about a symptom.
    const symptomWords = "upper left has been aching for a fortnight";
    world.fake.seed("previsit_response", {
      id: "resp-1",
      target_id: "site-cc:appt-1",
      site_id: SITE,
      dentally_patient_id: "pat-002",
      fork: "full",
      answers: [
        { key: "attending", value: "yes" },
        { key: "concern-words", value: symptomWords },
        { key: "pain-now", value: "8" },
      ],
      interest: [],
    });

    const ask = dispatchAs("client_coordinator");
    for (const tool of TOOL_CATALOG.manager) {
      const out = await ask(tool, { query: "Rajesh Patel", patient: "Rajesh Patel", patientId: "pat-002" });
      expect(
        JSON.stringify(out),
        `a manager read the patient's own symptom words through ${tool}`,
      ).not.toContain(symptomWords);
    }
  });

  it("the clinician's day is answered, and a clinician can never send anything to a patient", async () => {
    const ask = dispatchAs("client_clinician");
    expect(dayIsInsideCatalog(CLINICIAN_DAY, "clinician")).toEqual([]);
    for (const item of CLINICIAN_DAY) {
      const out = await ask(item.tool, item.input);
      expect(isWalledOff(out), `the clinician was refused "${item.ask}"`).toBe(false);
    }

    // Ruling W1-E/1: reads and decision support only, no act domain at all.
    expect(ACCESS_DOMAINS.clinician.acts).toEqual([]);
    for (const sendTool of ["send_sms", "send_email", "nudge_lead", "create_patient"]) {
      const out = await ask(sendTool, { patient: "Rajesh Patel", body: "hello", confirm: true });
      expect(isWalledOff(out), `a clinician reached ${sendTool}`).toBe(true);
    }
    expect(H.sent, "a clinician's turn put a message on the wire").toEqual([]);

    // The refusal explains their clearance without naming a tool they cannot use.
    const refused = await ask("send_sms", { patient: "Rajesh Patel", body: "hi", confirm: true });
    expect(String(refused.message)).toMatch(/your patients, your diary/i);
    expect(String(refused.message)).not.toContain("send_sms");
  });

  it("staff reach their own work and the two desks — and NOTHING else", async () => {
    const ask = dispatchAs("client_staff");
    world.setToggle("equipment", true);
    world.setToggle("it-desk", true);
    world.fake.seed("equipment_asset", {
      id: "asset-1",
      client_id: CLIENT,
      name: "Autoclave (Surgery 1)",
      category: "sterilisation",
      site_id: SITE,
      next_service_due: "2026-12-01",
    });

    // THE WHOLE OF THE STAFF CATALOG, named. Ruling W2-A/1 widened the two desks
    // and widened nothing else, and this is the assertion that holds the second
    // half of that: a fourth tool arriving in this catalog fails here.
    expect(TOOL_CATALOG.staff.slice().sort()).toEqual(["equipment_lookup", "it_desk", "my_work"]);
    expect(ACCESS_DOMAINS.staff.reads.slice().sort()).toEqual(["equipment", "it-desk", "self"]);
    expect(ACCESS_DOMAINS.staff.acts, "the staff clearance grew an act domain").toEqual([]);
    expect(ACCESS_DOMAINS.staff.maxTier, "a nurse can read the practice's private knowledge").toBe(1);

    for (const item of STAFF_DAY) {
      const out = await ask(item.tool, item.input);
      expect(isWalledOff(out), `a nurse was refused "${item.ask}": ${JSON.stringify(out).slice(0, 200)}`).toBe(false);
    }

    // Neither desk hands her anything about a patient — which is the reason the
    // widening was safe, so it is asserted rather than assumed.
    for (const item of STAFF_DAY.slice(1)) {
      const out = await ask(item.tool, item.input);
      const text = JSON.stringify(out);
      expect(text, `${item.tool} returned a patient name to a nurse`).not.toContain("Rajesh");
      expect(text, `${item.tool} returned money to a nurse`).not.toMatch(/1200|7350/);
    }

    expect(dayIsInsideCatalog(STAFF_DAY, "staff")).toEqual([]);
    for (const tool of outsideCatalog("staff")) {
      const out = await ask(tool, { query: "Rajesh Patel", patient: "Rajesh Patel", confirm: true });
      expect(isWalledOff(out), `staff reached ${tool}`).toBe(true);
    }

    // And there is no way to ask about somebody ELSE's work: my_work takes no
    // staff id, so a staff id in the input is simply not a parameter.
    const withId = await ask("my_work", { staffId: "staff-someone-else", staff: "Blerta" });
    expect(JSON.stringify(withId)).not.toContain("staff-someone-else");
    expect(JSON.stringify(withId)).not.toContain("Blerta");
    // (The staff clearance itself is pinned at the top of this test — the two
    // desks and their own work, and nothing more.)
  });

  it("an unknown role reaches nothing at all, including the shapes an attacker would try", async () => {
    // copilotAccessForRole fails CLOSED, and the lookup is a Map so a prototype
    // key cannot walk its way to a clearance.
    for (const role of ["", "admin", "superuser", "__proto__", "constructor", "client_ownerX"]) {
      expect(copilotAccessForRole(role as Role), `"${role}" resolved to a clearance`).toBe("none");
    }

    const ask = dispatchAs("__proto__" as Role);
    for (const tool of COPILOT_TOOL_NAMES) {
      const out = await ask(tool, { query: "x", patient: "Rajesh Patel", confirm: true });
      expect(isWalledOff(out), `an unknown role reached ${tool}`).toBe(true);
    }
    expect(ACCESS_DOMAINS.none.reads).toEqual([]);
    expect(ACCESS_DOMAINS.none.acts).toEqual([]);
    expect(H.sent).toEqual([]);
  });

  it("the tools the model is SHOWN match the tools the gate would allow, at every clearance", async () => {
    // Two independent filters — the schema list handed to the model, and the
    // gate inside the dispatch — and this is where they are held together. The
    // gate is the lock; the schema filter is an optimisation, and an optimisation
    // that disagrees with its lock is how a widening hides.
    for (const role of ["client_owner", "client_coordinator", "client_clinician", "client_staff"] as const) {
      const access = copilotAccessForRole(role);
      const shown = copilotToolsFor(access, COPILOT_TOOLS).map((t) => t.name);
      expect(shown.slice().sort(), role).toEqual(TOOL_CATALOG[access].slice().sort());

      const ask = dispatchAs(role);
      for (const name of COPILOT_TOOL_NAMES) {
        const out = await ask(name, { query: "x", patient: "Rajesh Patel", confirm: true });
        if (isScopeRefusal(out)) {
          expect(shown, `${role} was shown ${name} and then refused it`).not.toContain(name);
        }
      }
    }
  });

  it("every tool is placed in the clearance Record, so a new one cannot arrive unplaced", async () => {
    // The compile-time lock is `Record<CopilotToolName, Domain>`; this is the
    // runtime half of it, and it is what catches a tool added to the schema list
    // without a domain — which would be a tool with no wall around it.
    for (const name of COPILOT_TOOL_NAMES) {
      expect(TOOL_DOMAIN[name as CopilotToolName], `${name} has no domain`).toBeTruthy();
    }
    const schemaNames = COPILOT_TOOLS.map((t) => t.name).sort();
    expect(schemaNames, "the schema list and the clearance list disagree").toEqual(
      [...COPILOT_TOOL_NAMES].sort(),
    );
  });

  it("the knowledge tier is PROVED per clearance, not trusted", async () => {
    // The one place a clearance is observable from outside: the maxTier the
    // practice brain was actually asked for.
    await dispatchAs("client_owner")("search_knowledge", { query: "cancellation" });
    await dispatchAs("client_coordinator")("search_knowledge", { query: "cancellation" });
    await dispatchAs("client_clinician")("search_knowledge", { query: "cancellation" });

    expect(H.knowledgeTiers, "a clearance asked for the wrong knowledge tier").toEqual([4, 2, 1]);
  });

  it("nothing in a whole day of questions reached the network", async () => {
    for (const role of ["client_owner", "client_coordinator", "client_clinician", "client_staff"] as const) {
      const ask = dispatchAs(role);
      for (const item of [...OWNER_DAY, ...MANAGER_DAY, ...CLINICIAN_DAY, ...STAFF_DAY]) {
        await ask(item.tool, item.input);
      }
    }
    expect(guard.calls, "a co-pilot turn put a request on the network").toEqual([]);
    expect(world.rows("dentally_write_intent")).toEqual([]);
    expect(H.sent).toEqual([]);
  });
});
