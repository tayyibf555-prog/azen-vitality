// ===========================================================================
// JOURNEY 3 — THE ABANDONED-BOOKING RESCUE, UNDER THE FAIL-DIRECTION LAW.
//
// Somebody picks a slot on the public booking page, types their mobile, and
// closes the tab. Twenty minutes later the hold is still unconfirmed. The
// practice would like to text them once and say "your time is still there".
//
// That is a message to a person who did NOT ask to be marketed to, sent about a
// booking they started, on the strength of a consent tick that covered exactly
// that. So the rules around it are narrower than any other agent's, and this
// journey is those rules driven end to end:
//
//   * TWO SWITCHES, both required (ruling W1-B/4). Speed-to-lead is the
//     machinery; online booking is the page the text invites them back to. An
//     owner who switched online booking off has switched off that page, and the
//     message would read as "come and finish booking" about a page that refuses.
//   * ONE FOLLOW-UP, and no more. The lead is excluded from the three-touch
//     nurture cadence at BOTH of its selection queries, so "at most one rescue
//     message" is a property of the query rather than of a comment.
//   * CONSENT SOURCE "booking-form", marketing FALSE — recorded on the lead, so
//     a later reader does not have to infer the basis from the source column.
//   * AND THE FAIL DIRECTION: uncertainty fails CLOSED once messaging is live.
//
// The last clause of the ruling — a sweep re-reads its switch every ten rows —
// is asserted here against the SHARED gate, and this journey also records what
// the rescue's own host sweep does today. See the final describe block.
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  CLIENT,
  SITE,
  createOsWorld,
  installFetchGuard,
  liveDentallyViolations,
  correspondenceViolations,
  dailyCapViolations,
  patientCopyViolations,
  type FetchGuard,
} from "./harness";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const H = vi.hoisted(() => ({
  drafted: [] as string[],
  /** Draft number at which the owner flips the switch off mid-run. */
  flipOffAtDraft: 0,
  onFlip: () => {},
}));

// The journey owns its database and hands it to the harness — see the
// harness header for why the harness may not import it itself.
const world = createOsWorld(createFakeSupabase());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.fake.client }));

vi.mock("@/lib/speed-to-lead/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speed-to-lead/draft")>();
  return {
    ...actual,
    draftFirstContact: async () => {
      const body = "Hi Priya, Vitality Dental here — your time is still free if you'd like it.";
      H.drafted.push(body);
      // The owner reaches for System controls part-way through the batch.
      if (H.flipOffAtDraft > 0 && H.drafted.length === H.flipOffAtDraft) H.onFlip();
      return { body, model: "stub" };
    },
    draftNurtureTouch: async () => {
      const body = "Just checking in from Vitality Dental.";
      H.drafted.push(body);
      return { body, model: "stub" };
    },
  };
});

import { POST as speedToLeadSweep } from "@/app/api/speed-to-lead/sweep/route";
import { convertAbandonedHolds } from "@/lib/booking/abandoned-holds";
import { createHold } from "@/lib/booking/holds";
import { listAttempts, listNurtureDue } from "@/lib/speed-to-lead/repository";
import { nurtureSweep } from "@/lib/speed-to-lead/nurture";
import { getThreadForPatient } from "@/lib/inbox/repository";
import { liveSwitch, SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";
import { srcPath } from "@/lib/test-support/walk-src";
import { AGENT_BY_KEY } from "@/lib/agent-wiring/roster";

const PHONE = "+447700900733";
const ORIGINAL_ENV = { ...process.env };
let guard: FetchGuard;

beforeEach(() => {
  world.reset();
  H.drafted.length = 0;
  H.flipOffAtDraft = 0;
  H.onFlip = () => {};
  guard = installFetchGuard();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MESSAGING_DRY_RUN; // absent = DRY RUN
  delete process.env.CRON_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.DENTALLY_WRITE_ENABLED;
  delete process.env.DENTALLY_BASE_URL;
  world.setToggle("speed-to-lead", true);
  world.setToggle("online-booking", true);
});

afterEach(() => {
  guard.restore();
  process.env = { ...ORIGINAL_ENV };
});

/** A hold left un-confirmed long enough to count as abandoned. */
async function seedAbandonedHold() {
  const start = new Date(Date.now() + 3 * 86_400_000);
  const hold = await createHold({
    clientId: CLIENT,
    siteId: SITE,
    slotStart: start.toISOString(),
    slotFinish: new Date(start.getTime() + 30 * 60_000).toISOString(),
    practitionerId: "prac-jawad",
    practitionerName: "Dr Jawad",
    treatment: "Exam",
    name: "Priya Shah",
    phone: PHONE,
    email: null,
  });
  // Age it past the twenty-minute abandonment window.
  const row = world.fake.db.tables.booking_hold!.find((r) => r.id === hold.id)!;
  row.created_at = new Date(Date.now() - 45 * 60_000).toISOString();
  return hold;
}

async function runSweep(): Promise<Record<string, unknown>> {
  const res = await speedToLeadSweep(
    new Request("https://vitality.invalid/api/speed-to-lead/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

function ageLeads(): void {
  for (const row of world.fake.db.tables.speed_to_lead_lead ?? []) {
    row.created_at = new Date(Date.now() - 120_000).toISOString();
  }
}

describe("JOURNEY 3 — a hold is abandoned, rescued once, and only under both switches", () => {
  it("step 1: the hold becomes a lead only when BOTH switches are on", async () => {
    await seedAbandonedHold();

    // (a) online booking OFF: nothing converts, and the hold stays held so the
    //     rescue can still happen the moment the owner switches it back on.
    world.setToggle("online-booking", false);
    const offBooking = await convertAbandonedHolds(new Date());
    expect(offBooking).toEqual({ checked: 0, converted: 0, deduped: 0 });
    expect(world.rows("speed_to_lead_lead")).toEqual([]);
    expect(world.rows("booking_hold")[0].status).toBe("held");

    // (b) speed-to-lead OFF, online booking back on: also nothing. Either one
    //     off means nothing, which is what "requires BOTH" has to mean.
    world.setToggle("online-booking", true);
    world.setToggle("speed-to-lead", false);
    expect(await convertAbandonedHolds(new Date())).toEqual({ checked: 0, converted: 0, deduped: 0 });
    expect(world.rows("speed_to_lead_lead")).toEqual([]);

    // (c) CONTROL: both on, and it converts. Without this the two refusals above
    //     would pass just as well against a rescue that never worked at all.
    world.setToggle("speed-to-lead", true);
    const on = await convertAbandonedHolds(new Date());
    expect(on.converted, "both switches on and still nothing converted").toBe(1);
    expect(world.rows("speed_to_lead_lead")).toHaveLength(1);
    expect(world.rows("booking_hold")[0].status, "the hold was not retired").toBe("expired");
  });

  it("step 2: the lead records the narrow basis — consent source booking-form, marketing false", async () => {
    await seedAbandonedHold();
    await convertAbandonedHolds(new Date());

    const [lead] = world.rows("speed_to_lead_lead");
    expect(lead.source).toBe("abandoned-booking");
    const consent = lead.consent as Record<string, unknown>;
    // THE BASIS IS WRITTEN DOWN, not inferred. `marketing: false` is the point of
    // the row: the patient typed their number into a booking form under microcopy
    // about THAT booking, which covers one transactional follow-up and nothing else.
    expect(consent.source).toBe("booking-form");
    expect(consent.marketing).toBe(false);
    expect(consent.sms).toBe(true);
    expect(consent.whatsapp).toBe(false);
    // The slot they wanted rides along so the worklist shows what they were doing.
    expect(String(lead.treatment_interest)).toContain("Exam");
  });

  it("step 3: the same sweep that converts it sends exactly ONE message, in dry-run", async () => {
    await seedAbandonedHold();

    // First tick: converts the hold. The lead is brand new, so the SLA window has
    // not passed and it is not contacted in the same tick.
    const first = await runSweep();
    expect(first.abandonedConverted, JSON.stringify(first)).toBe(1);

    // Second tick, with the lead now old enough: it is first-contacted.
    ageLeads();
    const second = await runSweep();
    expect(second.contacted, JSON.stringify(second)).toBe(1);

    const [lead] = world.rows("speed_to_lead_lead");
    const attempts = await listAttempts(String(lead.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("sent");
    expect(attempts[0].provider).toBe("dry-run");
    expect(patientCopyViolations("rescue text", [attempts[0].body])).toEqual([]);

    // A third tick sends nothing more: the lead is out of the uncontacted window.
    H.drafted.length = 0;
    const third = await runSweep();
    expect(third.contacted, JSON.stringify(third)).toBe(0);
    expect(H.drafted, "a second rescue message was drafted").toEqual([]);
  });

  it("step 4: ONE follow-up only — the rescue lead is never enrolled in the nurture cadence", async () => {
    await seedAbandonedHold();
    await convertAbandonedHolds(new Date());
    const [row] = world.fake.db.tables.speed_to_lead_lead!;

    // Put it in exactly the state the cadence selects: contacted, step 0, first
    // contact well past the entry interval, well inside the age limit.
    row.stage = "contacted";
    row.nurture_step = 0;
    row.nurture_next_at = null;
    row.first_response_at = new Date(Date.now() - 10 * 86_400_000).toISOString();
    row.created_at = new Date(Date.now() - 12 * 86_400_000).toISOString();

    const due = await listNurtureDue({
      nowIso: new Date().toISOString(),
      entryCutoffIso: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      ageCutoffIso: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    expect(due, "an abandoned-booking lead was selected for the marketing cadence").toEqual([]);

    // CONTROL: the same row with a genuine enquiry source IS selected, so the
    // exclusion above is about the source and not about the row being wrong.
    row.source = "web";
    const dueAfter = await listNurtureDue({
      nowIso: new Date().toISOString(),
      entryCutoffIso: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      ageCutoffIso: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    expect(dueAfter.map((l) => l.source), "the control lead was not selected either").toEqual(["web"]);

    // And through the real sweep: with the abandoned source restored, the nurture
    // pass drafts nothing at all.
    row.source = "abandoned-booking";
    H.drafted.length = 0;
    const result = await nurtureSweep(new Date());
    expect(result.due).toBe(0);
    expect(result.sent).toBe(0);
    expect(H.drafted).toEqual([]);
  });

  it("step 5: the rescue message is on the record, and nothing reached Dentally", async () => {
    await seedAbandonedHold();
    await runSweep();
    ageLeads();
    // Give the lead a Dentally identity, as a number match would, so the record
    // read has a patient to read for.
    for (const row of world.fake.db.tables.speed_to_lead_lead ?? []) {
      row.dentally_patient_id = "dp-priya-1";
    }
    await runSweep();

    const read = await getThreadForPatient([SITE], "dp-priya-1");
    expect(correspondenceViolations(read, ["agent", "speed-to-lead"])).toEqual([]);

    expect(liveDentallyViolations(world, guard)).toEqual([]);
    expect(guard.calls).toEqual([]);
    // The rescue writes nothing to Dentally — it converts a hold into a lead and
    // sends a text. No intent row is the right answer, not an oversight.
    expect(world.rows("dentally_write_intent")).toEqual([]);
    expect(dailyCapViolations(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE LAST CLAUSE OF THE RULING: a switch flipped mid-run stops the drafting
// within ten rows.
// ---------------------------------------------------------------------------

describe("JOURNEY 3 — the fail-direction law: a switch flipped at row 12 stops the drafting", () => {
  it("the shared gate admits at most ten more rows after the flip", async () => {
    // MESSAGING_DRY_RUN absent means dry run, and isSystemEnabledForSend is
    // fail-open there — so this drives the switch through the REAL toggle table
    // rather than through an error path, which is the case the ruling is about.
    world.setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");

    let admitted = 0;
    for (let row = 0; row < 200; row += 1) {
      if (!(await gate.stillOn())) break;
      admitted += 1;
      // The owner flips it off in System controls after the twelfth row.
      if (admitted === 12) world.setToggle("recall", false);
    }

    expect(SWITCH_RECHECK_EVERY_ROWS).toBe(10);
    expect(gate.switchedOffMidRun, "the gate never noticed the switch").toBe(true);
    // The first re-read after row 12 lands on row 20, which is inside the bound
    // the ruling asks for: at most ten rows of exposure, never the whole run.
    expect(admitted).toBe(20);
    expect(admitted - 12).toBeLessThanOrEqual(SWITCH_RECHECK_EVERY_ROWS);
  });

  it("CONTROL: with the switch left ON, the same loop runs to its own end", async () => {
    // Without this the assertion above would pass against a gate that stopped for
    // any reason at all, including one that never admits anything.
    world.setToggle("recall", true);
    const gate = liveSwitch(CLIENT, "recall");
    let admitted = 0;
    for (let row = 0; row < 35; row += 1) {
      if (!(await gate.stillOn())) break;
      admitted += 1;
    }
    expect(admitted).toBe(35);
    expect(gate.switchedOffMidRun).toBe(false);
  });

  it("the REAL host sweep the rescue rides stops drafting within ten rows of a flip", async () => {
    // HANDOFF H1, NOW LANDED. The rescue has no sweep of its own — its guard IS
    // the speed-to-lead SLA sweep (roster.ts) — and that sweep used to read its
    // switch once and then loop for up to 300 seconds, drafting a model message
    // per lead. The fix lane adopted the shared ten-row gate and added the route
    // to the ruling's enumeration; this is the same claim driven end to end
    // through the real route rather than through the gate in isolation.
    world.setToggle("speed-to-lead", true);
    world.setToggle("online-booking", true);

    for (let i = 0; i < 40; i += 1) {
      world.fake.seed("speed_to_lead_lead", {
        id: `lead-${String(i).padStart(3, "0")}`,
        site_id: SITE,
        name: `Enquirer ${i}`,
        phone: `+44770090${String(4000 + i).padStart(4, "0")}`,
        email: null,
        channel: "sms",
        stage: "new",
        source: "web",
        consent: { sms: true, marketing: true, source: "web" },
        created_at: new Date(Date.now() - 120_000 - i).toISOString(),
      });
    }

    // The owner flips it off in System controls once the twelfth message has
    // been drafted — mid-batch, exactly the case the ruling is about.
    H.flipOffAtDraft = 12;
    H.onFlip = () => world.setToggle("speed-to-lead", false);

    await runSweep();

    expect(H.drafted.length, "the sweep drafted nothing at all").toBeGreaterThan(12);
    // The first re-read after row 12 lands on row 20. Ten rows of exposure, not
    // forty, and never the whole run.
    expect(H.drafted.length, "the sweep drafted past the ten-row bound").toBeLessThanOrEqual(20);
    expect(H.drafted.length - 12).toBeLessThanOrEqual(SWITCH_RECHECK_EVERY_ROWS);

    // AND THE UNDRAFTED LEADS ARE LEFT EXACTLY AS THEY WERE, at 'new', so the
    // next tick picks them up rather than stranding them at 'contacting'.
    const stranded = world.rows("speed_to_lead_lead").filter((r) => r.stage === "contacting");
    expect(stranded, "leads were claimed and then abandoned mid-run").toEqual([]);
    const untouched = world.rows("speed_to_lead_lead").filter((r) => r.stage === "new");
    expect(untouched.length).toBe(40 - H.drafted.length);
  });

  it("CONTROL: with the switch left ON, the same sweep works through every lead", async () => {
    // Without this, the bound above would pass against a sweep that stopped for
    // any reason at all — a claim that failed, a consent check, a typo.
    world.setToggle("speed-to-lead", true);
    world.setToggle("online-booking", true);
    for (let i = 0; i < 15; i += 1) {
      world.fake.seed("speed_to_lead_lead", {
        id: `lead-${String(i).padStart(3, "0")}`,
        site_id: SITE,
        name: `Enquirer ${i}`,
        phone: `+44770090${String(5000 + i).padStart(4, "0")}`,
        email: null,
        channel: "sms",
        stage: "new",
        source: "web",
        consent: { sms: true, marketing: true, source: "web" },
        created_at: new Date(Date.now() - 120_000 - i).toISOString(),
      });
    }

    const body = await runSweep();
    expect(body.contacted, JSON.stringify(body)).toBe(15);
    expect(H.drafted.length).toBe(15);
  });

  it("the ruling's enumeration now names the sweep the rescue rides", async () => {
    // The list grew rather than the assertion bending: rulings.test.ts pins that
    // every long-running sweep uses the shared gate, and the rescue's host sweep
    // is now one of the routes it names.
    const sweepSrc = readFileSync(srcPath("app/api/speed-to-lead/sweep/route.ts"), "utf8");
    expect(sweepSrc, "the rescue's host sweep dropped the shared gate again").toContain("liveSwitch(");

    const rulingsSrc = readFileSync(srcPath("lib/agent-wiring/rulings.test.ts"), "utf8");
    expect(
      rulingsSrc,
      "the ruling's enumeration does not name the rescue's host sweep, so a regression would go unnoticed",
    ).toContain("src/app/api/speed-to-lead/sweep/route.ts");

    const rescue = AGENT_BY_KEY.get("abandoned-booking-rescue");
    expect(rescue!.guard).toBe("src/app/api/speed-to-lead/sweep/route.ts");
  });
});
