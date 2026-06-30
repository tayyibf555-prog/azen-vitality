import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSuppressed } from "@/lib/messaging/suppression";
import { getClient, getSite } from "@/lib/mock/clients";
import { draftReviewRequest } from "@/lib/reviews/draft";
import { practiceName, reviewLink } from "@/lib/reviews/config";
import {
  listDue,
  markStatus,
  insertTouch,
  approveTouch,
  enqueueOutbox,
} from "@/lib/reviews/repository";
import type { ReviewRequest } from "@/lib/reviews/types";

export const dynamic = "force-dynamic";

function patientRef(r: ReviewRequest): string {
  return `patient:${r.dentallyPatientId}`;
}

// The client name for a site, for the review copy. Best-effort: falls back to the
// neutral practice name when the site/client cannot be resolved.
function clientNameForSite(siteId: string): string | null {
  const clientId = getSite(siteId)?.clientId;
  if (!clientId) return null;
  return getClient(clientId)?.name ?? null;
}

// GET/POST /api/reviews/sweep
// For each due, still-scheduled review request: re-check suppression, draft the
// (templated) review request, insert + approve a touch, enqueue the outbox row, and
// mark the request 'sent'. The shared drain dispatches the outbox via Twilio/Resend
// and honours MESSAGING_DRY_RUN; suppression is re-checked there too.
export async function POST(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // The copy needs a review link; without one we have nothing useful to send.
  const link = reviewLink();
  if (link === "") {
    return Response.json({ ok: true, skipped: "REVIEW_LINK_URL not set" });
  }

  // Never overlap with another review sweep: two runs would both see the same due
  // requests and double-enqueue. Lease for just under maxDuration so a crashed run
  // self-heals on the next tick.
  if (!(await acquireCronLock("sweep-reviews", 280))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const due = await listDue(now.toISOString());
    let sent = 0;
    let suppressed = 0;

    for (const req of due) {
      // Re-check the opt-out at send time: a patient may have replied STOP between
      // attendance and the scheduled send.
      if (await isSuppressed(req.siteId, req.channel, patientRef(req))) {
        await markStatus(req.id, "suppressed");
        suppressed += 1;
        continue;
      }

      const body = draftReviewRequest(req.patientName, practiceName(clientNameForSite(req.siteId)), link);
      const touch = await insertTouch({
        requestId: req.id,
        siteId: req.siteId,
        channel: req.channel,
        body,
        draftedBy: "human", // templated, deterministic copy (not model-generated)
        status: "draft",
      });
      await approveTouch(touch.id, "auto");
      // Leave the outbox row 'queued' so the shared drain dispatches it and records
      // to_address + the provider message id (honouring MESSAGING_DRY_RUN there).
      await enqueueOutbox({
        touchId: touch.id,
        siteId: req.siteId,
        channel: req.channel,
        toRef: patientRef(req),
        body,
      });
      await markStatus(req.id, "sent");
      sent += 1;
    }

    return Response.json({ ok: true, due: due.length, sent, suppressed });
  } finally {
    await releaseCronLock("sweep-reviews");
  }
}

// Vercel Cron / pg_cron triggers with GET; reuse the same handler.
export const GET = POST;
export const maxDuration = 300;
