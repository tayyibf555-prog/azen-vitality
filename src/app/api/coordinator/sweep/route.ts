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
import { isSystemEnabled } from "@/lib/systems/repository";

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

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  if (!(await isSystemEnabled("vitality", "treatment-coordinator"))) {
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

  let swept = 0;
  let drafted = 0;
  let autoSent = 0;
  let awaitingApproval = 0;
  let skipped = 0;

  for (const o of opportunities) {
    swept += 1;

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

  return Response.json({ ok: true, swept, drafted, autoSent, awaitingApproval, skipped });
  } finally {
    await releaseCronLock("sweep-coordinator");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
