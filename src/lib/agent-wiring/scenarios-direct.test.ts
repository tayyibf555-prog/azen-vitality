// ===========================================================================
// THE AGENTS THAT DO NOT GO THROUGH THE DRAIN.
//
// scenarios.test.ts traces the ten modules whose messages the shared outbox
// drain delivers. This file traces the other eight, which are the ones the
// codebase's existing coverage is thinnest about precisely BECAUSE they have no
// outbox: there is no queued row to assert on, so the only proof that they are
// wired is to run them and read the patient's record afterwards.
//
//   speed-to-lead              the real sweep route, guard and all
//   abandoned-booking-rescue   a real hold, converted inside that same sweep
//   smile-assessment           an assessment lead through the shared primitive
//   missed-call-bridge         the real decision function, gates and all
//   booking-agent              an agent reply, and where it lands on the record
//   whatsapp-agent             the same, on the channel with its own switch
//   booking-reply-context      default-OFF, proved against an empty database
//   anomaly-alerts             default-OFF, and it messages nobody at all
//   online-booking             fail-CLOSED, unlike its own hold route
//   rota-notify                staff, and deliberately off the patient record
//
// The model call is the one thing stubbed: draftFirstContact would otherwise
// reach Anthropic. Everything the wiring consists of — the guard, the consent
// check, the suppression check, the deliverability check, the send, the attempt
// row, the conversation thread and the record read — is the real code.
// ===========================================================================

import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const H = vi.hoisted(() => ({ drafted: [] as string[] }));

const fake = createFakeSupabase();

// contact.ts opens with `import "server-only"`, a Next build-time marker with no
// node implementation. The established stub in this suite, e.g.
// src/app/api/anomaly/sweep/route.test.ts.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => fake.client }));

// The ONLY stub. draftFirstContact and draftNurtureTouch call Anthropic; the
// wiring under test is everything around them.
vi.mock("@/lib/speed-to-lead/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speed-to-lead/draft")>();
  return {
    ...actual,
    draftFirstContact: async () => {
      const body = "Hello from the practice, thanks for getting in touch.";
      H.drafted.push(body);
      return { body, model: "stub" };
    },
  };
});

import { POST as speedToLeadSweep } from "@/app/api/speed-to-lead/sweep/route";
import { insertLead, getLead, listAttempts } from "@/lib/speed-to-lead/repository";
import { getThreadForPatient } from "@/lib/inbox/repository";
import { recordOutbound, outboundPatientKey } from "@/lib/inbox/record-outbound";
import { decideCallOutcome } from "@/lib/after-hours/call-outcome";
import {
  isSystemEnabled,
  isSystemEnabledForSend,
  isSystemEnabledStrict,
  getDisabledSlugsForSend,
} from "@/lib/systems/repository";
import { DEFAULT_OFF_SLUGS } from "@/lib/systems/catalog";
import { AGENT_BY_KEY } from "./roster";

const SITE = "site-cc";
const CLIENT = "vitality";
const PHONE = "+447700900321";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fake.reset();
  H.drafted.length = 0;
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CRON_SECRET;
  delete process.env.MESSAGING_DRY_RUN; // absent means DRY RUN
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.TWILIO_WHATSAPP_FROM;
});

function setToggle(slug: string, enabled: boolean): void {
  const rows = (fake.db.tables.system_toggle ??= []);
  const existing = rows.find((r) => r.client_id === CLIENT && r.module_slug === slug);
  if (existing) existing.enabled = enabled;
  else fake.seed("system_toggle", { client_id: CLIENT, module_slug: slug, enabled });
}

async function runSweep(): Promise<Record<string, unknown>> {
  const res = await speedToLeadSweep(
    new Request("https://scenario.invalid/api/speed-to-lead/sweep", { method: "POST" }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** A lead old enough for the SLA sweep to pick up. */
async function seedLead(overrides: Record<string, unknown> = {}) {
  const lead = await insertLead({
    siteId: SITE,
    name: "Kofi Mensah",
    phone: PHONE,
    email: null,
    channel: "sms",
    treatmentInterest: "Straightening",
    source: "web",
    consent: { sms: true },
    ...overrides,
  });
  // listUncontacted selects rows OLDER than now-30s, so age the row deliberately.
  const row = fake.db.tables.speed_to_lead_lead!.find((r) => r.id === lead.id)!;
  row.created_at = new Date(Date.now() - 120_000).toISOString();
  return lead;
}

// ---------------------------------------------------------------------------
// speed-to-lead: the whole sweep, guard included.
// ---------------------------------------------------------------------------

describe("speed-to-lead: trigger → guard → draft → send (dry) → the lead's record", () => {
  it("contacts an uncontacted lead and puts the message on their thread", async () => {
    setToggle("speed-to-lead", true);
    const lead = await seedLead({ dentallyPatientId: "p-stl" });

    const body = await runSweep();
    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(H.drafted.length, "nothing was drafted").toBe(1);

    // The lead moved out of the retry window, and the attempt was recorded.
    expect((await getLead(lead.id))?.stage).toBe("contacted");
    const attempts = await listAttempts(lead.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("sent");
    expect(attempts[0].provider).toBe("dry-run");

    // AND it is on the patient's record, from BOTH sources this path writes:
    // the threaded conversation and the speed-to-lead attempt row.
    const read = await getThreadForPatient([SITE], "p-stl");
    expect(read.failedSourceNames).toEqual([]);
    expect(read.thread).not.toBeNull();
    const sources = new Set(read.thread!.messages.map((m) => m.source));
    expect(sources.has("agent"), "the conversation turn is missing").toBe(true);
    expect(sources.has("speed-to-lead"), "the attempt row is missing").toBe(true);
  });

  it("SWITCHED OFF: the sweep does nothing at all, and nothing is drafted", async () => {
    setToggle("speed-to-lead", false);
    const lead = await seedLead();

    const body = await runSweep();
    expect(body.skipped).toBe("system off");
    expect(H.drafted.length, "a switched-off system called the model").toBe(0);
    expect((await getLead(lead.id))?.stage).toBe("new");
    expect(await listAttempts(lead.id)).toEqual([]);
  });

  it("OPTED OUT: the lead is retired rather than texted, and never re-picked", async () => {
    setToggle("speed-to-lead", true);
    fake.seed("message_suppression", { site_id: SITE, channel: "sms", to_ref: PHONE, reason: "stop" });
    const lead = await seedLead();

    await runSweep();
    expect(H.drafted.length, "a suppressed number was drafted for").toBe(0);
    // Terminal, so the SLA sweep does not re-select it every minute forever.
    expect((await getLead(lead.id))?.stage).toBe("lost");
    const attempts = await listAttempts(lead.id);
    expect(attempts[0].status).toBe("failed");
  });

  it("NO CONSENT on the chosen channel: retired, not texted", async () => {
    setToggle("speed-to-lead", true);
    const lead = await seedLead({ consent: {} });

    await runSweep();
    expect(H.drafted.length).toBe(0);
    expect((await getLead(lead.id))?.stage).toBe("lost");
  });
});

// ---------------------------------------------------------------------------
// abandoned-booking rescue: hosted inside that same sweep.
// ---------------------------------------------------------------------------

describe("abandoned-booking rescue: a hold nobody finished becomes a contacted lead", () => {
  function seedAbandonedHold(): void {
    fake.seed("booking_hold", {
      id: "hold-1",
      client_id: CLIENT,
      site_id: SITE,
      slot_start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      slot_finish: new Date(Date.now() + 3 * 86_400_000 + 1_800_000).toISOString(),
      treatment: "Exam",
      name: "Lena Novak",
      phone: "+447700900444",
      status: "held",
      created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });
  }

  it("converts the hold, and the same tick first-contacts the lead it made", async () => {
    // BOTH switches, since ruling W1-B/4: the machinery it feeds and the flow it
    // invites the patient back into.
    setToggle("speed-to-lead", true);
    setToggle("online-booking", true);
    seedAbandonedHold();

    const body = await runSweep();
    expect(body.abandonedConverted, JSON.stringify(body)).toBe(1);
    const leads = fake.rows("speed_to_lead_lead");
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("abandoned-booking");
    // The hold is retired so a later tick cannot convert it twice.
    expect(fake.rows("booking_hold")[0].status).toBe("expired");
  });

  it("is stopped by the speed-to-lead switch, which halts the whole sweep", async () => {
    setToggle("speed-to-lead", false);
    setToggle("online-booking", true);
    seedAbandonedHold();

    const body = await runSweep();
    expect(body.skipped).toBe("system off");
    expect(fake.rows("speed_to_lead_lead")).toHaveLength(0);
    expect(fake.rows("booking_hold")[0].status).toBe("held");
  });

  it("and by the ONLINE-BOOKING switch, even though the sweep itself runs", async () => {
    // The distinction matters. The sweep is speed-to-lead's, so it runs and does
    // its other work; the rescue inside it is what stops. Before ruling W1-B/4 the
    // rescue had no opinion about online booking at all and cheerfully invited
    // patients back to a page that had been switched off.
    setToggle("speed-to-lead", true);
    setToggle("online-booking", false);
    seedAbandonedHold();

    const body = await runSweep();
    expect(body.skipped, "the whole sweep stopped; only the rescue should have").toBeUndefined();
    expect(body.abandonedConverted).toBe(0);
    expect(fake.rows("speed_to_lead_lead")).toHaveLength(0);
    expect(fake.rows("booking_hold")[0].status).toBe("held");
  });

  it("the roster records the two-switch rule where a person will read it", () => {
    const agent = AGENT_BY_KEY.get("abandoned-booking-rescue")!;
    expect(agent.slug).toBeNull();
    expect(agent.slugNote).toMatch(/speed-to-lead/);
    expect(agent.slugNote).toMatch(/online-booking/);
    // THE RULE, NOT THE RULING CODE. This asserted /W1-B\/4/ until 5 September
    // 2026, which held the citation in place in a sentence the co-pilot reads
    // back to the practice owner — a reference to a programme document he has
    // never seen (roster.test.ts, "cites no internal ruling code in anything the
    // owner is shown"). What he has to be told is the consequence, so that is
    // what is pinned; the traceability moved one layer in, to the comment above
    // the entry, and is asserted there rather than dropped.
    expect(agent.slugNote).toMatch(/switched off the page this text points at/);
    const roster = readFileSync("src/lib/agent-wiring/roster.ts", "utf8");
    expect(roster, "the decision behind the two-switch rule is no longer traceable").toContain(
      "ruling W1-B/4",
    );
  });
});

// ---------------------------------------------------------------------------
// smile-assessment: the assessment's own lead, through the shared primitive.
// ---------------------------------------------------------------------------

describe("smile-assessment: an assessment enquiry reaches the patient's record", () => {
  /**
   * The submit route's double gate (its own switch AND speed-to-lead's) is pinned
   * by the source crawl in roster.test.ts; what is driven here is the half that
   * has to be RUN to be believed — that an assessment lead ends up on a record
   * rather than only in the assessment's own table.
   */
  it("is contacted and threaded like any other lead", async () => {
    setToggle("speed-to-lead", true);
    setToggle("smile-assessment", true);
    const lead = await seedLead({
      source: "smile-assessment",
      dentallyPatientId: "p-assess",
      name: "Mira Solberg",
    });

    await runSweep();
    expect((await getLead(lead.id))?.stage).toBe("contacted");
    const read = await getThreadForPatient([SITE], "p-assess");
    expect(read.thread).not.toBeNull();
    expect(read.thread!.messages.some((m) => m.source === "speed-to-lead")).toBe(true);
  });

  it("its own switch off does not silently keep contacting: the roster says both are needed", () => {
    const agent = AGENT_BY_KEY.get("smile-assessment")!;
    expect(agent.gaps.join(" ")).toMatch(/DOUBLE-GATED/);
    expect(agent.correspondence).toContain("speed-to-lead");
  });
});

// ---------------------------------------------------------------------------
// missed-call bridge: the real decision function, with its real gates.
// ---------------------------------------------------------------------------

describe("missed-call bridge: what a missed call is allowed to do", () => {
  const base = {
    outside: false,
    dialable: true,
    alreadyCaptured: false,
    suppressed: false,
    systemOn: true,
    practiceName: "Vitality Dental",
  };

  it("texts the caller back when the system is on and they have not opted out", () => {
    const outcome = decideCallOutcome({ ...base });
    // "lead-bridge" outside hours, "callback-sms" as daytime overflow; either way
    // the caller is contacted. "none" is the log-only outcome.
    expect(outcome.action, JSON.stringify(outcome)).not.toBe("none");
    expect(outcome.capture).toBe(true);
  });

  it("sends NOTHING when the after-hours system is switched off", () => {
    const outcome = decideCallOutcome({ ...base, systemOn: false });
    expect(outcome.action).toBe("none");
    // The call is still LOGGED. Switching the texting off must not lose the fact
    // that somebody rang and nobody answered.
    expect(outcome.capture).toBe(true);
    expect(outcome.spoken).not.toMatch(/text/i);
  });

  it("sends NOTHING to a number that has opted out", () => {
    const outcome = decideCallOutcome({ ...base, suppressed: true });
    expect(outcome.action).toBe("none");
    expect(outcome.capture).toBe(true);
  });

  it("sends NOTHING to a withheld number, which outranks every other rule", () => {
    expect(decideCallOutcome({ ...base, dialable: false }).action).toBe("none");
  });

  it("its callback text is on the record under 'agent', which is where the tab reads it", async () => {
    // The voice route calls recordOutbound after the provider accepts. This is
    // that call, and then the record read the Correspondence tab performs.
    const ok = await recordOutbound({
      siteId: SITE,
      dentallyPatientId: outboundPatientKey("p-missedcall", "+447700900555"),
      patientName: "Noor Rahimi",
      channel: "sms",
      body: "Sorry we missed your call — reply here and we will book you in.",
      source: "voice-callback",
    });
    expect(ok).toBe(true);
    const read = await getThreadForPatient([SITE], "p-missedcall");
    expect(read.thread, "the callback text is on nobody's record").not.toBeNull();
    expect(read.thread!.messages[0].source).toBe("agent");
    expect(read.thread!.messages[0].direction).toBe("outbound");
  });
});

// ---------------------------------------------------------------------------
// The conversational agents: where their replies land.
// ---------------------------------------------------------------------------

describe("booking agent and WhatsApp agent: a reply lands on the patient's record", () => {
  it.each([
    ["booking-agent", "sms"],
    ["whatsapp-agent", "whatsapp"],
  ] as const)("%s reply is recorded under 'agent'", async (key, channel) => {
    const patientId = `p-${key}`;
    await recordOutbound({
      siteId: SITE,
      dentallyPatientId: patientId,
      patientName: "Omar Haddad",
      channel,
      body: "Of course — we have Tuesday at 10:20. Shall I book that?",
      source: key,
    });
    const read = await getThreadForPatient([SITE], patientId);
    expect(read.thread).not.toBeNull();
    expect(read.thread!.messages[0].source).toBe("agent");
    expect(AGENT_BY_KEY.get(key)!.correspondence).toContain("agent");
  });

  it("the two agents have SEPARATE switches, so stopping sending cannot swallow inbound", () => {
    // Outbound WhatsApp routing is 'whatsapp'; the inbound agent is 'whatsapp-agent'.
    // Conflating them would mean switching sending off silently dropped patient messages.
    expect(AGENT_BY_KEY.get("whatsapp-agent")!.slug).toBe("whatsapp-agent");
    expect(AGENT_BY_KEY.get("booking-agent")!.slug).toBe("booking-agent");
  });
});

// ---------------------------------------------------------------------------
// The default-OFF systems, proved against an EMPTY toggle table.
// ---------------------------------------------------------------------------

describe("a system nobody has ever switched on is OFF, in a database with no rows at all", () => {
  /**
   * THE TRAP THIS IS ABOUT. system_toggle is default-ON: an absent row means
   * enabled, which is what keeps the kill switch dormant until an owner uses it.
   * For a brand new SEND surface that default is the wrong way round, so five
   * systems invert it in the catalog. The inversion is easy to write and easy to
   * forget, and a seeded migration row does not cover a database the seed never
   * reached — which is exactly what an empty table here stands for.
   */
  it.each([...DEFAULT_OFF_SLUGS])("%s reads DISABLED with no row present", async (slug) => {
    expect(fake.rows("system_toggle")).toEqual([]);
    expect(await isSystemEnabled(CLIENT, slug)).toBe(false);
    expect(await isSystemEnabledForSend(CLIENT, slug)).toBe(false);
    expect(await isSystemEnabledStrict(CLIENT, slug)).toBe(false);
    expect(await getDisabledSlugsForSend(CLIENT)).toContain(slug);
  });

  it("and still reads DISABLED when the toggle table itself cannot be read", async () => {
    fake.failTable("system_toggle");
    for (const slug of DEFAULT_OFF_SLUGS) {
      expect(await isSystemEnabledForSend(CLIENT, slug), slug).toBe(false);
    }
  });

  it("while a system that shipped ON is untouched by the inversion", async () => {
    expect(await isSystemEnabled(CLIENT, "recall")).toBe(true);
    expect(await isSystemEnabledForSend(CLIENT, "recall")).toBe(true);
  });

  it("booking-reply-context and anomaly-alerts are among them, which is the whole point", () => {
    expect(DEFAULT_OFF_SLUGS.has("booking-reply-context")).toBe(true);
    expect(DEFAULT_OFF_SLUGS.has("anomaly-alerts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The agents that message nobody, and the one that messages staff.
// ---------------------------------------------------------------------------

describe("the agents that are not senders are recorded as not being senders", () => {
  it("anomaly alerts message nobody and hold nothing on a record", () => {
    const agent = AGENT_BY_KEY.get("anomaly-alerts")!;
    expect(agent.audience).toBe("nobody");
    expect(agent.sendPath).toBe("none");
    expect(agent.correspondence).toEqual([]);
    expect(agent.recordNote).toBeTruthy();
  });

  it("booking reply context changes what the agent KNOWS, not what it sends", () => {
    const agent = AGENT_BY_KEY.get("booking-reply-context")!;
    expect(agent.sendPath).toBe("none");
    expect(agent.draft).toBe("none");
  });

  it("online booking says nothing to the patient at all", () => {
    const agent = AGENT_BY_KEY.get("online-booking")!;
    expect(agent.audience).toBe("nobody");
    expect(agent.correspondence).toEqual([]);
  });

  it("rota notifications are STAFF messages and are deliberately off the patient record", () => {
    const agent = AGENT_BY_KEY.get("rota-notify")!;
    expect(agent.audience).toBe("staff");
    expect(agent.correspondence).toEqual([]);
    expect(agent.recordNote).toMatch(/staff/i);
  });

  it("online booking's create path fails CLOSED where its hold path fails open", async () => {
    // Asymmetry on purpose: a hold is reversible, a booking in a real diary is not.
    fake.failTable("system_toggle");
    expect(await isSystemEnabledStrict(CLIENT, "online-booking")).toBe(false);
    expect(await isSystemEnabled(CLIENT, "online-booking")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Completeness: between the two files, every rostered agent is traced.
// ---------------------------------------------------------------------------

describe("this file covers the agents the drain file cannot", () => {
  it("names each of them", () => {
    for (const key of [
      "speed-to-lead",
      "abandoned-booking-rescue",
      "smile-assessment",
      "missed-call-bridge",
      "booking-agent",
      "whatsapp-agent",
      "booking-reply-context",
      "anomaly-alerts",
      "online-booking",
      "rota-notify",
    ]) {
      expect(AGENT_BY_KEY.has(key), `${key} is not in the roster`).toBe(true);
    }
  });
});
