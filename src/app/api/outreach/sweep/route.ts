import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { draftOutreach } from "@/lib/outreach/draft";
import { assignVariant } from "@/lib/outreach/variant";
import { stepDef, advanceAfter, OUTREACH_CADENCE } from "@/lib/outreach/cadence";
import {
  listRunningCampaigns,
  listBuildingCampaigns,
  listDueTargets,
  getTarget,
  listTouches,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  advanceTarget,
  countContactedToday,
} from "@/lib/outreach/repository";
import { runOutreachBuildTickById } from "@/lib/outreach/build";
import type { OutreachCampaign, OutreachTarget } from "@/lib/outreach/types";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import { liveSwitch, type LiveSwitch } from "@/lib/systems/live-switch";
import { dentallyReadKey } from "@/lib/dentally/read";
import {
  loadExcludedTargetKeys,
  isExclusionsUnavailable,
  excludedTargetKey,
} from "@/lib/patient-status/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Single-client pilot; every outreach campaign belongs to Vitality. The kill switch
// and drain are keyed at the client level to match the rest of the platform.
const CLIENT_ID = "vitality";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function patientToRef(t: OutreachTarget): string {
  return `patient:${t.patientId}`;
}

/** The outreach cadence is SMS-only, so a target must have SMS consent to be messaged. */
function consented(t: OutreachTarget): boolean {
  return t.consent.sms;
}

// Build-continuation bounds. Each build tick is itself bounded (a handful of Dentally
// reads), so these cap how much of the sweep's wall-clock the build pass may spend
// before the send pass, and how many campaigns/ticks it advances per run. The lease
// (310s) and maxDuration (300s) sit above the wall-clock budget so a build pass can
// never run the request over.
const BUILD_CONTINUATION_BUDGET_MS = 120_000;
const MAX_BUILD_CAMPAIGNS_PER_TICK = 10;
const MAX_BUILD_TICKS_PER_CAMPAIGN = 12;

interface BuildContinuationSummary {
  campaigns: number;
  ticks: number;
  completed: number;
  skipped?: string;
}

/**
 * UNGATED build-continuation pass. Advances any campaign left in status 'building' (e.g.
 * one created via the co-pilot, which only runs a single tick at creation) so it reaches
 * 'ready' on the 24/7 schedule WITHOUT the Campaigns UI loop. Building a patient list is
 * NOT sending, so this deliberately runs even when the outreach SEND switch is off; the
 * kill switch stays on the send section only. runOutreachBuildTickById reloads the
 * campaign each call, so looping it walks the resumable cursor forward; a 403/429 stop or
 * a failed tick ends that campaign's turn (it resumes next sweep). A build that completes
 * flips itself to 'ready' via the existing build path. Never throws.
 */
async function continueBuilds(): Promise<BuildContinuationSummary> {
  let building: OutreachCampaign[];
  try {
    building = await listBuildingCampaigns(MAX_BUILD_CAMPAIGNS_PER_TICK);
  } catch (err) {
    console.error("[outreach] build-continuation: listing building campaigns failed", err);
    return { campaigns: 0, ticks: 0, completed: 0, skipped: "list failed" };
  }
  if (building.length === 0) return { campaigns: 0, ticks: 0, completed: 0 };
  // runOutreachBuildTick assumes the Dentally read key is configured (its callers check
  // first), so gate the whole pass on it rather than letting each tick fail.
  if (!dentallyReadKey()) return { campaigns: building.length, ticks: 0, completed: 0, skipped: "no dentally key" };

  const start = Date.now();
  let ticks = 0;
  let completed = 0;
  for (const campaign of building) {
    if (Date.now() - start > BUILD_CONTINUATION_BUDGET_MS) break;
    for (let i = 0; i < MAX_BUILD_TICKS_PER_CAMPAIGN; i += 1) {
      if (Date.now() - start > BUILD_CONTINUATION_BUDGET_MS) break;
      try {
        const res = await runOutreachBuildTickById(campaign.id);
        ticks += 1;
        if (res.done) { completed += 1; break; }   // flipped to 'ready' by the build path
        if (!res.ok || res.stopped) break;          // paused/failed: resume next sweep
      } catch (err) {
        // A build blip on one campaign must never abort the pass (or the send pass).
        console.error(`[outreach] build-continuation: tick failed for campaign ${campaign.id}`, err);
        break;
      }
    }
  }
  return { campaigns: building.length, ticks, completed };
}

interface CampaignResult {
  id: string;
  dailyLimit: number;
  usedToday: number;
  queued: number;
  drafted: number;
  capped: number;
  paused: number;
  exhausted: number;
  excluded: number;
  suppressed: number;
}

async function sweepCampaign(
  campaign: OutreachCampaign,
  now: Date,
  gate: LiveSwitch,
  excludedKeys: Set<string>,
): Promise<CampaignResult> {
  const r: CampaignResult = {
    id: campaign.id,
    dailyLimit: campaign.dailyCap,
    usedToday: await countContactedToday(campaign.id, now),
    queued: 0,
    drafted: 0,
    capped: 0,
    paused: 0,
    exhausted: 0,
    excluded: 0,
    suppressed: 0,
  };

  const due = await listDueTargets(campaign.id, now.toISOString());
  for (const stale of due) {
    // THE OWNER'S SWITCH, RE-READ MID-RUN (ruling W1-B/5), and consulted BEFORE
    // the row is touched at all. Every later statement in this loop mutates the
    // target — it settles it 'exhausted' or 'excluded', or drafts, approves,
    // ADVANCES THE CADENCE and queues a patient-facing marketing SMS — so a
    // verdict read 300 seconds ago is the wrong thing to spend a step on. Asking
    // first means a run the owner halted leaves every target it never reached
    // exactly where it was, due, for the next tick.
    if (!(await gate.stillOn())) break;

    // Re-read the target so concurrent state (an inbound reply flipping it to
    // 'replied') is respected even within a single run.
    const target = await getTarget(stale.id);
    if (!target) continue;
    if (target.status !== "pending" && target.status !== "contacted") continue;

    // PLATFORM ADMIN STATUS, RE-CONSULTED ON EVERY STEP — not once, at build time.
    //
    // The outreach audience is a SNAPSHOT: build.ts checks loadExcludedPatientIds as it
    // enrols each patient into outreach_target, and until this line nothing ever looked
    // again. So a patient a receptionist marked `inactive` AFTER the audience was built
    // kept receiving the rest of the cadence, and `inactive` has no second net: the
    // drain stops `do_not_contact` on its message_suppression rows, but applyStatusChange
    // writes no suppression row for `inactive`, so nothing downstream would have caught it.
    // Checked BEFORE listTouches and before any mutation, so no Anthropic draft is spent,
    // no touch is queued and the cadence is not advanced.
    //
    // The target is left DUE rather than settled 'excluded': an override is a reversible
    // act by a human at the desk, so clearing it lets the cadence resume naturally — the
    // same posture as the seven sibling sweeps (recall, reactivation, coordinator, noshow,
    // closer, collection, postop). The no-consent branch below settles instead; that
    // predates this and is unchanged.
    if (excludedKeys.has(excludedTargetKey(target.siteId, target.patientId))) {
      r.suppressed += 1;
      continue;
    }

    // Skip if an outbound touch is already pending (approved-but-unsent): without
    // this the next sweep would draft a SECOND message for the same step and the
    // drain would send both. Mirrors the recall sweep predicate exactly.
    const touches = await listTouches(target.id);
    const hasPending = touches.some(
      (t) => t.direction !== "inbound" && t.status !== "sent" && t.status !== "failed",
    );
    if (hasPending) {
      r.paused += 1;
      continue;
    }

    const step = stepDef(target.currentStep + 1, OUTREACH_CADENCE);
    if (!step) {
      // Cadence complete: settle exhausted so the target leaves the due set.
      await advanceTarget(target.id, {
        currentStep: target.currentStep,
        status: "exhausted",
        nextDueAt: null,
        endedAt: now.toISOString(),
      });
      r.exhausted += 1;
      continue;
    }

    // No consent for the SMS cadence: settle 'excluded' rather than pausing forever,
    // so the target is not stuck in limbo. Consent is acted on at send time (here),
    // not at build time, per the campaign contract.
    if (!consented(target)) {
      await advanceTarget(target.id, {
        currentStep: target.currentStep,
        status: "excluded",
        nextDueAt: null,
        endedAt: now.toISOString(),
      });
      r.excluded += 1;
      continue;
    }

    // Enforce the per-campaign daily cap BEFORE drafting: a capped draft would count
    // as a pending touch and freeze the target at the hasPending guard above, and
    // would cost an Anthropic call for nothing. Once the day's budget is spent the
    // target simply stays due, so tomorrow's sweep continues where today stopped.
    if (r.usedToday + r.queued >= r.dailyLimit) {
      r.capped += 1;
      continue;
    }

    // A/B message test: when the campaign carries a second angle, deterministically
    // assign this patient one variant and always keep it (same patient, same variant on
    // every step and re-run). A single-angle campaign is all 'a'. The variant ONLY
    // chooses which angle the draft is written from; consent, the daily cap, suppression
    // and the drain are all untouched. Stamped on both the touch (per-variant "sent"
    // count) and the target (per-variant assigned/replied/booked).
    const hasVariantB = !!(campaign.messageAngleB && campaign.messageAngleB.trim());
    const variant = assignVariant(campaign.id, target.patientId, hasVariantB);

    // Draft (guardrail-checked inside draftOutreach, with a safe fallback), approve,
    // advance, then queue. Advancing BEFORE the enqueue means a kill between here and
    // the enqueue skips this step next run rather than re-sending it (a skipped
    // message beats a double-send). Mirrors the recall sweep ordering.
    const { body } = await draftOutreach(target, campaign, step.channel, step, undefined, variant);
    const touch = await insertTouch({
      targetId: target.id,
      campaignId: campaign.id,
      siteId: target.siteId,
      step: step.step,
      channel: step.channel,
      body,
      draftedBy: "claude",
      status: "draft",
      variant,
    });
    r.drafted += 1;

    await approveTouch(touch.id, "auto");

    const adv = advanceAfter(step.step, now, OUTREACH_CADENCE);
    await advanceTarget(target.id, {
      currentStep: adv.currentStep,
      status: adv.status === "exhausted" ? "exhausted" : "contacted",
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
      variant,
    });

    // Leave the outbox row 'queued' so the shared drain delivers it via Twilio and
    // writes to_address (what inbound reply correlation matches on). The drain also
    // applies consent-independent suppression + the cross-module one-per-day cap.
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel: step.channel,
      toRef: patientToRef(target),
      body,
    });
    r.queued += 1;
  }

  return r;
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Never overlap with another outreach sweep: two runs would both advance the same
  // building cursor OR see the same due targets and draft+queue duplicates. The lease is
  // acquired UP FRONT so the build-continuation pass is protected too. Lease OUTLIVES
  // maxDuration (300s) so a slow run cannot be lapped; a crashed run self-heals ~10s
  // after the platform kills it.
  if (!(await acquireCronLock("sweep-outreach", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    // UNGATED build-continuation FIRST, BEFORE the send kill-switch: a co-pilot-created
    // campaign is left mid-build and must finish on the schedule even when the outreach
    // SEND switch is off. Building a list is not sending, so it is deliberately not gated
    // by isSystemEnabledForSend (that gate stays on the send section below).
    const build = await continueBuilds();

    // Owner kill switch, fail-closed on the SEND path: with outreach OFF (its default),
    // nothing is drafted or queued. This is the primary gate on a system that seeds
    // disabled and only runs during a supervised client test. The build pass above has
    // already run, so lists still finish while sending stays halted.
    if (!(await isSystemEnabledForSend(CLIENT_ID, "outreach"))) {
      return Response.json({ ok: true, build, skipped: "system off" });
    }

    // Patients marked inactive / do_not_contact are excluded from outreach. Loaded ONCE
    // per tick (campaigns span sites, so the cross-site key set is the right read) and
    // checked per target below, before anything is drafted or queued.
    // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED (ruling W1-B/2). loadExcludedTargetKeys
    // throws once messaging is LIVE and the override table cannot be read, so a database
    // blip can never be the reason a patient a human marked inactive got a marketing SMS.
    // It still returns an empty set under dry-run, so local work is unaffected. The build
    // pass above has already run: a list still finishes while the send pass refuses.
    let excludedKeys: Set<string>;
    try {
      excludedKeys = await loadExcludedTargetKeys();
    } catch (err) {
      if (!isExclusionsUnavailable(err)) throw err;
      console.error("[outreach] exclusion list unreadable while messaging is live; skipping this tick", err);
      return Response.json({ ok: true, build, skipped: "exclusions unavailable" });
    }

    const now = new Date();
    const campaigns = await listRunningCampaigns();
    const results: CampaignResult[] = [];
    // ONE GATE FOR THE WHOLE RUN, ACROSS EVERY CAMPAIGN (ruling W1-B/5). The
    // check above is read ONCE and this handler then loops for up to 300 seconds
    // over every running campaign and every due target inside each — an
    // Anthropic draft, an auto-approved touch, an advanced cadence and a queued
    // patient-facing marketing SMS per row. An owner who switched Segment
    // outreach off at 10:03 during a supervised test would otherwise keep paying
    // for drafts until the tick ended, and the rows would sit in the outbox for
    // 48 hours ready to land as a burst the moment outreach came back on.
    //
    // The gate is created here rather than per campaign so the ten-row bound is
    // the RUN's, not each campaign's: five running campaigns must not multiply
    // the exposure by five.
    const gate = liveSwitch(CLIENT_ID, "outreach");
    let drafted = 0, queued = 0, paused = 0, capped = 0, exhausted = 0, excluded = 0, suppressed = 0, swept = 0;
    for (const campaign of campaigns) {
      // Isolate each campaign: one campaign's failure (a DB blip on its targets)
      // must not abort the others' sends for this tick.
      try {
        const res = await sweepCampaign(campaign, now, gate, excludedKeys);
        results.push(res);
        drafted += res.drafted; queued += res.queued; paused += res.paused;
        capped += res.capped; exhausted += res.exhausted; excluded += res.excluded;
        suppressed += res.suppressed;
        swept += res.queued + res.capped + res.paused + res.exhausted + res.excluded + res.suppressed;
      } catch (err) {
        console.error(`[outreach] sweep failed for campaign ${campaign.id}; skipping`, err);
      }
      // The inner loop breaks out of ITS campaign; without this the next
      // campaign would start a fresh pass over its own due targets and the run
      // would carry on drafting on a switch already read as off. (The gate
      // itself never resumes once off, so each of those passes would stop on its
      // first row — but "stops immediately" is not "does not start", and the
      // reads it would spend getting there are pointless.)
      if (gate.switchedOffMidRun) break;
    }
    return Response.json({
      ok: true,
      build,
      campaigns: campaigns.length,
      // Honest signal for ops: this run stopped early because the owner switched
      // outreach off while it was working, not because there was nothing to do.
      switchedOffMidRun: gate.switchedOffMidRun,
      swept,
      drafted,
      queued,
      paused,
      capped,
      exhausted,
      excluded,
      // Rows skipped because the patient carries a platform admin override
      // (inactive / do_not_contact). Named apart from `excluded` (no SMS consent)
      // because they are different facts and only one of them settles the target.
      suppressed,
      // Convenience for a single-campaign run (and the daily-cap test): surface the
      // one campaign's budget at the top level.
      ...(results.length === 1 ? { dailyLimit: results[0].dailyLimit, usedToday: results[0].usedToday } : {}),
      detail: results,
    });
  } finally {
    await releaseCronLock("sweep-outreach");
  }
}

// EVERY Dentally read inside this handler is BACKGROUND work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): it is starved first, at 60%
// consumption, so a bulk sweep can never be the reason a practice manager's screen or
// a patient's booking calendar goes blank. A refusal aborts this run; the next tick
// retries. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
