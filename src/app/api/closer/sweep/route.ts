import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { SITES, getSite } from "@/lib/mock/clients";
import { listOpportunities } from "@/lib/coordinator/repository";
import { loadExcludedTargetKeys, excludedTargetKey } from "@/lib/patient-status/repository";
import { isSuppressed } from "@/lib/messaging/suppression";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { decideCloserAction, type CloserOpportunityFacts } from "@/lib/closer/cadence";
import { draftCloserMessage } from "@/lib/closer/draft";
import {
  listStatesByOpportunity,
  listInboundBodiesByOpportunity,
  insertDraft,
  stopOpportunity,
  coolOff,
} from "@/lib/closer/repository";
import { closerConfig } from "@/lib/closer/types";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";
const OPEN_STATUSES = ["accepted", "in_progress", "stalled"] as const;

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === CLIENT_ID).map((s) => s.id);
}

/** The public booking link a draft may offer, or null so the ask becomes "reply". */
function bookingLink(): string | null {
  const explicit = (process.env.CLOSER_BOOKING_URL ?? "").trim();
  if (explicit.startsWith("https://")) return explicit;
  const base = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (base.startsWith("https://")) return `${base.replace(/\/+$/, "")}/book`;
  return null;
}

function patientToRef(o: TreatmentOpportunity): string {
  return `patient:${o.dentallyPatientId}`;
}

function toFacts(o: TreatmentOpportunity): CloserOpportunityFacts {
  return {
    id: o.id,
    siteId: o.siteId,
    status: o.status,
    acceptedAt: o.acceptedAt,
    amountOutstanding: o.amountOutstanding,
    consent: { sms: o.consent.sms, email: o.consent.email },
  };
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // KILL SWITCH, FIRST AND FAIL-CLOSED FOR THIS SLUG.
  //
  // 'treatment-closer' is declared defaultEnabled:false in the systems catalog,
  // so isSystemEnabled resolves the ABSENCE of a system_toggle row to DISABLED,
  // and resolves a toggle-read ERROR to disabled too. That is the difference
  // between this and every other module: for the rest, an absent row means on.
  // A brand new send surface must never be armed by a row nobody wrote or by a
  // database blip, so the closer is off until somebody deliberately turns it on.
  if (!(await isSystemEnabled(CLIENT_ID, "treatment-closer"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // Never overlap: two runs would see the same opportunities and draft twice for
  // the same patient. The lease outlives maxDuration (300s) so a slow run cannot
  // have the next tick start underneath it; a crashed run self-heals when the
  // lease expires.
  if (!(await acquireCronLock("sweep-closer", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const config = closerConfig();
    const siteIds = vitalitySiteIds();

    // NO DENTALLY READ HAPPENS IN THIS ROUTE. Everything the closer reasons about
    // (the plan, its remaining value, consent, the patient's name) is already
    // mirrored into treatment_opportunity by the coordinator's own sync, so a
    // live read here would spend the practice's shared quota to learn something
    // we already stored. The handler is still declared background work below,
    // because it is scheduled work and because the classification must already be
    // right on the day someone does add a read.
    const opportunities = await listOpportunities({ siteIds, statuses: [...OPEN_STATUSES] });
    const ranked = opportunities.slice(0, config.maxExaminedPerRun);
    const ids = ranked.map((o) => o.id);

    const [states, inbound, excludedKeys, usps] = await Promise.all([
      listStatesByOpportunity(ids),
      listInboundBodiesByOpportunity(ids),
      loadExcludedTargetKeys(),
      listActiveUspTexts(CLIENT_ID),
    ]);

    const link = bookingLink();
    let examined = 0;
    let drafted = 0;
    let stopped = 0;
    let skipped = 0;
    let refused = 0;
    const stopReasons: Record<string, number> = {};
    const skipReasons: Record<string, number> = {};
    const refusalReasons: Record<string, number> = {};

    for (const o of ranked) {
      if (drafted >= config.maxDraftsPerRun) break;
      examined += 1;

      const state = states.get(o.id) ?? null;
      const facts = toFacts(o);
      const toRef = patientToRef(o);

      // The decider needs to know whether this patient is already opted out. The
      // channel it matters for is the one the NEXT step would use, but a cheap
      // pre-check on both channels is safer than guessing the step first: an
      // opt-out on either channel is treated as an opt-out from the closer.
      let suppressed = false;
      try {
        suppressed =
          (await isSuppressed(o.siteId, "sms", toRef)) || (await isSuppressed(o.siteId, "email", toRef));
      } catch {
        // A suppression read that throws must never be read as "not opted out".
        // Skip this opportunity for this tick instead; the next tick retries.
        skipped += 1;
        skipReasons.suppression_unavailable = (skipReasons.suppression_unavailable ?? 0) + 1;
        continue;
      }

      const decision = decideCloserAction({
        opportunity: facts,
        state,
        inboundBodies: inbound.get(o.id) ?? [],
        excluded: excludedKeys.has(excludedTargetKey(o.siteId, o.dentallyPatientId)),
        suppressed,
        now,
        config,
      });

      if (decision.action === "stop") {
        // Only write when something changes: an opportunity already recorded as
        // stopped short-circuits at the top of the decider, so reaching here means
        // this is a new stop.
        await stopOpportunity(o.id, o.siteId, decision.reason);
        stopped += 1;
        stopReasons[decision.reason] = (stopReasons[decision.reason] ?? 0) + 1;
        continue;
      }

      if (decision.action === "skip") {
        skipped += 1;
        skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
        continue;
      }

      const result = await draftCloserMessage(o, decision.step, {
        bookingLink: link,
        practiceName: getSite(o.siteId)?.name ?? "",
        usps,
      });

      if (!result.ok) {
        // A refused draft is NOT stored. Nothing about a message that broke a rule
        // should exist in a place a human could approve it from. Cool the
        // opportunity off so a systematic refusal cannot burn budget every tick.
        refused += 1;
        refusalReasons[result.category] = (refusalReasons[result.category] ?? 0) + 1;
        console.warn(
          `[closer] refused a draft for ${o.id} (${result.category}: ${result.detail}); nothing stored`,
        );
        await coolOff(o.id, o.siteId, new Date(now.getTime() + config.cooldownHours * 3_600_000));
        continue;
      }

      // DRAFT ONLY. insertDraft writes closer_touch and moves the state to
      // awaiting_approval. It does not write closer_outbox, and no other path in
      // this route does either, so nothing this sweep produces can be delivered
      // until a human approves it.
      await insertDraft({
        opportunityId: o.id,
        siteId: o.siteId,
        step: decision.step.step,
        channel: decision.step.channel,
        body: result.body,
      });
      drafted += 1;
    }

    return Response.json({
      ok: true,
      examined,
      drafted,
      stopped,
      skipped,
      refused,
      queued: 0, // the closer never queues: approval is the only route to the outbox
      stopReasons,
      skipReasons,
      refusalReasons,
    });
  } finally {
    await releaseCronLock("sweep-closer");
  }
}

// Scheduled work: nobody is waiting on this run, so it takes the practice's shared
// Dentally quota at BACKGROUND priority and is starved first. The handler reads no
// Dentally data today (see the note inside), but the classification is declared
// anyway: it is what the cron-lease coverage test requires of every scheduled
// route, and it means a read added later is already correctly classified rather
// than silently competing with the people at the front desk.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// pg_cron / Vercel Cron trigger with GET; same handler.
export const GET = POST;
