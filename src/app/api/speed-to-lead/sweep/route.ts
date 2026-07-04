import { cronUnauthorized } from "@/lib/cron";
import { contactLead } from "@/lib/speed-to-lead/contact";
import {
  listUncontacted,
  claimLeadForContact,
  releaseLeadClaim,
  resetStaleContacting,
} from "@/lib/speed-to-lead/repository";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// SLA failsafe. If the in-request intake contact did not fire (a send error, a
// cold start, a crash mid-request), this sweep catches any lead still
// uncontacted after the ~30s target and contacts it. contactLead is idempotent
// enough for our purposes: it re-drafts and reuses the threaded conversation,
// and only advances the stage to 'contacted' once a send succeeds.

const SLA_MS = 30_000;

export async function POST(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  if (!(await isSystemEnabled("vitality", "speed-to-lead"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // Never overlap with another SLA sweep: two runs would both list the same
  // uncontacted leads and double first-contact. The lease must OUTLIVE
  // maxDuration (300s): a shorter lease would expire while a slow run was still
  // working, letting the next tick double-contact. A crashed run still
  // self-heals: the lease expires ~10s after the platform kills the function.
  if (!(await acquireCronLock("sweep-speed-to-lead", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
  const now = Date.now();
  // Recover leads stranded at 'contacting' by a crash/timeout between claim and the
  // contactLead stage-advance: reset any older than 10 min back to 'new' so they are
  // re-picked below. The 10-min window is safe against an in-flight contact (the claim
  // bumps updated_at).
  const recovered = await resetStaleContacting(10);
  const stale = await listUncontacted(new Date(now - SLA_MS).toISOString());

  let contacted = 0;
  let claimedBy = 0;
  for (const lead of stale) {
    // Atomically claim the lead ('new' → 'contacting') before contacting it. This
    // closes the race with the in-request intake contact: if intake is still in
    // flight on this brand-new lead, the claim fails (intake already advanced it
    // past 'new', or wins the flip) and the sweep skips it, so the lead is never
    // first-contacted twice.
    if (!(await claimLeadForContact(lead.id))) continue;
    claimedBy += 1;
    try {
      await contactLead(lead);
      contacted += 1;
    } catch {
      // Leave it for the next sweep rather than failing the whole run.
    } finally {
      // Release the claim if it's still stranded. contactLead advances the stage
      // to 'contacted' on success, so this is a no-op then; but on a thrown error
      // OR a silent early-return (no consent / no address) the lead is left at
      // 'contacting' — this conditional 'contacting' → 'new' resets it so the SLA
      // sweep can re-pick it up. A claimed-but-not-contacted lead must stay
      // retryable. Best-effort; swallow so one reset can't fail the whole run.
      try {
        await releaseLeadClaim(lead.id);
      } catch {
        // swallow.
      }
    }
  }

  return Response.json({ ok: true, recovered, checked: stale.length, claimed: claimedBy, contacted });
  } finally {
    await releaseCronLock("sweep-speed-to-lead");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
