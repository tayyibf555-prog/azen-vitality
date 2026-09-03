// ===========================================================================
// JOURNEY 7 — THE KILL SWITCHES ACTUALLY KILL.
//
// The owner opens System controls the night before a busy Monday and switches
// four things off. This journey is the morning after: for each of the four
// systems wave 1 added, the surface it governs refuses AT THE SERVER, and
// nothing is queued, drafted, sent or written while it is off.
//
// A KILL SWITCH IS NOT A NAV FILTER. Hiding a page stops nobody: the cron still
// ticks, the route still answers a hand-made request, and the model call is
// still spent. So every assertion here is about what the SERVER did — a row that
// was not written, a queue that stayed empty, a model that was never called —
// and never about what a screen showed.
//
// AND EACH ONE HAS ITS CONTROL. An "off" assertion passes just as happily
// against a feature that never worked. So every switch is exercised twice: once
// off, and once ON with the same input, which must SUCCEED. Without the second
// half this file would prove nothing at all.
//
// THE FOURTH SWITCH IS DIFFERENT and gets its own section: Dentally write-back
// needs the practice's switch ON *and* the deployment armed, and the last part
// of this journey is that conjunction — master on, env unarmed, still blocked.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  CLIENT,
  SITE,
  createOsWorld,
  installFetchGuard,
  liveDentallyViolations,
  type FetchGuard,
} from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

const H = vi.hoisted(() => ({
  /** Every model call any surface made. Empty is the point of most of this file. */
  modelCalls: 0,
  appointments: [] as Record<string, unknown>[],
  patients: new Map<string, Record<string, unknown>>(),
  siteUuid: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: async () => true }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => {
        H.modelCalls += 1;
        return { content: [{ type: "text", text: "An answer." }], stop_reason: "end_turn" };
      },
    };
  }
  return { default: FakeAnthropic };
});

vi.mock("@/lib/dentally/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/client")>();
  class FakeDentallyClient {
    constructor() {}
    async listAppointments(args: { siteId?: string }) {
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
import { POST as previsitSubmit } from "@/app/api/previsit/submit/route";
import { POST as equipmentRoute } from "@/app/api/equipment/[action]/route";
import { POST as itdeskRoute } from "@/app/api/itdesk/[action]/route";
import { dentallyWrite, precheckDentallyWrite, DentallyWriteRefused } from "@/lib/dentally/write-gate";
import { DENTALLY_WRITE_MASTER_SLUG } from "@/lib/dentally/write-vocabulary";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import { EQUIPMENT_SLUG } from "@/lib/equipment/types";
import { IT_DESK_SLUG } from "@/lib/itdesk/types";
import { DEFAULT_OFF_SLUGS, defaultEnabledFor } from "@/lib/systems/catalog";
import { getTarget, triageTargetId } from "@/lib/triage/repository";
import { dentallySiteId } from "@/lib/mock/clients";

const ORIGINAL_ENV = { ...process.env };
let guard: FetchGuard;

const PATIENT = { id: "dp-kill-1", first: "Nadia", last: "Khan", phone: "07700900901", plan: 2 };

/**
 * An appointment far enough ahead to be flagged, and near enough to stay inside
 * the sweep's window at EVERY hour of the day.
 *
 * THIS USED TO BE "tomorrow at 09:30 UTC", and that was a clock bomb of the same
 * family as the day-key one. The sweep's window is [now, now + 26h] (leadHours
 * 24 plus two hours of slack), so a UTC calendar hop to tomorrow morning is 14
 * hours ahead when the suite runs at 19:30 and 32 hours ahead when it runs at
 * 01:30 — inside the window in the evening, outside it after midnight. Green on
 * a developer's machine, red on a nightly CI run. The shifted-clock sweep at the
 * two DST changeover instants is what surfaced it.
 *
 * An offset from `now` has no such edge: twelve hours ahead is twelve hours
 * ahead whatever the clock says and on both sides of a DST change.
 */
function soonIso(hoursAhead = 12): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  world.reset();
  H.modelCalls = 0;
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MESSAGING_DRY_RUN;
  delete process.env.CRON_SECRET;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DENTALLY_WRITE_ENABLED;
  delete process.env.DENTALLY_WRITE_API_KEY;
  delete process.env.DENTALLY_WRITE_BASE_URL;
  delete process.env.DENTALLY_BASE_URL;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DENTALLY_API_KEY = "test-read-key";
  process.env.PUBLIC_BASE_URL = "https://vitality.example";

  H.siteUuid = dentallySiteId(SITE);
  H.appointments = [
    { id: "appt-kill", patient_id: PATIENT.id, start_time: soonIso(), state: "booked" },
  ];
  H.patients.clear();
  H.patients.set(PATIENT.id, {
    id: PATIENT.id,
    first_name: PATIENT.first,
    last_name: PATIENT.last,
    mobile_phone: PATIENT.phone,
    use_sms: true,
    payment_plan_id: PATIENT.plan,
  });

  world.fake.seed("equipment_asset", {
    id: "asset-1",
    client_id: CLIENT,
    name: "Autoclave (Surgery 1)",
    category: "sterilisation",
    site_id: SITE,
    next_service_due: "2026-09-02",
  });
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

async function askEquipment(): Promise<Record<string, unknown>> {
  const res = await equipmentRoute(
    new Request("https://vitality.invalid/api/equipment/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: CLIENT, messages: [{ role: "user", content: "When is the autoclave due?" }] }),
    }),
    { params: Promise.resolve({ action: "ask" }) },
  );
  return (await res.json()) as Record<string, unknown>;
}

async function askItDesk(): Promise<Record<string, unknown>> {
  const res = await itdeskRoute(
    new Request("https://vitality.invalid/api/itdesk/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: CLIENT,
        messages: [{ role: "user", content: "The printer in reception will not print." }],
      }),
    }),
    { params: Promise.resolve({ action: "ask" }) },
  );
  return (await res.json()) as Record<string, unknown>;
}

async function runPrevisitSweep(): Promise<Record<string, unknown>> {
  const res = await previsitSweep(
    new Request("https://vitality.invalid/api/previsit/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("JOURNEY 7 — each new system, switched off, refuses at the server", () => {
  it("all four ship default-OFF in the catalog, so an absent row is not an armed system", () => {
    // The FIRST of the two independent OFFs (charter section 0.6). The second is
    // the disabled row each migration seeds, which covers only the databases the
    // migration was applied to; this one covers every client and every
    // environment, including one where nothing has been migrated at all.
    for (const slug of [TRIAGE_SYSTEM_SLUG, EQUIPMENT_SLUG, IT_DESK_SLUG, DENTALLY_WRITE_MASTER_SLUG]) {
      expect(DEFAULT_OFF_SLUGS.has(slug), `${slug} is not default-off in the catalog`).toBe(true);
      expect(defaultEnabledFor(slug), `${slug} would be enabled by an absent row`).toBe(false);
    }
  });

  it("pre-visit triage OFF: the sweep reads nothing, queues nothing, and says why", async () => {
    world.setToggle(TRIAGE_SYSTEM_SLUG, false);
    const body = await runPrevisitSweep();

    expect(body.skipped).toBe("system off");
    expect(world.rows("previsit_target"), "a target was flagged while off").toEqual([]);
    expect(world.rows("previsit_touch")).toEqual([]);
    expect(world.rows("previsit_outbox"), "a link was queued while off").toEqual([]);

    // CONTROL: the same tick with the switch ON does all three.
    world.setToggle(TRIAGE_SYSTEM_SLUG, true);
    const on = await runPrevisitSweep();
    expect(on.skipped, JSON.stringify(on)).toBeUndefined();
    expect(world.rows("previsit_target").length, "the control tick flagged nothing").toBe(1);
    expect(world.rows("previsit_outbox").length).toBe(1);
  });

  it("pre-visit triage OFF: a link already in a patient's hand stops working, and stores nothing", async () => {
    // The sweep is only half the switch. A patient who was sent a link yesterday
    // still has it; switching the system off has to close that door too, and the
    // page and the submit route both read the switch STRICTLY for that reason.
    world.setToggle(TRIAGE_SYSTEM_SLUG, true);
    await runPrevisitSweep();
    const target = await getTarget(triageTargetId(SITE, "appt-kill"));
    expect(target, "no target to test the link against").toBeTruthy();

    world.setToggle(TRIAGE_SYSTEM_SLUG, false);
    const res = await previsitSubmit(
      new Request("https://vitality.example/api/previsit/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: target!.linkToken,
          answers: [{ key: "attending", value: "yes" }],
          interest: [
            { treatment: "whitening", answer: "yes" },
            { treatment: "straightening", answer: "not_now" },
            { treatment: "implants", answer: "not_now" },
            { treatment: "veneers-bonding", answer: "not_now" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(world.rows("previsit_response"), "answers were stored while the system was off").toEqual([]);
    expect(world.rows("treatment_interest")).toEqual([]);
  });

  it("equipment OFF: the desk refuses before the register read and before the model", async () => {
    world.setToggle(EQUIPMENT_SLUG, false);
    const off = await askEquipment();

    expect(off.refused).toBe(true);
    expect(off.reason).toBe("system_off");
    expect(String(off.reply)).toContain("The equipment desk is switched off");
    expect(H.modelCalls, "a switched-off desk spent a model call").toBe(0);

    // CONTROL.
    world.setToggle(EQUIPMENT_SLUG, true);
    const on = await askEquipment();
    expect(on.refused, JSON.stringify(on)).toBeUndefined();
    expect(H.modelCalls).toBe(1);
  });

  it("IT desk OFF: the same, and the playbooks stay readable by design", async () => {
    world.setToggle(IT_DESK_SLUG, false);
    const off = await askItDesk();

    expect(off.refused).toBe(true);
    expect(off.reason).toBe("system_off");
    expect(String(off.reply)).toContain("The IT desk is switched off");
    expect(H.modelCalls).toBe(0);

    world.setToggle(IT_DESK_SLUG, true);
    const on = await askItDesk();
    expect(on.refused, JSON.stringify(on)).toBeUndefined();
    expect(H.modelCalls).toBe(1);
  });

  it("an UNREADABLE toggle table switches all four off, rather than leaving them armed", async () => {
    // The fail direction for a default-off slug is CLOSED at every reader: a
    // database blip must never be the thing that arms a surface that texts
    // patients or answers safety questions.
    world.fake.failTable("system_toggle", "toggles unavailable");

    expect((await runPrevisitSweep()).skipped).toBe("system off");
    expect((await askEquipment()).reason).toBe("system_off");
    expect((await askItDesk()).reason).toBe("system_off");
    expect(H.modelCalls).toBe(0);
    expect(world.rows("previsit_outbox")).toEqual([]);
  });
});

describe("JOURNEY 7 — Dentally write-back needs the switch AND the arming, and one is not enough", () => {
  /** The write every one of these attempts, through a door that injects no client. */
  function attemptWrite() {
    return precheckDentallyWrite({
      ctx: { source: "recall", siteId: SITE, actor: "user-abc", patientId: "dp-kill-1" },
      kind: "appointment.create",
      patientId: "dp-kill-1",
      payload: { patient_id: "dp-kill-1", reason: "Exam" },
    });
  }

  it("the master switch explicitly OFF: refused as master_off, and the module slug never gets a say", async () => {
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, false);
    world.setToggle("recall", true);

    const refused = await attemptWrite();
    expect(refused, "a write got past an explicitly disabled master switch").not.toBeNull();
    expect(refused!.reason).toBe("master_off");
    expect(String(refused!.message)).toContain("switched off in System controls");

    const [row] = world.rows("dentally_write_intent");
    expect(row.status).toBe("blocked");
    expect(row.blocked_reason).toBe("master_off");
    // The master is checked BEFORE the module's own switch, so the reason the
    // practice reads is the one nearest to them and the one they can act on.
    expect(row.module_slug).toBe("recall");
  });

  it("the master switch ON but the deployment NOT armed: still blocked, as writes_disabled", async () => {
    // THE CONJUNCTION, and the point of this section. An owner who has switched
    // write-back on has done everything they can do; the write still cannot
    // happen, because the agency has not armed the deployment. The row says which
    // of the two is in the way, and it is the honest one.
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
    world.setToggle("recall", true);
    expect(process.env.DENTALLY_WRITE_ENABLED).toBeUndefined();

    const refused = await attemptWrite();
    expect(refused, "a write got through with the deployment unarmed").not.toBeNull();
    expect(refused!.reason).toBe("writes_disabled");

    const [row] = world.rows("dentally_write_intent");
    expect(row.status).toBe("blocked");
    expect(row.blocked_reason).toBe("writes_disabled");
    expect(liveDentallyViolations(world, guard)).toEqual([]);
  });

  it("the deployment armed by a NEAR-MISS string is not armed at all", async () => {
    // "TRUE", "1", "yes", " true" are every one of them a dry run. A config typo
    // must fail safe rather than go live against 51,000 real records.
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
    world.setToggle("recall", true);
    process.env.DENTALLY_WRITE_API_KEY = "k";
    process.env.DENTALLY_WRITE_BASE_URL = "https://api.dentally.co";

    for (const value of ["TRUE", "True", "1", "yes", " true", "true "]) {
      world.reset();
      world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
      world.setToggle("recall", true);
      process.env.DENTALLY_WRITE_ENABLED = value;

      const refused = await attemptWrite();
      expect(refused, `"${value}" armed the write path`).not.toBeNull();
      expect(refused!.reason, `"${value}"`).toBe("writes_disabled");
    }
  });

  it("the module's OWN switch off blocks it even with master on and the mock in front", async () => {
    // With the target being the local mock the deployment arming no longer
    // applies, so this is the one configuration where the MODULE switch is the
    // only thing standing in the way — and it has to be enough on its own.
    process.env.DENTALLY_BASE_URL = "http://localhost:3000/api/mock-dentally";
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
    world.setToggle("recall", false);

    const refused = await attemptWrite();
    expect(refused, "a module switched off still wrote").not.toBeNull();
    expect(refused!.reason).toBe("system_off");

    // CONTROL: the same call with the module switched on goes through, so the
    // refusal above is about the switch and not about the configuration.
    world.reset();
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
    world.setToggle("recall", true);
    expect(await attemptWrite(), "the control write was refused too").toBeNull();

    const client = {
      createAppointment: async () => ({ appointment: { id: "mock-1" } }),
    };
    const result = await dentallyWrite.createAppointment(
      { source: "recall", siteId: SITE, actor: "user-abc", client },
      { patient_id: "dp-kill-1", reason: "Exam" },
    );
    expect(result.appointment.id).toBe("mock-1");
    const rows = world.rows("dentally_write_intent");
    expect(rows[rows.length - 1].status, "a mock write was not recorded as a dry run").toBe("dry_run");
    expect(rows[rows.length - 1].target).toBe("localhost:3000");
  });

  it("nothing in this whole journey reached a live Dentally host", async () => {
    world.setToggle(DENTALLY_WRITE_MASTER_SLUG, true);
    world.setToggle("recall", true);
    await attemptWrite();
    await expect(
      dentallyWrite.createAppointment(
        { source: "recall", siteId: SITE, actor: "user-abc" },
        { patient_id: "dp-kill-1", reason: "Exam" },
      ),
    ).rejects.toBeInstanceOf(DentallyWriteRefused);

    expect(liveDentallyViolations(world, guard)).toEqual([]);
    expect(guard.calls).toEqual([]);
  });
});
