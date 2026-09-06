import { describe, it, expect, vi, beforeEach } from "vitest";

// The co-pilot create_patient tool: a HIGH-STAKES write to the practice's real Dentally
// book. Mirrors the send_sms two-step discipline, strict validation, a dedupe short-
// circuit, a preview WITHOUT confirm that never writes, a single write only WITH confirm,
// audit logging and honest error read-backs, PLUS three safety properties specific to a
// patient-creating write:
//   - the Dentally write gate is checked BEFORE any network call (E1): nothing is looked
//     up or created while writes are switched off, and the tool never claims "test mode"
//     for a call that never should have reached Dentally at all;
//   - the dedupe check fails CLOSED (E2): if the Dentally search itself errors, creation
//     is refused rather than risking a duplicate;
//   - the dedupe check searches EVERY site of the client (E3), not just the site
//     currently in view, so a patient already registered at a sister site is found.
//
// The dedupe search now goes through the raw Dentally client (dentallyFromEnv().listPatients)
// rather than the swallowing searchPatients() helper, precisely so a per-site failure can
// propagate instead of silently reading as "no match" (see findLikelyExistingPatient /
// rawPatientSearch in ./tools.ts). The write client and the audit log are mocked so we
// test the branching deterministically.

const searchPatients = vi.fn(); // still statically imported by tools.ts for other tool cases (unused by create_patient itself now)
const listPatientsRaw = vi.fn(); // the raw DentallyClient.listPatients, used ONLY by create_patient's dedupe
const createPatient = vi.fn();
const isDentallyWriteEnabled = vi.fn();
const logCopilotAction = vi.fn();

// tools.ts now reaches the Speed-to-lead contact path (the co-pilot can nudge a
// lead), which opens with `import "server-only"` — a Next.js marker package that is
// not installed and that vitest cannot resolve. Stubbed to an empty module, which is
// exactly what it is at runtime on the server. Same line as landing-lead/route.test.ts.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/dentally/read", () => ({
  searchPatients: (...a: unknown[]) => searchPatients(...a),
  dentallyFromEnv: () => ({ listPatients: (...a: unknown[]) => listPatientsRaw(...a) }),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
}));
vi.mock("@/lib/dentally/write", () => ({
  dentallyAgentClient: () => {
    throw new Error("create_patient must go through the write gate, never a client of its own");
  },
  isDentallyWriteEnabled: () => isDentallyWriteEnabled(),
}));
// THE WRITE GATE STANDS BETWEEN THIS TOOL AND DENTALLY (W1-A). The real class is
// kept via importOriginal so `err instanceof DentallyWriteRefused` in tools.ts
// matches the object this mock throws; only the five doors are stubbed, and the
// `createPatient` spy every assertion below already uses is what they call. The
// gate's OWN behaviour (mode, master switch, ledger) is tested in
// src/lib/dentally/write-gate.test.ts, not re-tested here.
vi.mock("@/lib/dentally/write-gate", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    dentallyWrite: {
      createPatient: async (_ctx: unknown, payload: unknown) => createPatient(payload),
    },
  };
});
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));

import { makeCopilotDispatch } from "./tools";
import { DentallyError } from "@/lib/dentally/client";

// The real internal->Dentally site UUIDs for vitality's three sites (from
// src/lib/mock/clients.ts). The write payload must carry site-cc's UUID, not our
// internal id, proving the site mapping is applied.
const SITE_CC_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";

// The co-pilot's view is scoped to ONE site (site-cc); vitality also has site-rv and
// site-ng. E3 requires the dedupe to search all three regardless of this view scope.
const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

// A complete, valid new-patient input (nobody matching in the mocked search).
//
// `title` and `funding` were ADDED on 2026-08-18. They are not decoration: live
// Dentally refuses a registration without a title and a payment plan, so every
// create this tool made before they existed would have 422'd against the real
// practice while the local mock accepted it (DENTALLY.md; memory
// dentally-createpatient-422). The owner is the right person to ask for both, so
// they are required inputs rather than defaults.
const GOOD = {
  firstName: "Jane",
  lastName: "Doe",
  title: "Mrs",
  dateOfBirth: "1990-05-01",
  funding: "NHS",
  phone: "07700900123",
  email: "jane.doe@example.co.uk",
};

/** A raw Dentally-shaped patient row, as the live API returns it. */
function rawPatient(fields: Record<string, unknown>) {
  return { id: "pat-1", first_name: "", last_name: "", ...fields };
}

beforeEach(() => {
  vi.clearAllMocks();
  listPatientsRaw.mockResolvedValue({ patients: [] }); // default: genuinely new patient
  createPatient.mockResolvedValue({ patient: { id: "new-pat-1" } });
  isDentallyWriteEnabled.mockReturnValue(true);
  logCopilotAction.mockResolvedValue(undefined);
});

describe("create_patient write gate (E1: refuses BEFORE any network call)", () => {
  it("refuses outright when the Dentally write gate is off, before any dedupe search or create attempt", async () => {
    isDentallyWriteEnabled.mockReturnValue(false);
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("writes_disabled");
    expect(out.message).toMatch(/switched off/i);
    // Honesty: never call this "test mode" for a call that never reached Dentally.
    expect(out.message).not.toMatch(/test mode/i);
    expect(listPatientsRaw).not.toHaveBeenCalled();
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("refuses even on the unconfirmed preview call, so no dedupe lookup runs while writes are off", async () => {
    isDentallyWriteEnabled.mockReturnValue(false);
    const out = JSON.parse(await dispatch("create_patient", GOOD));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("writes_disabled");
    expect(listPatientsRaw).not.toHaveBeenCalled();
  });
});

describe("create_patient validation (never invents a missing detail)", () => {
  it("rejects a missing last name and never touches the write client", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", dateOfBirth: "1990-05-01", phone: "07700900123" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/first and last name/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a missing date of birth", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", phone: "07700900123" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a FUTURE date of birth", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "2999-01-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an impossible / malformed date of birth", async () => {
    const bad = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "1990-13-40" }));
    expect(bad.created).toBe(false);
    expect(bad.error).toMatch(/valid date of birth/i);
    const notADate = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "last tuesday" }));
    expect(notADate.created).toBe(false);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an absurdly old date of birth (age over 120)", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, dateOfBirth: "1850-01-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a bad phone number", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", phone: "abc" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid mobile number/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects a bad email address", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", email: "not-an-email" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/valid email address/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects when neither a phone nor an email is given", async () => {
    const out = JSON.parse(await dispatch("create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/at least a mobile number or an email/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised gender rather than guessing", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "unsure" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/did not recognise the gender/i);
    expect(createPatient).not.toHaveBeenCalled();
  });
});

describe("create_patient dedupe (short-circuits creation)", () => {
  it("finds an existing record by the same mobile and does NOT create", async () => {
    listPatientsRaw.mockResolvedValue({
      patients: [rawPatient({ id: "pat-existing", first_name: "Jane", last_name: "Doe", mobile_phone: "+447700900123", date_of_birth: "1990-05-01" })],
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.match.id).toBe("pat-existing");
    expect(out.match.matchedOn).toMatch(/mobile/i);
    // The dedupe short-circuits BEFORE any write, even with confirm true.
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("finds an existing record by the same name and date of birth (different phone)", async () => {
    listPatientsRaw.mockResolvedValue({
      patients: [rawPatient({ id: "pat-namedob", first_name: "Jane", last_name: "Doe", mobile_phone: "+447700999999", date_of_birth: "1990-05-01" })],
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.match.id).toBe("pat-namedob");
    expect(out.match.matchedOn).toMatch(/name and date of birth/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("does NOT treat a mere name substring hit (different DOB and contact) as a duplicate", async () => {
    // A broad text hit that is clearly a different person must not block a real new patient.
    listPatientsRaw.mockResolvedValue({
      patients: [
        rawPatient({
          id: "pat-other",
          first_name: "Jane",
          last_name: "Doe-Smith",
          mobile_phone: "+447700111111",
          email_address: "other@example.co.uk",
          date_of_birth: "1975-02-02",
        }),
      ],
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(true);
    expect(createPatient).toHaveBeenCalledTimes(1);
  });

  it("(E2) fails CLOSED and refuses to create when the Dentally dedupe search errors, rather than creating anyway", async () => {
    listPatientsRaw.mockRejectedValue(new Error("Dentally 503: upstream unavailable"));
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("dedupe_check_failed");
    expect(out.message).toMatch(/could not fully check/i);
    expect(createPatient).not.toHaveBeenCalled();
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked:dedupe_check_failed" }));
  });

  it("(E3) searches EVERY site of the client, not just the site currently in view", async () => {
    // The co-pilot's view is scoped to site-cc only; vitality also has site-rv and
    // site-ng, and the dedupe must cover all three so a sister-site patient is found.
    await dispatch("create_patient", GOOD); // preview call is enough to trigger the dedupe search
    const searchedSiteIds = new Set(listPatientsRaw.mock.calls.map((call) => (call[0] as { siteId: string }).siteId));
    // dentallySiteId maps site-cc/site-rv/site-ng to their real Dentally UUIDs; every
    // one of the three must appear, proving the search was not limited to site-cc.
    expect(searchedSiteIds.size).toBeGreaterThanOrEqual(3);
  });

  it("(E3) finds a duplicate at a sister site outside the current view scope", async () => {
    // site-rv's real Dentally UUID (from src/lib/mock/clients.ts).
    const SITE_RV_UUID = "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf";
    listPatientsRaw.mockImplementation(async (args: { siteId: string }) => {
      if (args.siteId === SITE_RV_UUID) {
        return { patients: [rawPatient({ id: "pat-sister-site", first_name: "Jane", last_name: "Doe", mobile_phone: "+447700900123" })] };
      }
      return { patients: [] };
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.match.id).toBe("pat-sister-site");
    expect(out.match.site).toBe("N17 Dental");
    expect(createPatient).not.toHaveBeenCalled();
  });
});

describe("create_patient two-step confirm", () => {
  it("previews (does not write) when not confirmed, reading back every field", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "female" }));
    expect(out.created).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.firstName).toBe("Jane");
    expect(out.lastName).toBe("Doe");
    expect(out.dateOfBirth).toBe("1990-05-01");
    expect(out.phone).toBe("+447700900123"); // normalised to E.164
    expect(out.email).toBe("jane.doe@example.co.uk");
    expect(out.gender).toBe("female");
    expect(out.site).toBe("N15 Vitality Dental");
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("creates exactly once on confirm, mapping the internal site id to Dentally's UUID", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, gender: "female", confirm: true }));
    expect(out.created).toBe(true);
    expect(out.patientId).toBe("new-pat-1");
    expect(createPatient).toHaveBeenCalledTimes(1);
    // THE WHOLE PAYLOAD, not a subset: the defect this tool shipped with was three
    // ABSENT fields, and objectContaining cannot see an absence.
    expect(createPatient).toHaveBeenCalledWith({
      first_name: "Jane",
      last_name: "Doe",
      title: "Mrs",
      date_of_birth: "1990-05-01",
      payment_plan_id: 1, // NHS, confirmed against GET /v1/payment_plans
      // A BOOLEAN. This call used to send the STRING "Female", to an API that
      // answers "gender: must be male or female" to anything that is not a boolean.
      gender: false,
      email_address: "jane.doe@example.co.uk",
      mobile_phone: "+447700900123",
      site_id: SITE_CC_UUID,
      use_sms: true,
      use_email: true,
    });
    expect(logCopilotAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_patient", status: "created", targetRef: "patient:new-pat-1" }),
    );
  });

  it("derives the boolean sex from the title when the owner did not state one", async () => {
    // It used to OMIT gender entirely in this case, which live refuses outright.
    // GOOD carries title "Mrs", so the derivation is false (female).
    await dispatch("create_patient", { ...GOOD, confirm: true });
    const payload = createPatient.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.gender).toBe(false);
    expect(typeof payload.gender).toBe("boolean");

    createPatient.mockClear();
    await dispatch("create_patient", { ...GOOD, title: "Mr", confirm: true });
    expect((createPatient.mock.calls[0][0] as Record<string, unknown>).gender).toBe(true);
  });

  it("lets a sex the owner actually stated beat the title derivation", async () => {
    // The title is a ~2%-wrong default (5 of 232 live "Mr" records are female); a
    // person who says otherwise knows better than the derivation.
    await dispatch("create_patient", { ...GOOD, title: "Mr", gender: "female", confirm: true });
    expect((createPatient.mock.calls[0][0] as Record<string, unknown>).gender).toBe(false);
  });

  it("maps Private to the id that IS Private live (2), not to a positional guess", async () => {
    await dispatch("create_patient", { ...GOOD, funding: "Private", confirm: true });
    expect((createPatient.mock.calls[0][0] as Record<string, unknown>).payment_plan_id).toBe(2);
  });
});

// ===========================================================================
// THE FIELDS LIVE DENTALLY REFUSES A REGISTRATION WITHOUT.
//
// This tool sent NONE of title, payment_plan or a boolean gender, so every create
// it made would have failed 422 against the real practice — invisibly, because the
// local mock defaulted them all. These cases pin the refusals that now happen
// BEFORE any network call, and the sentences that send the model back to the owner
// rather than letting it guess.
// ===========================================================================
describe("create_patient refuses rather than sending a registration live would reject", () => {
  it("will not create without a title, and asks the owner for one", async () => {
    const { title: _title, ...noTitle } = GOOD;
    const out = JSON.parse(await dispatch("create_patient", { ...noTitle, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/title/i);
    expect(out.error).toMatch(/never guess/i);
    expect(createPatient).not.toHaveBeenCalled();
    expect(listPatientsRaw).not.toHaveBeenCalled(); // refused before the dedupe search
  });

  it("will not create on a title Dentally does not carry a sex signal for", async () => {
    // Dr appears in live data (twice: one male, one female) and predicts nothing,
    // so it is not offered — the same refusal the public funnel makes.
    for (const title of ["Dr", "Rev", "Sir", "constructor"]) {
      const out = JSON.parse(await dispatch("create_patient", { ...GOOD, title, confirm: true }));
      expect(out.created, `${title} must be refused`).toBe(false);
      expect(out.error).toMatch(/Mr, Mrs, Miss, Ms, Master/);
    }
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("will not create without knowing how the patient is to be seen", async () => {
    const { funding: _funding, ...noFunding } = GOOD;
    const out = JSON.parse(await dispatch("create_patient", { ...noFunding, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/NHS or privately/i);
    expect(out.error).toMatch(/never assume/i);
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("will not accept a plan the practice has that this tool does not offer", async () => {
    // UDC (47752) is the practice's biggest plan by volume, and is deliberately not
    // selectable: a plan nobody chose must not be reachable by naming it.
    for (const funding of ["UDC", "47752", "Denplan A", "constructor"]) {
      const out = JSON.parse(await dispatch("create_patient", { ...GOOD, funding, confirm: true }));
      expect(out.created, `${funding} must be refused`).toBe(false);
    }
    expect(createPatient).not.toHaveBeenCalled();
  });

  it("reads the title and the funding back in the preview, so the owner approves what is saved", async () => {
    const out = JSON.parse(await dispatch("create_patient", GOOD));
    expect(out.preview).toBe(true);
    expect(out.title).toBe("Mrs");
    expect(out.funding).toBe("NHS");
    // The DERIVED sex is read back too: a person catches a wrong derivation, and
    // nobody can catch a value they were never shown.
    expect(out.gender).toBe("female");
    expect(out.note).toContain("Mrs");
    expect(out.note).toContain("NHS");
  });
});

describe("create_patient honesty (errors, never a misleading dry run)", () => {
  it("surfaces a 403 (key not permitted to create patients) honestly and never retries", async () => {
    createPatient.mockRejectedValue(new DentallyError(403, "forbidden"));
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("dentally_error");
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/does not allow creating patients/i);
    expect(createPatient).toHaveBeenCalledTimes(1); // no auto-retry
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "error:create_failed" }));
  });

  it("surfaces a generic Dentally failure honestly", async () => {
    createPatient.mockRejectedValue(new DentallyError(422, "unprocessable"));
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("dentally_error");
    expect(out.status).toBe(422);
    expect(createPatient).toHaveBeenCalledTimes(1);
  });

  it("reports a real (non-dry-run) creation now that the write gate guarantees writes are enabled", async () => {
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(true);
    expect(out.dryRun).toBe(false);
    expect(out.note).not.toMatch(/test mode/i);
  });

  // -------------------------------------------------------------------------
  // THE WRITE GATE (W1-A). Every outbound Dentally write in the platform goes
  // through it, and the source crawl in write-gate-sites.test.ts enforces that
  // the five client write methods are named in write-gate.ts and nowhere else.
  // These two pin the co-pilot's END of that contract: it goes through the door,
  // and it reports a refusal at the door as a refusal rather than as a failure.
  // -------------------------------------------------------------------------
  it("writes through the GATE and never through a client of its own", async () => {
    // The `dentallyAgentClient` mock at the top of this file THROWS, so a
    // regression that reached for its own client would fail loudly here rather
    // than quietly writing to Dentally outside the ledger and the master switch.
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(true);
    expect(createPatient).toHaveBeenCalledTimes(1);
  });

  it("names itself as the 'copilot' write source, so the ledger does not misdescribe it", async () => {
    // The source decides which kill switch governs the write and what a practice
    // reads in Sync status. Using `onboarding` would have put "registering a
    // completed form" against something an owner typed into a chat.
    const seen: unknown[] = [];
    const gate = await import("@/lib/dentally/write-gate");
    const spy = vi
      .spyOn(gate.dentallyWrite, "createPatient")
      .mockImplementation(async (ctx: unknown, payload: unknown) => {
        seen.push(ctx);
        return createPatient(payload) as Promise<{ patient: { id: string } }>;
      });
    await dispatch("create_patient", { ...GOOD, confirm: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: "copilot", siteId: "site-cc", clientId: "vitality" });
    spy.mockRestore();
  });

  it("reports a gate REFUSAL as a refusal, never as a Dentally failure", async () => {
    // The gate throws rather than returning a "nothing happened" value, and the
    // two must never look alike to the owner: "your write-back switch is off" and
    // "Dentally rejected the details" call for completely different actions.
    const gate = await import("@/lib/dentally/write-gate");
    const spy = vi.spyOn(gate.dentallyWrite, "createPatient").mockImplementation(async () => {
      throw new gate.DentallyWriteRefused(
        "master_off",
        "Your Dentally write-back switch is off in System controls, so nothing was sent.",
      );
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    // THE GATE'S OWN REASON TRAVELS, and this assertion was flipped in wave 3
    // because the old one pinned a defect. It read `writes_disabled` while the
    // gate had refused with `master_off`: harmless while the deployment switch
    // was the only refusal this branch could see, and wrong the moment ruling
    // W3/19 routed patient.create through the Onboarding switch — a caller
    // reading `reason` would send the owner to the write key for a refusal that
    // was their own module switch.
    expect(out.reason).toBe("master_off");
    expect(out.blockedReason).toBe("master_off");
    expect(out.message).toMatch(/write-back switch is off/i);
    // NOT reported as a Dentally rejection, which would send the owner to check
    // the patient's date of birth for a problem that is a switch.
    expect(out.message).not.toMatch(/Dentally rejected/i);
    expect(out.status).toBeUndefined();
    spy.mockRestore();
  });

  it("names the ONBOARDING switch as the reason when that is what refused it (W3/19)", async () => {
    // THE CASE RULING W3/19 CREATED. `copilot::patient.create` resolves the
    // Onboarding module's slug, so an owner who switches New-patient onboarding
    // off in System controls gets `system_off` from the gate here — a refusal
    // this branch could not see while the deployment's write key was the only
    // thing in the way. The `reason` field is machine-readable and is what a
    // caller would act on, so it must be the gate's own reason: "writes_disabled"
    // would send the owner to their agency for a switch on their own screen.
    const gate = await import("@/lib/dentally/write-gate");
    const spy = vi.spyOn(gate.dentallyWrite, "createPatient").mockImplementation(async () => {
      throw new gate.DentallyWriteRefused(
        "system_off",
        "Refusing patient.create: Onboarding is switched off in System controls.",
      );
    });
    const out = JSON.parse(await dispatch("create_patient", { ...GOOD, confirm: true }));
    expect(out.created).toBe(false);
    expect(out.reason).toBe("system_off");
    expect(out.blockedReason).toBe("system_off");
    // The message was already right and stays untouched: it relays the gate's
    // own sentence, which names the control the owner actually threw.
    expect(out.message).toMatch(/Onboarding is switched off in System controls/i);
    expect(out.message).not.toMatch(/Dentally rejected/i);
    spy.mockRestore();
  });
});
