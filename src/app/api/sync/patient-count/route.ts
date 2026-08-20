import { dentallyScopeRefusal, dentallyScopeRefused, runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { dentallyReadKey } from "@/lib/dentally/read";
import { upsertPatientCount } from "@/lib/patient-count/repository";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_PAGE = 100;
// Bound the scan: ~330 pages covers a 33k-patient site; a site bigger than that
// logs and reports partial=true rather than looping forever.
const MAX_PAGES = 400;

// Nightly exact patient count per site. Dentally's /v1/patients meta.total gives
// the whole book in one call but IGNORES active/archived filters, so the ACTIVE
// count is made by paging the book and counting flags. Scheduled off-hours
// (pg_cron, 03:15) so its ~300 requests/site never compete with staff reads —
// the July 11 rate-limit incident showed the API budget is shared with every
// dashboard view. Pure counting: no per-patient enrichment calls.
async function countSite(client: DentallyClient, siteId: string): Promise<{
  siteId: string;
  total: number;
  active: number;
  partial: boolean;
  budgetRefused?: boolean;
}> {
  let total = 0;
  let active = 0;
  let partial = true;
  let budgetRefused = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // The shared Dentally budget has refused this run (the refusal is sticky per
    // scope, src/lib/dentally/budget.ts). The three sites page CONCURRENTLY here, so
    // without this each of them would keep asking and the first refusal would be
    // paid three times over. Stop with a partial count rather than a wrong one.
    if (dentallyScopeRefused()) {
      budgetRefused = true;
      break;
    }
    const res = await client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE });
    const rows = Array.isArray(res.patients) ? res.patients : [];
    for (const raw of rows) {
      const p = (raw ?? {}) as Record<string, unknown>;
      total += 1;
      // Same active semantics as everywhere else in the platform: absent flag =
      // active; archived counts as not active regardless of the active flag.
      if (p.active !== false && p.archived !== true) active += 1;
    }
    if (rows.length < PER_PAGE) {
      partial = false;
      break;
    }
  }
  if (budgetRefused) {
    // NOT written to the store. This count is the dashboard's ONLY source for
    // "active patients" (dashboard/read.ts readActiveCounts), and a short count from
    // a refused scan would replace an exact figure with a smaller one that looks
    // just as exact. An unchanged stored count that is a day old is strictly better
    // than a fresh wrong one, and the panel already handles a missing site.
    console.warn(
      `[patient-count] site ${siteId}: the shared Dentally budget refused this run after ` +
        `${total} patients; the stored count is left UNCHANGED rather than overwritten with a ` +
        `partial figure. The next run recounts from page 1.`,
    );
    return { siteId, total, active, partial: true, budgetRefused: true };
  }
  if (partial) {
    console.warn(`[patient-count] site ${siteId} hit the ${MAX_PAGES}-page bound; counts are partial`);
  }
  await upsertPatientCount({ siteId, total, active });
  return { siteId, total, active, partial };
}

async function handleWithDentallyPriority(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  if (!(await acquireCronLock("sync-patient-count", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      // This sync only READS (listPatients). Arms the write latch so the key it
      // carries — which is NOT read-only despite its name, see client.ts
      // assertWritable — cannot issue a write from here.
      readOnly: true,
    });
    const siteIds = SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
    // Sites in PARALLEL (3 concurrent pagers): wall-clock is the largest site, and
    // one site's failure must not lose the others' counts.
    const perSite = await Promise.all(
      siteIds.map(async (siteId) => {
        try {
          return await countSite(client, siteId);
        } catch (e) {
          return { siteId, error: String(e) };
        }
      }),
    );
    const refusal = dentallyScopeRefusal();
    return Response.json({
      ok: true,
      budgetRefused: refusal !== null,
      budgetRefusalReason: refusal?.reason ?? null,
      perSite,
    });
  } finally {
    await releaseCronLock("sync-patient-count");
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
