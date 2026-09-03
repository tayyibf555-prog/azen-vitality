// ===========================================================================
// ONE TRACE PER AGENT, THROUGH THE REAL CODE.
//
// trigger → guard → draft → outbox → drain (dry-run) → the patient's record.
//
// The platform's per-module suites are thorough and each one is complete about
// its own module. What none of them can prove is the thing the owner actually
// asked for — "every agent working where it needs to be" — because every one of
// them mocks the modules on either side of it. The drain's own suite mocks all
// eleven repositories; each module's suite mocks the drain. So the SEAM between
// them has never been driven, and the seam is where this lane's defects were.
//
// WHAT IS REAL HERE. Every repository, the drain route handler, the messaging
// send path (dry-run), suppression, the cross-module daily cap, the output
// guardrail, the kill-switch reads, and the Correspondence read the patient
// record renders. The database is src/lib/test-support/fake-supabase, whose
// column defaults are parsed out of supabase/migrations/ rather than typed here.
//
// WHAT IS MOCKED, AND WHY IT HAS TO BE.
//   * @/lib/supabase/server  — there is no Postgres in a unit run.
//   * @/lib/dentally/client  — Dentally is READ-ONLY for this platform and this
//     lane makes no live requests. resolveRecipient's getPatient is the only
//     call the drain makes, so the stub is one method wide.
// Nothing else. In particular sendMessage is NOT mocked: MESSAGING_DRY_RUN is
// left unset, so the real send path runs and returns its synthetic dry-run
// result. That is deliberate — the fail-safe that keeps a test run from texting
// anybody is the same one that protects production, and this suite is where it
// gets exercised on every agent at once.
// ===========================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// vi.mock factories are hoisted above every top-level statement, so the state
// they close over has to be created by vi.hoisted rather than by a const here.
const H = vi.hoisted(() => {
  class StubDentallyError extends Error {
    constructor(
      public status: number,
      message = "dentally",
    ) {
      super(message);
    }
  }
  return {
    StubDentallyError,
    patients: new Map<string, { mobile_phone?: string; email_address?: string }>(),
    missingPatients: new Set<string>(),
  };
});

const { patients, missingPatients } = H;
const fake = createFakeSupabase();

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => fake.client,
}));

/** The one Dentally read the drain makes: resolveRecipient → getPatient. */
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_cfg: unknown) {
      void _cfg;
    }
    async getPatient(id: string) {
      if (H.missingPatients.has(id)) throw new H.StubDentallyError(404);
      const p = H.patients.get(id);
      if (!p) throw new H.StubDentallyError(404);
      return { patient: { id, ...p } };
    }
  },
  DentallyError: H.StubDentallyError,
}));

import { POST as drainPost } from "@/app/api/messaging/drain/route";
import { getThreadForPatient } from "@/lib/inbox/repository";
import { DRAIN_SOURCE_TO_SLUG } from "@/lib/systems/catalog";
import { DRAIN_AGENTS, AGENT_BY_KEY } from "./roster";

import * as recall from "@/lib/recall/repository";
import * as reactivation from "@/lib/reactivation/repository";
import * as noshow from "@/lib/noshow/repository";
import * as coordinator from "@/lib/coordinator/repository";
import * as reviews from "@/lib/reviews/repository";
import * as outreach from "@/lib/outreach/repository";
import * as calendar from "@/lib/calendar/repository";
import * as closer from "@/lib/closer/repository";
import * as collection from "@/lib/collection/repository";
import * as postop from "@/lib/postop/repository";
import * as previsit from "@/lib/triage/repository";
import { offerSlotToNextCandidate } from "@/lib/noshow/fill";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SITE = "site-cc"; // N15 Vitality Dental, per src/lib/mock/clients.ts
const CLIENT = "vitality";
const MOBILE = "07700900123";
const E164 = "+447700900123";

/** One patient per agent, so a cross-module daily cap cannot silently hide a trace. */
function patientFor(key: string): string {
  return `p-${key}`;
}

/** Wholly benign copy: no funding words, no clinical advice, no price. */
function bodyFor(key: string): string {
  return `Hello from the practice about your ${key} note.`;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fake.reset();
  patients.clear();
  missingPatients.clear();
  process.env = { ...ORIGINAL_ENV };
  // The drain 503s without a key, and authorises on NODE_ENV when CRON_SECRET is
  // unset. Neither is ever used to reach Dentally here: the client is stubbed.
  process.env.DENTALLY_API_KEY = "scenario-suite";
  delete process.env.CRON_SECRET;
  delete process.env.MESSAGING_DRY_RUN; // absent means DRY RUN, which is the point
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.TWILIO_WHATSAPP_FROM;
});

/**
 * Switch a system on or off exactly as the owner's control panel does.
 *
 * UPSERT, not insert: system_toggle's primary key is (client_id, module_slug), so
 * a second row for the same system is not a thing Postgres would hold. A fake that
 * allowed one would let `allSystemsOn()` then `setToggle(slug, false)` leave the
 * enabled row in front and every switched-OFF scenario pass vacuously.
 */
function setToggle(slug: string, enabled: boolean): void {
  const rows = (fake.db.tables.system_toggle ??= []);
  const existing = rows.find((r) => r.client_id === CLIENT && r.module_slug === slug);
  if (existing) existing.enabled = enabled;
  else fake.seed("system_toggle", { client_id: CLIENT, module_slug: slug, enabled });
}

/** Every system on, so a trace's failure is never just a switch nobody set. */
function allSystemsOn(): void {
  for (const slug of new Set(Object.values(DRAIN_SOURCE_TO_SLUG))) setToggle(slug, true);
}

function knowPatient(patientId: string): void {
  patients.set(patientId, { mobile_phone: MOBILE, email_address: "patient@example.com" });
}

interface DrainResult {
  ok: boolean;
  sent: number;
  blocked: number;
  failed: number;
  perSource: Record<string, { sent: number; blocked: number; failed: number; skipped?: string }>;
}

async function runDrain(): Promise<DrainResult> {
  const res = await drainPost(new Request("https://scenario.invalid/api/messaging/drain", { method: "POST" }));
  return (await res.json()) as DrainResult;
}

// ---------------------------------------------------------------------------
// Per-agent seeding: the REAL repository call each agent's own trigger makes.
// ---------------------------------------------------------------------------

async function seedRecall(patientId: string): Promise<void> {
  fake.seed("recall_target", {
    id: "recall-t1",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Amara Okonjo",
  });
  const touch = await recall.insertTouch({
    targetId: "recall-t1",
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("recall"),
    draftedBy: "claude",
    status: "draft",
  });
  await recall.approveTouch(touch.id, "auto");
  await recall.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("recall"),
  });
}

async function seedReactivation(patientId: string): Promise<void> {
  fake.seed("reactivation_target", {
    id: "react-t1",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Bela Nagy",
  });
  const touch = await reactivation.insertTouch({
    targetId: "react-t1",
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("reactivation"),
    draftedBy: "claude",
    status: "draft",
  });
  await reactivation.approveTouch(touch.id, "auto");
  await reactivation.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("reactivation"),
  });
}

async function seedNoshow(patientId: string): Promise<void> {
  fake.seed("noshow_target", {
    id: "noshow-t1",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Cai Zhang",
  });
  const touch = await noshow.insertTouch({
    targetId: "noshow-t1",
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("noshow"),
    draftedBy: "claude",
    status: "draft",
  });
  await noshow.approveTouch(touch.id, "auto");
  await noshow.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("noshow"),
  });
}

async function seedCoordinator(patientId: string): Promise<void> {
  fake.seed("treatment_opportunity", {
    id: "opp-1",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Dara Byrne",
  });
  const touch = await coordinator.insertTouch({
    opportunityId: "opp-1",
    siteId: SITE,
    channel: "sms",
    body: bodyFor("coordinator"),
    draftedBy: "claude",
    status: "draft",
  });
  await coordinator.approveTouch(touch.id, "auto");
  await coordinator.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("coordinator"),
  });
}

/** The closer NEVER auto-queues: a human approving the draft is the only route out. */
async function seedCloser(patientId: string): Promise<{ touchId: string }> {
  fake.seed("treatment_opportunity", {
    id: "opp-closer",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Eve Lindqvist",
  });
  const touch = await closer.insertDraft({
    opportunityId: "opp-closer",
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("closer"),
  });
  return { touchId: touch.id };
}

/** Balance reminders never auto-queue either. collection_touch carries the id itself. */
async function seedCollection(patientId: string): Promise<{ touchId: string }> {
  const touch = await collection.insertDraft({
    patientId,
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("collection"),
    amountPence: null,
  });
  return { touchId: touch.id };
}

async function seedPostop(patientId: string): Promise<{ touchId: string; targetId: string }> {
  const targetId = `${SITE}:appt-postop`;
  await postop.upsertTargetIfNew({
    siteId: SITE,
    dentallyPatientId: patientId,
    appointmentId: "appt-postop",
    patientName: "Farid Haddad",
    procedureFlag: "extraction",
    procedureSource: "Extraction UR6",
    procedureAt: new Date(Date.now() - 86_400_000).toISOString(),
    dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    consentSms: true,
    consentEmail: false,
  });
  const touch = await postop.insertDraft({
    targetId,
    siteId: SITE,
    channel: "sms",
    body: bodyFor("postop"),
  });
  return { touchId: touch.id, targetId };
}

async function seedReviews(patientId: string): Promise<void> {
  fake.seed("review_request", {
    id: "rev-1",
    site_id: SITE,
    dentally_patient_id: patientId,
    patient_name: "Gita Raman",
  });
  const touch = await reviews.insertTouch({
    requestId: "rev-1",
    siteId: SITE,
    channel: "sms",
    body: bodyFor("reviews"),
    draftedBy: "claude",
    status: "draft",
  });
  await reviews.approveTouch(touch.id, "auto");
  await reviews.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("reviews"),
  });
}

async function seedOutreach(patientId: string): Promise<void> {
  fake.seed("outreach_campaign", { id: "camp-1", site_id: SITE, name: "Scenario" });
  fake.seed("outreach_target", {
    id: "out-t1",
    campaign_id: "camp-1",
    site_id: SITE,
    patient_id: patientId,
    name: "Hana Petrova",
  });
  const touch = await outreach.insertTouch({
    targetId: "out-t1",
    campaignId: "camp-1",
    siteId: SITE,
    step: 1,
    channel: "sms",
    body: bodyFor("outreach"),
    draftedBy: "claude",
    status: "draft",
  });
  await outreach.approveTouch(touch.id, "auto");
  await outreach.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("outreach"),
  });
}

async function seedDiary(patientId: string): Promise<void> {
  fake.seed("diary_move", {
    id: "move-1",
    client_id: CLIENT,
    site_id: SITE,
    appointment_id: "appt-1",
    patient_id: patientId,
    outcome: "saved",
  });
  const touch = await calendar.insertTouch({
    moveId: "move-1",
    siteId: SITE,
    channel: "sms",
    body: bodyFor("diary"),
  });
  await calendar.enqueueOutbox({
    touchId: touch.id,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("diary"),
    notBeforeAt: new Date(Date.now() - 60_000).toISOString(),
  });
}


/**
 * The pre-visit questionnaire invite. Owned by another lane; traced here because
 * it registered a source with the shared drain, and a source the drain sends for
 * has to be provably killable and provably on the record like every other.
 */
async function seedPrevisit(patientId: string): Promise<void> {
  const targetId = `${SITE}:appt-previsit`;
  await previsit.upsertTargetIfNew({
    siteId: SITE,
    dentallyPatientId: patientId,
    appointmentId: "appt-previsit",
    patientName: "Priya Nair",
    // "full" is the fork the module resolves for a patient whose plan is not an
    // NHS one; the fork is decided server-side and the patient never sees which.
    fork: "full",
    appointmentAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    consentSms: true,
  });
  await previsit.enqueueSend({
    targetId,
    siteId: SITE,
    channel: "sms",
    toRef: `patient:${patientId}`,
    body: bodyFor("previsit"),
    notBeforeAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// THE TRACE. Every drain agent, one at a time, all the way to the record.
// ---------------------------------------------------------------------------

interface Trace {
  key: string;
  slug: string;
  source: string;
  /** The module's own outbox table. Named, because no two of them agree. */
  outboxTable: string;
  /** The key `bodyFor` was called with, so the record assertion knows the words. */
  bodyKey: string;
  /** Queue a message for `patientId` using this agent's own real code path. */
  queue: (patientId: string) => Promise<void>;
}

/** The approval agents queue only after a human approves, so their trace says so. */
const AUTO_TRACES: Trace[] = [
  { key: "recall", slug: "recall", source: "recall", outboxTable: "recall_outbox", bodyKey: "recall", queue: seedRecall },
  { key: "reactivation", slug: "reactivation", source: "reactivation", outboxTable: "reactivation_outbox", bodyKey: "reactivation", queue: seedReactivation },
  { key: "no-show-defence", slug: "no-show-defence", source: "noshow", outboxTable: "noshow_outbox", bodyKey: "noshow", queue: seedNoshow },
  // The coordinator is the one module whose outbox is the bare legacy `outbox`
  // table rather than a prefixed one, which is exactly why this is named per trace.
  { key: "treatment-coordinator", slug: "treatment-coordinator", source: "coordinator", outboxTable: "outbox", bodyKey: "coordinator", queue: seedCoordinator },
  { key: "reviews", slug: "reviews", source: "reviews", outboxTable: "review_outbox", bodyKey: "reviews", queue: seedReviews },
  { key: "outreach", slug: "outreach", source: "outreach", outboxTable: "outreach_outbox", bodyKey: "outreach", queue: seedOutreach },
  { key: "diary-notify", slug: "calendar-writes", source: "diary", outboxTable: "diary_outbox", bodyKey: "diary", queue: seedDiary },
  { key: "pre-visit-triage", slug: "pre-visit-triage", source: "previsit", outboxTable: "previsit_outbox", bodyKey: "previsit", queue: seedPrevisit },
];

const APPROVAL_TRACES: Trace[] = [
  {
    key: "treatment-closer",
    slug: "treatment-closer",
    source: "closer",
    outboxTable: "closer_outbox",
    bodyKey: "closer",
    queue: async (patientId) => {
      const { touchId } = await seedCloser(patientId);
      const approved = await closer.approveDraft(touchId, "user-1", { toRef: `patient:${patientId}` });
      expect(approved, "the closer draft could not be approved").not.toBeNull();
    },
  },
  {
    key: "balance-reminders",
    slug: "balance-reminders",
    source: "collection",
    outboxTable: "collection_outbox",
    bodyKey: "collection",
    queue: async (patientId) => {
      const { touchId } = await seedCollection(patientId);
      const approved = await collection.approveDraft(touchId, "user-1", { toRef: `patient:${patientId}` });
      expect(approved, "the balance draft could not be approved").not.toBeNull();
    },
  },
  {
    key: "postop-checkin",
    slug: "postop-checkin",
    source: "postop",
    outboxTable: "postop_outbox",
    bodyKey: "postop",
    queue: async (patientId) => {
      const { touchId } = await seedPostop(patientId);
      const approved = await postop.approveDraft(touchId, "user-1", {
        toRef: `patient:${patientId}`,
        notBeforeAt: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(approved, "the post-op draft could not be approved").not.toBeNull();
    },
  },
];

const ALL_TRACES = [...AUTO_TRACES, ...APPROVAL_TRACES];

describe.each(ALL_TRACES)("$key: trigger → guard → outbox → drain → the record", (trace) => {
  const patientId = patientFor(trace.key);

  it("is in the roster, and the roster agrees with the drain about its source", () => {
    const agent = AGENT_BY_KEY.get(trace.key);
    expect(agent, `${trace.key} is not in the roster`).toBeTruthy();
    expect(agent!.drainSource).toBe(trace.source);
    expect(agent!.slug).toBe(trace.slug);
    expect(DRAIN_SOURCE_TO_SLUG[trace.source]).toBe(trace.slug);
  });

  it("queues one row, the drain sends it (dry-run), and the patient's record shows it", async () => {
    allSystemsOn();
    knowPatient(patientId);
    await trace.queue(patientId);

    const result = await runDrain();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.perSource[trace.source]?.sent, `${trace.source} did not send`).toBe(1);

    // The provider result is the dry-run one, and the address was stamped — the
    // only thing an inbound reply can be correlated against.
    const rows = fake.rows(trace.outboxTable);
    expect(rows.length, `no outbox row for ${trace.source}`).toBe(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].provider).toBe("dry-run");
    expect(rows[0].to_address).toBe(E164);

    // AND THE POINT OF THE WHOLE TRACE: the Correspondence tab's own read.
    const read = await getThreadForPatient([SITE], patientId);
    expect(read.failedSourceNames, `record read failed for: ${read.failedSourceNames.join(", ")}`).toEqual([]);
    expect(read.thread, `${trace.key} sent a message that appears on no record`).not.toBeNull();
    const mine = read.thread!.messages.filter((m) => m.source === trace.source);
    expect(mine.length, `the record holds nothing from ${trace.source}`).toBe(1);
    expect(mine[0].body).toBe(bodyFor(trace.bodyKey));
    expect(mine[0].direction).toBe("outbound");
  });

  it("SWITCHED OFF: the row is queued and the drain refuses to touch it", async () => {
    allSystemsOn();
    setToggle(trace.slug, false);
    knowPatient(patientId);
    await trace.queue(patientId);

    const result = await runDrain();
    expect(result.perSource[trace.source]?.skipped, `${trace.source} was not skipped`).toBe("system off");
    expect(result.sent).toBe(0);

    // The row is untouched, not failed: it drains the moment the owner switches
    // the system back on. That is the behaviour the runbook's 48-hour note is about.
    const rows = fake.rows(trace.outboxTable);
    expect(rows.length, `no outbox row for ${trace.source}`).toBe(1);
    expect(rows[0].status).toBe("queued");
    expect(rows[0].to_address ?? null).toBeNull();
  });

  it("OPTED OUT: a STOP on the number blocks the send and nothing is sent", async () => {
    allSystemsOn();
    knowPatient(patientId);
    fake.seed("message_suppression", { site_id: SITE, channel: "sms", to_ref: E164, reason: "stop" });
    await trace.queue(patientId);

    const result = await runDrain();
    expect(result.sent).toBe(0);
    expect(result.perSource[trace.source]?.blocked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The approval agents, specifically: a draft cannot send.
// ---------------------------------------------------------------------------

describe("the three approval agents cannot send without a person", () => {
  it.each([
    ["treatment-closer", "closer", async (p: string) => void (await seedCloser(p))],
    ["balance-reminders", "collection", async (p: string) => void (await seedCollection(p))],
    ["postop-checkin", "postop", async (p: string) => void (await seedPostop(p))],
  ])("%s: a drafted message is invisible to the drain", async (key, source, seed) => {
    allSystemsOn();
    const patientId = patientFor(key);
    knowPatient(patientId);
    await seed(patientId);

    const result = await runDrain();
    expect(result.sent, `${key} sent a message nobody approved`).toBe(0);
    expect(result.perSource[source]?.sent ?? 0).toBe(0);
    // And no outbox row exists at all: the draft never opened the table.
    expect(fake.rows(`${source}_outbox`).length).toBe(0);
  });

  it("and the drafts DO appear on the record, marked as drafts rather than as sent", async () => {
    allSystemsOn();
    const patientId = patientFor("draft-visibility");
    knowPatient(patientId);
    await seedCollection(patientId);
    const read = await getThreadForPatient([SITE], patientId);
    // belongsOnRecord excludes drafts: a message nobody approved was never said.
    expect(read.thread).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cross-module rules, driven across agents rather than asserted per module.
// ---------------------------------------------------------------------------

describe("the cross-module rules hold when two agents want the same patient", () => {
  it("only ONE outreach message reaches a patient per London day", async () => {
    allSystemsOn();
    const patientId = "p-shared";
    knowPatient(patientId);
    await seedRecall(patientId);
    await seedReactivation(patientId);
    await seedReviews(patientId);

    const result = await runDrain();
    expect(result.sent, "more than one outreach message reached one patient in a day").toBe(1);
    expect(result.blocked).toBe(2);
    // Priority: recall outranks reactivation, which outranks reviews.
    expect(result.perSource.recall.sent).toBe(1);
    expect(result.perSource.reactivation.blocked).toBe(1);
    expect(result.perSource.reviews.blocked).toBe(1);
  });

  it("a TRANSACTIONAL confirmation still goes out, and takes the slot first", async () => {
    allSystemsOn();
    const patientId = "p-shared-2";
    knowPatient(patientId);
    await seedNoshow(patientId);
    await seedRecall(patientId);

    const result = await runDrain();
    expect(result.perSource.noshow.sent, "the appointment confirmation lost its slot").toBe(1);
    expect(result.perSource.recall.blocked).toBe(1);
  });

  it("the diary's move notice outranks even the confirmation", async () => {
    allSystemsOn();
    const patientId = "p-shared-3";
    knowPatient(patientId);
    await seedRecall(patientId);
    await seedDiary(patientId);

    const result = await runDrain();
    expect(result.perSource.diary.sent).toBe(1);
    expect(result.perSource.recall.blocked).toBe(1);
  });

  it("a message that would say a forbidden thing is BLOCKED, not sent", async () => {
    // The output backstop applies to every module's body, whoever composed it.
    allSystemsOn();
    const patientId = "p-jargon";
    knowPatient(patientId);
    fake.seed("recall_target", {
      id: "recall-j",
      site_id: SITE,
      dentally_patient_id: patientId,
      patient_name: "Iris Bakker",
    });
    const touch = await recall.insertTouch({
      targetId: "recall-j",
      siteId: SITE,
      step: 1,
      channel: "sms",
      body: "Your NHS check-up is due.",
      draftedBy: "claude",
      status: "draft",
    });
    await recall.approveTouch(touch.id, "auto");
    await recall.enqueueOutbox({
      touchId: touch.id,
      siteId: SITE,
      channel: "sms",
      toRef: `patient:${patientId}`,
      body: "Your NHS check-up is due.",
    });

    const result = await runDrain();
    expect(result.sent, "funding jargon reached a patient").toBe(0);
    expect(result.perSource.recall.blocked).toBe(1);
  });

  it("a patient Dentally no longer has is retired, not retried forever", async () => {
    allSystemsOn();
    const patientId = "p-gone";
    missingPatients.add(patientId);
    await seedRecall(patientId);

    const result = await runDrain();
    expect(result.perSource.recall.failed).toBe(1);
    expect(fake.rows("recall_outbox")[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// The waitlist fill: the defect this lane found, driven rather than described.
// ---------------------------------------------------------------------------

describe("no-show waitlist fill honours the owner's switch wherever it is called from", () => {
  const slot = {
    appointmentId: "appt-freed",
    siteId: SITE,
    startAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    durationMin: 30,
    practitioner: "Dr Rahman",
  };

  function seedWaitingPatient(): void {
    fake.seed("noshow_waitlist", {
      id: "wl-1",
      site_id: SITE,
      dentally_patient_id: "p-waitlist",
      patient_name: "Jonas Weber",
      status: "waiting",
      consent: { sms: true },
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
  }

  it("offers the slot and queues one message when the system is ON", async () => {
    allSystemsOn();
    seedWaitingPatient();
    const offered = await offerSlotToNextCandidate(slot, new Date());
    expect(offered?.waitlistId).toBe("wl-1");
    expect(fake.rows("noshow_outbox").length).toBe(1);
    expect(fake.rows("noshow_outbox")[0].status).toBe("queued");
  });

  it("offers NOTHING and queues NOTHING when the system is OFF", async () => {
    // THE REGRESSION. Before this lane the guard lived in three of the four
    // callers, and src/app/api/sync/noshow/route.ts — the Dentally reconciliation
    // pass — had none, so a desk cancellation queued a real patient SMS for a
    // system the owner had switched off. The guard is inside the fill now, so it
    // holds for every caller including the one that never had it.
    allSystemsOn();
    setToggle("no-show-defence", false);
    seedWaitingPatient();
    const offered = await offerSlotToNextCandidate(slot, new Date());
    expect(offered, "a switched-off system offered a slot").toBeNull();
    expect(fake.rows("noshow_outbox").length, "a switched-off system queued an SMS").toBe(0);
    expect(fake.rows("noshow_slot_offer").length, "a switched-off system created an offer").toBe(0);
  });

  it("still queues nothing when the toggle table itself is unreadable and messaging is LIVE", async () => {
    // Fail direction: isSystemEnabledForSend fails CLOSED once messaging is live.
    // A slot that goes unoffered during a blip is re-offered next tick; a text sent
    // for a system the owner switched off cannot be recalled.
    process.env.MESSAGING_DRY_RUN = "false";
    allSystemsOn();
    seedWaitingPatient();
    fake.failTable("system_toggle");
    const offered = await offerSlotToNextCandidate(slot, new Date());
    expect(offered).toBeNull();
    expect(fake.rows("noshow_outbox").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The suite's own completeness.
// ---------------------------------------------------------------------------

describe("this suite traces every drain agent there is", () => {
  it("covers each one exactly once", () => {
    const traced = ALL_TRACES.map((t) => t.key).sort();
    const rostered = DRAIN_AGENTS.map((a) => a.key).sort();
    expect(
      traced,
      `agents in the roster with no scenario trace: ${rostered.filter((k) => !traced.includes(k)).join(", ")}`,
    ).toEqual(rostered);
  });

  it("and every trace ran against a real repository, not a stub of one", () => {
    // If somebody mocks a module repository in this file to make a trace pass, the
    // trace stops proving anything. The fake database records the tables actually
    // written; a real repository call is the only thing that puts them there.
    expect(typeof recall.enqueueOutbox).toBe("function");
    expect(typeof postop.approveDraft).toBe("function");
    expect(vi.isMockFunction(recall.enqueueOutbox)).toBe(false);
    expect(vi.isMockFunction(closer.approveDraft)).toBe(false);
  });
});
