import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { draftOutreach } from "@/lib/coordinator/draft";
import { stepDef, COORDINATOR_CADENCE } from "@/lib/coordinator/cadence";
import {
  listOpportunities,
  listTouches,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  setLastTouchAt,
} from "@/lib/coordinator/repository";
import type { TouchChannel, TreatmentOpportunity } from "@/lib/coordinator/types";
import { SITES } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import { liveSwitch } from "@/lib/systems/live-switch";
import {
  loadExcludedTargetKeys,
  excludedTargetKey,
  isExclusionsUnavailable,
} from "@/lib/patient-status/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DAY = 86_400_000;

// `completed` is the coordinator's terminal status. Everything else is still OPEN
// and eligible for a cadence step.
const OPEN_STATUSES = ["accepted", "in_progress", "stalled"] as const;

function autoSendThreshold(): number {
  return Number(process.env.COORDINATOR_AUTO_SEND_THRESHOLD ?? 250);
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

/** WhatsApp uses SMS consent as a proxy, mirroring the [action] route. */
function channelConsented(o: TreatmentOpportunity, channel: TouchChannel): boolean {
  if (channel === "email") return o.consent.email;
  return o.consent.sms;
}

function patientToRef(o: TreatmentOpportunity): string {
  return `patient:${o.dentallyPatientId}`;
}

async function handleWithDentallyPriority(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // FAIL-CLOSED WHEN LIVE (ruling W1-B/1, 3 Sep 2026). This used to be
  // isSystemEnabled, which resolves a toggle-read ERROR to "enabled" for a
  // default-ON system and then let the whole batch draft. isSystemEnabledForSend
  // keeps that behaviour while MESSAGING_DRY_RUN is on, so development against a
  // partial database still works, and fails CLOSED once messaging is live: a
  // switch we cannot read is treated as off. A skipped tick is a delay; a batch
  // sent against an unknown switch is an incident.
  if (!(await isSystemEnabledForSend("vitality", "treatment-coordinator"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // Never overlap with another coordinator sweep: two runs would both see the
  // same open opportunities and draft+queue duplicates. The lease must OUTLIVE
  // maxDuration (300s): a shorter lease would expire while a slow run was still
  // working, letting the next tick double-queue. A crashed run still self-heals:
  // the lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("sweep-coordinator", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
  const now = new Date();
  const opportunities = await listOpportunities({
    siteIds: vitalitySiteIds(),
    statuses: [...OPEN_STATUSES],
  });

  // Platform admin status: patients marked inactive / do_not_contact are excluded from
  // coordinator follow-ups. Loaded ONCE per sweep and checked per opportunity before
  // drafting, so no Anthropic draft is spent and nothing is queued.
  // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED (ruling W1-B/2, 3 Sep 2026).
  // loadExcludedTargetKeys throws once messaging is LIVE and it cannot read the
  // override table, so a patient a human marked inactive can never be drafted
  // because of a database blip. It still returns an empty set under dry-run.
  let excludedKeys: Set<string>;
  try {
    excludedKeys = await loadExcludedTargetKeys();
  } catch (err) {
    if (!isExclusionsUnavailable(err)) throw err;
    console.error("[coordinator] exclusion list unreadable while messaging is live; skipping this tick", err);
    return Response.json({ ok: true, skipped: "exclusions unavailable" });
  }

  let swept = 0;
  let drafted = 0;
  let autoSent = 0;
  let awaitingApproval = 0;
  let skipped = 0;
  let suppressed = 0;

  // The switch is re-read every ten rows for the rest of this run (ruling
  // W1-B/5): a long sweep must not keep drafting after the owner has switched
  // the system off. See src/lib/systems/live-switch.ts.
  const gate = liveSwitch("vitality", "treatment-coordinator");

  for (const o of opportunities) {
    if (!(await gate.stillOn())) break;
    swept += 1;

    // Platform admin status excludes this patient: skip before any draft.
    if (excludedKeys.has(excludedTargetKey(o.siteId, o.dentallyPatientId))) {
      suppressed += 1;
      continue;
    }

    // Derive the next cadence step from the touch history: count the outbound
    // touches that have actually been sent, and ask the cadence for the step after.
    const touches = await listTouches(o.id);

    // Pause-on-reply: once the patient has replied (an inbound touch exists), stop
    // the cadence so we never keep chasing someone who has already engaged. The
    // inbound webhook records that reply as an inbound coordinator_touch.
    if (touches.some((t) => t.direction === "inbound")) {
      skipped += 1;
      continue;
    }

    // Don't re-draft while an outbound touch is still pending (draft awaiting
    // human approval, or approved/queued waiting on the drain). Without this a
    // high-value opportunity (which drafts-for-approval and never advances
    // lastTouchAt) would accumulate a fresh duplicate draft on every sweep.
    const hasPending = touches.some(
      (t) => t.direction !== "inbound" && t.status !== "sent" && t.status !== "failed",
    );
    if (hasPending) {
      skipped += 1;
      continue;
    }

    const sentSteps = touches.filter(
      (t) => t.direction !== "inbound" && t.status === "sent",
    ).length;
    const step = stepDef(sentSteps + 1, COORDINATOR_CADENCE);
    if (!step) {
      skipped += 1;
      continue;
    }

    // Due when nothing has gone out yet, or enough time has passed since the last touch.
    const due =
      o.lastTouchAt === null ||
      now.getTime() - new Date(o.lastTouchAt).getTime() >= step.waitDays * DAY;
    if (!due) {
      skipped += 1;
      continue;
    }

    if (!channelConsented(o, step.channel)) {
      skipped += 1;
      continue;
    }

    const { body } = await draftOutreach(o, step.channel);

    // HUMAN-IN-THE-LOOP: high-value opportunities (outstanding >= threshold) are
    // drafted for a human to approve; only smaller-value ones auto-send.
    const autoSend = o.amountOutstanding < autoSendThreshold();
    if (!autoSend) {
      await insertTouch({
        opportunityId: o.id,
        siteId: o.siteId,
        channel: step.channel,
        body,
        draftedBy: "claude",
        status: "draft",
      });
      drafted += 1;
      awaitingApproval += 1;
      continue;
    }

    // Auto-send path: draft, approve, enqueue. We deliberately do NOT call
    // markTouchSent here. Leaving the outbox row 'queued' lets the shared drain
    // deliver it and write to_address; marking it sent here would break both
    // delivery and inbound correlation.
    const touch = await insertTouch({
      opportunityId: o.id,
      siteId: o.siteId,
      channel: step.channel,
      body,
      draftedBy: "claude",
      status: "draft",
    });
    drafted += 1;
    await approveTouch(touch.id, "auto");
    await enqueueOutbox({
      touchId: touch.id,
      siteId: o.siteId,
      channel: step.channel,
      toRef: patientToRef(o),
      body,
    });
    await setLastTouchAt(o.id, now.toISOString());
    autoSent += 1;
  }

  return Response.json({ ok: true, swept, drafted, autoSent, awaitingApproval, skipped, suppressed });
  } finally {
    await releaseCronLock("sweep-coordinator");
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
