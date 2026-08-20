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
import { dentallyReadKey } from "@/lib/dentally/read";

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
}

async function sweepCampaign(campaign: OutreachCampaign, now: Date): Promise<CampaignResult> {
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
  };

  const due = await listDueTargets(campaign.id, now.toISOString());
  for (const stale of due) {
    // Re-read the target so concurrent state (an inbound reply flipping it to
    // 'replied') is respected even within a single run.
    const target = await getTarget(stale.id);
    if (!target) continue;
    if (target.status !== "pending" && target.status !== "contacted") continue;

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

    const now = new Date();
    const campaigns = await listRunningCampaigns();
    const results: CampaignResult[] = [];
    let drafted = 0, queued = 0, paused = 0, capped = 0, exhausted = 0, excluded = 0, swept = 0;
    for (const campaign of campaigns) {
      // Isolate each campaign: one campaign's failure (a DB blip on its targets)
      // must not abort the others' sends for this tick.
      try {
        const res = await sweepCampaign(campaign, now);
        results.push(res);
        drafted += res.drafted; queued += res.queued; paused += res.paused;
        capped += res.capped; exhausted += res.exhausted; excluded += res.excluded;
        swept += res.queued + res.capped + res.paused + res.exhausted + res.excluded;
      } catch (err) {
        console.error(`[outreach] sweep failed for campaign ${campaign.id}; skipping`, err);
      }
    }
    return Response.json({
      ok: true,
      build,
      campaigns: campaigns.length,
      swept,
      drafted,
      queued,
      paused,
      capped,
      exhausted,
      excluded,
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
