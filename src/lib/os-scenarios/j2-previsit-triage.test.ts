// ===========================================================================
// JOURNEY 2 — THE PRE-VISIT QUESTIONNAIRE, FULL CIRCLE.
//
// Two patients have an appointment tomorrow. One is on the practice's NHS plan,
// one is private. Neither is ever told which — that word appears nowhere they
// can see it — but the questions they are asked are not the same, and the
// difference is a contractual one: an NHS-plan patient asked about pain has
// volunteered a symptom the practice must then treat under the contract.
//
// SO THE JOURNEY IS: the sweep flags both appointments and resolves each
// patient's bank from their payment plan → the link is composed, scanned and
// queued → the shared drain sends it (dry) → it appears on the patient's
// correspondence record → the patient answers the bank their target names →
// their interest lands on a per-treatment list → the clinician reads their
// words and the manager reads a count and a flag, and no more.
//
// FIVE SEAMS NO SINGLE MODULE'S TESTS CAN SEE: the fork travelling from a
// Dentally payment plan into a target row; the composed body surviving the
// message scan AND fitting one SMS credit with a real link in it; the triage
// outbox being a source the SHARED drain knows about; the drain's send landing
// on the record; and the same projection being the allow-list at submit that it
// was at render, so a hand-posted symptom key against a brief target is dropped.
//
// STUBBED: the DentallyClient class (the network boundary — the sweep and the
// drain each construct their own, and neither may reach a wire). Nothing else.
// The fork decision, the message scan, the outbox, the drain, the record read,
// the projection, the submit route and the summary are all the real code.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  SITE,
  SITE_PHONE,
  createOsWorld,
  installFetchGuard,
  liveDentallyViolations,
  correspondenceViolations,
  dailyCapViolations,
  patientCopyViolations,
  type FetchGuard,
} from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

// The two patients, and the ONE fact that forks them. Plan 1 is the practice's
// NHS plan and plan 2 its private plan (src/lib/patient/profile.ts).
const NHS_PATIENT = { id: "dp-nhs-1", first: "Amara", last: "Okafor", plan: 1, phone: "07700900511" };
const PRIVATE_PATIENT = { id: "dp-priv-1", first: "Tomasz", last: "Nowak", plan: 2, phone: "07700900522" };

const H = vi.hoisted(() => ({
  appointments: [] as Record<string, unknown>[],
  patients: new Map<string, Record<string, unknown>>(),
  /** The Dentally uuid of the ONE site these appointments live at. */
  siteUuid: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));

// THE ONE STUB: the Dentally client class. Both the sweep and the drain build
// their own, so replacing the class is the only place a single seam covers both,
// and it is the network boundary rather than any piece of our own logic.
vi.mock("@/lib/dentally/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/client")>();
  class FakeDentallyClient {
    constructor() {}
    async listAppointments(args: { siteId?: string }) {
      // Per SITE, deliberately. The sweep walks every one of the practice's
      // three sites, and a stub that returned the same appointment to all of
      // them would flag one visit three times — which is not a Dentally any
      // patient has.
      return { appointments: args?.siteId === H.siteUuid ? H.appointments : [] };
    }
    async getPatient(id: string) {
      const p = H.patients.get(id);
      if (!p) throw new actual.DentallyError(404, "no such patient");
      return { patient: p };
    }
  }
  return { ...actual, DentallyClient: FakeDentallyClient };
});

import { POST as previsitSweep } from "@/app/api/previsit/sweep/route";
import { POST as drain } from "@/app/api/messaging/drain/route";
import { POST as previsitSubmit } from "@/app/api/previsit/submit/route";
import { getThreadForPatient } from "@/lib/inbox/repository";
import {
  getTarget,
  listInterest,
  countInterestByTreatment,
  listResponsesForPatient,
  triageTargetId,
} from "@/lib/triage/repository";
import { projectBank } from "@/lib/triage/project";
import { symptomTermIn } from "@/lib/triage/forbidden";
import { projectSummary } from "@/lib/triage/summary";
import { MAX_CHARS, URGENT_HELP_THRESHOLD, urgentHelpLine } from "@/lib/triage/copy";
import { TRIAGE_SYSTEM_SLUG, TRIAGE_DRAIN_SOURCE } from "@/lib/triage/types";
import { DRAIN_SOURCE_TO_SLUG } from "@/lib/systems/catalog";
import { dentallySiteId } from "@/lib/mock/clients";

const ORIGINAL_ENV = { ...process.env };
let guard: FetchGuard;

/**
 * An appointment far enough ahead to be flagged, and near enough to stay inside
 * the sweep's window at EVERY hour of the day.
 *
 * THIS USED TO BE "tomorrow at 09:30 UTC", and that was a clock bomb of exactly
 * the same family as the day-key one. The sweep's window is [now, now + 26h]
 * (leadHours 24 plus two hours of slack), so a UTC calendar hop to tomorrow
 * morning is 14 hours ahead when the suite runs at 19:30 and 32 hours ahead when
 * it runs at 01:30 — inside the window in the evening, outside it after
 * midnight. Green on a developer's machine, red on a nightly CI run, and the
 * shifted-clock sweep at the two DST changeover instants is what surfaced it.
 *
 * An offset from `now` has no such edge: twelve hours ahead is twelve hours
 * ahead whatever the clock says, whatever the timezone is doing, and on both
 * sides of a DST change.
 */
function soonIso(hoursAhead = 12): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

function seedDentally(): void {
  H.siteUuid = dentallySiteId(SITE);
  H.appointments = [
    { id: "appt-nhs", patient_id: NHS_PATIENT.id, start_time: soonIso(), state: "booked" },
    { id: "appt-priv", patient_id: PRIVATE_PATIENT.id, start_time: soonIso(), state: "booked" },
  ];
  H.patients.clear();
  for (const p of [NHS_PATIENT, PRIVATE_PATIENT]) {
    H.patients.set(p.id, {
      id: p.id,
      first_name: p.first,
      last_name: p.last,
      mobile_phone: p.phone,
      use_sms: true,
      payment_plan_id: p.plan,
    });
  }
}

beforeEach(() => {
  world.reset();
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MESSAGING_DRY_RUN; // absent = DRY RUN
  delete process.env.CRON_SECRET;
  delete process.env.DENTALLY_WRITE_ENABLED;
  process.env.DENTALLY_API_KEY = "test-read-key";
  process.env.DENTALLY_BASE_URL = "http://localhost:3000/api/mock-dentally";
  // PUBLIC_BASE_URL must be set or the link cannot be built and every target is
  // stopped with reason `no_link` — a real failure mode, and not this journey's.
  process.env.PUBLIC_BASE_URL = "https://vitality.example";
  world.setToggle(TRIAGE_SYSTEM_SLUG, true);
  seedDentally();
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

async function runSweep(): Promise<Record<string, unknown>> {
  const res = await previsitSweep(
    new Request("https://vitality.invalid/api/previsit/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function runDrain(): Promise<Record<string, unknown>> {
  const res = await drain(new Request("https://vitality.invalid/api/messaging/drain", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

/**
 * The sweep queues at `not_before_at = dueAt`, which is deliberately in the
 * future. Bring the queued rows forward so the drain has something to send —
 * the alternative is a fake clock across two routes, which would prove less.
 */
function releaseQueuedRows(): void {
  for (const row of world.fake.db.tables.previsit_outbox ?? []) {
    row.not_before_at = new Date(Date.now() - 60_000).toISOString();
  }
}

function targetFor(appointmentId: string) {
  return getTarget(triageTargetId(SITE, appointmentId));
}

/**
 * Submit exactly the payload the public form posts: answers as `{key,value}`
 * pairs and the interest grid as `{treatment,answer}` rows, every row present.
 */
async function submitFor(
  appointmentId: string,
  answers: Record<string, string>,
  interest: Record<string, "yes" | "not_now">,
) {
  const target = await targetFor(appointmentId);
  const res = await previsitSubmit(
    new Request("https://vitality.example/api/previsit/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: target!.linkToken,
        answers: Object.entries(answers).map(([key, value]) => ({ key, value })),
        interest: Object.entries(interest).map(([treatment, answer]) => ({ treatment, answer })),
      }),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown>, target };
}

describe("JOURNEY 2 — pre-visit triage: appointment → link → answers → interest → the two summaries", () => {
  it("step 1: the sweep flags both appointments and forks each one from its payment plan", async () => {
    const body = await runSweep();
    expect(body.skipped, JSON.stringify(body)).toBeUndefined();

    const nhs = await targetFor("appt-nhs");
    const priv = await targetFor("appt-priv");
    expect(nhs, "the NHS-plan patient's appointment was not flagged").toBeTruthy();
    expect(priv, "the private patient's appointment was not flagged").toBeTruthy();

    // THE FORK, resolved server-side from the plan and stored on the row. The
    // words "full" and "brief" are the only vocabulary the platform keeps: a
    // column that never holds a funding word cannot leak one.
    expect(nhs!.fork).toBe("brief");
    expect(priv!.fork).toBe("full");
    expect(nhs!.status).toBe("queued");
    expect(nhs!.consentSms).toBe(true);
    expect(nhs!.patientName).toBe("Amara Okafor");
  });

  it("step 2: the link is one SMS credit, names the practice, and says nothing about funding", async () => {
    await runSweep();

    const outbox = world.rows("previsit_outbox");
    expect(outbox, "no link was queued").toHaveLength(2);

    for (const row of outbox) {
      const text = String(row.body);
      // ONE CREDIT is the rule, and it is measured on the WHOLE body with the
      // real 22-character token in it, not on a template.
      expect(text.length, `body is ${text.length} chars: ${text}`).toBeLessThanOrEqual(MAX_CHARS);
      expect(text, "the message does not name the practice").toContain("Vitality Dental");
      expect(text, "the message carries no link").toMatch(/https:\/\/vitality\.example\/pv\/[A-Za-z0-9_-]{22}/);
      expect(patientCopyViolations("previsit link", [text])).toEqual([]);
      expect(row.status).toBe("queued");
    }

    // The touch row is written too — the outbox alone would send a message that
    // appears nowhere on the record.
    expect(world.rows("previsit_touch")).toHaveLength(2);
  });

  it("step 3: the SHARED drain sends it dry-run, and the practice's record shows it", async () => {
    await runSweep();
    releaseQueuedRows();

    // The source really is one the shared drain knows about, and it is mapped to
    // a kill-switch slug. An unmapped drain source is an unkillable one.
    expect(DRAIN_SOURCE_TO_SLUG[TRIAGE_DRAIN_SOURCE]).toBe(TRIAGE_SYSTEM_SLUG);

    const body = await runDrain();
    const perSource = (body.perSource ?? {}) as Record<string, Record<string, unknown>>;
    expect(perSource[TRIAGE_DRAIN_SOURCE], JSON.stringify(body)).toBeTruthy();
    expect(perSource[TRIAGE_DRAIN_SOURCE].sent, JSON.stringify(body)).toBe(2);

    const outbox = world.rows("previsit_outbox");
    for (const row of outbox) {
      expect(row.status).toBe("sent");
      expect(row.provider).toBe("dry-run");
      expect(String(row.to_address)).toMatch(/^\+44/);
    }
    // The target has moved on too, so the sweep will not re-queue it.
    expect((await targetFor("appt-nhs"))!.status).toBe("sent");

    const read = await getThreadForPatient([SITE], NHS_PATIENT.id);
    expect(correspondenceViolations(read, ["previsit"])).toEqual([]);
  });

  it("step 4: the NHS-plan patient is never asked about a symptom — at render AND at submit", async () => {
    await runSweep();
    const nhs = await targetFor("appt-nhs");

    // (a) WHAT THE PAGE WOULD RENDER. projectBank is the single function the
    //     public page and the submit route both call, so this is not a parallel
    //     implementation of the rule.
    const bank = projectBank(nhs!.fork, null);
    expect(bank.questions.length, "the brief bank is empty").toBeGreaterThan(0);
    for (const q of bank.questions) {
      expect(q.kind, `"${q.label}" is a symptom question on the brief bank`).not.toBe("symptom");
      expect(
        symptomTermIn(q.label),
        `"${q.label}" uses a symptom term on the brief bank`,
      ).toBeNull();
      expect(symptomTermIn(q.help ?? "")).toBeNull();
      expect(patientCopyViolations("brief bank", [q.label, q.help ?? ""])).toEqual([]);
    }

    // (b) NON-VACUOUS CONTROL. The private patient's bank DOES ask, so (a) is a
    //     property of the fork rather than of the question list being empty.
    const full = projectBank((await targetFor("appt-priv"))!.fork, null);
    expect(
      full.questions.some((q) => q.kind === "symptom"),
      "the full bank asks no symptom question — then (a) proves nothing",
    ).toBe(true);

    // (c) AND THE SUBMIT ROUTE HOLDS THE SAME LINE. A symptom key hand-posted
    //     against a brief target is dropped, not stored, however it arrives.
    const { res, body } = await submitFor(
      "appt-nhs",
      { attending: "yes", "health-changed": "no", "pain-now": "9", "concern-words": "my tooth is agony" },
      { whitening: "not_now", straightening: "yes", implants: "not_now", "veneers-bonding": "not_now" },
    );
    expect(res.status, JSON.stringify(body)).toBe(200);

    const stored = await listResponsesForPatient([SITE], NHS_PATIENT.id, 5);
    expect(stored, "the answers were not stored").toHaveLength(1);
    const keys = stored[0].answers.map((a) => a.key);
    expect(keys, "a symptom answer was stored against a brief-fork patient").not.toContain("pain-now");
    expect(keys).not.toContain("concern-words");
    expect(keys).toContain("attending");
  });

  it("step 5: a Yes lands on the per-treatment interest list, and a refusal is recorded as an answer", async () => {
    await runSweep();
    // "checkup" is one of visit-reason's OWN option values. A choice answer that
    // is not is a hard refusal, not a stored string — so this also proves the
    // submit is not simply accepting whatever it is handed.
    const { res, body } = await submitFor(
      "appt-priv",
      { attending: "yes", "health-changed": "no", "visit-reason": "checkup" },
      { whitening: "yes", straightening: "yes", implants: "not_now", "veneers-bonding": "not_now" },
    );
    expect(res.status, JSON.stringify(body)).toBe(200);

    // listInterest defaults to answer "yes" — the list a campaign would target.
    const yes = await listInterest({ siteIds: [SITE] });
    expect(yes.map((r) => r.treatment).sort()).toEqual(["straightening", "whitening"]);
    expect(yes[0].dentallyPatientId).toBe(PRIVATE_PATIENT.id);
    expect(yes[0].patientName).toBe("Tomasz Nowak");

    // "Not right now" is a real answer, stored, not an absence — which is what
    // makes the grid required-but-refusable rather than required.
    const notNow = await listInterest({ siteIds: [SITE], answer: "not_now" });
    expect(notNow.map((r) => r.treatment).sort()).toEqual(["implants", "veneers-bonding"]);

    const counts = await countInterestByTreatment([SITE]);
    expect(counts.whitening).toBe(1);
    expect(counts.implants ?? 0).toBe(0);
  });

  it("step 6: the clinician reads the patient's words; the manager reads a count and a flag", async () => {
    await runSweep();
    await submitFor(
      "appt-priv",
      {
        attending: "yes",
        "health-changed": "no",
        "visit-reason": "something-bothering",
        "concern-words": "upper left has been aching for a fortnight",
        "pain-now": String(URGENT_HELP_THRESHOLD + 1),
      },
      { whitening: "not_now", straightening: "not_now", implants: "not_now", "veneers-bonding": "not_now" },
    );

    const [response] = await listResponsesForPatient([SITE], PRIVATE_PATIENT.id, 1);
    expect(response, "no response to summarise").toBeTruthy();
    expect(response.fork, "the response did not copy the target's fork").toBe("full");

    // THE CLINICIAN sees the patient's own words.
    const clinical = projectSummary(response, "client_clinician");
    expect(clinical.clinical, "the clinician's summary has no clinical section").not.toBeNull();
    const clinicalText = clinical.clinical!.lines.map((l) => l.answer).join(" | ");
    expect(clinicalText).toContain("aching for a fortnight");

    // THE MANAGER sees a count and a flag, and never the words. A practice-
    // authored record is not the same thing as a patient's own symptom words.
    const manager = projectSummary(response, "client_coordinator");
    expect(manager.clinical, "the manager can read the patient's symptom words").toBeNull();
    expect(manager.flaggedForClinician).toBeGreaterThan(0);
    expect(manager.discomfortReported).toBe(true);
    expect(JSON.stringify(manager)).not.toContain("aching for a fortnight");

    // Both are told which bank was used, in words that name no funding regime.
    expect(patientCopyViolations("summary labels", [manager.forkLabel, manager.forkNote])).toEqual([]);
  });

  it("step 7: a score at or above the threshold shows the help-now line with THIS site's real number", async () => {
    const line = urgentHelpLine(SITE_PHONE);
    expect(URGENT_HELP_THRESHOLD).toBe(7);
    expect(line).toContain(SITE_PHONE);
    // "call 111", never "NHS 111" — the patient-facing crawl forbids the word,
    // and the number is the same number either way.
    expect(line).toContain("call 111");
    expect(patientCopyViolations("urgent help line", [line])).toEqual([]);

    // It never invents a number when the site has none on file.
    const noPhone = urgentHelpLine(null);
    expect(noPhone).toContain("please call the practice.");
    expect(noPhone).not.toMatch(/\d{4}/);
  });

  it("step 8: the standing invariants hold, and nothing was written back to Dentally", async () => {
    await runSweep();
    releaseQueuedRows();
    await runDrain();
    await submitFor(
      "appt-nhs",
      { attending: "yes", "health-changed": "no" },
      { whitening: "yes", straightening: "not_now", implants: "not_now", "veneers-bonding": "not_now" },
    );

    expect(liveDentallyViolations(world, guard)).toEqual([]);
    expect(guard.calls, "a scenario put a request on the network").toEqual([]);
    // Triage READS Dentally and writes nothing back to it — the questionnaire is
    // an authored record this platform keeps. No intent row is the right answer.
    expect(world.rows("dentally_write_intent")).toEqual([]);

    for (const patient of [NHS_PATIENT, PRIVATE_PATIENT]) {
      const read = await getThreadForPatient([SITE], patient.id);
      expect(correspondenceViolations(read, ["previsit"])).toEqual([]);
      for (const message of read.thread!.messages) {
        expect(patientCopyViolations("record", [message.body])).toEqual([]);
      }
    }

    expect(dailyCapViolations(world)).toEqual([]);
    // The pre-visit link is TRANSACTIONAL: exempt from the once-per-day cap, but
    // it still stamps the day, so an outreach message later today yields to it.
    const stamps = world.rows("message_daily_log");
    expect(stamps.length, "a transactional send did not stamp the day").toBe(2);
    expect(stamps.every((s) => s.source === TRIAGE_DRAIN_SOURCE)).toBe(true);
  });
});
