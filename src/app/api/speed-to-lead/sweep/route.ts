import { cronUnauthorized } from "@/lib/cron";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { listUncontacted } from "@/lib/speed-to-lead/repository";

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

  const now = Date.now();
  const stale = await listUncontacted(new Date(now - SLA_MS).toISOString());

  let contacted = 0;
  for (const lead of stale) {
    try {
      await contactLead(lead);
      contacted += 1;
    } catch {
      // Leave it for the next sweep rather than failing the whole run.
    }
  }

  return Response.json({ ok: true, checked: stale.length, contacted });
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
