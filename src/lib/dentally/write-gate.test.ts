import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// WHAT IS MOCKED, AND WHAT IS DELIBERATELY NOT.
//
// NOT mocked: isDentallyWriteEnabled, targetsRealDentally, dentallyWriteMode and
// dentallyWriteTarget. Those read process.env, and the whole point of these
// tests is the EXACT-STRING behaviour of DENTALLY_WRITE_ENABLED — a test that
// stubbed the mode would prove the gate branches on a boolean somebody handed
// it, which is not the property that matters. So the environment is set for real
// and the real predicates run.
//
// Mocked: dentallyAgentClient (so no test can put a request on a wire), the
// ledger (so an intent is an assertion rather than a database round trip) and
// the kill-switch reads.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  client: {
    createPatient: vi.fn(async () => ({ patient: { id: "pat-1" } })),
    updatePatient: vi.fn(async () => ({ patient: { id: "pat-1", active: true } })),
    createAppointment: vi.fn(async () => ({ appointment: { id: "appt-1" } })),
    updateAppointment: vi.fn(async () => ({ appointment: { id: "appt-1" } })),
    cancelAppointment: vi.fn(async () => ({ appointment: { id: "appt-1", state: "cancelled" } })),
  },
  agentClient: vi.fn(),
  recordWriteIntent: vi.fn(async (input: Record<string, unknown>) => (input ? "intent-1" : null) as string | null),
  isSystemEnabled: vi.fn(async (_clientId: string, _slug: string) => true),
  isSystemEnabledStrict: vi.fn(async (_clientId: string, _slug: string) => true),
  // Only an EXPLICIT disabling row counts, and only while writes are simulated.
  isSystemExplicitlyDisabled: vi.fn(async (_clientId: string, _slug: string) => false),
}));
h.agentClient.mockImplementation(() => h.client);

vi.mock("./write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./write")>();
  return { ...actual, dentallyAgentClient: h.agentClient };
});
vi.mock("./sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-ledger")>();
  return { ...actual, recordWriteIntent: h.recordWriteIntent };
});
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  isSystemExplicitlyDisabled: h.isSystemExplicitlyDisabled,
}));

import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";
import { DENTALLY_WRITE_KINDS } from "./sync-ledger";
import {
  DENTALLY_WRITE_MASTER_SLUG,
  DENTALLY_WRITE_SOURCES,
  DentallyWriteRefused,
  dentallyWrite,
  dentallyWriteMode,
  dentallyWriteTarget,
  isLiveDentallyHost,
  precheckDentallyWrite,
  sanitiseActor,
  summariseWritePayload,
  targetLabel,
  writeSlugFor,
  type DentallyWriteSource,
} from "./write-gate";
import { targetsRealDentally } from "./write";

const ENV_KEYS = [
  "DENTALLY_WRITE_ENABLED",
  "DENTALLY_WRITE_API_KEY",
  "DENTALLY_WRITE_BASE_URL",
  "DENTALLY_BASE_URL",
  "DENTALLY_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

/** Writes OFF, and the base URL pointing at the LIVE practice book (production). */
function gateOffAgainstLiveDentally(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DENTALLY_API_KEY = "read-key";
}

/** Writes OFF, base URL pointing at the local mock (a developer's machine). */
function gateOffAgainstTheMock(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DENTALLY_API_KEY = "read-key";
  process.env.DENTALLY_BASE_URL = "http://localhost:3000/api/mock-dentally";
}

/** Writes ON, deliberately, with all three variables set. */
function gateOn(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DENTALLY_WRITE_ENABLED = "true";
  process.env.DENTALLY_WRITE_API_KEY = "write-key";
  process.env.DENTALLY_WRITE_BASE_URL = "https://api.dentally.co";
}

// An OPAQUE user id, which is the only shape of actor this ledger may hold.
const ACTOR_ID = "usr_9f2b41c8";
const ctx = { source: "recall" as DentallyWriteSource, siteId: "site-ng", actor: ACTOR_ID };

/** Every write kind, expressed as a call. One place, so no path is forgotten. */
const CALLS: Array<{ kind: string; run: () => Promise<unknown>; method: keyof typeof h.client }> = [
  { kind: "patient.create", method: "createPatient", run: () => dentallyWrite.createPatient(ctx, { first_name: "A" }) },
  { kind: "patient.update", method: "updatePatient", run: () => dentallyWrite.updatePatient(ctx, "pat-1", { active: false }) },
  { kind: "appointment.create", method: "createAppointment", run: () => dentallyWrite.createAppointment(ctx, { patient_id: "pat-1" }) },
  { kind: "appointment.update", method: "updateAppointment", run: () => dentallyWrite.updateAppointment(ctx, "appt-1", { start_time: "x" }) },
  { kind: "appointment.cancel", method: "cancelAppointment", run: () => dentallyWrite.cancelAppointment(ctx, "appt-1") },
];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  vi.clearAllMocks();
  h.agentClient.mockImplementation(() => h.client);
  h.recordWriteIntent.mockResolvedValue("intent-1");
  h.isSystemEnabled.mockResolvedValue(true);
  h.isSystemEnabledStrict.mockResolvedValue(true);
  h.isSystemExplicitlyDisabled.mockResolvedValue(false);
  h.client.createPatient.mockResolvedValue({ patient: { id: "pat-1" } });
  h.client.updatePatient.mockResolvedValue({ patient: { id: "pat-1", active: true } });
  h.client.createAppointment.mockResolvedValue({ appointment: { id: "appt-1" } });
  h.client.updateAppointment.mockResolvedValue({ appointment: { id: "appt-1" } });
  h.client.cancelAppointment.mockResolvedValue({ appointment: { id: "appt-1", state: "cancelled" } });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The single intent the gate filed during a call. */
function intent(): Record<string, unknown> {
  expect(h.recordWriteIntent).toHaveBeenCalledTimes(1);
  return h.recordWriteIntent.mock.calls[0][0];
}

// ===========================================================================
describe("the mode is decided by the EXACT string, like MESSAGING_DRY_RUN", () => {
  it('is live ONLY for "true" with a write key and an explicit write base URL', () => {
    gateOn();
    expect(dentallyWriteMode()).toBe("live");
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "true ", ""])(
    'treats DENTALLY_WRITE_ENABLED=%j as a DRY RUN, never as live',
    (value) => {
      gateOn();
      process.env.DENTALLY_WRITE_ENABLED = value;
      expect(dentallyWriteMode()).toBe("dry_run");
    },
  );

  it('is a dry run when the flag says "true" but the write key or base URL is missing', () => {
    // Three variables, on purpose: enabling writes must never be able to default
    // silently at production Dentally because one of them was forgotten.
    gateOn();
    delete process.env.DENTALLY_WRITE_API_KEY;
    expect(dentallyWriteMode()).toBe("dry_run");
    gateOn();
    delete process.env.DENTALLY_WRITE_BASE_URL;
    expect(dentallyWriteMode()).toBe("dry_run");
  });

  it("resolves the TARGET host from the same variables the client factory uses", () => {
    gateOffAgainstLiveDentally();
    expect(dentallyWriteTarget()).toEqual({ host: "api.dentally.co", live: true });
    gateOffAgainstTheMock();
    expect(dentallyWriteTarget()).toEqual({ host: "localhost:3000", live: false });
    gateOn();
    expect(dentallyWriteTarget().live).toBe(true);
  });
});

// ===========================================================================
describe("with the gate OFF, nothing reaches the live practice book", () => {
  it.each(CALLS)("$kind: never calls the client, and refuses loudly", async ({ run, method }) => {
    gateOffAgainstLiveDentally();
    await expect(run()).rejects.toBeInstanceOf(DentallyWriteRefused);
    // THE MUTATION PIN. Not "the write failed" — the client was never built and
    // the method was never called, so there was nothing on the wire to fail.
    expect(h.agentClient).not.toHaveBeenCalled();
    expect(h.client[method]).not.toHaveBeenCalled();
  });

  it.each(CALLS)("$kind: files the attempt as blocked/writes_disabled, so it does not vanish", async ({ run, kind }) => {
    // "This is what staff tried to send to Dentally while write-back was off."
    // It is NOT `queued`: nothing here will ever be replayed, and a status that
    // implied a pending delivery would be a promise the platform has not made.
    gateOffAgainstLiveDentally();
    await expect(run()).rejects.toThrow();
    const filed = intent();
    expect(filed.kind).toBe(kind);
    expect(filed.status).toBe("blocked");
    expect(filed.blockedReason).toBe("writes_disabled");
    expect(filed.target).toBe("api.dentally.co");
  });

  it.each(CALLS)("$kind: is never recorded as QUEUED, which has no producer", async ({ run }) => {
    gateOffAgainstLiveDentally();
    await expect(run()).rejects.toThrow();
    expect(intent().status).not.toBe("queued");
  });

  it.each(CALLS)("$kind: NEVER records a 'sent' while the gate is off", async ({ run }) => {
    gateOffAgainstLiveDentally();
    await expect(run()).rejects.toThrow();
    expect(intent().status).not.toBe("sent");
  });

  it("names the gate, not Dentally, as the reason", async () => {
    gateOffAgainstLiveDentally();
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toMatchObject({
      reason: "writes_disabled",
    });
  });

  it("still performs against the LOCAL MOCK, and still calls it a dry run", async () => {
    // The developer's booking flow writes to /api/mock-dentally and must keep
    // working. What it must NEVER do is claim it went to the practice's book.
    gateOffAgainstTheMock();
    const res = await dentallyWrite.createAppointment(ctx, { patient_id: "pat-1" });
    expect(res.appointment.id).toBe("appt-1");
    expect(h.client.createAppointment).toHaveBeenCalledTimes(1);
    const filed = intent();
    expect(filed.status).toBe("dry_run");
    expect(filed.target).toBe("localhost:3000");
    expect(filed.responseId).toBe("appt-1");
  });
});

// ===========================================================================
describe("with the gate ON, the write happens and is recorded as sent", () => {
  it.each(CALLS)("$kind: performs the write and files a 'sent' intent", async ({ run, kind, method }) => {
    gateOn();
    await run();
    expect(h.client[method]).toHaveBeenCalledTimes(1);
    const filed = intent();
    expect(filed.kind).toBe(kind);
    expect(filed.status).toBe("sent");
    expect(filed.responseId).toBeTruthy();
    expect(filed.actor).toBe(ACTOR_ID);
  });

  it("records the client the site belongs to, resolved from the site id", async () => {
    gateOn();
    await dentallyWrite.createAppointment(ctx, { patient_id: "pat-1" });
    // site-ng is one of the pilot practice's sites; the gate resolves the client
    // rather than making the caller repeat it.
    expect(intent().clientId).toBe("vitality");
    expect(intent().siteId).toBe("site-ng");
  });
});

// ===========================================================================
describe("the kill switch stops a Dentally write, not only a message", () => {
  it("blocks when the source's system is switched off, and never calls the client", async () => {
    gateOn();
    // The MASTER stays on: this is about the module's own switch, and a test
    // that turned both off would pass on the wrong one.
    h.isSystemEnabledStrict.mockImplementation(async (_c: string, slug: string) => slug !== "recall");
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toBeInstanceOf(DentallyWriteRefused);
    expect(h.client.createAppointment).not.toHaveBeenCalled();
    const filed = intent();
    expect(filed.status).toBe("blocked");
    expect(filed.blockedReason).toBe("system_off");
  });

  it("asks the STRICT (fail-closed) reader when writes are live", async () => {
    gateOn();
    await dentallyWrite.createAppointment(ctx, {});
    expect(h.isSystemEnabledStrict).toHaveBeenCalledWith("vitality", "recall");
    expect(h.isSystemEnabled).not.toHaveBeenCalled();
  });

  it("asks the fail-OPEN reader while writes are only simulated", async () => {
    // Same reasoning isSystemEnabledForSend uses: a toggle-read blip must not
    // halt a developer's machine, and must halt a live write.
    gateOffAgainstTheMock();
    await dentallyWrite.createAppointment(ctx, {});
    expect(h.isSystemEnabled).toHaveBeenCalledWith("vitality", "recall");
    expect(h.isSystemEnabledStrict).not.toHaveBeenCalled();
  });

  it("skips the switch for a source that declares it has none, and says why", () => {
    expect(writeSlugFor("patient-admin")).toBe(null);
    expect(DENTALLY_WRITE_SOURCES["patient-admin"].whyNoSwitch.length).toBeGreaterThan(60);
  });
});

// ===========================================================================
describe("the owner's MASTER switch sits above every write", () => {
  it("blocks with master_off when the owner has switched Dentally write-back off", async () => {
    gateOn();
    h.isSystemEnabledStrict.mockImplementation(
      async (_c: string, slug: string) => slug !== DENTALLY_WRITE_MASTER_SLUG,
    );
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toMatchObject({ reason: "master_off" });
    expect(h.client.createAppointment).not.toHaveBeenCalled();
    expect(intent()).toMatchObject({ status: "blocked", blockedReason: "master_off" });
  });

  it("is asked BEFORE the module's own switch, so the owner reads the lever they flipped", async () => {
    // Both off. The reason has to be the master, because that is the one control
    // the owner used and the one they will look at to undo it.
    gateOn();
    h.isSystemEnabledStrict.mockResolvedValue(false);
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toMatchObject({ reason: "master_off" });
  });

  it("stops EVERY kind, not just appointments", async () => {
    gateOn();
    h.isSystemEnabledStrict.mockImplementation(
      async (_c: string, slug: string) => slug !== DENTALLY_WRITE_MASTER_SLUG,
    );
    for (const call of CALLS) {
      vi.clearAllMocks();
      h.isSystemEnabledStrict.mockImplementation(
        async (_c: string, slug: string) => slug !== DENTALLY_WRITE_MASTER_SLUG,
      );
      await expect(call.run()).rejects.toMatchObject({ reason: "master_off" });
      expect(h.client[call.method]).not.toHaveBeenCalled();
    }
  });

  it("asks the STRICT reader when live: a missing row and an unreadable table both mean OFF", async () => {
    gateOn();
    await dentallyWrite.createAppointment(ctx, {});
    expect(h.isSystemEnabledStrict).toHaveBeenCalledWith("vitality", DENTALLY_WRITE_MASTER_SLUG);
    expect(h.isSystemExplicitlyDisabled).not.toHaveBeenCalled();
  });

  it("asks only for an EXPLICIT disabling while writes are simulated", async () => {
    // The master is defaultEnabled:false in the catalog, which is right for an
    // armed deployment and would otherwise brick every developer machine and the
    // whole mock test suite, where nothing can reach a real book anyway.
    gateOffAgainstTheMock();
    await dentallyWrite.createAppointment(ctx, {});
    expect(h.isSystemExplicitlyDisabled).toHaveBeenCalledWith("vitality", DENTALLY_WRITE_MASTER_SLUG);
    expect(h.isSystemEnabledStrict).not.toHaveBeenCalled();
    expect(h.client.createAppointment).toHaveBeenCalledTimes(1);
  });

  it("still refuses a simulated write when the owner HAS explicitly turned it off", async () => {
    gateOffAgainstTheMock();
    h.isSystemExplicitlyDisabled.mockResolvedValue(true);
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toMatchObject({ reason: "master_off" });
    expect(h.client.createAppointment).not.toHaveBeenCalled();
  });

  it("names a slug the owner's control panel really has", () => {
    expect(SYSTEM_BY_SLUG.has(DENTALLY_WRITE_MASTER_SLUG)).toBe(true);
    // DEFAULT-OFF: the absence of a row must never arm writes to a real book.
    expect(SYSTEM_BY_SLUG.get(DENTALLY_WRITE_MASTER_SLUG)?.defaultEnabled).toBe(false);
  });
});

// ===========================================================================
describe("the precheck records the attempt, then refuses", () => {
  it("returns the refusal AND files exactly one blocked row", async () => {
    gateOffAgainstLiveDentally();
    const refused = await precheckDentallyWrite({
      ctx,
      kind: "appointment.create",
      patientId: "pat-3",
    });
    expect(refused).toBeInstanceOf(DentallyWriteRefused);
    expect(refused?.reason).toBe("writes_disabled");
    expect(intent()).toMatchObject({
      status: "blocked",
      blockedReason: "writes_disabled",
      kind: "appointment.create",
      dentallyPatientId: "pat-3",
    });
  });

  it("returns null and records NOTHING when the gate is open", async () => {
    // One action, one row. The write that follows files it; a precheck that also
    // filed one would double every booking in the practice's ledger.
    gateOn();
    await expect(precheckDentallyWrite({ ctx, kind: "appointment.create" })).resolves.toBe(null);
    expect(h.recordWriteIntent).not.toHaveBeenCalled();
  });

  it("never reaches a client, whatever the answer", async () => {
    gateOffAgainstLiveDentally();
    await precheckDentallyWrite({ ctx, kind: "appointment.create" });
    expect(h.agentClient).not.toHaveBeenCalled();
  });

  it("shares the gate's policy: it refuses everything the write would refuse", async () => {
    gateOn();
    h.isSystemEnabledStrict.mockImplementation(async (_c: string, slug: string) => slug !== "recall");
    const refused = await precheckDentallyWrite({ ctx, kind: "appointment.create" });
    expect(refused?.reason).toBe("system_off");
  });
});

// ===========================================================================
describe("the actor is an opaque id, never a person's address", () => {
  it("stores an id as given", () => {
    expect(sanitiseActor("usr_9f2b41c8")).toBe("usr_9f2b41c8");
    expect(sanitiseActor("agent:booking-agent")).toBe("agent:booking-agent");
  });

  it("REDACTS anything address-shaped rather than storing it", () => {
    // The braces on the belt: call sites pass auth?.id and a source crawl fails
    // if one ever passes an email, and a slip that got past both is redacted here
    // rather than filed beside a patient's Dentally id.
    expect(sanitiseActor("blerta@vitalitydental.co.uk")).toBe("[redacted:email]");
    expect(sanitiseActor("Blerta <blerta@vitalitydental.co.uk>")).toBe("[redacted:email]");
  });

  it("treats an empty or absent actor as absent, never as a string", () => {
    expect(sanitiseActor(null)).toBe(null);
    expect(sanitiseActor(undefined)).toBe(null);
    expect(sanitiseActor("   ")).toBe(null);
  });

  it("a fixture email handed to the gate NEVER reaches a stored row", async () => {
    gateOn();
    await dentallyWrite.createAppointment({ ...ctx, actor: "blerta@vitalitydental.co.uk" }, {});
    const filed = intent();
    expect(JSON.stringify(filed)).not.toContain("blerta@vitalitydental.co.uk");
    expect(filed.actor).toBe("[redacted:email]");
  });
});

// ===========================================================================
describe("the target host says where a write really went", () => {
  it("agrees with targetsRealDentally for the same host", () => {
    // One rule, two shapes: targetsRealDentally judges a URL beside the client,
    // isLiveDentallyHost judges a stored host and can be read in a browser.
    for (const [url, host] of [
      ["https://api.dentally.co", "api.dentally.co"],
      ["https://api.sandbox.dentally.co", "api.sandbox.dentally.co"],
      ["http://localhost:3000/api/mock-dentally", "localhost:3000"],
      ["https://dentally.co.evil.test", "dentally.co.evil.test"],
    ] as const) {
      expect(isLiveDentallyHost(host), host).toBe(targetsRealDentally(url));
    }
  });

  it("labels a non-Dentally host as the local mock, so a test write cannot read as a rehearsal", () => {
    expect(targetLabel("localhost:3000")).toBe("localhost:3000 (local mock)");
    expect(targetLabel("api.dentally.co")).toBe("api.dentally.co");
  });

  it("treats a host it cannot read as the LIVE book", () => {
    expect(isLiveDentallyHost("")).toBe(true);
  });
});

// ===========================================================================
describe("the blocked reasons a practice can act on", () => {
  it("refuses a write with no target id rather than sending an incomplete request", async () => {
    gateOn();
    await expect(dentallyWrite.updateAppointment(ctx, "", { start_time: "x" })).rejects.toMatchObject({
      reason: "invalid_target",
    });
    expect(h.client.updateAppointment).not.toHaveBeenCalled();
    expect(intent().blockedReason).toBe("invalid_target");
  });

  it("records the client's own read-only latch as BLOCKED, not as a Dentally failure", async () => {
    // Telling a practice "Dentally rejected this" about a request Dentally never
    // saw is the sort of wrong answer that sends somebody to the wrong support desk.
    gateOn();
    const latched = new Error(
      "Dentally 0: refusing POST /v1/appointments: this DentallyClient is read-only. Writes must go through the write client (see isDentallyWriteEnabled).",
    );
    h.client.createAppointment.mockRejectedValue(latched);
    await expect(dentallyWrite.createAppointment(ctx, {})).rejects.toBe(latched);
    const filed = intent();
    expect(filed.status).toBe("blocked");
    expect(filed.blockedReason).toBe("client_read_only");
  });

  it("records a real Dentally refusal as FAILED, and rethrows the original error", async () => {
    // Rethrowing the ORIGINAL matters: every call site in the tree branches on
    // `err instanceof DentallyError` and on its status to tell a 403 from a 422.
    gateOn();
    const rejected = Object.assign(new Error("Dentally 422: date_of_birth is missing"), { status: 422 });
    h.client.createPatient.mockRejectedValue(rejected);
    await expect(dentallyWrite.createPatient(ctx, { first_name: "A" })).rejects.toBe(rejected);
    const filed = intent();
    expect(filed.status).toBe("failed");
    expect(String(filed.error)).toContain("422");
  });
});

// ===========================================================================
describe("the ledger holds ids and shapes, never a patient", () => {
  it("keeps the NAMES of personal fields and none of their values", () => {
    const summary = summariseWritePayload({
      first_name: "Aisha",
      last_name: "Rahman",
      title: "Miss",
      date_of_birth: "1988-04-02",
      email_address: "aisha@example.com",
      mobile_phone: "+447700900123",
      gender: false,
      notes: "Booked online via Smile Assessment. Patient interest: whitening",
      patient_id: "12345",
      site_id: "abc-uuid",
      payment_plan_id: 77,
      start_time: "2026-09-10T09:00:00Z",
      reason: "Exam",
      booked_via_api: true,
    });
    const serialised = JSON.stringify(summary);
    for (const secret of [
      "Aisha",
      "Rahman",
      "Miss",
      "1988-04-02",
      "aisha@example.com",
      "+447700900123",
      "whitening",
    ]) {
      expect(serialised, `the summary leaked ${secret}`).not.toContain(secret);
    }
    // ...while still saying WHICH fields went across, which is the useful half.
    expect(summary.fields).toContain("date_of_birth");
    expect(summary.fields).toContain("mobile_phone");
    expect(summary.fieldCount).toBe(14);
    // ...and keeping the non-personal values in full.
    expect(summary.values).toMatchObject({
      patient_id: "12345",
      payment_plan_id: 77,
      reason: "Exam",
      booked_via_api: true,
    });
  });

  it("is an ALLOW-list: a field nobody predicted keeps its name and loses its value", () => {
    const summary = summariseWritePayload({ nhs_number: "4857773456", address_line_1: "12 Elm Road" });
    expect(summary.fields).toEqual(["address_line_1", "nhs_number"]);
    expect(summary.values).toEqual({});
  });

  it("truncates even an allow-listed string, in case a field has become free text", () => {
    const summary = summariseWritePayload({ reason: "x".repeat(500) });
    expect(String(summary.values.reason).length).toBe(64);
  });

  it("files the Dentally ids, because they are what makes a row actionable", async () => {
    gateOn();
    await dentallyWrite.cancelAppointment({ ...ctx, patientId: "pat-9" }, "appt-7");
    expect(intent().dentallyAppointmentId).toBe("appt-7");
    expect(intent().dentallyPatientId).toBe("pat-9");
  });

  it("takes an appointment's patient id off the payload when the caller did not name one", async () => {
    gateOn();
    await dentallyWrite.createAppointment({ source: "recall", siteId: "site-ng" }, { patient_id: "pat-42" });
    expect(intent().dentallyPatientId).toBe("pat-42");
  });
});

// ===========================================================================
describe("the source registry cannot make a write unkillable", () => {
  const sources = Object.keys(DENTALLY_WRITE_SOURCES) as DentallyWriteSource[];

  it("has a source for every writing surface, and none that is empty", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
    for (const s of sources) {
      expect(DENTALLY_WRITE_SOURCES[s].label.length, s).toBeGreaterThan(10);
      expect(DENTALLY_WRITE_SOURCES[s].kinds.length, s).toBeGreaterThan(0);
    }
  });

  it.each(sources)("%s names a slug the owner's control panel really has, or none at all", (source) => {
    const def = DENTALLY_WRITE_SOURCES[source];
    if (def.slug === null) {
      // A null is allowed ONLY with a written reason. Without this a future
      // source could be made unkillable by leaving the field empty — which is
      // exactly the "unmapped = unkillable" trap DRAIN_SOURCE_TO_SLUG carries.
      expect(
        "whyNoSwitch" in def && typeof def.whyNoSwitch === "string" && def.whyNoSwitch.length > 60,
        `${source} has no kill switch and does not say why`,
      ).toBe(true);
      return;
    }
    expect(SYSTEM_BY_SLUG.has(def.slug), `${source} names "${def.slug}", which is not a controllable system`).toBe(
      true,
    );
  });

  it.each(sources)("%s only claims write kinds that exist", (source) => {
    for (const kind of DENTALLY_WRITE_SOURCES[source].kinds) {
      expect(DENTALLY_WRITE_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("every one of the five kinds is claimed by at least one source", () => {
    const claimed = new Set(sources.flatMap((s) => [...DENTALLY_WRITE_SOURCES[s].kinds]));
    for (const kind of DENTALLY_WRITE_KINDS) expect([...claimed]).toContain(kind);
  });
});

// ===========================================================================
describe("a caller may share its own client, and the gate still records the write", () => {
  it("uses the injected client instead of building one", async () => {
    // The booking agent's availability read and its booking MUST hit the same
    // Dentally instance; the gate must not quietly build a second client.
    gateOffAgainstLiveDentally();
    const shared = { createAppointment: vi.fn(async () => ({ appointment: { id: "shared-1" } })) };
    const res = await dentallyWrite.createAppointment({ ...ctx, client: shared }, { patient_id: "p" });
    expect(res.appointment.id).toBe("shared-1");
    expect(h.agentClient).not.toHaveBeenCalled();
    expect(intent().status).toBe("dry_run");
  });

  it("says so loudly when the injected client cannot make the write it was handed", async () => {
    gateOn();
    const partial = { createAppointment: vi.fn() };
    await expect(
      dentallyWrite.updatePatient({ ...ctx, client: partial }, "pat-1", { active: true }),
    ).rejects.toThrow(/carries no updatePatient/);
  });
});
